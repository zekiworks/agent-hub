// Every reader and writer is identified: a person by a passkey session, an agent by its machine account's approved
// agent token. Agent tokens the bus has not seen wait for a person's decision; file links carry a signed key.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isJsonObject, type AgentTokenInfo, type FileRef, type PostMessageResponse } from "@agent-bus/protocol";
import { AgentTokens, type BusServerHandle } from "@agent-bus/server";
import { agentSocketUrl, busFetch, identity, postJson, startBus, TEST_TOKEN } from "./helpers";

type Frame = { type: string } & Record<string, unknown>;

/** A raw WebSocket that queues frames and records how it closed. */
class Socket {
  readonly frames: Frame[] = [];
  private waiter: { type: string; resolve: (frame: Frame) => void } | null = null;
  private readonly closedWith = Promise.withResolvers<number>();
  readonly opened: Promise<void>;

  constructor(url: string, headers?: Record<string, string>) {
    const ws = new WebSocket(url, headers ? ({ headers } as never) : undefined);
    this.ws = ws;
    const opened = Promise.withResolvers<void>();
    this.opened = opened.promise;
    ws.addEventListener("open", () => opened.resolve(), { once: true });
    ws.addEventListener("error", () => opened.reject(new Error(`WebSocket ${url} failed`)), { once: true });
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      if (this.waiter?.type === frame.type) {
        const { resolve } = this.waiter;
        this.waiter = null;
        resolve(frame);
        return;
      }
      this.frames.push(frame);
    });
    ws.addEventListener("close", (event) => this.closedWith.resolve(event.code));
  }

  private readonly ws: WebSocket;

  /** Removes and returns the first frame of `type`, waiting for it if none is queued. */
  take(type: string): Promise<Frame> {
    const index = this.frames.findIndex((frame) => frame.type === type);
    if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0]!);
    const { promise, resolve } = Promise.withResolvers<Frame>();
    this.waiter = { type, resolve };
    return promise;
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** The close code, once the server (or `close`) closed the socket. */
  get closeCode(): Promise<number> {
    return this.closedWith.promise;
  }

  close(): void {
    this.ws.close();
  }
}

let dataDir = "";
let bus: BusServerHandle;
const sockets: Socket[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-access-test-"));
  bus = startBus({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol", "uma"] });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await bus.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const wsUrl = (route: string): string => `${bus.url.replace(/^http/, "ws")}${route}`;

function connect(url: string, headers?: Record<string, string>): Socket {
  const socket = new Socket(url, headers);
  sockets.push(socket);
  return socket;
}

/** An agent socket for `/tmp/x/<folder>` sending `token`. */
const agent = (folder: string, token = TEST_TOKEN): Socket =>
  connect(agentSocketUrl(bus, { host: "h1", harness: "raw", path: `/tmp/x/${folder}`, token }));

const get = (route: string, headers: Record<string, string> = {}): Promise<Response> => fetch(`${bus.url}${route}`, { headers });

async function errorOf(res: Response): Promise<string> {
  const body: unknown = await res.json();
  if (!isJsonObject(body) || typeof body.error !== "string") throw new Error(`No error in ${JSON.stringify(body)}`);
  return body.error;
}

/** A person's decision on the website: POST /api/agent-tokens/<ref>/(approve|deny) as carol. */
const decide = (ref: string, decision: "approve" | "deny"): Promise<Response> =>
  busFetch(bus, `/api/agent-tokens/${encodeURIComponent(ref)}/${decision}`, { method: "POST" }, "carol");

async function tokens(): Promise<AgentTokenInfo[]> {
  return ((await (await busFetch(bus, "/api/agent-tokens", {}, "carol")).json()) as { tokens: AgentTokenInfo[] }).tokens;
}

const tokenIdOf = (token: string): string => new Bun.CryptoHasher("sha256").update(token).digest("hex").slice(0, 12);

test("every read route needs a session or an approved agent token (401 otherwise); health and auth state stay open", async () => {
  await agent("alpha").take("joined");
  const { message } = (await (await postJson(bus, "/api/messages", { from: "carol", to: "@alpha", text: "hi" })).json()) as PostMessageResponse;
  const upload = await busFetch(bus, "/api/files?from=carol&name=a.txt", { method: "POST", body: "abc" }, "carol");
  const { file } = (await upload.json()) as { file: FileRef };
  const routes = [
    "/api/state",
    "/api/inbox?for=alpha",
    "/api/history?from=carol&to=@alpha",
    "/api/search?from=carol&q=hi",
    `/api/conversations/${message.conversationId}/messages`,
    `/api/messages/${message.seq}`,
    `/api/files/${file.id}`,
    "/api/resources",
  ];
  for (const route of routes) {
    expect([route, (await get(route)).status]).toEqual([route, 401]);
    expect([route, (await get(route, { "X-Agent-Token": "never-seen" })).status]).toEqual([route, 401]);
    expect([route, (await get(route, { Authorization: "Bearer made-up" })).status]).toEqual([route, 401]);
    expect([route, (await get(route, identity(bus, "carol"))).status]).toEqual([route, 200]);
    expect([route, (await get(route, identity(bus))).status]).toEqual([route, 200]);
  }
  expect((await get("/api/health")).status).toBe(200);
  expect((await get("/api/auth/state")).status).toBe(200);
  // Writes too: an agent's write without any identity.
  const anonymous = await fetch(`${bus.url}/api/messages`, { method: "POST", body: JSON.stringify({ from: "alpha", to: "@carol", text: "x" }) });
  expect(anonymous.status).toBe(401);
});

test("an unknown agent token waits (pending frame, 401 naming its code) and joins once a person approves it by code", async () => {
  const viewer = connect(wsUrl("/ws/viewer"), identity(bus, "carol"));
  await viewer.take("participants");
  const waiting = agent("newcomer", "new-machine");
  const code = String((await waiting.take("pending")).code);
  expect(code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  await viewer.take("agent-tokens");

  const refused = await get("/api/state", { "X-Agent-Token": "new-machine" });
  expect(refused.status).toBe(401);
  expect(await errorOf(refused)).toContain(code);
  expect(await tokens()).toContainEqual(expect.objectContaining({ id: tokenIdOf("new-machine"), state: "pending", code, host: "h1", agents: ["/tmp/x/newcomer"] }));

  // A second socket of the same machine waits under the same code.
  const second = agent("other", "new-machine");
  expect((await second.take("pending")).code).toBe(code);

  const approved = await decide(code.toLowerCase().replace("-", ""), "approve");
  expect(approved.status).toBe(200);
  expect(((await approved.json()) as { token: AgentTokenInfo }).token).toMatchObject({ state: "approved", decidedBy: "carol" });
  expect((await waiting.take("joined")).id).toBe("newcomer");
  expect((await second.take("joined")).id).toBe("other");
  await viewer.take("agent-tokens");
  expect((await get("/api/state", { "X-Agent-Token": "new-machine" })).status).toBe(200);
});

test("approveAgentToken (in-process) and a decision in the database (agent-bus approve) also admit waiting sockets", async () => {
  const inProcess = agent("one", "machine-one");
  await inProcess.take("pending");
  bus.approveAgentToken("machine-one");
  expect((await inProcess.take("joined")).id).toBe("one");

  // The CLI writes the decision into the bus's database; the bus applies it within a few seconds.
  const onHost = agent("two", "machine-two");
  const code = String((await onHost.take("pending")).code);
  const db = new Database(bus.dbPath);
  try {
    const store = new AgentTokens(db);
    store.decide(store.resolve(code)!, "approved", "someone on the host");
  } finally {
    db.close();
  }
  expect((await onHost.take("joined")).id).toBe("two");
});

test("no token: error frame and close 4401", async () => {
  const anonymous = connect(wsUrl(`/ws/agent?${new URLSearchParams({ host: "h1", harness: "raw", path: "/tmp/x/anon" })}`));
  expect(String((await anonymous.take("error")).error)).toContain("sends no agent token");
  expect(await anonymous.closeCode).toBe(4401);
});

test("a denied token is closed with 4403 and refused afterwards; revoking an approved one closes its agents", async () => {
  const waiting = agent("denied", "bad-machine");
  const code = String((await waiting.take("pending")).code);
  expect((await decide(code, "deny")).status).toBe(200);
  expect(String((await waiting.take("error")).error)).toContain("denied");
  expect(await waiting.closeCode).toBe(4403);
  expect(await agent("denied-again", "bad-machine").closeCode).toBe(4403);
  const denied = await get("/api/state", { "X-Agent-Token": "bad-machine" });
  expect(denied.status).toBe(401);
  expect(await errorOf(denied)).toContain("denied or revoked");

  bus.approveAgentToken("old-machine");
  const connected = agent("revoked", "old-machine");
  await connected.take("joined");
  expect((await get("/api/state", { "X-Agent-Token": "old-machine" })).status).toBe(200);
  expect((await decide(tokenIdOf("old-machine"), "deny")).status).toBe(200);
  expect(String((await connected.take("error")).error)).toContain("revoked");
  expect(await connected.closeCode).toBe(4403);
  expect((await get("/api/state", { "X-Agent-Token": "old-machine" })).status).toBe(401);
  expect((await decide("ZZZ-ZZZ", "approve")).status).toBe(404);
});

test("only a signed-in person sees and decides agent tokens (an agent token gets 403)", async () => {
  expect((await get("/api/agent-tokens", identity(bus))).status).toBe(403);
  expect((await busFetch(bus, `/api/agent-tokens/${tokenIdOf(TEST_TOKEN)}/deny`, { method: "POST" })).status).toBe(403);
  expect((await get("/api/agent-tokens")).status).toBe(401);
  expect((await get("/api/agent-tokens", identity(bus, "uma"))).status).toBe(200);
  // The test token is still allowed.
  expect((await get("/api/state", identity(bus))).status).toBe(200);
});

test("a viewer gets nothing before it signs in; a bad auth frame closes it (4401); a session or agent token frame signs it in", async () => {
  const silent = connect(wsUrl("/ws/viewer"));
  await silent.opened;
  const bySession = connect(wsUrl("/ws/viewer"));
  await bySession.opened;
  bySession.send({ type: "auth", session: bus.signIn("uma") });
  expect(await bySession.take("participants")).toMatchObject({ participants: [{ id: "carol" }, { id: "uma" }] });
  const byToken = connect(wsUrl("/ws/viewer"));
  await byToken.opened;
  byToken.send({ type: "auth", agentToken: TEST_TOKEN });
  await byToken.take("participants");

  await agent("alpha").take("joined");
  await bySession.take("participants");
  await postJson(bus, "/api/messages", { from: "carol", to: "@all", text: "live" });
  expect(await bySession.take("message")).toMatchObject({ message: { text: "live" } });
  expect(await byToken.take("message")).toMatchObject({ message: { text: "live" } });
  // Proving the absence of frames needs a moment: nothing would arrive to await. The signed-in viewers got the same
  // frames already, so anything sent to the silent one would be in flight on the same local server.
  await Bun.sleep(50);
  expect(silent.frames).toEqual([]);

  silent.send({ type: "auth", session: "made-up" });
  expect((await silent.take("error")).type).toBe("error");
  expect(await silent.closeCode).toBe(4401);
  const pendingToken = connect(wsUrl("/ws/viewer"));
  await pendingToken.opened;
  pendingToken.send({ type: "auth", agentToken: "never-approved" });
  expect(await pendingToken.closeCode).toBe(4401);
});

test("file links: a valid key reads the file without a header; a tampered or expired key does not", async () => {
  const upload = await busFetch(bus, "/api/files?from=carol&name=a.txt", { method: "POST", body: "secret bytes" }, "carol");
  const { file } = (await upload.json()) as { file: FileRef };
  const state = (await (await get("/api/auth/state", identity(bus, "carol"))).json()) as { fileKey?: string };
  const key = state.fileKey!;
  expect(key).toBeString();
  expect("fileKey" in ((await (await get("/api/auth/state")).json()) as object)).toBe(false);

  const withKey = (k: string) => get(`/api/files/${file.id}?k=${encodeURIComponent(k)}`);
  const ok = await withKey(key);
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("secret bytes");
  const [expires, human, signature] = key.split(".") as [string, string, string];
  expect((await withKey(`${expires}.uma.${signature}`)).status).toBe(401);
  expect((await withKey(`${Number(expires) + 1}.${human}.${signature}`)).status).toBe(401);
  expect((await withKey(`${expires}.${human}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`)).status).toBe(401);
  // Expired but properly signed (with the bus's own secret): refused.
  const db = new Database(bus.dbPath, { readonly: true });
  const secret = db.query<{ secret: string }, []>("SELECT secret FROM auth_secret").get()!.secret;
  db.close();
  const past = Date.now() - 1000;
  const expired = `${past}.${human}.${createHmac("sha256", Buffer.from(secret, "base64url")).update(`${past}.${human}`).digest("base64url")}`;
  expect((await withKey(expired)).status).toBe(401);
  // A key only opens files: other routes still need a header.
  expect((await get(`/api/state?k=${encodeURIComponent(key)}`)).status).toBe(401);
});

test("tokens agents had bound to their ids before approval existed are approved at startup", async () => {
  bus.approveAgentToken("legacy-machine");
  const legacy = agent("legacy", "legacy-machine");
  await legacy.take("joined");
  await postJson(bus, "/api/messages", { from: "carol", to: "@legacy", text: "stay" }); // in a group: kept on logoff
  legacy.close();
  await legacy.closeCode;
  await bus.stop();
  const db = new Database(path.join(dataDir, "message-bus.sqlite"));
  db.exec("DELETE FROM agent_tokens");
  db.close();

  bus = startBus({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol", "uma"] });
  expect(await tokens()).toContainEqual(
    expect.objectContaining({ id: tokenIdOf("legacy-machine"), state: "approved", agents: ["legacy"], decidedBy: "joined before approval existed" })
  );
  expect((await get("/api/state", { "X-Agent-Token": "legacy-machine" })).status).toBe(200);
  expect((await agent("legacy", "legacy-machine").take("joined")).id).toBe("legacy");
});
