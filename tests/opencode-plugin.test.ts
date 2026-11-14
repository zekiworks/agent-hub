import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { BusServerHandle } from "@agent-bus/server";
import type { Participant, PostMessageResponse, ViewerServerFrame } from "@agent-bus/protocol";
import plugin, { type Context } from "../packages/opencode-plugin/src/index";
import * as installer from "../packages/opencode-plugin/scripts/install";
import { harness } from "../packages/cli/src/harnesses";
import type { MessageBusToolParams } from "../packages/client/src/tool";
import { getJson, postJson, startBus, viewerSocket } from "./helpers";

type Hook = (event: never) => void | Promise<void>;
type Info = Awaited<ReturnType<Context["session"]["get"]>>;
type Synthetic = Parameters<Context["session"]["synthetic"]>[0];
type Tool = { execute(input: unknown, context: { sessionID: string }): Promise<{ content: string }> };

/** A V2 server, shared across locations and sessions, with real bus sockets and a fake native inbox. */
class FakeOpenCode {
  readonly sessions = new Map<string, Info>();
  readonly injected: Synthetic[] = [];
  readonly hooks = new Map<string, Hook>();
  readonly queue: unknown[] = [];
  readonly tools = new Map<string, Tool>();
  private changed = Promise.withResolvers<void>();
  private cleanup?: () => void | Promise<void>;
  failDelivery = false;
  readonly attempted: Synthetic[] = [];
  options: Record<string, unknown> = {};

  constructor(readonly directory: string) {}

  add(sessionID: string, directory = this.directory, parentID?: string): void {
    this.sessions.set(sessionID, { id: sessionID, location: { directory }, parentID, time: {} } as Info);
  }

  async start(entry = plugin): Promise<void> {
    const registration = { dispose: async () => {} };
    const hook = (domain: string) => async (name: string, handler: Hook) => {
      this.hooks.set(`${domain}:${name}`, handler);
      return registration;
    };
    const self = this;
    const ctx = {
      location: { directory: this.directory },
      options: this.options,
      session: {
        get: async ({ sessionID }: { sessionID: string }) => this.sessions.get(sessionID)!,
        synthetic: async (input: Synthetic) => {
          this.attempted.push(input);
          if (this.failDelivery) throw new Error("inbox unavailable");
          this.injected.push(input);
          return {};
        },
        hook: hook("session"),
      },
      tool: {
        hook: hook("tool"),
        transform: async (transform: (editor: { add(tool: Tool & { name: string }): void }) => void) => {
          transform({ add: (tool) => this.tools.set(tool.name, tool) });
          return registration;
        },
      },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          signal.addEventListener("abort", () => self.changed.resolve(), { once: true });
          while (!signal.aborted) {
            while (self.queue.length) yield self.queue.shift();
            if (signal.aborted) break;
            await self.changed.promise;
            self.changed = Promise.withResolvers<void>();
          }
        },
      },
    } as unknown as Context;
    this.cleanup = await entry.setup(ctx) || undefined;
  }

  event(type: string, sessionID: string, data: object = {}): void {
    this.queue.push({ type, created: Date.now(), data: { sessionID, ...data } });
    this.changed.resolve();
  }

  async hook(name: string, event: object): Promise<void> {
    await this.hooks.get(name)?.(event as never);
  }

  async prompt(sessionID: string, text = "hello"): Promise<void> {
    await this.hook("session:prompt", { sessionID, messageID: crypto.randomUUID(), prompt: { text } });
  }

  async context(sessionID: string, texts: string[]): Promise<void> {
    await this.hook("session:context", { sessionID, messages: texts.map((text) => ({ role: "user", content: [{ type: "text", text }] })) });
  }

  run(sessionID: string, input: MessageBusToolParams) {
    return this.tools.get("message-bus")!.execute(input, { sessionID });
  }

  async stop(): Promise<void> {
    await this.cleanup?.();
    this.cleanup = undefined;
  }
}

let dir: string;
let bus: BusServerHandle;
const servers: FakeOpenCode[] = [];
const sockets: WebSocket[] = [];

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

async function participants(): Promise<Participant[]> {
  return (await getJson<{ participants: Participant[] }>(bus, "/api/state")).participants;
}

async function active(id: string): Promise<Participant> {
  await until(async () => (await participants()).some((p) => p.id === id && p.online));
  return (await participants()).find((p) => p.id === id)!;
}

async function start(folder = "alpha"): Promise<FakeOpenCode> {
  const server = new FakeOpenCode(path.join(dir, folder));
  servers.push(server);
  await server.start();
  server.add("s1");
  await server.prompt("s1");
  await active(folder);
  return server;
}

async function post(from: string, to: string, text: string): Promise<PostMessageResponse> {
  const res = await postJson(bus, "/api/messages", { from, to, text });
  expect(res.status).toBe(200);
  return res.json() as Promise<PostMessageResponse>;
}

beforeEach(() => {
  const tmp = path.join(tmpdir(), "opencode");
  mkdirSync(tmp, { recursive: true });
  dir = mkdtempSync(path.join(tmp, "agent-hub-test-"));
  bus = startBus({ host: "127.0.0.1", port: 0, dataDir: path.join(dir, "bus"), humans: ["carol"] });
  process.env.AGENT_BUS_URL = bus.url;
  process.env.AGENT_BUS_JOIN_FROM_TMP = "1";
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const socket of sockets.splice(0)) socket.close();
  await bus.stop();
  delete process.env.AGENT_BUS_URL;
  delete process.env.AGENT_BUS_JOIN_FROM_TMP;
  rmSync(dir, { recursive: true, force: true });
});

test("native inbox wakes/steers direct messages, keeps agent broadcasts quiet, and marks seen only at model dispatch", async () => {
  const server = await start();
  const beta = new FakeOpenCode(path.join(dir, "beta"));
  servers.push(beta);
  await beta.start();
  beta.add("beta");
  await beta.prompt("beta");
  await active("beta");

  const { message } = await post("carol", "@alpha", "check logs");
  await until(() => server.injected.length === 1);
  expect(server.injected[0]).toMatchObject({
    sessionID: "s1", delivery: "steer", resume: true, metadata: { source: "agent-bus" },
  });
  expect(server.injected[0]!.text).toContain("@carol (verified)");
  const receipt = async () => (await getJson<{ message: typeof message }>(bus, `/api/messages/${message.seq}`, "carol")).message.receipts[0]!;
  await until(async () => (await receipt()).deliveredAt !== null);
  expect((await receipt()).seenAt).toBeNull();
  await server.context("s1", ["not dequeued yet"]);
  expect((await receipt()).seenAt).toBeNull();
  await server.context("s1", [server.injected[0]!.text]);
  await until(async () => (await receipt()).seenAt !== null);

  // Already busy: same steer admission, no interrupt or duplicate prompt.
  await post("carol", "@alpha", "while busy");
  await until(() => server.injected.length === 2);
  expect(server.injected[1]).toMatchObject({ delivery: "steer", resume: true });
  await post("beta", "@all", "broadcast");
  await until(() => server.injected.length === 3);
  expect(server.injected[2]).toMatchObject({ delivery: "steer", resume: false });
  await server.run("s1", { op: "set", key: "all", value: "wake" });
  await post("beta", "@all", "wake broadcast");
  await until(() => server.injected.length === 4);
  expect(server.injected[3]!.resume).toBe(true);
});

test("one binding per main session, concurrent hooks deduplicate; no stored history, child, scratch or foreign-location joins", async () => {
  const server = await start();
  server.add("s2");
  await Promise.all([server.prompt("s2"), server.context("s2", []), server.prompt("s2")]);
  await until(async () => (await active("alpha")).sessions?.length === 2);
  await post("carol", "@alpha-2", "second window");
  await until(() => server.injected.length === 1);
  expect(server.injected[0]!.sessionID).toBe("s2");
  server.add("stored");
  server.add("child", server.directory, "s1");
  server.add("foreign", path.join(dir, "foreign"));
  await server.prompt("child");
  await server.prompt("foreign");
  await expect(server.run("child", { op: "inbox" })).rejects.toThrow("not on the message bus");
  delete process.env.AGENT_BUS_JOIN_FROM_TMP;
  server.add("scratch", path.join(dir, "scratch"));
  await server.prompt("scratch");
  expect((await participants()).filter((p) => p.online)).toHaveLength(1);
  expect((await active("alpha")).sessions).toHaveLength(2);
});

test("creation/view resume sessions; archive, move, delete and plugin unload close connections", async () => {
  const server = await start();
  server.add("s2");
  server.event("session.viewed", "s2");
  await until(async () => (await active("alpha")).sessions?.length === 2);
  server.event("session.archived", "s2");
  await until(async () => (await active("alpha")).sessions?.length === 1);
  server.event("session.unarchived", "s2");
  server.event("session.viewed", "s2");
  await until(async () => (await active("alpha")).sessions?.length === 2);
  server.sessions.set("s2", { ...server.sessions.get("s2")!, location: { directory: path.join(dir, "moved") } });
  server.event("session.moved", "s2");
  await until(async () => (await active("alpha")).sessions?.length === 1);
  await server.prompt("s2");
  expect((await participants()).some((p) => p.id === "moved")).toBe(false);
  server.event("session.deleted", "s1");
  await until(async () => !(await participants()).some((p) => p.online));
  server.add("new");
  server.event("session.created", "new");
  await active("alpha");
  await server.stop();
  await until(async () => !(await participants()).some((p) => p.online));
});

test("shared tool writes/replies/reads and resolves file paths in the session directory", async () => {
  const server = await start();
  mkdirSync(server.directory, { recursive: true });
  writeFileSync(path.join(server.directory, "report.txt"), "result\n");
  const written = await server.run("s1", { op: "send", to: "@carol", files: ["report.txt"], message: "report" });
  expect(written.content).toContain("1 file: report.txt");
  const { message } = await post("carol", "@alpha", "question");
  await until(() => server.injected.length > 0);
  expect((await server.run("s1", { op: "reply", message_id: message.seq, message: "answer" })).content).toContain(`Replied to #${message.seq}`);
  expect((await server.run("s1", { op: "inbox" })).content).toContain("question");
  expect((await server.run("s1", { op: "search", query: "question" })).content).toContain("question");
});

test("failed native admission is not acknowledged or seen; bus backlog retries it on a later session", async () => {
  const server = await start();
  server.failDelivery = true;
  const { message } = await post("carol", "@alpha", "retry after admission failure");
  await until(() => server.attempted.length === 1);
  const receipt = async () => (await getJson<{ message: typeof message }>(bus, `/api/messages/${message.seq}`, "carol")).message.receipts[0]!;
  expect((await receipt()).deliveredAt).toBeNull();
  expect((await receipt()).seenAt).toBeNull();
  await server.stop();
  await until(async () => !(await participants()).some((p) => p.online));
  const resumed = await start();
  await until(() => resumed.injected.length === 1);
  expect(resumed.injected[0]!.text).toContain("retry after admission failure");
  await resumed.context("s1", [resumed.injected[0]!.text]);
  await until(async () => (await receipt()).seenAt !== null);
});

test("status and live output report tools, text and reasoning without model turns", async () => {
  const server = await start();
  await server.context("s1", []);
  const toolEvent = { sessionID: "s1", id: "call1", tool: "shell", input: { command: "pwd" } };
  await server.hook("tool:execute.before", toolEvent);
  await until(async () => (await active("alpha")).status?.tool === "shell");
  await server.hook("tool:execute.after", { ...toolEvent, status: "completed", result: { content: "project" } });
  server.event("session.text.delta", "s1", { assistantMessageID: "a1", ordinal: 0, delta: "Hello" });
  server.event("session.text.ended", "s1", { assistantMessageID: "a1", ordinal: 0, text: "Hello world" });
  server.event("session.reasoning.ended", "s1", { assistantMessageID: "a1", ordinal: 1, text: "Thinking" });
  server.event("session.execution.succeeded", "s1");
  await until(async () => (await active("alpha")).status?.state === "idle");
  const watcher = viewerSocket(bus);
  sockets.push(watcher);
  const frames: Array<Extract<ViewerServerFrame, { type: "activity" }>> = [];
  watcher.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ViewerServerFrame;
    if (frame.type === "activity") frames.push(frame);
  });
  await new Promise((resolve) => watcher.addEventListener("open", resolve, { once: true }));
  watcher.send(JSON.stringify({ type: "watch", agentId: "alpha" }));
  await until(() => frames.some((frame) => frame.replay));
  const events = frames.flatMap((frame) => frame.events);
  expect(events).toContainEqual(expect.objectContaining({ kind: "tool", name: "shell", input: "pwd", output: "project", state: "done" }));
  expect(events).toContainEqual(expect.objectContaining({ kind: "assistant", text: "Hello world", done: true }));
  expect(events).toContainEqual(expect.objectContaining({ kind: "assistant", thinking: "Thinking", done: true }));
  expect(server.injected).toHaveLength(0);
});

test("installer is registered, preserves URL, refuses foreign directories, and produces a self-contained loadable plugin", async () => {
  expect(harness("opencode").command).toBe("opencode");
  const target = path.join(dir, "plugin");
  await installer.install({ dir: target, url: bus.url, buildOnly: true });
  expect(installer.status({ dir: target })).toMatchObject({ installed: true, busUrl: bus.url });
  await installer.install({ dir: target, buildOnly: true });
  expect(JSON.parse(readFileSync(path.join(target, "config.json"), "utf8")).busUrl).toBe(bus.url);
  const installed = (await import(path.join(target, "index.js"))).default as typeof plugin;
  expect(installed.id).toBe("agent-bus");
  const server = new FakeOpenCode(path.join(dir, "installed"));
  servers.push(server);
  delete process.env.AGENT_BUS_URL;
  await server.start(installed);
  server.add("s1");
  await server.prompt("s1");
  await active("installed");
  await server.stop();
  await installer.uninstall({ dir: target });
  expect(existsSync(target)).toBe(false);
  mkdirSync(target);
  writeFileSync(path.join(target, "package.json"), '{"name":"someone-else"}');
  await expect(installer.install({ dir: target })).rejects.toThrow("not touching");
  await expect(installer.uninstall({ dir: target })).rejects.toThrow("not touching");
  expect(readFileSync(path.join(target, "package.json"), "utf8")).toContain("someone-else");
});

test("default install/doctor/uninstall respect XDG_CONFIG_HOME and leave unrelated OpenCode configuration alone", async () => {
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, "config");
  const configFile = path.join(process.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc");
  mkdirSync(path.dirname(configFile), { recursive: true });
  const config = '{ // user config\n "plugins": ["another-plugin"]\n}\n';
  writeFileSync(configFile, config);
  try {
    await harness("opencode").install({ url: bus.url });
    expect(harness("opencode").status({})).toMatchObject({
      installed: true, where: path.join(path.dirname(configFile), "plugins", "agent-bus"), busUrl: bus.url, notes: [],
    });
    expect(readFileSync(configFile, "utf8")).toBe(config);
    await harness("opencode").uninstall({});
    expect(harness("opencode").status({}).installed).toBe(false);
    expect(readFileSync(configFile, "utf8")).toBe(config);
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
});
