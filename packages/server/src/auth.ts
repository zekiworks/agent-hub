// Human authentication with passkeys: invites from the shell, passkey enrollment and sign-in, and sessions (a
// random token the website keeps in localStorage and sends as `Authorization: Bearer`, stored hashed here). Not a
// cookie: browsers send cookies to every port of a host, so a cookie would also reach other services on the bus's
// host name. Every person reading or writing on the bus is signed in; their messages carry `verified`.
import type { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  b64url,
  SUPPORTED_ALGS,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
  type RelyingParty,
  type StoredCredential,
} from "./webauthn";

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const INVITE_MS = 10 * MIN;
const CHALLENGE_MS = 5 * MIN;
const SESSION_MS = 30 * DAY;
/** File links on the website carry a key (an <img> cannot send the session header); it lasts this long. */
const FILE_KEY_MS = DAY;
/** A device link (QR code from a signed-in browser) works once, this soon. */
const LINK_MS = 2 * MIN;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_humans (
  human TEXT PRIMARY KEY,
  user_handle TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_credentials (
  id TEXT PRIMARY KEY,
  human TEXT NOT NULL,
  public_key TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL,
  user_verified INTEGER NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  human TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_invites (
  token_hash TEXT PRIMARY KEY,
  human TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_links (
  token_hash TEXT PRIMARY KEY,
  human TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_secret (
  secret TEXT NOT NULL
);
`;

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");
const token = (): string => b64url(new Uint8Array(randomBytes(32)));

/** Creates the auth tables (also used by `agent-bus invite`, which writes to the database directly). */
export function ensureAuthSchema(db: Database): void {
  db.exec(SCHEMA);
}

/** A one-time enrollment link token for `human`, valid 10 minutes. Only someone with the bus's database can make one. */
export function createInvite(db: Database, human: string, now = Date.now()): string {
  ensureAuthSchema(db);
  const t = token();
  db.query("INSERT INTO auth_invites (token_hash, human, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)").run(hash(t), human, now, now + INVITE_MS);
  return t;
}

export interface AuthOptions {
  rpId: string;
  /** Exact website origins; a function because the port is known only once the server listens. */
  origins: () => string[];
  humans: readonly string[];
  now?: () => number;
}

interface CredentialRow {
  id: string;
  human: string;
  public_key: string;
  alg: number;
  sign_count: number;
  user_verified: number;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

type Challenge = { kind: "register"; human: string; invite: string; expires: number } | { kind: "login"; expires: number };

export interface CredentialInfo {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export class HumanAuth {
  private readonly challenges = new Map<string, Challenge>();
  private readonly now: () => number;
  /** Signs file keys; made once per database. */
  private readonly secret: Buffer;

  constructor(
    private readonly db: Database,
    private readonly options: AuthOptions
  ) {
    this.now = options.now ?? Date.now;
    ensureAuthSchema(db);
    let row = db.query<{ secret: string }, []>("SELECT secret FROM auth_secret").get();
    if (!row) {
      row = { secret: b64url(new Uint8Array(randomBytes(32))) };
      db.query("INSERT INTO auth_secret (secret) VALUES (?1)").run(row.secret);
    }
    this.secret = Buffer.from(row.secret, "base64url");
  }

  private rp(): RelyingParty {
    return { rpId: this.options.rpId, origins: this.options.origins() };
  }

  private newChallenge(entry: Challenge): string {
    const now = this.now();
    for (const [key, value] of this.challenges) if (value.expires < now) this.challenges.delete(key);
    const challenge = token();
    this.challenges.set(challenge, entry);
    return challenge;
  }

  /** The challenge a client response answers (each is single-use). */
  private takeChallenge(clientDataJSON: unknown): [string, Challenge] {
    if (typeof clientDataJSON !== "string") throw new AuthError(400, "credential.response.clientDataJSON is missing");
    let challenge: unknown;
    try {
      challenge = (JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as { challenge?: unknown }).challenge;
    } catch {
      throw new AuthError(400, "clientDataJSON is not JSON");
    }
    const entry = typeof challenge === "string" ? this.challenges.get(challenge) : undefined;
    if (!entry || entry.expires < this.now()) throw new AuthError(400, "Unknown or expired challenge; start again");
    this.challenges.delete(challenge as string);
    return [challenge as string, entry];
  }

  private inviteHuman(invite: string): string {
    const row = this.db
      .query<{ human: string; expires_at: number; used_at: number | null }, [string]>("SELECT human, expires_at, used_at FROM auth_invites WHERE token_hash = ?1")
      .get(hash(invite));
    if (!row || row.used_at !== null || row.expires_at < this.now()) throw new AuthError(403, "This invite link is unknown, used or expired; ask for a new one (agent-bus invite <name>)");
    if (!this.options.humans.includes(row.human)) throw new AuthError(403, `@${row.human} is not a human on this bus`);
    return row.human;
  }

  private userHandle(human: string): string {
    const row = this.db.query<{ user_handle: string }, [string]>("SELECT user_handle FROM auth_humans WHERE human = ?1").get(human);
    if (row) return row.user_handle;
    const handle = b64url(new Uint8Array(randomBytes(16)));
    this.db.query("INSERT INTO auth_humans (human, user_handle) VALUES (?1, ?2)").run(human, handle);
    return handle;
  }

  /** PublicKeyCredentialCreationOptions (binary fields as base64url) for the invite's human. */
  registerOptions(invite: string): Record<string, unknown> {
    const human = this.inviteHuman(invite);
    const challenge = this.newChallenge({ kind: "register", human, invite, expires: this.now() + CHALLENGE_MS });
    const existing = this.db.query<{ id: string }, [string]>("SELECT id FROM auth_credentials WHERE human = ?1").all(human);
    return {
      challenge,
      rp: { id: this.options.rpId, name: "Agent Bus" },
      user: { id: this.userHandle(human), name: human, displayName: human },
      pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: "public-key", alg })),
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
      attestation: "none",
      excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.id })),
      timeout: CHALLENGE_MS,
    };
  }

  /** Stores the new passkey, uses up the invite and signs the human in; returns the session token. */
  registerVerify(body: { invite?: unknown; credential?: { response?: Record<string, unknown> }; label?: unknown }, label: string): { human: string; token: string } {
    const response = body.credential?.response ?? {};
    const [challenge, entry] = this.takeChallenge(response.clientDataJSON);
    if (entry.kind !== "register" || entry.invite !== body.invite) throw new AuthError(400, "This challenge is not for this invite");
    this.inviteHuman(entry.invite);
    let credential: StoredCredential;
    try {
      credential = verifyRegistration(this.rp(), challenge, {
        clientDataJSON: String(response.clientDataJSON),
        attestationObject: String(response.attestationObject ?? ""),
      });
    } catch (error) {
      throw new AuthError(400, `Passkey not accepted: ${(error as Error).message}`);
    }
    const now = this.now();
    this.db.transaction(() => {
      this.db.query("UPDATE auth_invites SET used_at = ?2 WHERE token_hash = ?1").run(hash(entry.invite), now);
      this.db
        .query(
          `INSERT INTO auth_credentials (id, human, public_key, alg, sign_count, user_verified, label, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        )
        .run(credential.id, entry.human, credential.publicKey, credential.alg, credential.signCount, credential.userVerified ? 1 : 0, (typeof body.label === "string" && body.label.trim()) || label, now);
    })();
    return { human: entry.human, token: this.newSession(entry.human, label) };
  }

  /**
   * PublicKeyCredentialRequestOptions. With `human` (the website's profile), the request names that human's
   * passkeys: Chrome on a Mac finds passkeys in its own profile only when they are named, and otherwise offers just a
   * phone (QR code) or a security key. Without it: discoverable credentials, any passkey for this bus.
   */
  loginOptions(human?: string): Record<string, unknown> {
    const challenge = this.newChallenge({ kind: "login", expires: this.now() + CHALLENGE_MS });
    const ids = human
      ? this.db.query<{ id: string }, [string]>("SELECT id FROM auth_credentials WHERE human = ?1").all(human).map((r) => r.id)
      : [];
    const allowCredentials = ids.map((id) => ({ type: "public-key", id, transports: ["internal", "hybrid"] }));
    return { challenge, rpId: this.options.rpId, userVerification: "preferred", timeout: CHALLENGE_MS, allowCredentials };
  }

  loginVerify(body: { credential?: { id?: unknown; response?: Record<string, unknown> } }, label: string): { human: string; token: string } {
    const response = body.credential?.response ?? {};
    const [challenge, entry] = this.takeChallenge(response.clientDataJSON);
    if (entry.kind !== "login") throw new AuthError(400, "This challenge is not for signing in");
    const id = body.credential?.id;
    const row = typeof id === "string" ? this.db.query<CredentialRow, [string]>("SELECT * FROM auth_credentials WHERE id = ?1").get(id) : null;
    if (!row) throw new AuthError(403, "Unknown passkey (removed, or made for another bus)");
    if (typeof response.userHandle === "string" && response.userHandle !== "" && response.userHandle !== this.userHandle(row.human)) {
      throw new AuthError(403, "The passkey's user does not match");
    }
    let signCount: number;
    try {
      signCount = verifyAssertion(
        this.rp(),
        challenge,
        { id: row.id, publicKey: row.public_key, alg: row.alg, signCount: row.sign_count, userVerified: row.user_verified === 1 },
        { clientDataJSON: String(response.clientDataJSON), authenticatorData: String(response.authenticatorData ?? ""), signature: String(response.signature ?? "") }
      );
    } catch (error) {
      if (error instanceof WebAuthnError) throw new AuthError(403, `Sign-in refused: ${error.message}`);
      throw error;
    }
    this.db.query("UPDATE auth_credentials SET sign_count = ?2, last_used_at = ?3 WHERE id = ?1").run(row.id, signCount, this.now());
    return { human: row.human, token: this.newSession(row.human, label) };
  }

  /**
   * A session for `human` without a passkey ceremony. Not reachable over the network: for tests and for programs
   * embedding the server, which hold the database anyway.
   */
  signIn(human: string, label: string): string {
    if (!this.options.humans.includes(human)) throw new AuthError(400, `@${human} is not a human on this bus`);
    return this.newSession(human, label);
  }

  private newSession(human: string, label: string): string {
    const now = this.now();
    const t = token();
    this.db
      .query("INSERT INTO auth_sessions (token_hash, human, label, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?4)")
      .run(hash(t), human, label.slice(0, 120), now, now + SESSION_MS);
    return t;
  }

  /** The signed-in human of a request (`Authorization: Bearer <session>`), if any. */
  humanOf(req: Request): string | undefined {
    const t = sessionToken(req);
    return t ? this.humanOfSession(t) : undefined;
  }

  /** The human a session token belongs to, if it is current. Sessions slide: each use extends them to 30 days. */
  humanOfSession(t: string): string | undefined {
    const row = this.db.query<{ human: string; expires_at: number; last_seen_at: number }, [string]>("SELECT human, expires_at, last_seen_at FROM auth_sessions WHERE token_hash = ?1").get(hash(t));
    const now = this.now();
    if (!row || row.expires_at < now) return undefined;
    if (now - row.last_seen_at > 60 * MIN) {
      this.db.query("UPDATE auth_sessions SET last_seen_at = ?2, expires_at = ?3 WHERE token_hash = ?1").run(hash(t), now, now + SESSION_MS);
    }
    return row.human;
  }

  /** A key for the website's file links, valid FILE_KEY_MS: `<expiry>.<human>.<signature>`. */
  fileKey(human: string): string {
    const expires = this.now() + FILE_KEY_MS;
    return `${expires}.${human}.${this.sign(`${expires}.${human}`)}`;
  }

  /** Whether `key` is a file key this bus made, not expired, for a human who still has a session. */
  checkFileKey(key: string): boolean {
    const [expires, human, signature] = key.split(".");
    if (!expires || !human || !signature || Number(expires) < this.now()) return false;
    const expected = Buffer.from(this.sign(`${expires}.${human}`));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
    return this.db.query("SELECT 1 FROM auth_sessions WHERE human = ?1 AND expires_at > ?2").get(human, this.now()) !== null;
  }

  private sign(text: string): string {
    return createHmac("sha256", this.secret).update(text).digest("base64url");
  }

  logout(req: Request): void {
    const t = sessionToken(req);
    if (t) this.db.query("DELETE FROM auth_sessions WHERE token_hash = ?1").run(hash(t));
  }

  credentials(human: string): CredentialInfo[] {
    return this.db
      .query<CredentialRow, [string]>("SELECT * FROM auth_credentials WHERE human = ?1 ORDER BY created_at")
      .all(human)
      .map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }

  /** Removes one of the human's passkeys and ends all their sessions (a lost device may hold one). */
  removeCredential(human: string, id: string): void {
    const result = this.db.query("DELETE FROM auth_credentials WHERE id = ?1 AND human = ?2").run(id, human);
    if (result.changes === 0) throw new AuthError(404, "No such passkey of yours");
    this.db.query("DELETE FROM auth_sessions WHERE human = ?1").run(human);
  }

  /**
   * A one-time code that signs another device in as `human` (shown as a QR code by a browser where `human` is signed
   * in), valid LINK_MS. Whoever holds it within that time becomes `human` on that device, like a pairing code.
   */
  createLink(human: string): { code: string; expiresAt: number } {
    const now = this.now();
    const code = token();
    this.db.query("DELETE FROM auth_links WHERE expires_at < ?1").run(now);
    this.db.query("INSERT INTO auth_links (token_hash, human, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)").run(hash(code), human, now, now + LINK_MS);
    return { code, expiresAt: now + LINK_MS };
  }

  /** Uses up a device link and signs this device in; returns the session token. */
  redeemLink(code: string, label: string): { human: string; token: string } {
    const now = this.now();
    const row = this.db
      .query<{ human: string; expires_at: number; used_at: number | null }, [string]>("SELECT human, expires_at, used_at FROM auth_links WHERE token_hash = ?1")
      .get(hash(code));
    if (!row || row.used_at !== null || row.expires_at < now) throw new AuthError(403, "This code is unknown, used or expired; show a new one on a signed-in device");
    if (!this.options.humans.includes(row.human)) throw new AuthError(403, `@${row.human} is not a human on this bus`);
    this.db.query("UPDATE auth_links SET used_at = ?2 WHERE token_hash = ?1").run(hash(code), now);
    return { human: row.human, token: this.newSession(row.human, label) };
  }

  /** The devices `human` is signed in on (sessions), newest first; `current` is the one `req` comes from. */
  sessions(human: string, req: Request): Array<{ id: string; label: string; createdAt: number; lastSeenAt: number; current: boolean }> {
    const mine = sessionToken(req);
    const own = mine ? hash(mine) : "";
    return this.db
      .query<{ token_hash: string; label: string; created_at: number; last_seen_at: number }, [string, number]>(
        "SELECT token_hash, label, created_at, last_seen_at FROM auth_sessions WHERE human = ?1 AND expires_at > ?2 ORDER BY last_seen_at DESC"
      )
      .all(human, this.now())
      .map((r) => ({ id: r.token_hash.slice(0, 12), label: r.label, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.token_hash === own }));
  }

  /** Signs one of `human`'s devices out (its session id is the hash prefix `sessions` lists). */
  endSession(human: string, id: string): void {
    if (!/^[0-9a-f]{12}$/.test(id)) throw new AuthError(400, "Not a session id");
    const result = this.db.query("DELETE FROM auth_sessions WHERE human = ?1 AND substr(token_hash, 1, 12) = ?2").run(human, id);
    if (result.changes === 0) throw new AuthError(404, "No such device of yours");
  }

  enrolled(): string[] {
    return this.db.query<{ human: string }, []>("SELECT DISTINCT human FROM auth_credentials ORDER BY human").all().map((r) => r.human);
  }
}

function sessionToken(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  return /^Bearer (\S+)$/.exec(header ?? "")?.[1];
}
