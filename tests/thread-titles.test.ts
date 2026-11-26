// Thread titles (Can #17615, #17636): until a thread has a title, each delivery that wakes an agent in it asks that
// agent (one per message) to title it; the `message-bus` op=title sets it (on the thread's root); the website gets the
// root again in a "changed" frame.
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
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-thread-titles-"));
  bus = startBus({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol"] });
});

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await bus.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

/** An agent on the bus through the shared client, as harnesses connect: its deliveries in order, and its tool. */
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
    path: `/tmp/threads/${name}`,
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

const title = (seq: number, from: string, text: string): Promise<Response> => postJson(bus, `/api/messages/${seq}/title`, { from, title: text });

/** carol's plan to alpha and beta, alpha's answer, carol's reply to it: a thread rooted at the plan. */
async function thread(alpha: TestAgent, beta: TestAgent): Promise<{ plan: PostMessageResponse; draft: PostMessageResponse }> {
  const plan = await send({ from: "carol", to: `@{${alpha.id},${beta.id}}`, text: "plan the release" });
  for (const delivery of [await alpha.next(), await beta.next()]) expect(delivery.titleThread).toBeUndefined();
  const draft = await send({ from: alpha.id, replyToSeq: plan.message.seq, text: "draft ready", wake: [] });
  // An agent answering is no thread yet: the person decides (Can #14532).
  expect((await beta.next()).titleThread).toBeUndefined();
  return { plan, draft };
}

test("woken agents are asked until the thread has a title; op=title names the thread on its root", async () => {
  const alpha = await agent("alpha");
  const beta = await agent("beta");
  const { plan, draft } = await thread(alpha, beta);
  const root = plan.message.seq;

  // carol's reply makes it a thread and wakes alpha (the agent it answers): alpha is asked; beta, quiet, is not.
  const reply = await send({ from: "carol", replyToSeq: draft.message.seq, text: "ship it after review" });
  const asked = await alpha.next();
  expect(asked.wake).toBe(true);
  expect(asked.titleThread).toBe(root);
  expect(formatDelivery(asked, [], alpha.id)).toContain(
    `(This thread has no title yet: give it one (3-6 words) with message-bus op=title, message_id ${root}, value "…".)`
  );
  const quiet = await beta.next();
  expect(quiet.wake).toBe(false);
  expect(quiet.titleThread).toBeUndefined();
  expect(formatDelivery(quiet, [], beta.id)).not.toContain("no title yet");

  // The ask was ignored: the next woken delivery in the still untitled thread asks again (Can #17636).
  const again = await send({ from: "carol", replyToSeq: reply.message.seq, text: "and tag it" });
  expect((await alpha.next()).titleThread).toBe(root);
  await beta.next();

  // The tool takes any message of the thread and titles its root; open pages get the root as it is now.
  const viewer = viewerSocket(bus, "carol");
  closers.push(() => viewer.close());
  const changed = Promise.withResolvers<Message>();
  viewer.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ViewerServerFrame;
    if (frame.type === "changed") changed.resolve(frame.message);
  });
  const opened = Promise.withResolvers<void>();
  viewer.addEventListener("open", () => opened.resolve(), { once: true });
  await opened.promise;
  expect(await alpha.tool.run({ op: "title", message_id: again.message.seq, value: "  Release review plan " }, "/tmp")).toBe(
    `Thread #${root} titled "Release review plan". (you are @${alpha.id})`
  );
  expect(await changed.promise).toMatchObject({ seq: root, threadTitle: "Release review plan" });
  const page = await getJson<MessagesResponse>(bus, `/api/conversations/${plan.conversation.id}/messages`, "carol");
  expect(page.messages.filter((m) => m.threadTitle).map((m) => [m.seq, m.threadTitle])).toEqual([[root, "Release review plan"]]);

  // A later title replaces it; a person may set it too.
  const res = await title(root, "carol", "Release: final review");
  expect(res.status).toBe(200);
  const body: { message: Message } = await res.json();
  expect(body.message).toMatchObject({ seq: root, threadTitle: "Release: final review" });

  // Titled: woken deliveries in the thread no longer ask.
  await send({ from: "carol", replyToSeq: again.message.seq, text: "one more thing" });
  const after = await alpha.next();
  expect(after.wake).toBe(true);
  expect(after.titleThread).toBeUndefined();
  expect(formatDelivery(after, [], alpha.id)).not.toContain("no title yet");
  await beta.next();
});

test("two agents woken by the same reply: only one is asked", async () => {
  const alpha = await agent("alpha");
  const beta = await agent("beta");
  const { draft } = await thread(alpha, beta);
  await send({ from: "carol", replyToSeq: draft.message.seq, text: `@${alpha.id} @${beta.id} both of you, please` });
  const deliveries = [await alpha.next(), await beta.next()];
  expect(deliveries.map((d) => d.wake)).toEqual([true, true]);
  expect(deliveries.filter((d) => d.titleThread !== undefined)).toHaveLength(1);
});

test("titles are checked: one line, at most 80 characters, in a thread, by someone who may read it", async () => {
  const alpha = await agent("alpha");
  const beta = await agent("beta");
  const gamma = await agent("gamma");
  const { plan, draft } = await thread(alpha, beta);
  // Not a thread yet (only an agent answered).
  expect((await title(draft.message.seq, "carol", "Release plan")).status).toBe(409);
  await send({ from: "carol", replyToSeq: draft.message.seq, text: "ok" });
  expect((await title(plan.message.seq, alpha.id, "x".repeat(81))).status).toBe(400);
  expect((await title(plan.message.seq, alpha.id, "two\nlines")).status).toBe(400);
  expect((await title(plan.message.seq, alpha.id, "   ")).status).toBe(400);
  // gamma is not in the group DM: it cannot read the thread, so it cannot title it.
  expect((await title(plan.message.seq, gamma.id, "Release plan")).status).toBe(404);
  await expect(alpha.tool.run({ op: "title", message_id: plan.message.seq }, "/tmp")).rejects.toThrow("title needs `message_id`");
  expect((await title(plan.message.seq, alpha.id, "x".repeat(80))).status).toBe(200);
});
