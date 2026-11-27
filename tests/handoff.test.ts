// Handoff (Can #17876): an agent woken for a person's message that is meant for another agent passes it on with
// op=handoff instead of writing; the other agent gets it as a waking delivery naming who passed it, the message's wake
// list names it instead, and the conversation gets no new message.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message, MessagesResponse, PostMessageResponse, ViewerServerFrame } from "@agent-bus/protocol";
import type { BusServerHandle } from "@agent-bus/server";
import { BusConnection, type Delivery } from "../packages/client/src/connection";
import { BusTool, formatDelivery } from "../packages/client/src/tool";
import { getJson, postJson, startBus, viewerSocket } from "./helpers";

let dataDir = "";
let bus: BusServerHandle;
const closers: Array<() => void> = [];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-handoff-"));
  bus = startBus({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol"] });
});

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await bus.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

interface TestAgent {
  id: string;
  tool: BusTool;
  next: () => Promise<Delivery>;
}

async function agent(name: string): Promise<TestAgent> {
  const queue: Delivery[] = [];
  let waiting: ((delivery: Delivery) => void) | undefined;
  const joined = Promise.withResolvers<string>();
  const conn = new BusConnection({
    url: bus.url,
    host: "h1",
    harness: "omp",
    path: `/tmp/handoff/${name}`,
    onJoined: (id) => joined.resolve(id),
    onDeliver: async (delivery) => {
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve(delivery);
      } else queue.push(delivery);
    },
  });
  conn.connect();
  closers.push(() => conn.close());
  const id = await joined.promise;
  const next = (): Promise<Delivery> => {
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    const { promise, resolve } = Promise.withResolvers<Delivery>();
    waiting = resolve;
    return promise;
  };
  return { id, tool: new BusTool(conn), next };
}

async function send(body: Record<string, unknown>): Promise<PostMessageResponse> {
  const res = await postJson(bus, "/api/messages", body);
  if (!res.ok) throw new Error(`POST /api/messages ${res.status}: ${await res.text()}`);
  return (await res.json()) as PostMessageResponse;
}

const handoff = (seq: number, from: string, to: unknown): Promise<Response> => postJson(bus, `/api/messages/${seq}/handoff`, { from, to });

/** carol's room with alpha and beta, where alpha wrote last: carol's next message naming nobody wakes alpha only. */
async function room(alpha: TestAgent, beta: TestAgent): Promise<PostMessageResponse> {
  const start = await send({ from: "carol", to: `@{${alpha.id},${beta.id}}`, text: "morning" });
  await alpha.next();
  await beta.next();
  await send({ from: alpha.id, replyToSeq: start.message.seq, text: "here", wake: [] });
  await beta.next();
  const ask = await send({ from: "carol", to: `@{${alpha.id},${beta.id}}`, text: "the CSS on the login page is off" });
  expect(ask.message.wake).toEqual([alpha.id]);
  return ask;
}

test("the woken agent passes a message on: the other agent is woken with it, nothing is written", async () => {
  const alpha = await agent("alpha");
  const beta = await agent("beta");
  const ask = await room(alpha, beta);
  const seq = ask.message.seq;

  const woken = await alpha.next();
  expect(woken.wake).toBe(true);
  // The footer offers the handoff, by name.
  expect(formatDelivery(woken, [], alpha.id).split("\n").at(-1)).toBe(
    `(You were woken for this; @beta here was not. If it is for @beta rather than you, message-bus op=handoff, message_id ${seq}, ` +
      "`wake` naming it passes it on without a message (then leave it to @beta); if @beta should act on what you write, reply " +
      `with \`wake\` naming it; otherwise reply only if needed. message-bus reply, message_id ${seq} → @{beta,carol}.)`
  );
  expect((await beta.next()).wake).toBe(false);

  const viewer = viewerSocket(bus, "carol");
  closers.push(() => viewer.close());
  const changed = Promise.withResolvers<Message>();
  viewer.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ViewerServerFrame;
    if (frame.type === "changed" && frame.message.seq === seq) changed.resolve(frame.message);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const page = (): Promise<MessagesResponse> => getJson<MessagesResponse>(bus, `/api/conversations/${ask.conversation.id}/messages`, "carol");
  const before = await page();

  expect(await alpha.tool.run({ op: "handoff", message_id: seq, wake: ["@beta"] }, "/tmp")).toBe(
    `#${seq} passed on to @beta: it starts their turn now. Nothing was written in the conversation; leave it to them. (you are @alpha)`
  );
  const passed = await beta.next();
  expect(passed.message.seq).toBe(seq);
  expect(passed.wake).toBe(true);
  expect(passed.handedBy).toBe(alpha.id);
  const text = formatDelivery(passed, [], beta.id);
  expect(text).toContain("(@alpha was woken for this and passed it on to you: it is yours to answer.)");
  // alpha, which passed, is not offered back.
  expect(text.split("\n").at(-1)).toBe(`(Reply only if they need something from you: message-bus reply, message_id ${seq} → @{alpha,carol}.)`);

  // The website shows the same message, now waking beta, and no new one.
  expect((await changed.promise).wake).toEqual([beta.id]);
  const after = await page();
  expect(after.messages.map((m) => m.seq)).toEqual(before.messages.map((m) => m.seq));

  // carol's follow-up reply to her own message now goes to beta, the agent it was handed to.
  const follow = await send({ from: "carol", replyToSeq: seq, text: "the button too" });
  expect(follow.message.wake).toEqual([beta.id]);
});

test("a handoff is checked before anything changes", async () => {
  const alpha = await agent("alpha");
  const beta = await agent("beta");
  const ask = await room(alpha, beta);
  const seq = ask.message.seq;
  await alpha.next();
  await beta.next();

  // Only an agent the message woke, to another agent it went to.
  expect((await handoff(seq, beta.id, [alpha.id])).status).toBe(409);
  expect(await (await handoff(seq, alpha.id, ["carol"])).text()).toContain("@carol is not another agent this message went to");
  expect((await handoff(seq, alpha.id, [alpha.id])).status).toBe(400);
  expect((await handoff(seq, alpha.id, [])).status).toBe(400);
  await expect(alpha.tool.run({ op: "handoff", message_id: seq }, "/tmp")).rejects.toThrow("handoff needs `message_id`");

  // An agent that is not connected now: refused, so the writer replies with `wake` and the Hub holds it.
  const gone = await send({ from: "carol", text: "and the footer", replyToSeq: seq });
  expect(gone.message.wake).toEqual([alpha.id]);
  closers.splice(1, 1)[0]?.();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const offline = await handoff(gone.message.seq, alpha.id, [beta.id]);
  expect(offline.status).toBe(409);
  expect(await offline.text()).toContain("@beta is not connected now. Nothing was changed");
  const stored = (await getJson<MessagesResponse>(bus, `/api/conversations/${ask.conversation.id}/messages`, "carol")).messages;
  expect(stored.find((m) => m.seq === gone.message.seq)?.wake).toEqual([alpha.id]);
});
