import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentServerFrame, Message, Participant, PostMessageResponse } from "@agent-bus/protocol";
import { createBusServer, type BusServerHandle } from "@agent-bus/server";
import { DAEMON_MARK, HOOK_MARK, mergeHooks, mergeMcp, ourHookEntries, stripHooks, stripMcp } from "../packages/cursor-plugin/src/config";
import { Daemon, type HookInput } from "../packages/cursor-plugin/src/daemon";
import { WAIT_FOLLOWUP } from "../packages/cursor-plugin/src/folder";
import { install, status, uninstall } from "../packages/cursor-plugin/scripts/install";

let dataDir = "";
let bus: BusServerHandle;
let daemon: Daemon | undefined;
const sockets: WebSocket[] = [];

async function until<T>(check: () => T | Promise<T>, ms = 4000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false && value !== null) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

function folder(name: string): string {
  const dir = path.join(dataDir, "projects", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A main chat in `workspace`. generation_id differs from the conversation, as Cursor's parent events do. */
function chat(id: string, workspace: string, extra: Partial<HookInput> = {}): HookInput {
  return {
    conversation_id: id,
    session_id: id,
    generation_id: `gen-${id}`,
    workspace_roots: [folder(workspace)],
    ...extra,
  };
}

async function participant(id: string): Promise<Participant | undefined> {
  const state = (await (await fetch(`${bus.url}/api/state`)).json()) as { participants: Participant[] };
  return state.participants.find((p) => p.id === id);
}

async function message(seq: number): Promise<Message> {
  return ((await (await fetch(`${bus.url}/api/messages/${seq}`)).json()) as { message: Message }).message;
}

async function post(body: object): Promise<PostMessageResponse> {
  const res = await fetch(`${bus.url}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PostMessageResponse;
}

async function rawAgent(name: string): Promise<void> {
  const ws = new WebSocket(`${bus.url.replace(/^http/, "ws")}/ws/agent?host=test&harness=raw&path=${encodeURIComponent(folder(name))}`);
  sockets.push(ws);
  const joined = Promise.withResolvers<void>();
  ws.addEventListener("message", (e) => {
    const frame = JSON.parse(String(e.data)) as AgentServerFrame;
    if (frame.type === "joined") joined.resolve();
    if (frame.type === "deliver") ws.send(JSON.stringify({ type: "ack", seq: frame.message.seq }));
  });
  await joined.promise;
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-cursor-test-"));
  bus = createBusServer({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol"] });
  process.env.AGENT_BUS_URL = bus.url;
  process.env.AGENT_BUS_JOIN_FROM_TMP = "1";
});

afterEach(async () => {
  daemon?.close();
  daemon = undefined;
  for (const ws of sockets.splice(0)) ws.close();
  await bus.stop();
  delete process.env.AGENT_BUS_URL;
  delete process.env.AGENT_BUS_JOIN_FROM_TMP;
  delete process.env.AGENT_BUS_CURSOR_HOME;
  rmSync(dataDir, { recursive: true, force: true });
});

test("a message during a turn is handed over after the current tool and marked seen", async () => {
  daemon = new Daemon();
  await daemon.hook("sessionStart", chat("c1", "alpha"));
  await daemon.hook("beforeSubmitPrompt", chat("c1", "alpha", { prompt: "keep going" }));
  await until(async () => (await participant("alpha"))?.online);
  expect((await participant("alpha"))?.harness).toBe("cursor");
  const { message: hello } = await post({ from: "carol", to: "@alpha", text: "hello alpha" });
  await until(async () => (await message(hello.seq)).receipts[0]?.deliveredAt);
  expect((await message(hello.seq)).receipts[0]?.seenAt).toBeNull();

  const answer = (await daemon.hook("postToolUse", chat("c1", "alpha", { tool_name: "Shell", tool_use_id: "t1" }))) as {
    additional_context?: string;
  };
  expect(answer.additional_context).toContain(`[message-bus] #${hello.seq} @carol`);
  expect(answer.additional_context).toContain("hello alpha");
  await until(async () => (await message(hello.seq)).receipts[0]?.seenAt);
  expect(await daemon.hook("postToolUse", chat("c1", "alpha", { tool_name: "Shell", tool_use_id: "t2" }))).toEqual({});
});

test("a failed tool does not take a held message; the next successful tool does and marks it seen", async () => {
  daemon = new Daemon();
  await daemon.hook("sessionStart", chat("c1", "alpha"));
  await daemon.hook("beforeSubmitPrompt", chat("c1", "alpha", { prompt: "keep going" }));
  await until(async () => (await participant("alpha"))?.online);
  const { message: hello } = await post({ from: "carol", to: "@alpha", text: "after the failure" });
  await until(async () => (await message(hello.seq)).receipts[0]?.deliveredAt);

  const failed = await daemon.hook(
    "postToolUseFailure",
    chat("c1", "alpha", { tool_name: "Read", tool_use_id: "", tool_output: "not found" })
  );
  expect(failed).toEqual({});
  expect((await message(hello.seq)).receipts[0]?.seenAt).toBeNull();

  const answer = (await daemon.hook("postToolUse", chat("c1", "alpha", { tool_name: "Read", tool_use_id: "t1" }))) as {
    additional_context?: string;
  };
  expect(answer.additional_context).toContain("after the failure");
  await until(async () => (await message(hello.seq)).receipts[0]?.seenAt);
});

test("a wake still held when the turn completes becomes the next message; an aborted turn does not", async () => {
  daemon = new Daemon();
  await daemon.hook("sessionStart", chat("c1", "alpha"));
  await daemon.hook("beforeSubmitPrompt", chat("c1", "alpha"));
  await until(async () => (await participant("alpha"))?.online);
  const { message: hello } = await post({ from: "carol", to: "@alpha", text: "urgent follow-up" });
  await until(async () => (await message(hello.seq)).receipts[0]?.deliveredAt);

  const aborted = await daemon.hook("stop", chat("c1", "alpha", { status: "aborted" }));
  expect(aborted).toEqual({});
  expect((await message(hello.seq)).receipts[0]?.seenAt).toBeNull();

  await daemon.hook("beforeSubmitPrompt", chat("c1", "alpha"));
  const done = (await daemon.hook("stop", chat("c1", "alpha", { status: "completed" }))) as { followup_message?: string };
  expect(done.followup_message).toContain("urgent follow-up");
  await until(async () => (await message(hello.seq)).receipts[0]?.seenAt);
  expect(await daemon.hook("stop", chat("c1", "alpha", { status: "completed" }))).toEqual({});
});

test("op=wait blocks until a bus message, which it returns and marks seen", async () => {
  daemon = new Daemon();
  await daemon.hook("sessionStart", chat("c1", "alpha"));
  await daemon.hook("beforeSubmitPrompt", chat("c1", "alpha", { prompt: "park" }));
  await until(async () => (await participant("alpha"))?.online);
  const pending = daemon.callTool({ op: "wait", _conversation: "c1" });
  const blocked = await Promise.race([pending.then(() => "done"), Bun.sleep(80).then(() => "blocked")]);
  expect(blocked).toBe("blocked");

  const { message: hello } = await post({ from: "carol", to: "@alpha", text: "while you wait" });
  const text = await pending;
  expect(text).toContain(`[message-bus] #${hello.seq} @carol`);
  expect(text).toContain("while you wait");
  await until(async () => (await message(hello.seq)).receipts[0]?.seenAt);
  expect(await daemon.hook("postToolUse", chat("c1", "alpha", { tool_name: "MCP:message-bus", tool_use_id: "w1" }))).toEqual({});
});

test("a quiet @all does not unblock op=wait; a message that wakes does, and the quiet one rides along", async () => {
  daemon = new Daemon();
  await daemon.hook("sessionStart", chat("c1", "alpha"));
  await until(async () => (await participant("alpha"))?.online);
  await rawAgent("beta");
  const pending = daemon.callTool({ op: "wait", _conversation: "c1" });
  const { message: note } = await post({ from: "beta", to: "@all", text: "GPU 2 released" });
  await until(async () => (await message(note.seq)).receipts.find((r) => r.to === "alpha")?.deliveredAt);
  const blocked = await Promise.race([pending.then(() => "done"), Bun.sleep(80).then(() => "blocked")]);
  expect(blocked).toBe("blocked");
  expect((await message(note.seq)).receipts.find((r) => r.to === "alpha")?.seenAt).toBeNull();

  const { message: hello } = await post({ from: "carol", to: "@alpha", text: "your turn" });
  const text = await pending;
  expect(text).toContain("GPU 2 released");
  expect(text).toContain("your turn");
  await until(async () => (await message(hello.seq)).receipts[0]?.seenAt);
  await until(async () => (await message(note.seq)).receipts.find((r) => r.to === "alpha")?.seenAt);
});

test("a composer submit ends op=wait without taking the queue, and the next completed turn parks", async () => {
  daemon = new Daemon();
  await daemon.hook("sessionStart", chat("c1", "alpha"));
  await daemon.hook("beforeSubmitPrompt", chat("c1", "alpha", { prompt: "park" }));
  await until(async () => (await participant("alpha"))?.online);
  const pending = daemon.callTool({ op: "wait", _conversation: "c1" });
  await daemon.hook("beforeSubmitPrompt", chat("c1", "alpha", { prompt: "new idea" }));
  const text = await pending;
  expect(text).toContain("composer");
  expect(text).not.toContain("hold this");

  const { message: hello } = await post({ from: "carol", to: "@alpha", text: "hold this" });
  await until(async () => (await message(hello.seq)).receipts[0]?.deliveredAt);
  expect((await message(hello.seq)).receipts[0]?.seenAt).toBeNull();
  expect(await daemon.hook("postToolUse", chat("c1", "alpha", { tool_name: "MCP:message-bus", tool_use_id: "w1" }))).toEqual({});
  expect((await message(hello.seq)).receipts[0]?.seenAt).toBeNull();
  expect(await daemon.hook("stop", chat("c1", "alpha", { status: "completed" }))).toEqual({});

  const next = (await daemon.hook("postToolUse", chat("c1", "alpha", { tool_name: "Read", tool_use_id: "t1" }))) as {
    additional_context?: string;
  };
  expect(next.additional_context).toContain("hold this");
  await until(async () => (await message(hello.seq)).receipts[0]?.seenAt);

  expect(await daemon.hook("stop", chat("c1", "alpha", { status: "completed" }))).toEqual({});
});

test("a finished turn does not ask for op=wait, and that follow-up text does not end an in-flight wait", async () => {
  daemon = new Daemon();
  await daemon.hook("sessionStart", chat("c1", "alpha"));
  await daemon.hook("beforeSubmitPrompt", chat("c1", "alpha", { prompt: "work" }));
  await until(async () => (await participant("alpha"))?.online);
  expect(await daemon.hook("stop", chat("c1", "alpha", { status: "completed" }))).toEqual({});

  const pending = daemon.callTool({ op: "wait", _conversation: "c1" });
  await daemon.hook("beforeSubmitPrompt", chat("c1", "alpha", { prompt: WAIT_FOLLOWUP }));
  const blocked = await Promise.race([pending.then(() => "done"), Bun.sleep(80).then(() => "blocked")]);
  expect(blocked).toBe("blocked");
  const { message: hello } = await post({ from: "carol", to: "@alpha", text: "after the follow-up" });
  expect(await pending).toContain("after the follow-up");
  await until(async () => (await message(hello.seq)).receipts[0]?.seenAt);
});

test("quiet @all from another agent waits for the next tool call and does not start a turn", async () => {
  daemon = new Daemon();
  await daemon.hook("sessionStart", chat("c1", "alpha"));
  await until(async () => (await participant("alpha"))?.online);
  await rawAgent("beta");
  const { message: note } = await post({ from: "beta", to: "@all", text: "GPU 2 released" });
  await until(async () => (await message(note.seq)).receipts.find((r) => r.to === "alpha")?.deliveredAt);

  expect(await daemon.hook("stop", chat("c1", "alpha", { status: "completed" }))).toEqual({});
  const answer = (await daemon.hook("postToolUse", chat("c1", "alpha", { tool_name: "Read", tool_use_id: "t1" }))) as {
    additional_context?: string;
  };
  expect(answer.additional_context).toContain("GPU 2 released");
  await until(async () => (await message(note.seq)).receipts.find((r) => r.to === "alpha")?.seenAt);
});

test("an older chat ending does not take a message meant for the latest one", async () => {
  daemon = new Daemon();
  await daemon.hook("sessionStart", chat("c1", "alpha"));
  await daemon.hook("sessionStart", chat("c2", "alpha"));
  await until(async () => (await participant("alpha"))?.online);
  const { message: hello } = await post({ from: "carol", to: "@alpha", text: "for the new chat" });
  await until(async () => (await message(hello.seq)).receipts[0]?.deliveredAt);
  expect(await daemon.hook("stop", chat("c1", "alpha", { status: "completed" }))).toEqual({});
  const answer = (await daemon.hook("stop", chat("c2", "alpha", { status: "completed" }))) as { followup_message?: string };
  expect(answer.followup_message).toContain("for the new chat");
});

test("subagents, background agents, chats without a workspace, and one-shot runs do not join", async () => {
  daemon = new Daemon();
  await daemon.hook("sessionStart", chat("c1", "alpha"));
  await daemon.hook("sessionStart", chat("bg", "gamma", { is_background_agent: true }));
  await daemon.hook("sessionStart", { conversation_id: "nowhere", session_id: "nowhere" });
  await daemon.hook("preToolUse", chat("oneshot", "delta", { tool_name: "Shell", tool_use_id: "p1" }));
  await daemon.hook("subagentStart", { conversation_id: "c1", subagent_id: "child", parent_conversation_id: "c1" });
  await daemon.hook("preToolUse", {
    conversation_id: "child",
    generation_id: "child",
    parent_conversation_id: "c1",
    workspace_roots: [folder("alpha")],
    tool_name: "Shell",
    tool_use_id: "s1",
  });
  await until(async () => (await participant("alpha"))?.online);
  await Bun.sleep(200);
  expect(await participant("gamma")).toBeUndefined();
  expect(await participant("delta")).toBeUndefined();
  const state = (await (await fetch(`${bus.url}/api/state`)).json()) as { participants: Participant[] };
  expect(state.participants.filter((p) => p.kind === "agent").map((p) => p.id)).toEqual(["alpha"]);
});

test("the message-bus tool runs as the chat whose preToolUse stamped the call", async () => {
  daemon = new Daemon();
  await daemon.hook("sessionStart", chat("c1", "alpha"));
  await daemon.hook("sessionStart", chat("c2", "beta"));
  await until(async () => (await participant("alpha"))?.online && (await participant("beta"))?.online);
  const stamped = (await daemon.hook(
    "preToolUse",
    chat("c2", "beta", { tool_name: "MCP:message-bus", tool_use_id: "m1", tool_input: { op: "inbox" } })
  )) as { updated_input?: { _conversation?: string } };
  expect(stamped.updated_input?._conversation).toBe("c2");
  const text = await daemon.callTool({ op: "inbox" });
  expect(text).toContain("@beta");
});

test("after a restart a folder is back on the bus and a later hook hands over what arrived while idle", async () => {
  const stateFile = path.join(dataDir, "agents.json");
  daemon = new Daemon(stateFile);
  await daemon.hook("sessionStart", chat("c1", "alpha"));
  await until(async () => (await participant("alpha"))?.online);
  daemon.close();
  await until(async () => !(await participant("alpha"))?.online);

  daemon = new Daemon(stateFile);
  await until(async () => (await participant("alpha"))?.online);
  const { message: hello } = await post({ from: "carol", to: "@alpha", text: "still there?" });
  await until(async () => (await message(hello.seq)).receipts[0]?.deliveredAt);
  const answer = (await daemon.hook("postToolUse", chat("c1", "alpha", { tool_name: "Read", tool_use_id: "t1" }))) as {
    additional_context?: string;
  };
  expect(answer.additional_context).toContain("still there?");
});

test("hook and mcp config keep foreign entries and never put // in a hook command", () => {
  const entries = ourHookEntries("/usr/local/bin/node", "/tmp/cursor plugin/hook.mjs");
  for (const entry of Object.values(entries)) expect(entry.command ?? "").not.toContain("//");
  expect(entries.stop?.command).toContain(HOOK_MARK);
  expect(entries.stop?.loop_limit).toBeNull();

  const hooks = mergeHooks({ version: 1, hooks: { stop: [{ command: "format.sh" }] }, extra: true }, entries);
  expect(hooks.hooks?.stop?.[0]).toEqual({ command: "format.sh" });
  expect(hooks.hooks?.stop?.[1]?.command).toContain(HOOK_MARK);
  expect(hooks.extra).toBe(true);
  expect(stripHooks(hooks).hooks?.stop).toEqual([{ command: "format.sh" }]);

  const server = { command: "node", args: ["/opt/daemon.mjs", DAEMON_MARK] };
  expect(() => mergeMcp({ mcpServers: { "message-bus": { command: "other", args: ["x"] } } }, server, false)).toThrow(/not touching/);
  const mcp = mergeMcp({ mcpServers: { linear: { command: "linear", args: [] } } }, server, false);
  expect(Object.keys(mcp.mcpServers ?? {}).sort()).toEqual(["linear", "message-bus"]);
  expect(stripMcp(mcp).mcpServers?.linear?.command).toBe("linear");
  expect(stripMcp(mcp).mcpServers?.["message-bus"]).toBeUndefined();
});

test("install registers hooks and the MCP server without dropping other entries, and uninstall removes only its own", async () => {
  const home = path.join(dataDir, "cursor-home");
  const plugin = path.join(dataDir, "plugin");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, "hooks.json"),
    `${JSON.stringify({ version: 1, hooks: { stop: [{ command: "format.sh" }] } }, null, 2)}\n`
  );
  writeFileSync(
    path.join(home, "mcp.json"),
    `${JSON.stringify({ mcpServers: { linear: { command: "linear", args: [] } } }, null, 2)}\n`
  );
  process.env.AGENT_BUS_CURSOR_HOME = home;
  await install({ dir: plugin, url: "http://bus.example:7800" });

  const hooks = JSON.parse(readFileSync(path.join(home, "hooks.json"), "utf8")) as {
    hooks: Record<string, Array<{ command: string }>>;
  };
  expect(hooks.hooks.stop?.[0]?.command).toBe("format.sh");
  expect(hooks.hooks.sessionStart?.some((entry) => entry.command.includes(HOOK_MARK))).toBe(true);
  expect(JSON.stringify(hooks)).not.toContain("//");
  const mcp = JSON.parse(readFileSync(path.join(home, "mcp.json"), "utf8")) as {
    mcpServers: Record<string, { args?: string[] }>;
  };
  expect(mcp.mcpServers.linear?.args).toEqual([]);
  expect(mcp.mcpServers["message-bus"]?.args).toContain(DAEMON_MARK);
  const reported = status({ dir: plugin });
  expect(reported.installed).toBe(true);
  expect(reported.busUrl).toBe("http://bus.example:7800");
  expect(reported.notes.some((note) => note.includes("not registered"))).toBe(false);

  await uninstall({ dir: plugin });
  const left = JSON.parse(readFileSync(path.join(home, "hooks.json"), "utf8")) as { hooks: Record<string, Array<{ command: string }>> };
  expect(left.hooks.stop).toEqual([{ command: "format.sh" }]);
  expect(JSON.stringify(left)).not.toContain(HOOK_MARK);
  const mcpLeft = JSON.parse(readFileSync(path.join(home, "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
  expect(mcpLeft.mcpServers.linear).toBeDefined();
  expect(mcpLeft.mcpServers["message-bus"]).toBeUndefined();
  expect(status({ dir: plugin }).installed).toBe(false);
}, 30_000);
