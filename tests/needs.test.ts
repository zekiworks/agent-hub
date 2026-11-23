// "Waiting for your answer" (Ümit #14881): with a `box=needs` extension, agents' messages for people listed in
// attention-people.txt are judged in the background; GET /api/needs lists the ones a model marked, until the person
// writes in that conversation or dismisses them; every verdict is kept (table and live-verdicts.jsonl).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BoxNeedsBody, NeedsResponse, PostMessageResponse } from "@agent-bus/protocol";
import type { BusServerHandle } from "@agent-bus/server";
import { agentSocketUrl, busFetch, getJson, postJson, startBus, viewerSocket } from "./helpers";

let dataDir = "";
let bus: BusServerHandle | undefined;
let extension: Bun.Server<undefined>;
/** What the needs box was asked, and how it answers. */
let asked: BoxNeedsBody[] = [];
let verdictsFor: (body: BoxNeedsBody) => Promise<Response> = async () => Response.json({ verdicts: {} });
let sockets: WebSocket[] = [];

const both = (d1: number, glide: number) =>
  Response.json({ verdicts: { d1: { needs: d1 >= 0.5, p: d1 }, glide: { needs: glide >= 0.5, p: glide } } });

beforeEach(() => {
  asked = [];
  sockets = [];
  verdictsFor = async (body) => (body.message.text.includes("?") ? both(0.8, 0.3) : both(0.1, 0.2));
  extension = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname !== "/needs") return new Response("no", { status: 404 });
      const body = (await req.json()) as BoxNeedsBody;
      asked.push(body);
      return verdictsFor(body);
    },
  });
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-needs-test-"));
  writeFileSync(path.join(dataDir, "attention-people.txt"), "carol\n");
});

function start(withBox = true): BusServerHandle {
  bus = startBus({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    humans: ["carol", "uma"],
    ...(withBox ? { boxes: { needs: { url: `http://127.0.0.1:${extension.port}`, role: "needs" as const } } } : {}),
  });
  return bus;
}

afterEach(async () => {
  for (const ws of sockets) ws.close();
  await bus?.stop();
  bus = undefined;
  extension.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

async function joinAgent(b: BusServerHandle, id: string): Promise<void> {
  const ws = new WebSocket(agentSocketUrl(b, { host: "studio", harness: "omp", path: `/tmp/x/${id}` }));
  sockets.push(ws);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  await Bun.sleep(100);
}

async function send(b: BusServerHandle, body: Record<string, unknown>): Promise<PostMessageResponse> {
  const res = await postJson(b, "/api/messages", body);
  if (!res.ok) throw new Error(`send ${res.status}: ${await res.text()}`);
  return (await res.json()) as PostMessageResponse;
}

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

const waitingFor = (b: BusServerHandle, person: string) => getJson<NeedsResponse>(b, `/api/needs?from=${person}`, person);
const records = () => {
  const file = path.join(dataDir, "finetune", "needs-you", "live-verdicts.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};

/** A room with carol, uma and the agent webapp. */
async function room(b: BusServerHandle): Promise<string> {
  await joinAgent(b, "webapp");
  const created = await send(b, { from: "carol", to: "#launch", text: "Launch room." });
  const id = created.conversation.id;
  expect((await postJson(b, `/api/conversations/${id}/members`, { from: "carol", ids: ["uma", "webapp"] })).status).toBe(200);
  return id;
}

test("an agent's message is judged in the background for a listed person; both verdicts are kept and it is listed", async () => {
  const b = start();
  const id = await room(b);
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  verdictsFor = async () => {
    await held;
    return both(0.8, 0.6);
  };
  const viewer = viewerSocket(b, "carol");
  sockets.push(viewer);
  const frames: string[] = [];
  viewer.addEventListener("message", (event) => frames.push(String(event.data)));
  await new Promise((resolve) => viewer.addEventListener("open", resolve, { once: true }));
  await send(b, { from: "webapp", conversationId: id, text: "Two Safari tests fail. Shall I skip them for the release?", wake: [] });
  // Delivered while the box still thinks: the message is there, nothing is listed yet.
  await until(() => asked.length === 1);
  expect((await waitingFor(b, "carol")).items).toEqual([]);
  expect(asked[0]).toMatchObject({
    v: 1,
    kind: "needs",
    person: "carol",
    conversation: { id, kind: "project", name: "launch", people: ["carol", "uma"] },
    message: { from: "webapp", fromKind: "agent", text: "Two Safari tests fail. Shall I skip them for the release?" },
  });
  expect(asked[0]!.messages.at(-1)).toMatchObject({ from: "carol", fromKind: "human", text: "Launch room." });
  release();
  await until(async () => (await waitingFor(b, "carol")).items.length === 1);
  const list = await waitingFor(b, "carol");
  expect(list.items[0]!.message.text).toBe("Two Safari tests fail. Shall I skip them for the release?");
  expect(list.items[0]!.verdicts).toEqual({ d1: { needs: true, p: 0.8 }, glide: { needs: true, p: 0.6 } });
  expect(list.conversations.map((c) => c.id)).toEqual([id]);
  await until(() => frames.some((f) => JSON.parse(f).type === "needs"));
  // The benchmark's copy: one line per verdict, never the text.
  const lines = records();
  expect(lines.map((l) => [l.person, l.seq, l.model, l.needs, l.p])).toEqual([
    ["carol", list.items[0]!.message.seq, "d1", true, 0.8],
    ["carol", list.items[0]!.message.seq, "glide", true, 0.6],
  ]);
  expect(JSON.stringify(lines)).not.toContain("Safari");
});

test("only listed people: nobody else's messages are judged, and their list is empty", async () => {
  const b = start();
  const id = await room(b);
  // Neither uma's own message nor an agent's in a conversation carol is not in is judged; the queue runs in order, so
  // once the room's message was asked, anything queued before it would have been asked first.
  await send(b, { from: "uma", to: "@webapp", text: "Can you check the docs?" });
  await send(b, { from: "webapp", to: "@uma", text: "Shall I check the docs?" });
  await send(b, { from: "webapp", conversationId: id, text: "Can you check the build?", wake: [] });
  await until(() => asked.length >= 1);
  // carol is listed; uma, in the same room, is not.
  expect(asked.map((a) => [a.person, a.message.text])).toEqual([["carol", "Can you check the build?"]]);
  expect((await waitingFor(b, "uma")).items).toEqual([]);
  // Only the signed-in person reads their own list.
  expect((await busFetch(b, "/api/needs?from=carol", {}, "uma")).status).toBe(403);
  expect((await busFetch(b, "/api/needs?from=carol")).status).toBe(403);
});

test("a message carol answered (she wrote after it there) or dismissed leaves the list; one no model marked never shows", async () => {
  const b = start();
  const id = await room(b);
  const first = await send(b, { from: "webapp", conversationId: id, text: "Shall I merge the fix?", wake: [] });
  await send(b, { from: "webapp", conversationId: id, text: "Merged and deployed.", wake: [] });
  const dm = await send(b, { from: "webapp", to: "@carol", text: "Which port do you want?" });
  await until(() => asked.length === 3);
  await until(async () => (await waitingFor(b, "carol")).items.length === 2);
  // Newest first; the update ("Merged and deployed.") was judged but no model marked it.
  expect((await waitingFor(b, "carol")).items.map((i) => i.message.text)).toEqual(["Which port do you want?", "Shall I merge the fix?"]);

  const viewer = viewerSocket(b, "carol");
  sockets.push(viewer);
  const frames: string[] = [];
  viewer.addEventListener("message", (event) => frames.push(String(event.data)));
  await new Promise((resolve) => viewer.addEventListener("open", resolve, { once: true }));
  await send(b, { from: "carol", conversationId: id, text: "Yes, go ahead." });
  await until(() => frames.some((f) => JSON.parse(f).type === "needs"));
  expect((await waitingFor(b, "carol")).items.map((i) => i.message.seq)).toEqual([dm.message.seq]);

  expect((await postJson(b, "/api/needs/dismiss", { from: "carol", seq: dm.message.seq, reason: "read" })).status).toBe(200);
  expect((await waitingFor(b, "carol")).items).toEqual([]);
  expect(records().at(-1)).toMatchObject({ person: "carol", seq: dm.message.seq, dismissed: true, reason: "read" });
  // Not someone else's, nor a message the person may not read.
  expect((await postJson(b, "/api/needs/dismiss", { from: "uma", seq: dm.message.seq })).status).toBe(404);
  expect(first.message.seq).toBeLessThan(dm.message.seq);
});

test("a failing box is harmless: messages still go; a model's error keeps the other's verdict", async () => {
  const b = start();
  const id = await room(b);
  verdictsFor = async () => new Response("broken", { status: 500 });
  const sent = await send(b, { from: "webapp", conversationId: id, text: "Shall I retry?", wake: [] });
  expect(sent.message.seq).toBeGreaterThan(0);
  await until(() => asked.length === 1);
  verdictsFor = async () => Response.json({ verdicts: { d1: { needs: true, p: 0.7 }, glide: { error: "connection refused" } } });
  await send(b, { from: "webapp", conversationId: id, text: "Which branch?", wake: [] });
  await until(async () => (await waitingFor(b, "carol")).items.length === 1);
  const [item] = (await waitingFor(b, "carol")).items;
  expect(item!.message.text).toBe("Which branch?");
  expect(item!.verdicts).toEqual({ d1: { needs: true, p: 0.7 } });
  // The box down altogether: still delivered.
  extension.stop(true);
  const late = await send(b, { from: "webapp", conversationId: id, text: "Anyone?", wake: [] });
  expect(late.message.text).toBe("Anyone?");
});

test("at its start the bus judges the recent agent messages never judged, once", async () => {
  let b = start(false);
  const id = await room(b);
  await send(b, { from: "webapp", conversationId: id, text: "Shall I tag 2.3?", wake: [] });
  await send(b, { from: "webapp", conversationId: id, text: "Tests are green.", wake: [] });
  await b.stop();
  for (const ws of sockets) ws.close();
  sockets = [];
  b = start();
  await until(() => asked.length === 2);
  await until(async () => (await waitingFor(b, "carol")).items.length === 1);
  expect((await waitingFor(b, "carol")).items[0]!.message.text).toBe("Shall I tag 2.3?");
  // Newest first.
  expect(asked.map((a) => a.message.text)).toEqual(["Tests are green.", "Shall I tag 2.3?"]);
  await b.stop();
  for (const ws of sockets) ws.close();
  sockets = [];
  // Started again: nothing is asked twice; the next message is the next one asked.
  b = start();
  await joinAgent(b, "webapp");
  await send(b, { from: "webapp", conversationId: id, text: "Release is out.", wake: [] });
  await until(() => asked.length >= 3);
  expect(asked.map((a) => a.message.text)).toEqual(["Tests are green.", "Shall I tag 2.3?", "Release is out."]);
});

test("a message one model could not judge (it was down) is asked again at the next start; the verdict given stays", async () => {
  let b = start();
  const id = await room(b);
  await send(b, { from: "webapp", conversationId: id, text: "Shall I tag 2.3?", wake: [] });
  await until(async () => (await waitingFor(b, "carol")).items.length === 1);
  verdictsFor = async () => Response.json({ verdicts: { d1: { needs: false, p: 0.2 }, glide: { error: "connection refused" } } });
  await send(b, { from: "webapp", conversationId: id, text: "Which tag name?", wake: [] });
  await until(() => records().length === 3);
  await b.stop();
  for (const ws of sockets) ws.close();
  sockets = [];
  verdictsFor = async () => both(0.9, 0.7);
  b = start();
  await until(async () => (await waitingFor(b, "carol")).items.length === 2);
  // Only the message GLiDE missed was asked again; d1's first verdict on it is kept.
  expect(asked.map((a) => a.message.text)).toEqual(["Shall I tag 2.3?", "Which tag name?", "Which tag name?"]);
  expect((await waitingFor(b, "carol")).items[0]!.verdicts).toEqual({ d1: { needs: false, p: 0.2 }, glide: { needs: true, p: 0.7 } });
});
