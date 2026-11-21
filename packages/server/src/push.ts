// Web Push (Ümit #13927, #13934): a person's devices are told of the messages that need them while Agent Hub is closed,
// as a banner on the iPhone (a Home Screen web app, iOS 16.4+) or a desktop notification. The bus signs with its own
// VAPID key (RFC 8292) and encrypts every payload for the device (RFC 8291, aes128gcm): the push service (Apple's,
// Google's, Mozilla's) only passes ciphertext along. Which messages: a DM, one that @mentions the person, a reply to
// their message; never their own, never in a conversation they set to "none".
import type { Database } from "bun:sqlite";
import { createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, createCipheriv, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { conversationLabel, mentionedIds, type Conversation, type Message, type PushPayload, type WebPushSubscription } from "@agent-bus/protocol";
import { HttpError } from "./http";

/** The push services browsers use; a subscription elsewhere is refused (the bus would POST to any address). */
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const BODY_CHARS = 240;
/** A notification not delivered within a day is dropped by the push service. */
const TTL_SECONDS = 86_400;

const b64url = (data: Uint8Array): string => Buffer.from(data).toString("base64url");
const unb64url = (text: string): Buffer => Buffer.from(text, "base64url");

export interface PushOptions {
  /** The `sub` of the VAPID claims: a mailto: or https: address the push service can reach the bus's owner at. */
  subject: string;
  /** Tests only: allow http:// endpoints on any host. */
  anyEndpoint?: boolean;
}

interface SubscriptionRow {
  endpoint: string;
  human: string;
  p256dh: string;
  auth: string;
}

export class WebPush {
  private readonly privateKey: KeyObject;
  readonly publicKey: string;

  constructor(
    private readonly db: Database,
    keyFile: string,
    private readonly options: PushOptions
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      human TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_ok_at INTEGER
    )`);
    // The bus's VAPID key, made once: a new key would orphan every device's subscription.
    if (!existsSync(keyFile)) {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      writeFileSync(keyFile, JSON.stringify(privateKey.export({ format: "jwk" })), { mode: 0o600 });
    }
    const jwk = JSON.parse(readFileSync(keyFile, "utf8")) as { x: string; y: string; d: string };
    this.privateKey = createPrivateKey({ key: { ...jwk, kty: "EC", crv: "P-256" }, format: "jwk" });
    this.publicKey = b64url(Buffer.concat([Buffer.from([4]), unb64url(jwk.x), unb64url(jwk.y)]));
  }

  subscribe(human: string, body: Record<string, unknown>, now = Date.now()): void {
    const sub = this.checked(body.subscription);
    this.db
      .query(
        `INSERT INTO push_subscriptions (endpoint, human, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(endpoint) DO UPDATE SET human = ?2, p256dh = ?3, auth = ?4`
      )
      .run(sub.endpoint, human, sub.keys.p256dh, sub.keys.auth, now);
  }

  unsubscribe(human: string, endpoint: unknown): void {
    if (typeof endpoint !== "string") throw new HttpError(400, "Give the subscription's endpoint");
    this.db.query("DELETE FROM push_subscriptions WHERE endpoint = ?1 AND human = ?2").run(endpoint, human);
  }

  /** A test notification to one of `human`'s devices: the push service's HTTP status. */
  async test(human: string, endpoint: unknown): Promise<number> {
    const row = this.db
      .query<SubscriptionRow, [string, string]>("SELECT * FROM push_subscriptions WHERE endpoint = ?1 AND human = ?2")
      .get(typeof endpoint === "string" ? endpoint : "", human);
    if (!row) throw new HttpError(404, "This device is not subscribed");
    return this.send(row, { title: "Agent Hub", body: "Notifications work on this device.", url: "/", tag: "test" });
  }

  /**
   * Tells the people a new message needs (see the file comment). Never throws: a notification that fails costs
   * nothing but itself.
   */
  notify(message: Message, conversation: Conversation, isHuman: (id: string) => boolean): void {
    const people = this.peopleFor(message, conversation, isHuman);
    if (people.length === 0) return;
    // Where, as the website names it: a room's or project's own title ("#agent hub"), else its address (Ümit #14043:
    // '#hilde-hub ("#agent hub")' was not its name).
    const where = conversation.kind === "dm" ? "" : ` · ${conversation.kind === "project" && conversation.title ? conversation.title : conversationLabel(conversation)}`;
    const files = message.files.length > 0 ? ` [${message.files.map((f) => f.name).join(", ")}]` : "";
    const text = plainText(`${message.text}${files}`);
    const payload: PushPayload = {
      title: `@${message.from}${where}`,
      body: text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS - 1)}…` : text,
      url: `/#/c/${conversation.id}`,
      tag: conversation.id,
    };
    const rows = this.db
      .query<SubscriptionRow, []>("SELECT * FROM push_subscriptions")
      .all()
      .filter((row) => people.includes(row.human));
    for (const row of rows) void this.send(row, payload).catch(() => undefined);
  }

  /** The people `message` needs: see the file comment. */
  peopleFor(message: Message, conversation: Conversation, isHuman: (id: string) => boolean): string[] {
    if (message.deletedAt) return [];
    const mentioned = mentionedIds(message.text);
    const answered = message.quote?.from;
    return conversation.members.filter(
      (id) =>
        isHuman(id) &&
        id !== message.from &&
        conversation.notify?.[id] !== "none" &&
        (conversation.kind === "dm" || mentioned.includes(id) || answered === id)
    );
  }

  private checked(value: unknown): WebPushSubscription {
    const sub = value as Partial<WebPushSubscription> | undefined;
    const bad = (why: string): never => {
      throw new HttpError(400, `Not a push subscription: ${why}`);
    };
    if (!sub || typeof sub.endpoint !== "string" || typeof sub.keys?.p256dh !== "string" || typeof sub.keys.auth !== "string") {
      return bad("give {endpoint, keys: {p256dh, auth}}");
    }
    let url: URL;
    try {
      url = new URL(sub.endpoint);
    } catch {
      return bad("the endpoint is not an address");
    }
    if (!this.options.anyEndpoint && (url.protocol !== "https:" || !PUSH_HOSTS.some((host) => host.test(url.hostname)))) {
      bad(`${url.hostname} is not a browser's push service`);
    }
    const key = unb64url(sub.keys.p256dh);
    if (key.length !== 65 || key[0] !== 4) bad("p256dh is not a P-256 public key");
    if (unb64url(sub.keys.auth).length !== 16) bad("auth is not 16 bytes");
    return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
  }

  /** POSTs one encrypted notification; a device that is gone (404, 410) is forgotten. */
  private async send(row: SubscriptionRow, payload: PushPayload): Promise<number> {
    const body = encrypt(Buffer.from(JSON.stringify(payload)), unb64url(row.p256dh), unb64url(row.auth));
    const res = await fetch(row.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${this.jwt(new URL(row.endpoint).origin)}, k=${this.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(TTL_SECONDS),
        Urgency: "high",
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) {
      this.db.query("DELETE FROM push_subscriptions WHERE endpoint = ?1").run(row.endpoint);
    } else if (res.ok) {
      this.db.query("UPDATE push_subscriptions SET last_ok_at = ?2 WHERE endpoint = ?1").run(row.endpoint, Date.now());
    }
    return res.status;
  }

  /** The VAPID token for `audience` (the push service's origin), valid 12 hours. */
  private jwt(audience: string): string {
    const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = b64url(
      Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: this.options.subject }))
    );
    const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: this.privateKey, dsaEncoding: "ieee-p1363" });
    return `${header}.${claims}.${b64url(signature)}`;
  }
}

/** RFC 8291 message encryption, one aes128gcm record (RFC 8188), for the device's key `uaPublic` and `authSecret`. */
export function encrypt(plaintext: Buffer, uaPublic: Buffer, authSecret: Buffer): Buffer {
  const ecdh = createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02: the last (and only) record, no padding.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed]);
}

/** A message as a notification shows it: no markdown marks (`**`, `#`, `>`, a link's address), one line. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
