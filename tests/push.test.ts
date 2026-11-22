// Web Push (Ümit #13927, #13934): a person's subscribed device is told of the messages that need them (a DM, a mention,
// a reply to them), encrypted for that device and signed with the bus's VAPID key; nothing else, never their own.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify, type ECDH } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PostMessageResponse, PushKeyResponse, PushPayload } from "@agent-bus/protocol";
import type { BusServerHandle } from "@agent-bus/server";
import { getJson, postJson, startBus, viewerSocket } from "./helpers";

interface Pushed {
  headers: Headers;
  body: Buffer;
}

let dataDir = "";
let bus: BusServerHandle;
let service: ReturnType<typeof Bun.serve>;
let pushed: Pushed[] = [];
let answer = 201;
let device: { ecdh: ECDH; auth: Buffer; endpoint: string };

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-push-test-"));
  pushed = [];
  answer = 201;
  service = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      pushed.push({ headers: req.headers, body: Buffer.from(await req.arrayBuffer()) });
      return new Response(null, { status: answer });
    },
  });
  bus = startBus({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol", "uma"], pushAnyEndpoint: true });
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  device = { ecdh, auth: randomBytes(16), endpoint: `http://127.0.0.1:${service.port}/push/carol-phone` };
});

afterEach(async () => {
  await bus.stop();
  service.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

async function subscribe(): Promise<void> {
  const res = await postJson(bus, "/api/push/subscribe", {
    from: "carol",
    subscription: {
      endpoint: device.endpoint,
      keys: { p256dh: device.ecdh.getPublicKey().toString("base64url"), auth: device.auth.toString("base64url") },
    },
  });
  expect(res.status).toBe(200);
}

async function send(body: Record<string, unknown>): Promise<PostMessageResponse> {
  const res = await postJson(bus, "/api/messages", body);
  if (!res.ok) throw new Error(`POST /api/messages ${res.status}: ${await res.text()}`);
  return (await res.json()) as PostMessageResponse;
}

/** What the device decrypts (RFC 8291, aes128gcm). */
function decrypt(body: Buffer): PushPayload {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const sealed = body.subarray(21 + idLength);
  const shared = device.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), device.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, device.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return JSON.parse(plain.subarray(0, -1).toString()) as PushPayload;
}

const settle = () => Bun.sleep(150);

test("a DM, a mention and a reply reach the person's device, encrypted for it and signed by the bus; nothing else does", async () => {
  await subscribe();
  const project = await send({ from: "carol", to: "@@plans", text: "starting the plan" });
  await send({ from: "uma", to: "@@plans", text: "joining, no names here" });
  await settle();
  expect(pushed).toHaveLength(0); // her own message, and one that doesn't need her

  const asked = await send({ from: "uma", conversationId: project.conversation.id, text: "@carol can you look?" });
  const dm = await send({ from: "uma", to: "@carol", text: "a word in private" });
  const answered = await send({ from: "uma", replyToSeq: project.message.seq, text: "agreed" });
  await settle();
  expect(pushed).toHaveLength(3);
  const [mention, inDm, reply] = pushed.map((p) => decrypt(p.body));
  const tag = (m: PostMessageResponse) => `${m.conversation.id}-${m.message.seq}`;
  expect(mention).toEqual({ title: "@uma · @@plans", body: "@carol can you look?", url: `/?n=${asked.message.seq}#/c/${project.conversation.id}`, tag: tag(asked) });
  expect(inDm).toMatchObject({ title: "@uma", body: "a word in private", url: `/?n=${dm.message.seq}#/c/${dm.conversation.id}` });
  // Two in one conversation keep their own tags: Safari shows nothing for one that replaces another (Ümit #14070).
  expect(reply).toMatchObject({ body: "agreed", tag: tag(answered) });
  expect(reply?.tag).not.toBe(mention?.tag);

  // Headers as push services want them, and a VAPID token the bus's public key verifies.
  const headers = pushed[0]!.headers;
  expect(headers.get("content-encoding")).toBe("aes128gcm");
  expect(headers.get("ttl")).toBe("86400");
  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(headers.get("authorization") ?? "") ?? [];
  const { publicKey } = await getJson<PushKeyResponse>(bus, "/api/push/key", "carol");
  expect(key).toBe(publicKey);
  const [h, c, s] = token!.split(".");
  expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toMatchObject({ aud: `http://127.0.0.1:${service.port}` });
  const raw = Buffer.from(publicKey, "base64url");
  const jwk = { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") };
  const ok = verify("sha256", Buffer.from(`${h}.${c}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"));
  expect(ok).toBe(true);
});

test("a muted conversation stays quiet; a device the push service says is gone is forgotten; unsubscribing stops them", async () => {
  await subscribe();
  const project = await send({ from: "carol", to: "@@quiet", text: "start" });
  await send({ from: "uma", to: "@@quiet", text: "joining" });
  await postJson(bus, `/api/conversations/${project.conversation.id}/notify`, { from: "carol", level: "none" });
  await send({ from: "uma", conversationId: project.conversation.id, text: "@carol muted here" });
  await settle();
  expect(pushed).toHaveLength(0);

  answer = 410;
  await send({ from: "uma", to: "@carol", text: "one" });
  await settle();
  await send({ from: "uma", to: "@carol", text: "two" });
  await settle();
  expect(pushed).toHaveLength(1);

  answer = 201;
  await subscribe();
  await postJson(bus, "/api/push/unsubscribe", { from: "carol", endpoint: device.endpoint });
  await send({ from: "uma", to: "@carol", text: "three" });
  await settle();
  expect(pushed).toHaveLength(1);
});

test("no notification while the person has Agent Hub in front; back in the background they come again (Ümit #14595)", async () => {
  await subscribe();
  const page = viewerSocket(bus, "carol");
  await new Promise((resolve) => page.addEventListener("open", resolve, { once: true }));
  const say = async (visible: boolean) => {
    page.send(JSON.stringify({ type: "visible", visible }));
    await Bun.sleep(50);
  };
  await say(true);
  await send({ from: "uma", to: "@carol", text: "seen on the open page" });
  await settle();
  expect(pushed).toHaveLength(0);
  await say(false);
  await send({ from: "uma", to: "@carol", text: "the app is in the background" });
  await settle();
  expect(pushed).toHaveLength(1);
  page.close();
});

test("only people subscribe, only to a browser's push service, with a real key", async () => {
  const strict = startBus({ host: "127.0.0.1", port: 0, dataDir: mkdtempSync(path.join(tmpdir(), "mb-push-test-")), humans: ["carol"] });
  try {
    const keys = { p256dh: device.ecdh.getPublicKey().toString("base64url"), auth: device.auth.toString("base64url") };
    const tryWith = (endpoint: string, k = keys, from = "carol") =>
      postJson(strict, "/api/push/subscribe", { from, subscription: { endpoint, keys: k } }).then((r) => r.status);
    expect(await tryWith("http://169.254.169.254/latest")).toBe(400);
    expect(await tryWith("https://web.push.apple.com/abc", { ...keys, p256dh: "AAAA" })).toBe(400);
    expect(await tryWith("https://web.push.apple.com/abc", keys, "some-agent")).toBe(403);
    expect(await tryWith("https://web.push.apple.com/abc")).toBe(200);
  } finally {
    await strict.stop();
  }
});

test("a notification's text has no markdown marks (Ümit #14043)", async () => {
  const { plainText } = await import("../packages/server/src/push");
  expect(plainText("**hide ▴** while the agents show, see [the notes](https://x.y/z)\n\n> quoted\n- item `code`")).toBe(
    "hide ▴ while the agents show, see the notes quoted item code"
  );
});

test("what a person does with agents' messages is kept only for people who said yes, never the text (Ümit #13977)", async () => {
  const { readFileSync, existsSync, writeFileSync } = await import("node:fs");
  const ws = new WebSocket(`${bus.url.replace(/^http/, "ws")}/ws/agent?${new URLSearchParams({ token: (await import("./helpers")).TEST_TOKEN, host: "h1", harness: "omp", path: "/tmp/x/alpha" })}`);
  await new Promise((r) => ws.addEventListener("message", r, { once: true }));
  const sent = await send({ from: "alpha", to: "@carol", text: "secret build result", wake: [] });
  const mine = await send({ from: "carol", to: "@uma", text: "a person's message" });
  const file = path.join(dataDir, "attention.jsonl");
  const report = (from: string, events: unknown[]) => postJson(bus, "/api/attention", { from, events });
  // Nobody listed yet: nothing kept.
  expect(await (await report("carol", [{ seq: sent.message.seq, action: "seen", ms: 4000 }])).json()).toEqual({ ok: true, kept: 0 });
  expect(existsSync(file)).toBe(false);
  writeFileSync(path.join(dataDir, "attention-people.txt"), "carol\n");
  const res = await report("carol", [
    { seq: sent.message.seq, action: "seen", ms: 4000.4 },
    { seq: sent.message.seq, action: "replied" },
    { seq: mine.message.seq, action: "seen" }, // a person's message: not part of it
    { seq: sent.message.seq, action: "deleted-it" }, // no such action
  ]);
  expect(await res.json()).toEqual({ ok: true, kept: 2 });
  // uma may not read carol's DM with alpha.
  expect(await (await report("uma", [{ seq: sent.message.seq, action: "seen" }])).json()).toEqual({ ok: true, kept: 0 });
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map(({ at: _, ...rest }) => rest)).toEqual([
    { person: "carol", seq: sent.message.seq, conversationId: sent.conversation.id, from: "alpha", action: "seen", ms: 4000 },
    { person: "carol", seq: sent.message.seq, conversationId: sent.conversation.id, from: "alpha", action: "replied" },
  ]);
  expect(readFileSync(file, "utf8")).not.toContain("secret");
  ws.close();
});
