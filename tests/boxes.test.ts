// Box extensions (Can #12841–#12853): POST /api/box/:name asks a `--ext NAME=URL,box=ROLE` service, with only what the
// person may read: "complete" for the next words of a draft, "recipient" for the one agent of a room to ask (Ümit #13030).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BoxCompleteBody, BoxRecipientBody, PostMessageResponse, StateResponse } from "@agent-bus/protocol";
import type { BusServerHandle } from "@agent-bus/server";
import { agentSocketUrl, busFetch, getJson, postJson, startBus } from "./helpers";

let dataDir = "";
let bus: BusServerHandle;
let extension: ReturnType<typeof Bun.serve>;
/** What the extension was sent, and how it answers. */
let received: BoxCompleteBody[] = [];
let answer: (body: BoxCompleteBody) => Promise<Response> = async () => Response.json({ text: " notes." });
let asked: BoxRecipientBody[] = [];
let recipientAnswer: (body: BoxRecipientBody) => Response = () => Response.json({ recipient: "webapp", confidence: 0.82 });
let sockets: WebSocket[] = [];

beforeEach(() => {
  received = [];
  asked = [];
  sockets = [];
  answer = async () => Response.json({ text: " notes." });
  recipientAnswer = () => Response.json({ recipient: "webapp", confidence: 0.82 });
  extension = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const route = new URL(req.url).pathname;
      if (route === "/recipient") {
        const body = (await req.json()) as BoxRecipientBody;
        asked.push(body);
        return recipientAnswer(body);
      }
      if (route !== "/complete") return new Response("no", { status: 404 });
      const body = (await req.json()) as BoxCompleteBody;
      received.push(body);
      return answer(body);
    },
  });
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-boxes-test-"));
  bus = startBus({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    humans: ["carol", "uma"],
    boxes: {
      complete: { url: `http://127.0.0.1:${extension.port}`, role: "complete" },
      ask: { url: `http://127.0.0.1:${extension.port}`, role: "recipient" },
    },
  });
});

/** An agent on the bus, named by its folder. */
async function joinAgent(id: string): Promise<void> {
  const ws = new WebSocket(agentSocketUrl(bus, { host: "studio", harness: "omp", path: `/tmp/x/${id}` }));
  sockets.push(ws);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  await Bun.sleep(100);
}

afterEach(async () => {
  for (const ws of sockets) ws.close();
  await bus.stop();
  extension.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

async function send(body: Record<string, unknown>): Promise<PostMessageResponse> {
  const res = await postJson(bus, "/api/messages", body);
  if (!res.ok) throw new Error(`send ${res.status}: ${await res.text()}`);
  return (await res.json()) as PostMessageResponse;
}

const ask = (from: string, conversationId: string, text: string) => postJson(bus, "/api/box/complete", { from, conversationId, text });

test("a person's draft goes to the extension with the conversation's latest messages; its words come back", async () => {
  const room = await send({ from: "carol", to: "@uma", text: "The release notes draft is up." });
  const res = await ask("carol", room.conversation.id, "Thanks, I'll review the release");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: " notes." });
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    v: 1,
    kind: "complete",
    me: "carol",
    conversation: { id: room.conversation.id, kind: "dm", members: ["carol", "uma"] },
    messages: [{ seq: room.message.seq, from: "carol", text: "The release notes draft is up." }],
    draft: { text: "Thanks, I'll review the release" },
  });
  const state = await getJson<StateResponse>(bus, "/api/state", "carol");
  expect(state.boxes).toEqual({ complete: "complete", ask: "recipient" });
  expect(state.extensions).toBeUndefined(); // not a Workspace page
});

test("only a person who may read the conversation; agents never; nothing for an unknown extension", async () => {
  const dm = await send({ from: "carol", to: "@uma", text: "between the two of us" });
  const other = await startBusWithOnlyCarol();
  expect((await ask("uma", dm.conversation.id, "hi")).status).toBe(200);
  // An agent token is refused; a conversation the person cannot read looks unknown.
  expect((await postJson(bus, "/api/box/complete", { conversationId: dm.conversation.id, text: "hi" })).status).toBe(403);
  expect((await ask("carol", "g_000000000000", "hi")).status).toBe(404);
  expect((await postJson(bus, "/api/box/nothing", { from: "carol", conversationId: dm.conversation.id, text: "hi" })).status).toBe(404);
  expect(received.map((r) => r.me)).toEqual(["uma"]);
  await other.stop();
});

test("a newer draft from the same person cancels the one in flight: it comes back empty", async () => {
  const dm = await send({ from: "carol", to: "@uma", text: "x" });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  answer = async (body) => {
    if (body.draft.text === "first") await held;
    return Response.json({ text: ` after ${body.draft.text}` });
  };
  const first = ask("carol", dm.conversation.id, "first");
  await Bun.sleep(100);
  const second = await ask("carol", dm.conversation.id, "second");
  release();
  expect(await second.json()).toEqual({ text: " after second" });
  expect(await (await first).json()).toEqual({ text: "" });
});

test("an extension that fails or answers too much gives an error or nothing, never a wrong suggestion", async () => {
  const dm = await send({ from: "carol", to: "@uma", text: "x" });
  answer = async () => new Response("broken", { status: 500 });
  expect((await ask("carol", dm.conversation.id, "a")).status).toBe(502);
  answer = async () => Response.json({ text: "y".repeat(500) });
  expect(await (await ask("carol", dm.conversation.id, "a")).json()).toEqual({ text: "" });
});

/** A room with carol, uma, and the agents `agents`, after `webapp` reported failing tests and owns the fix; `docs`, when
 * there, writes last (so the rule would wake docs, and offering webapp is a real suggestion). */
async function launchRoom(agents: string[]): Promise<string> {
  for (const id of agents) await joinAgent(id);
  const room = await send({ from: "carol", to: "#launch", text: "Launch room." });
  const id = room.conversation.id;
  expect((await postJson(bus, `/api/conversations/${id}/members`, { from: "carol", ids: ["uma", ...agents] })).status).toBe(200);
  if (agents.includes("webapp")) {
    await send({ from: "webapp", conversationId: id, text: "Two Safari tests fail, both in the date picker.", wake: [] });
    const edit = await postJson(bus, `/api/conversations/${id}/checklist/edit`, {
      from: "webapp",
      base: 0,
      ops: [{ op: "add", heading: "#1 Release", text: "Fix the two Safari date-picker tests" }],
    });
    expect(edit.status).toBe(200);
  }
  if (agents.includes("docs")) await send({ from: "docs", conversationId: id, text: "Release notes are up.", wake: [] });
  return id;
}

const askWho = (from: string, conversationId: string, text: string) => postJson(bus, "/api/box/ask", { from, conversationId, text });

test("recipient: the room's agents, messages with their authors and checklist owners go along; one of those agents comes back", async () => {
  const room = await launchRoom(["webapp", "docs"]);
  const res = await askWho("carol", room, "Did both Safari tests pass after the fix?");
  expect(await res.json()).toEqual({ recipient: "webapp", confidence: 0.82 });
  expect(asked).toHaveLength(1);
  const body = asked[0]!;
  expect(body).toMatchObject({ v: 1, kind: "recipient", me: "carol", draft: { text: "Did both Safari tests pass after the fix?" } });
  expect([...body.agents].sort()).toEqual(["docs", "webapp"]);
  expect(body.messages.at(-2)).toMatchObject({ from: "webapp", fromKind: "agent", text: "Two Safari tests fail, both in the date picker." });
  expect(body.messages.at(-1)).toMatchObject({ from: "docs", fromKind: "agent" });
  expect(body.messages[0]).toMatchObject({ from: "carol", fromKind: "human" });
  expect(body.checklist).toEqual([
    expect.objectContaining({ text: "Fix the two Safari date-picker tests", owner: "webapp", done: false, heading: "#1 Release" }),
  ]);
});

test("recipient: the agent the message would wake anyway (the last one who wrote) is not offered (Can #13587)", async () => {
  const room = await launchRoom(["webapp", "docs"]);
  recipientAnswer = () => Response.json({ recipient: "docs", confidence: 0.9 });
  expect(await (await askWho("carol", room, "Are the notes final?")).json()).toEqual({ recipient: null });
  recipientAnswer = () => Response.json({ recipient: "webapp", confidence: 0.9 });
  expect(await (await askWho("carol", room, "Are the notes final?")).json()).toEqual({ recipient: "webapp", confidence: 0.9 });
});

test("recipient: an answer naming anyone but the room's agents is no suggestion", async () => {
  const room = await launchRoom(["webapp", "docs"]);
  for (const recipient of ["uma", "carol", "zeta", "none", 42]) {
    recipientAnswer = () => Response.json({ recipient, confidence: 0.9 });
    expect(await (await askWho("carol", room, "Is it done?")).json()).toEqual({ recipient: null });
  }
  recipientAnswer = () => new Response("down", { status: 503 });
  expect((await askWho("carol", room, "Is it done?")).status).toBe(502);
});

test("recipient: not asked when the person chose (a member named, @all), in a room with one agent, or outside rooms", async () => {
  const room = await launchRoom(["webapp", "docs"]);
  for (const draft of ["@docs did the notes go out?", "@all lunch", "@{uma,webapp} ok?", "   "]) {
    expect(await (await askWho("carol", room, draft)).json()).toEqual({ recipient: null });
  }
  const single = await send({ from: "carol", to: "#solo", text: "x" });
  await postJson(bus, `/api/conversations/${single.conversation.id}/members`, { from: "carol", ids: ["webapp"] });
  expect(await (await askWho("carol", single.conversation.id, "Is it done?")).json()).toEqual({ recipient: null });
  const dm = await send({ from: "carol", to: "@uma", text: "x" });
  expect(await (await askWho("carol", dm.conversation.id, "Is it done?")).json()).toEqual({ recipient: null });
  expect(asked).toHaveLength(0);
});

test("recipient report: what was done with an offer is kept in box-reports.jsonl, without the text, only from a reader", async () => {
  const room = await launchRoom(["webapp", "docs"]);
  const report = (from: string, body: Record<string, unknown>) => postJson(bus, "/api/box/ask/report", { from, conversationId: room, ...body });
  expect((await report("carol", { outcome: "taken", recipient: "webapp", confidence: 0.82, ms: 512.4, text: "secret" })).status).toBe(200);
  expect((await report("carol", { outcome: "quiet", recipient: "nobody-here" })).status).toBe(200);
  expect((await report("carol", { outcome: "great" })).status).toBe(400);
  expect((await postJson(bus, "/api/box/complete/report", { from: "carol", conversationId: room, outcome: "quiet" })).status).toBe(404);
  const dm = await send({ from: "carol", to: "@webapp", text: "x" });
  expect((await postJson(bus, "/api/box/ask/report", { from: "uma", conversationId: dm.conversation.id, outcome: "quiet" })).status).toBe(404);
  const lines = readFileSync(path.join(dataDir, "box-reports.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map(({ at: _, ...rest }) => rest)).toEqual([
    { box: "ask", person: "carol", conversationId: room, outcome: "taken", recipient: "webapp", confidence: 0.82, ms: 512 },
    { box: "ask", person: "carol", conversationId: room, outcome: "quiet" },
  ]);
});

test("recipient usage: a person's own counts, nobody else's, without conversation ids; not for agents or other boxes", async () => {
  const room = await launchRoom(["webapp", "docs"]);
  const report = (from: string, body: Record<string, unknown>) => postJson(bus, "/api/box/ask/report", { from, conversationId: room, ...body });
  for (const [outcome, ms] of [["taken", 400], ["taken", 600], ["ignored", 900], ["quiet", undefined], ["reply", 300]] as const) {
    expect((await report("carol", { outcome, recipient: "webapp", ...(ms ? { ms } : {}) })).status).toBe(200);
  }
  expect((await report("carol", { outcome: "named", failed: true })).status).toBe(200);
  // uma's lines are hers: they change none of carol's counts.
  for (const outcome of ["taken", "named-other", "named"]) expect((await report("uma", { outcome, ms: 5000, failed: true })).status).toBe(200);
  const res = await busFetch(bus, "/api/box/ask/usage", {}, "carol");
  expect(res.status).toBe(200);
  const text = await res.text();
  const today = new Date().toISOString().slice(0, 10);
  expect(JSON.parse(text)).toEqual({
    messages: 6,
    outcomes: { taken: 2, ignored: 1, "named-other": 0, named: 1, quiet: 1, reply: 1 },
    offered: 3,
    takenShare: 2 / 3,
    answerMs: { answers: 4, median: 600, p90: 900 },
    failed: 1,
    firstDay: today,
    lastDay: today,
    version: expect.any(String),
  });
  for (const secret of [room, "webapp", "carol", "uma"]) expect(text).not.toContain(secret);
  // An agent token is refused; a box that is not a recipient, or none, is unknown.
  expect((await busFetch(bus, "/api/box/ask/usage")).status).toBe(403);
  expect((await busFetch(bus, "/api/box/complete/usage", {}, "carol")).status).toBe(404);
  expect((await busFetch(bus, "/api/box/nothing/usage", {}, "carol")).status).toBe(404);
});

/** A second bus without the extension, to check one without boxes says nothing about them. */
async function startBusWithOnlyCarol(): Promise<BusServerHandle> {
  const dir = mkdtempSync(path.join(tmpdir(), "mb-boxes-none-"));
  const plain = startBus({ host: "127.0.0.1", port: 0, dataDir: dir, humans: ["carol"] });
  const state = await getJson<StateResponse>(plain, "/api/state", "carol");
  expect(state.boxes).toBeUndefined();
  return { ...plain, stop: async () => { await plain.stop(); rmSync(dir, { recursive: true, force: true }); } };
}
