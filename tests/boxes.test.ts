// Box extensions: POST /api/box/:name asks a `--ext NAME=URL,box=complete` service for the next
// words of a person's draft, with only what that person may read.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BoxCompleteBody, PostMessageResponse, StateResponse } from "@agent-bus/protocol";
import type { BusServerHandle } from "@agent-bus/server";
import { getJson, postJson, startBus } from "./helpers";

let dataDir = "";
let bus: BusServerHandle;
let extension: ReturnType<typeof Bun.serve>;
/** What the extension was sent, and how it answers. */
let received: BoxCompleteBody[] = [];
let answer: (body: BoxCompleteBody) => Promise<Response> = async () => Response.json({ text: " notes." });

beforeEach(() => {
  received = [];
  answer = async () => Response.json({ text: " notes." });
  extension = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname !== "/complete") return new Response("no", { status: 404 });
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
    boxes: { complete: { url: `http://127.0.0.1:${extension.port}`, role: "complete" } },
  });
});

afterEach(async () => {
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
  expect(state.boxes).toEqual({ complete: "complete" });
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

/** A second bus without the extension, to check one without boxes says nothing about them. */
async function startBusWithOnlyCarol(): Promise<BusServerHandle> {
  const dir = mkdtempSync(path.join(tmpdir(), "mb-boxes-none-"));
  const plain = startBus({ host: "127.0.0.1", port: 0, dataDir: dir, humans: ["carol"] });
  const state = await getJson<StateResponse>(plain, "/api/state", "carol");
  expect(state.boxes).toBeUndefined();
  return { ...plain, stop: async () => { await plain.stop(); rmSync(dir, { recursive: true, force: true }); } };
}
