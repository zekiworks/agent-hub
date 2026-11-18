import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isJsonObject, mentionedIds, slugFromTitle, titledLabel } from "@agent-bus/protocol";
import { BusDatabase } from "../packages/server/src/db";
import type {
  AgentServerFrame,
  Checklist,
  TasksResponse,
  Conversation,
  FileRef,
  Message,
  MessagesResponse,
  Participant,
  PostMessageResponse,
  SharedFilesResponse,
  StateResponse,
  ViewerServerFrame,
} from "@agent-bus/protocol";
import type { BusServerHandle } from "@agent-bus/server";
import { agentSocketUrl, busFetch, getJson, identity, postJson, startBus } from "./helpers";

type Frame = AgentServerFrame | ViewerServerFrame;
type DeliverFrame = Extract<AgentServerFrame, { type: "deliver" }>;

/** A real WebSocket client that queues frames so tests can await them in order. */
class Client {
  private readonly queue: Frame[] = [];
  private waiter: { type: Frame["type"]; resolve: (frame: Frame) => void } | null = null;
  private readonly closed = Promise.withResolvers<void>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      if (this.waiter && this.waiter.type === frame.type) {
        const { resolve } = this.waiter;
        this.waiter = null;
        resolve(frame);
        return;
      }
      this.queue.push(frame);
    });
    ws.addEventListener("close", () => this.closed.resolve());
  }

  static async connect(url: string, headers?: Record<string, string>): Promise<Client> {
    const ws = new WebSocket(url, headers ? ({ headers } as never) : undefined);
    const client = new Client(ws);
    const opened = Promise.withResolvers<void>();
    ws.addEventListener("open", () => opened.resolve(), { once: true });
    ws.addEventListener("error", () => opened.reject(new Error(`WebSocket ${url} failed`)), { once: true });
    await opened.promise;
    return client;
  }

  /** Removes and returns the first frame of `type`, waiting for it if none is queued. */
  take<T extends Frame["type"]>(type: T): Promise<Extract<Frame, { type: T }>> {
    const index = this.queue.findIndex((frame) => frame.type === type);
    if (index >= 0) {
      const [frame] = this.queue.splice(index, 1);
      return Promise.resolve(frame as Extract<Frame, { type: T }>);
    }
    const { promise, resolve } = Promise.withResolvers<Frame>();
    this.waiter = { type, resolve };
    return promise as Promise<Extract<Frame, { type: T }>>;
  }

  /** Frames of `type` received and not taken yet. */
  queued(type: Frame["type"]): number {
    return this.queue.filter((frame) => frame.type === type).length;
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  get closedPromise(): Promise<void> {
    return this.closed.promise;
  }

  async close(): Promise<void> {
    this.ws.close();
    await this.closed.promise;
  }
}

let dataDir = "";
let bus: BusServerHandle;
const clients: Client[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-server-test-"));
  bus = startBus({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol", "uma"] });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await bus.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const wsUrl = (route: string): string => `${bus.url.replace(/^http/, "ws")}${route}`;

async function joinAgent(query: Record<string, string>): Promise<{ client: Client; id: string }> {
  const client = await Client.connect(agentSocketUrl(bus, query));
  clients.push(client);
  const joined = await client.take("joined");
  return { client, id: joined.id };
}

const joinPath = (projectPath: string, host = "h1") => joinAgent({ host, harness: "omp", path: projectPath });

async function leave(client: Client): Promise<void> {
  clients.splice(clients.indexOf(client), 1);
  await client.close();
}

function post(body: Record<string, unknown>): Promise<Response> {
  return postJson(bus, "/api/messages", body);
}

async function send(body: Record<string, unknown>): Promise<PostMessageResponse> {
  const res = await post(body);
  if (!res.ok) throw new Error(`POST /api/messages ${res.status}: ${await res.text()}`);
  return (await res.json()) as PostMessageResponse;
}

function setSetting(from: string, key: string, value: unknown): Promise<Response> {
  return postJson(bus, "/api/settings", { from, key, value });
}

/** GET /api/state as `as` (a person: what they see), else as the test agent token (what agents may read). */
function state(as?: string): Promise<StateResponse> {
  return getJson<StateResponse>(bus, "/api/state", as);
}

/** A viewer signed in at upgrade with a human's session. */
async function connectViewer(): Promise<Client> {
  const viewer = await Client.connect(wsUrl("/ws/viewer"), identity(bus, "carol"));
  clients.push(viewer);
  return viewer;
}

/** The conversation a /api/conversations/:id/… answer carries (400 etc. throw with the bus's error). */
async function answeredConversation(res: Response): Promise<Conversation> {
  const body: unknown = await res.json();
  if (!res.ok || !isJsonObject(body) || !isJsonObject(body.conversation)) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  // The bus's ConversationResponse; its shape is what these tests check.
  const conversation = body.conversation as unknown as Conversation;
  return conversation;
}

async function errorOf(res: Response): Promise<string> {
  const body: unknown = await res.json();
  if (!isJsonObject(body) || typeof body.error !== "string") throw new Error(`No error in ${JSON.stringify(body)}`);
  return body.error;
}

describe("agent ids", () => {
  test("id comes from the folder and is stable for the same host+path", async () => {
    const first = await joinPath("/tmp/x/alpha");
    expect(first.id).toBe("alpha");
    await leave(first.client);
    const again = await joinPath("/tmp/x/alpha");
    expect(again.id).toBe("alpha");
  });

  test("a machine whose host name changes domain or case (MacBook-Pro-2.local → macbook-pro-2.home) keeps its agents' ids", async () => {
    const first = await joinPath("/Users/someone/code/proj", "MacBook-Pro-2.local");
    expect(first.id).toBe("proj");
    await send({ from: "carol", to: "@proj", text: "taking part" }); // agents that took part are kept when they leave
    await leave(first.client);
    const again = await joinPath("/Users/someone/code/proj", "macbook-pro-2.home");
    expect(again.id).toBe("proj");
    // Another machine with the same folder is still another agent.
    expect((await joinPath("/Users/someone/code/proj", "other-mac.home")).id).not.toBe("proj");
  });

  test("an id already held is qualified by the first part of the address that differs", async () => {
    const a = await joinPath("/tmp/a/proj");
    const b = await joinPath("/tmp/b/proj");
    expect(a.id).toBe("proj");
    expect(b.id).toBe("proj@b");
    const mac = await joinPath("/Users/someone/code/proj", "macbook-pro-2.home");
    expect(mac.id).toBe("proj@macbook-pro-2");
    // Same qualifier again (a third tree under /tmp/b): numeric suffix.
    const deeper = await joinPath("/tmp/b/x/proj");
    expect(deeper.id).toBe("proj@b-2");
    // The qualified id is an address like any other.
    const sent = await send({ from: "carol", to: "@{proj@macbook-pro-2,proj}", text: "both of you" });
    expect(sent.conversation.addressed).toEqual(["carol", "proj", "proj@macbook-pro-2"]);
    expect((await mac.client.take("deliver")).replyTo).toBe("@{carol,proj}");
  });

  test("human ids are never taken by agents", async () => {
    const agent = await joinPath("/home/someone/carol");
    expect(agent.id).toBe("carol@h1");
    const participants = (await state()).participants;
    expect(participants.find((p) => p.id === "carol")?.kind).toBe("human");
  });

  test("name joins are stable per host and coexist with path joins", async () => {
    const bot = await joinAgent({ host: "hostb", harness: "hermes", name: "hermes-bot" });
    expect(bot.id).toBe("hermes-bot");
    const folder = await joinPath("/srv/hermes-bot", "hostb");
    expect(folder.id).toBe("hermes-bot@srv");
    const otherHost = await joinAgent({ host: "h2", harness: "hermes", name: "hermes-bot" });
    expect(otherHost.id).toBe("hermes-bot@h2");
    await leave(bot.client);
    const again = await joinAgent({ host: "hostb", harness: "hermes", name: "hermes-bot" });
    expect(again.id).toBe("hermes-bot");

    const participant = (await state()).participants.find((p) => p.id === "hermes-bot");
    expect(participant?.harness).toBe("hermes");
    expect(participant?.host).toBe("hostb");
    expect(participant?.path).toBeUndefined();
    expect(participant?.online).toBe(true);
  });

  test("a join without exactly one of path/name gets an error frame and is closed", async () => {
    const both = await Client.connect(wsUrl("/ws/agent?host=h1&path=/tmp/x/a&name=a"));
    expect((await both.take("error")).error).toContain("exactly one");
    await both.closedPromise;
    const neither = await Client.connect(wsUrl("/ws/agent?host=h1"));
    expect((await neither.take("error")).error).toContain("exactly one");
    await neither.closedPromise;
  });
});

describe("sessions and harnesses", () => {
  const session = (path: string, key: string, harness = "omp") => joinAgent({ host: "h1", harness, path, session: key });
  const settle = () => Bun.sleep(80);

  test("two windows of one agent are sessions 1 and 2; a message goes to the most recently active one only", async () => {
    const one = await session("/tmp/x/alpha", "k1");
    const two = await session("/tmp/x/alpha", "k2");
    expect(two.id).toBe(one.id);
    const alpha = (await state()).participants.find((p) => p.id === "alpha");
    expect(alpha?.sessions?.map((s) => s.n)).toEqual([1, 2]);

    // The later join is the most recent: only it gets the message.
    const first = await send({ from: "carol", to: "@alpha", text: "first" });
    expect((await two.client.take("deliver")).message.id).toBe(first.message.id);
    await settle();
    expect(one.client.queued("deliver")).toBe(0);

    // Session 1 starts working: it is the one in use now.
    one.client.send({ type: "status", status: { state: "busy", since: Date.now() } });
    await settle();
    const second = await send({ from: "carol", conversationId: first.conversation.id, text: "second" });
    expect((await one.client.take("deliver")).message.id).toBe(second.message.id);

    // Naming a session reaches that one, in the same conversation; so does the website's picker.
    const named = await send({ from: "carol", to: "@alpha-2", text: "to two" });
    expect(named.conversation.id).toBe(first.conversation.id);
    expect(named.message.receipts).toEqual([{ to: "alpha", session: 2, deliveredAt: null, seenAt: null }]);
    expect((await two.client.take("deliver")).message.text).toBe("to two");
    await send({ from: "carol", conversationId: first.conversation.id, text: "picked", toSession: 2 });
    expect((await two.client.take("deliver")).message.text).toBe("picked");
    await settle();
    expect(one.client.queued("deliver")).toBe(0);
  });

  test("a session keeps its number across a reconnect; a new session takes the lowest free one", async () => {
    const one = await session("/tmp/x/alpha", "k1");
    const two = await session("/tmp/x/alpha", "k2");
    await leave(one.client);
    const back = await joinAgent({ host: "h1", harness: "omp", path: "/tmp/x/alpha", session: "k1" });
    expect(((await back.client.take("participants")) && (await state())).participants.find((p) => p.id === "alpha")?.sessions?.map((s) => s.n)).toEqual([1, 2]);
    const third = await Client.connect(agentSocketUrl(bus, { host: "h1", harness: "omp", path: "/tmp/x/alpha", session: "k3" }));
    clients.push(third);
    expect((await third.take("joined")).session).toBe(3);
    await leave(two.client);
    const fourth = await Client.connect(agentSocketUrl(bus, { host: "h1", harness: "omp", path: "/tmp/x/alpha", session: "k4" }));
    clients.push(fourth);
    // Session 2's number is held a minute for its own reconnect, so a new session does not take it.
    expect((await fourth.take("joined")).session).toBe(4);
  });

  test("a delivery not acked by a session that goes away is handed to the next one", async () => {
    const one = await session("/tmp/x/alpha", "k1");
    const two = await session("/tmp/x/alpha", "k2");
    const { message } = await send({ from: "carol", to: "@alpha", text: "do this" });
    expect((await two.client.take("deliver")).message.id).toBe(message.id);
    await leave(two.client);
    const handed = await one.client.take("deliver");
    expect(handed.message.id).toBe(message.id);
    one.client.send({ type: "ack", seq: message.seq });
    await settle();
    // Acked by now: a new session gets no backlog of it.
    const three = await session("/tmp/x/alpha", "k3");
    await settle();
    expect(three.client.queued("deliver")).toBe(0);
  });

  test("an agent's message names its session while it has several; a reply goes back to that session", async () => {
    const one = await session("/tmp/x/alpha", "k1");
    const two = await session("/tmp/x/alpha", "k2");
    const asked = (await (
      await busFetch(bus, "/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-Session": "k1" },
        body: JSON.stringify({ from: "alpha", to: "@carol", text: "a question from window 1" }),
      })
    ).json()) as PostMessageResponse;
    expect(asked.message.fromSession).toBe(1);
    await send({ from: "carol", replyToSeq: asked.message.seq, text: "the answer" });
    expect((await one.client.take("deliver")).message.text).toBe("the answer");
    await settle();
    expect(two.client.queued("deliver")).toBe(0);
  });

  test("another harness in the same folder is a separate agent, named after its harness", async () => {
    const omp = await joinAgent({ host: "h1", harness: "omp", path: "/tmp/x/alpha" });
    const codex = await joinAgent({ host: "h1", harness: "codex", path: "/tmp/x/alpha" });
    expect(omp.id).toBe("alpha");
    expect(codex.id).toBe("alpha-codex");
    await send({ from: "carol", to: "@alpha", text: "for omp" });
    expect((await omp.client.take("deliver")).message.text).toBe("for omp");
    await settle();
    expect(codex.client.queued("deliver")).toBe(0);
    // The same harness again is the same agent.
    const again = await joinAgent({ host: "h1", harness: "codex", path: "/tmp/x/alpha" });
    expect(again.id).toBe("alpha-codex");
  });

  test("a viewer gets the live output of the most recently active session, or the one it names", async () => {
    const one = await session("/tmp/x/alpha", "k1");
    const two = await session("/tmp/x/alpha", "k2");
    const viewer = await connectViewer();
    await viewer.take("participants");
    viewer.send({ type: "watch", agentId: "alpha" });
    await one.client.take("watch");
    await two.client.take("watch");
    const entry = (text: string) => ({ type: "activity", events: [{ id: text, at: Date.now(), kind: "user", text }] });
    one.client.send(entry("from one"));
    two.client.send(entry("from two"));
    const got = await viewer.take("activity");
    expect(got.events.map((e) => (e.kind === "user" ? e.text : ""))).toEqual(["from two"]);
    viewer.send({ type: "watch", agentId: "alpha", session: 1 });
    await one.client.take("watch");
    one.client.send(entry("one again"));
    two.client.send(entry("two again"));
    const named = await viewer.take("activity");
    expect(named.events.map((e) => (e.kind === "user" ? e.text : ""))).toEqual(["one again"]);
  });
});

describe("delivery", () => {
  test("a person's message wakes its DM's agent; elsewhere those it mentions, the answered agent when needed", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const both = async () => ({ alpha: (await alpha.client.take("deliver")).wake, beta: (await beta.client.take("deliver")).wake });
    // Nobody else has written here yet: the conversation was started with them, so all its agents.
    await send({ from: "carol", to: "@all", text: "hello" });
    expect(await both()).toEqual({ alpha: true, beta: true });
    // Then it answers the previous message's author.
    const asked = await send({ from: alpha.id, to: "@all", text: "anyone?", wake: [] });
    await beta.client.take("deliver");
    await send({ from: "carol", to: "@all", text: "me" });
    expect(await both()).toEqual({ alpha: true, beta: false });
    // A mentioned member, who has the context: only it.
    await send({ from: "carol", to: "@all", text: "@beta look" });
    expect(await both()).toEqual({ alpha: false, beta: true });
    // A reply answers its message's author, whoever wrote last.
    await send({ from: "carol", replyToSeq: asked.message.seq, text: "again" });
    expect(await both()).toEqual({ alpha: true, beta: false });
    // "@all" in the text wakes every agent of the conversation.
    await send({ from: "carol", to: "@all", text: "@all stop your runs" });
    expect(await both()).toEqual({ alpha: true, beta: true });
    // A DM wakes its agent.
    await send({ from: "carol", to: "@beta", text: "dm" });
    expect((await beta.client.take("deliver")).wake).toBe(true);
  });

  test("a person calling in an agent new to the conversation also wakes the one it answers; a mention reaching nobody wakes that one", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const group = await send({ from: "carol", to: "@{alpha,uma}", text: "plan" });
    await alpha.client.take("deliver");
    await send({ from: alpha.id, conversationId: group.conversation.id, text: "my plan", wake: [] });
    // "Send only": beta is not added, so the mention reaches nobody and alpha, who has the context, is woken.
    const only = await send({ from: "carol", conversationId: group.conversation.id, text: "I thought @beta would do that" });
    expect(only.message.wake).toEqual(["alpha"]);
    await alpha.client.take("deliver");
    // "Add and send": beta joins with the last messages, and both are woken.
    const added = await send({ from: "carol", conversationId: group.conversation.id, text: "@beta would do that", addMentioned: true });
    expect(added.message.wake).toEqual(["alpha", "beta"]);
  });

  test("a person replying to a message of a DM they are not in writes in the group DM of its members and them, quoting it", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const dm = await send({ from: alpha.id, to: "@beta", text: "about carol's plan", wake: ["beta"] });
    await beta.client.take("deliver");
    const reply = await send({ from: "carol", replyToSeq: dm.message.seq, text: "that's my call" });
    expect(reply.conversation).toMatchObject({ kind: "group", members: ["alpha", "beta", "carol"] });
    expect(reply.message.quote?.seq).toBe(dm.message.seq);
    expect(reply.message.wake).toEqual(["alpha"]); // it answers alpha
    // Again: the same group, not a new one.
    expect((await send({ from: "carol", replyToSeq: dm.message.seq, text: "and" })).conversation.id).toBe(reply.conversation.id);
  });

  test("an agent's message wakes those it lists and the agent it replies to; members only; no list: the old rule", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const gamma = await joinPath("/tmp/x/gamma");
    const group = await send({ from: alpha.id, to: "@{beta,gamma}", text: "plan", wake: ["@Beta"] });
    expect(group.message.wake).toEqual(["beta"]);
    expect((await beta.client.take("deliver")).wake).toBe(true);
    expect((await gamma.client.take("deliver")).wake).toBe(false);
    const reply = await send({ from: gamma.id, replyToSeq: group.message.seq, text: "ok", wake: [] });
    expect(reply.message.wake).toEqual(["alpha"]);
    await beta.client.take("deliver");
    expect((await alpha.client.take("deliver")).wake).toBe(true);
    // An @mention alone wakes nobody; the writer is told.
    const mention = await send({ from: alpha.id, conversationId: group.conversation.id, text: "@gamma see above", wake: [] });
    expect(mention.warnings).toEqual(["@gamma is mentioned but not in wake: it reads this at its next turn, no turn now"]);
    await beta.client.take("deliver");
    expect((await gamma.client.take("deliver")).wake).toBe(false);
    // Only agents of the conversation; nothing is sent otherwise.
    expect((await postJson(bus, "/api/messages", { from: alpha.id, conversationId: group.conversation.id, text: "x", wake: ["carol"] })).status).toBe(400);
    // A muted member is never woken, even when listed.
    await postJson(bus, `/api/conversations/${group.conversation.id}/notify`, { from: beta.id, level: "none" });
    await send({ from: alpha.id, conversationId: group.conversation.id, text: "y", wake: ["beta", "gamma"] });
    expect((await beta.client.take("deliver")).wake).toBe(false);
    expect((await gamma.client.take("deliver")).wake).toBe(true);
    // An older tool sends no list: the old rule (a group wakes its members).
    const old = await send({ from: alpha.id, conversationId: group.conversation.id, text: "z" });
    expect(old.message.wake).toBeUndefined();
    expect((await gamma.client.take("deliver")).wake).toBe(true);
  });

  test("@all from an agent is quiet by default and wakes after the setting", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");

    await send({ from: beta.id, to: "@all", text: "quiet one" });
    expect((await alpha.client.take("deliver")).wake).toBe(false);

    const res = await setSetting(alpha.id, "all", "wake");
    expect(res.status).toBe(200);
    const { participant } = (await res.json()) as { participant: Participant };
    expect(participant.settings.all).toBe("wake");

    await send({ from: beta.id, to: "@all", text: "loud one" });
    expect((await alpha.client.take("deliver")).wake).toBe(true);
  });

  test("invalid settings name the valid ones", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const badKey = await setSetting(alpha.id, "volume", "wake");
    expect(badKey.status).toBe(400);
    expect(await errorOf(badKey)).toContain("all");
    const badValue = await setSetting(alpha.id, "all", "loud");
    expect(badValue.status).toBe(400);
    const error = await errorOf(badValue);
    expect(error).toContain("wake");
    expect(error).toContain("quiet");
  });

  test("the writer never receives its own message", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    await send({ from: alpha.id, to: "@all", text: "mine" });
    await send({ from: alpha.id, to: `@${beta.id}`, text: "mine too" });
    const sentinel = await send({ from: "carol", to: "@all", text: "sentinel" });
    expect((await alpha.client.take("deliver")).message.id).toBe(sentinel.message.id);
  });

  test("an agent's own name at the start of its message is dropped (the bus shows the sender); others' names stay", async () => {
    await joinPath("/tmp/x/alpha");
    expect((await send({ from: "alpha", to: "@carol", text: "alpha: run 7 is done" })).message.text).toBe("run 7 is done");
    expect((await send({ from: "alpha", to: "@carol", text: "@Alpha – again" })).message.text).toBe("again");
    expect((await send({ from: "alpha", to: "@carol", text: "beta: said hi" })).message.text).toBe("beta: said hi");
    expect((await send({ from: "alpha", to: "@carol", text: "alpha is idle" })).message.text).toBe("alpha is idle");
    expect((await send({ from: "carol", to: "@alpha", text: "carol: from a human, kept" })).message.text).toBe("carol: from a human, kept");
  });

  test("@x is a DM, @{a,b} the group DM with exactly those members; both are reused, and the two never mix", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const first = await send({ from: "carol", to: "@{beta,alpha}", text: "one" });
    const second = await send({ from: "carol", to: "@{alpha, beta}", text: "two" });
    expect(first.conversation.id).toBe(second.conversation.id);
    expect(first.conversation.kind).toBe("group");
    expect(first.conversation.members).toEqual(["alpha", "beta", "carol"]);
    // Old clients read `addressed`: it stays, equal to the members.
    expect(first.conversation.addressed).toEqual(["alpha", "beta", "carol"]);
    const toAlpha = await alpha.client.take("deliver");
    expect(toAlpha.replyTo).toBe("@{beta,carol}");
    expect((await beta.client.take("deliver")).replyTo).toBe("@{alpha,carol}");

    // The same agents without the person: their own DM, not the group.
    const direct = await send({ from: alpha.id, to: "@beta", text: "direct" });
    expect(direct.conversation.kind).toBe("dm");
    expect(direct.conversation.id).not.toBe(first.conversation.id);
    expect(direct.conversation.members).toEqual(["alpha", "beta"]);
    // A person's DM with an agent is another conversation again, reused both ways.
    const dm = await send({ from: "carol", to: "@alpha", text: "dm" });
    expect(dm.conversation.kind).toBe("dm");
    expect((await send({ from: alpha.id, to: "@carol", text: "back" })).conversation.id).toBe(dm.conversation.id);
  });

  test("a DM is fixed at two: writing in it from outside goes to a group DM (people) or is refused (agents); nobody leaves", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const gamma = await joinPath("/tmp/x/gamma");
    const started = await send({ from: alpha.id, to: `@${beta.id}`, text: "hi beta" });
    expect((await beta.client.take("deliver")).replyTo).toBe("@alpha");
    const person = await send({ from: "uma", conversationId: started.conversation.id, text: "did you read this?" });
    expect(person.conversation).toMatchObject({ kind: "group", members: ["alpha", "beta", "uma"] });
    const agent = await post({ from: gamma.id, conversationId: started.conversation.id, text: "me too" });
    expect(agent.status).toBe(403);
    expect(await errorOf(agent)).toContain("not in this DM");
    const left = await postJson(bus, `/api/conversations/${started.conversation.id}/leave`, { from: alpha.id });
    expect(left.status).toBe(400);
    // An agent saying "exit" in a DM is an ordinary message.
    const exit = await send({ from: alpha.id, conversationId: started.conversation.id, text: "exit" });
    expect(exit.message.receipts.map((r) => r.to)).toEqual(["beta"]);
  });

  test("@@name creates an open project; others join by writing; replies use @@name; names are not participant ids", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const created = await send({ from: "carol", to: "@@turkish-reading", text: "starting" });
    expect(created.conversation).toMatchObject({ kind: "project", name: "turkish-reading", visibility: "open", members: ["carol"] });
    expect(created.message.receipts).toEqual([]);

    const joined = await send({ from: alpha.id, to: "@@turkish-reading", text: "alpha joins" });
    expect(joined.conversation.id).toBe(created.conversation.id);
    expect(joined.conversation.members).toEqual(["alpha", "carol"]);
    // Joining, alpha first gets the messages before it.
    expect((await alpha.client.take("deliver")).message.text).toBe("starting");
    // Writing by id joins an open project too.
    await send({ from: beta.id, conversationId: created.conversation.id, text: "beta joins" });
    const toAlpha = await alpha.client.take("deliver");
    expect(toAlpha.message.text).toBe("beta joins");
    expect(toAlpha.replyTo).toBe("@@turkish-reading");

    // A participant's id is that participant's own project name: carol cannot take @@alpha, alpha can, others join it.
    expect((await post({ from: "carol", to: "@@alpha", text: "x" })).status).toBe(400);
    const own = await send({ from: alpha.id, to: "@@alpha", text: "alpha's own project" });
    expect(own.conversation).toMatchObject({ kind: "project", name: "alpha" });
    expect((await send({ from: "carol", to: "@@alpha", text: "joining alpha's project" })).conversation.id).toBe(own.conversation.id);
    expect((await post({ from: "carol", to: "@@Not A Name", text: "x" })).status).toBe(400);
  });

  test("adding members: a member adds anyone, an agent gets the last 5 messages first; mentions add only with addMentioned, from people", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const first = await send({ from: "carol", to: "@@review", text: "m1" });
    await send({ from: alpha.id, to: "@@review", text: "m2" });
    for (const text of ["m3", "m4", "m5", "m6"]) await send({ from: "carol", conversationId: first.conversation.id, text });
    const beta = await joinPath("/tmp/x/beta");
    const gamma = await joinPath("/tmp/x/gamma");

    // Named in passing (no addMentioned): nobody is added.
    const named = await send({ from: "carol", conversationId: first.conversation.id, text: "@beta might know" });
    expect(named.conversation.members).toEqual(["alpha", "carol"]);
    // "Add and send": beta joins and gets the last 5 earlier messages, then this one.
    const invite = await send({ from: "carol", conversationId: first.conversation.id, text: "@beta can you look?", addMentioned: true });
    expect(invite.conversation.members).toEqual(["alpha", "beta", "carol"]);
    const toBeta: string[] = [];
    for (let i = 0; i < 6; i++) toBeta.push((await beta.client.take("deliver")).message.text);
    expect(toBeta).toEqual(["m3", "m4", "m5", "m6", "@beta might know", "@beta can you look?"]);
    // Agents' mentions never add, even when they ask.
    const byAgent = await send({ from: alpha.id, conversationId: first.conversation.id, text: "@gamma could do this", addMentioned: true });
    expect(byAgent.conversation.members).toEqual(["alpha", "beta", "carol"]);
    // Any member (an agent too) adds explicitly.
    const added = await postJson(bus, `/api/conversations/${first.conversation.id}/members`, { from: alpha.id, ids: ["gamma"] });
    expect(added.status).toBe(200);
    expect((await answeredConversation(added)).members).toEqual(["alpha", "beta", "carol", "gamma"]);
    // The last 5 before it joined: m5, m6 and the three about beta and gamma.
    expect((await gamma.client.take("deliver")).message.text).toBe("m5");
    // Not a member: cannot add.
    expect((await postJson(bus, `/api/conversations/${first.conversation.id}/members`, { from: "uma", ids: ["uma"] })).status).toBe(403);
  });

  test("leaving: an agent's bare exit or op leave; a group DM keeps its id when members change", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const group = await send({ from: "carol", to: "@{alpha,beta}", text: "hello both" });
    await alpha.client.take("deliver");
    await beta.client.take("deliver");
    const exit = await send({ from: alpha.id, conversationId: group.conversation.id, text: "exit" });
    expect(exit.conversation.id).toBe(group.conversation.id);
    expect(exit.conversation.members).toEqual(["beta", "carol"]);
    expect(exit.message.receipts).toEqual([]);
    const next = await send({ from: "carol", conversationId: group.conversation.id, text: "only beta now" });
    expect(next.message.receipts.map((r) => r.to)).toEqual(["beta"]);
    expect((await postJson(bus, `/api/conversations/${group.conversation.id}/leave`, { from: "carol" })).status).toBe(200);
    // A person's "exit" is a message, not a leave (they use the website's Leave).
    const word = await send({ from: "uma", to: "@{alpha,beta}", text: "exit" });
    expect(word.conversation.members).toContain("uma");
  });

  test("notify none mutes a member: never woken, even when answered or mentioned; DMs cannot be muted", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const project = await send({ from: "carol", to: "@@notify-test", text: "start" });
    await send({ from: alpha.id, to: "@@notify-test", text: "in" });
    expect((await alpha.client.take("deliver")).message.text).toBe("start"); // context on joining
    await send({ from: "carol", conversationId: project.conversation.id, text: "@alpha look" });
    expect((await alpha.client.take("deliver")).wake).toBe(true);
    const set = await postJson(bus, `/api/conversations/${project.conversation.id}/notify`, { from: alpha.id, level: "none" });
    expect((await answeredConversation(set)).notify).toEqual({ alpha: "none" });
    await send({ from: "carol", conversationId: project.conversation.id, text: "@alpha again" });
    expect((await alpha.client.take("deliver")).wake).toBe(false);
    const dm = await send({ from: "carol", to: "@alpha", text: "dm" });
    expect((await postJson(bus, `/api/conversations/${dm.conversation.id}/notify`, { from: alpha.id, level: "none" })).status).toBe(400);
    expect((await alpha.client.take("deliver")).wake).toBe(true);
  });

  test("a group DM becomes a project with its members and history; projects can be private; archiving", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const group = await send({ from: "carol", to: "@{alpha,uma}", text: "plan" });
    await alpha.client.take("deliver");
    const turned = await postJson(bus, `/api/conversations/${group.conversation.id}/project`, { from: alpha.id, name: "plan", topic: "the plan" });
    expect(await answeredConversation(turned)).toMatchObject({
      id: group.conversation.id, kind: "project", name: "plan", topic: "the plan", visibility: "open", members: ["alpha", "carol", "uma"],
    });
    // Only people rename; anyone in it changes visibility.
    expect((await postJson(bus, `/api/conversations/${group.conversation.id}/project`, { from: alpha.id, name: "other" })).status).toBe(403);
    await postJson(bus, `/api/conversations/${group.conversation.id}/project`, { from: "carol", visibility: "private" });
    const beta = await joinPath("/tmp/x/beta");
    expect((await post({ from: beta.id, to: "@@plan", text: "let me in" })).status).toBe(403);
    expect((await post({ from: beta.id, conversationId: group.conversation.id, text: "let me in" })).status).toBe(403);

    // Archived: an agent's message is refused, a person's brings it back.
    expect((await postJson(bus, `/api/conversations/${group.conversation.id}/archive`, { from: alpha.id, archived: true })).status).toBe(403);
    await postJson(bus, `/api/conversations/${group.conversation.id}/archive`, { from: "carol", archived: true });
    expect((await post({ from: alpha.id, to: "@@plan", text: "still here" })).status).toBe(409);
    const back = await send({ from: "uma", to: "@@plan", text: "back" });
    expect(back.conversation.archived).toBeUndefined();
  });

  test("who sees what: people's DMs stay with them; agents' conversations are readable by people; discoverable projects are previews", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const umasDm = await send({ from: "uma", to: "@alpha", text: "between us" });
    const agents = await send({ from: alpha.id, to: "@beta", text: "agents only" });
    const hidden = await send({ from: "uma", to: "@@quiet", text: "q" });
    await postJson(bus, `/api/conversations/${hidden.conversation.id}/project`, { from: "uma", visibility: "discoverable" });

    const carol = await state("carol");
    const ids = carol.conversations.map((c: Conversation) => c.id);
    expect(ids).not.toContain(umasDm.conversation.id);
    expect(ids).toContain(agents.conversation.id);
    expect(carol.conversations.find((c: Conversation) => c.id === hidden.conversation.id)?.preview).toBe(true);
    expect((await busFetch(bus, `/api/conversations/${umasDm.conversation.id}/messages`, {}, "carol")).status).toBe(404);
    expect((await busFetch(bus, `/api/conversations/${hidden.conversation.id}/messages`, {}, "carol")).status).toBe(404);
    expect((await busFetch(bus, `/api/conversations/${agents.conversation.id}/messages`, {}, "carol")).status).toBe(200);

    // An agent with scope=all reads other agents' conversations, never a person's DM.
    const gamma = await joinPath("/tmp/x/gamma");
    const history = (id: string) => busFetch(bus, `/api/history?from=${gamma.id}&conversationId=${id}&scope=all`);
    expect((await history(agents.conversation.id)).status).toBe(200);
    expect((await history(umasDm.conversation.id)).status).toBe(403);
    void beta;
  });

  test("projects and group DMs go under a root project, one level only; DMs and non-projects cannot be parents", async () => {
    await joinPath("/tmp/x/alpha");
    const root = await send({ from: "carol", to: "@@benchmarks", text: "root" });
    const child = await send({ from: "carol", to: "@@reading", text: "child" });
    const group = await send({ from: "carol", to: "@{alpha,uma}", text: "a group" });
    const dm = await send({ from: "carol", to: "@alpha", text: "a dm" });
    const parent = (id: string, value: string | null, from = "carol") =>
      postJson(bus, `/api/conversations/${id}/parent`, { from, parent: value });

    expect((await answeredConversation(await parent(child.conversation.id, "@@benchmarks"))).parentId).toBe(root.conversation.id);
    expect((await answeredConversation(await parent(group.conversation.id, root.conversation.id))).parentId).toBe(root.conversation.id);
    // One level: a child is no parent, and a project with children stays a root. A group as parent, a DM as child: no.
    const third = await send({ from: "carol", to: "@@third", text: "third" });
    expect((await parent(third.conversation.id, "@@reading")).status).toBe(409);
    expect((await parent(root.conversation.id, "@@third")).status).toBe(409);
    expect((await parent(child.conversation.id, group.conversation.id)).status).toBe(404);
    expect((await parent(dm.conversation.id, "@@benchmarks")).status).toBe(400);
    // Only members set it; null makes it a root again.
    expect((await parent(child.conversation.id, null, "uma")).status).toBe(403);
    expect((await answeredConversation(await parent(child.conversation.id, null))).parentId).toBeUndefined();
  });

  test("@{@@project,a,b} is the group DM of those members under that project, apart from the same set elsewhere", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    await send({ from: "carol", to: "@@benchmarks", text: "root" });
    const loose = await send({ from: "carol", to: "@{alpha,uma}", text: "not under a project" });
    await alpha.client.take("deliver");

    const under = await send({ from: "carol", to: "@{@@benchmarks,alpha,uma}", text: "under benchmarks" });
    expect(under.conversation.id).not.toBe(loose.conversation.id);
    expect(under.conversation).toMatchObject({ kind: "group", parentName: "benchmarks", members: ["alpha", "carol", "uma"] });
    // Replies keep the prefix, so the answer lands in the same group.
    expect((await alpha.client.take("deliver")).replyTo).toBe("@{@@benchmarks,carol,uma}");
    expect((await send({ from: alpha.id, to: "@{@@benchmarks,carol,uma}", text: "back" })).conversation.id).toBe(under.conversation.id);

    // Two members under a project make a group DM there (DMs have no parent); the DM itself stays apart.
    const pair = await send({ from: "carol", to: "@{@@benchmarks,alpha}", text: "just us, in benchmarks" });
    expect(pair.conversation).toMatchObject({ kind: "group", parentName: "benchmarks", members: ["alpha", "carol"] });
    expect((await send({ from: "carol", to: "@alpha", text: "our DM" })).conversation.kind).toBe("dm");

    // The prefix is nobody's mention, and history finds the group by it.
    expect(mentionedIds("see @{@@benchmarks,alpha} and @carol")).toEqual(["alpha", "carol"]);
    const hist = await getJson<{ messages: Message[] }>(bus, `/api/history?from=alpha&to=${encodeURIComponent("@{@@benchmarks,carol,uma}")}`);
    expect(hist.messages.map((m) => m.text)).toEqual(["under benchmarks", "back"]);

    // Only root projects, and only real ones.
    const child = await send({ from: "carol", to: "@@reading", text: "child" });
    await postJson(bus, `/api/conversations/${child.conversation.id}/parent`, { from: "carol", parent: "@@benchmarks" });
    expect((await postJson(bus, "/api/messages", { from: "carol", to: "@{@@reading,alpha}", text: "x" })).status).toBe(409);
    expect((await postJson(bus, "/api/messages", { from: "carol", to: "@{@@nowhere,alpha}", text: "x" })).status).toBe(404);
    expect((await postJson(bus, "/api/messages", { from: "carol", to: "@{@@benchmarks}", text: "x" })).status).toBe(400);
  });

  test("an agent citing #n a person of the conversation cannot open is warned (the message still goes); opening it says why", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const umas = await send({ from: "uma", to: "@alpha", text: "uma's own" }); // carol cannot read uma's DM
    const mine = await send({ from: "carol", to: "@alpha", text: "carol's own" });
    const cited = await send({ from: alpha.id, to: "@carol", text: `see #${umas.message.seq} and #${mine.message.seq}` });
    expect(cited.warnings).toEqual([`@carol cannot open #${umas.message.seq} (it is in a conversation they are not in): quote what it says instead`]);
    expect(cited.message.text).toContain(`#${umas.message.seq}`); // sent anyway
    // People are not warned (they know what they can see); and carol opening it is told why, not "unknown".
    expect((await send({ from: "carol", to: "@alpha", text: `#${umas.message.seq}?` })).warnings).toBeUndefined();
    const res = await busFetch(bus, `/api/messages/${umas.message.seq}`, {}, "carol");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(`#${umas.message.seq} is in a conversation you are not in`);
  });

  test("quiet unpinned projects and group DMs are archived; any member's message brings them back, an agent's too", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const quiet = await send({ from: alpha.id, to: "@@quiet", text: "x" });
    const pinned = await send({ from: "carol", to: "@@kept", text: "x" });
    await postJson(bus, `/api/conversations/${pinned.conversation.id}/pin`, { from: "carol", pinned: true });
    const group = await send({ from: "carol", to: "@{alpha,uma}", text: "x" });
    const dm = await send({ from: "carol", to: "@alpha", text: "x" });
    // The hourly step, with "quiet" meaning everything so far (the same database the bus uses).
    const db = new BusDatabase(bus.dbPath, ["carol", "uma"]);
    const archived = db.archiveIdle(Date.now() + 1000);
    db.close();
    expect(archived.sort()).toEqual([group.conversation.id, quiet.conversation.id].sort()); // not the pinned one, not DMs
    const state0 = (await state("carol")).conversations;
    expect(state0.find((c) => c.id === quiet.conversation.id)).toMatchObject({ archived: true, archivedIdle: true });
    expect(state0.find((c) => c.id === dm.conversation.id)?.archived).toBeUndefined();
    // An agent writing brings back what was archived for being quiet…
    expect((await send({ from: alpha.id, conversationId: quiet.conversation.id, text: "back" })).conversation.archived).toBeUndefined();
    // …but not what a person archived.
    await send({ from: "carol", conversationId: quiet.conversation.id, text: "joining to archive it" });
    expect((await postJson(bus, `/api/conversations/${quiet.conversation.id}/archive`, { from: "carol", archived: true })).status).toBe(200);
    expect((await postJson(bus, "/api/messages", { from: alpha.id, conversationId: quiet.conversation.id, text: "x" })).status).toBe(409);
    // Pinning a quiet-archived group brings it back.
    const pin = await postJson(bus, `/api/conversations/${group.conversation.id}/pin`, { from: "carol", pinned: true });
    expect((await answeredConversation(pin)).archived).toBeUndefined();
  });

  test("pins are per person: anyone who can see a project pins it for themselves, member or not", async () => {
    await joinPath("/tmp/x/alpha");
    const project = await send({ from: "carol", to: "@@pinme", text: "x" });
    await send({ from: "uma", conversationId: project.conversation.id, text: "me too" });
    const pin = (pinned: boolean, from = "carol", id = project.conversation.id) => postJson(bus, `/api/conversations/${id}/pin`, { from, pinned });
    expect((await answeredConversation(await pin(true))).pinnedBy).toEqual(["carol"]);
    expect((await answeredConversation(await pin(true, "uma"))).pinnedBy).toEqual(["carol", "uma"]);
    expect((await answeredConversation(await pin(false))).pinnedBy).toEqual(["uma"]);
    // Not a member (pinned from "Other projects"): allowed; a project the person cannot see: not.
    const other = await send({ from: "carol", to: "@@other", text: "x" });
    expect((await answeredConversation(await pin(true, "uma", other.conversation.id))).pinnedBy).toEqual(["uma"]);
    await postJson(bus, `/api/conversations/${other.conversation.id}/project`, { from: "carol", visibility: "private" });
    expect((await pin(true, "uma", other.conversation.id)).status).toBe(404);
    // DMs pin too since tabs (Can #11480: a tab for a person or an agent); that person's own tabs list it.
    const dm = await send({ from: "carol", to: "@alpha", text: "x" });
    expect((await pin(true, "carol", dm.conversation.id)).status).toBe(200);
    expect((await state("carol")).tabs).toContain(dm.conversation.id);
    expect((await pin("yes" as unknown as boolean)).status).toBe(400);
  });

  test("rooms: #name is their only address; writing to a new one creates it; a group becomes one (private, under a project); names keep apart from projects and message numbers", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    // Writing to a new #name creates an open room; deliveries and replies name it #name.
    const made = await send({ from: alpha.id, to: "#nightly", text: "first" });
    expect(made.conversation).toMatchObject({ kind: "project", name: "nightly", room: true, visibility: "open" });
    await send({ from: "carol", to: "#nightly", text: "joining" });
    expect((await alpha.client.take("deliver")).replyTo).toBe("#nightly");
    // One way to write each: a room is not @@name, a project is not #name; digits alone are a message number.
    expect((await postJson(bus, "/api/messages", { from: "carol", to: "@@nightly", text: "x" })).status).toBe(409);
    await send({ from: "carol", to: "@@infra", text: "a project" });
    expect((await postJson(bus, "/api/messages", { from: "carol", to: "#infra", text: "x" })).status).toBe(409);
    expect((await postJson(bus, "/api/messages", { from: "carol", to: "#8351", text: "x" })).status).toBe(400);
    // "#all" is everyone's room: @all; no room takes the name.
    expect((await send({ from: "carol", to: "#all", text: "hello all" })).conversation.id).toBe("all");
    // A group becomes a room with a name and a parent project; it stays private; its address is #name.
    const group = await send({ from: "carol", to: "@{alpha,uma}", text: "plan" });
    await alpha.client.take("deliver");
    const room = (body: Record<string, unknown>) => postJson(bus, `/api/conversations/${group.conversation.id}/room`, { from: "carol", ...body });
    expect((await room({ name: "infra" })).status).toBe(409); // a project's name
    expect((await room({ name: "all" })).status).toBe(400);
    expect((await room({ name: "plan", parent: "#nightly" })).status).toBe(404); // rooms are never parents
    expect(await answeredConversation(await room({ name: "#Plan", parent: "@@infra" }))).toMatchObject({
      kind: "project", room: true, name: "plan", visibility: "private", parentName: "infra", members: ["alpha", "carol", "uma"],
    });
    expect((await send({ from: "carol", to: "#plan", text: "in the room" })).conversation.id).toBe(group.conversation.id);
    // A room and a project turn into each other (people only): only the address changes.
    const back = (room: boolean, from = "carol") => postJson(bus, `/api/conversations/${group.conversation.id}/room`, { from, room });
    expect((await back(false, alpha.id)).status).toBe(403);
    const turned = await answeredConversation(await back(false));
    expect(turned).toMatchObject({ kind: "project", name: "plan", visibility: "private", parentName: "infra" });
    expect(turned.room).toBeUndefined();
    expect((await back(false)).status).toBe(409); // already one
    expect((await postJson(bus, "/api/messages", { from: "carol", to: "#plan", text: "x" })).status).toBe(409);
    expect((await send({ from: "carol", to: "@@plan", text: "now a project" })).conversation.id).toBe(group.conversation.id);
    expect((await answeredConversation(await back(true))).room).toBe(true);
    // Nothing goes under a room, even named by its id.
    const project = await send({ from: "carol", to: "@@infra", text: "again" });
    expect((await postJson(bus, `/api/conversations/${project.conversation.id}/parent`, { from: "carol", parent: made.conversation.id })).status).toBe(409);
  });

  test("tasks: assigned by mention or DM, they wake their agents; assignees accept/finish/reject, the assigner withdraws; each step replies in the conversation", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const act = (seq: number, action: string, from: string, reason?: string) =>
      postJson(bus, `/api/tasks/${seq}/${action}`, { from, ...(reason ? { reason } : {}) });
    const tasks = async (who: string, box = "mine", state = "open") =>
      (await busFetch(bus, `/api/tasks?for=${who}&box=${box}&state=${state}`, {}, who === "carol" || who === "uma" ? who : undefined)).json() as Promise<TasksResponse>;

    // In a group, the @mentioned member is the assignee, and an agent assignee is woken even if listed in nobody's wake.
    const group = await send({ from: "carol", to: "@{alpha,beta}", text: "plan" });
    await alpha.client.take("deliver");
    await beta.client.take("deliver");
    await send({ from: alpha.id, conversationId: group.conversation.id, text: "plan done", wake: [] });
    await beta.client.take("deliver");
    const t = await send({ from: "carol", conversationId: group.conversation.id, text: "@beta please rerun 7", task: { type: "chore" } });
    expect(t.message.task).toEqual({ type: "chore", assignees: [{ id: "beta", state: "open" }] });
    expect((await beta.client.take("deliver")).openTasks).toBe(1);
    expect((await alpha.client.take("deliver")).wake).toBe(false); // not its task
    expect(await tasks("beta")).toMatchObject({ open: 1, unread: 1 });
    // Nobody named: refused; agents cannot approve; approvals go to people only.
    expect((await postJson(bus, "/api/messages", { from: "carol", conversationId: group.conversation.id, text: "someone do it", task: {} })).status).toBe(400);
    expect((await postJson(bus, "/api/messages", { from: alpha.id, conversationId: group.conversation.id, text: "@beta approve?", task: { type: "approval" } })).status).toBe(400);

    // The assignee accepts (informs, wakes nobody), then finishes (wakes the assigner if an agent).
    expect((await act(t.message.seq, "done", "alpha")).status).toBe(403); // not assigned
    expect((await act(t.message.seq, "accept", beta.id)).status).toBe(200);
    const accepted = await alpha.client.take("deliver");
    expect([accepted.message.text, accepted.message.quote?.seq, accepted.wake]).toEqual(["Accepted: on it.", t.message.seq, false]);
    expect((await act(t.message.seq, "done", beta.id)).status).toBe(200);
    expect((await alpha.client.take("deliver")).message.text).toBe("✓ Done.");
    expect((await act(t.message.seq, "reject", beta.id)).status).toBe(409); // already done
    expect(await tasks("beta")).toMatchObject({ open: 0, messages: [] });
    expect((await tasks("beta", "mine", "all")).messages[0]?.task?.assignees[0]).toMatchObject({ id: "beta", state: "done" });

    // An agent assigns a person an approval in a DM; only that person, signed in, decides it; the agent is woken by it.
    const ask = await send({ from: alpha.id, to: "@carol", text: "May I delete run 3?", task: { type: "approval" } });
    expect(ask.message.task?.assignees).toEqual([{ id: "carol", state: "open" }]);
    expect((await tasks("carol")).unread).toBe(1);
    await act(ask.message.seq, "read", "carol");
    expect(await tasks("carol")).toMatchObject({ open: 1, unread: 0 });
    expect((await act(ask.message.seq, "reject", "carol", "keep it until Monday")).status).toBe(200);
    const denied = await alpha.client.take("deliver");
    expect([denied.message.text, denied.wake, denied.message.verified]).toEqual(["✕ Denied. keep it until Monday", true, true]);
    expect((await tasks(alpha.id, "assigned", "all")).messages[0]?.task?.assignees[0]).toMatchObject({ state: "rejected", reason: "keep it until Monday", verified: true });

    // The assigner withdraws an open task: its agent assignees are told and woken.
    const w = await send({ from: "carol", to: "@beta", text: "check the logs", task: {} });
    await beta.client.take("deliver");
    expect((await act(w.message.seq, "withdraw", beta.id)).status).toBe(403);
    expect((await act(w.message.seq, "withdraw", "carol", "not needed")).status).toBe(200);
    expect(await beta.client.take("deliver")).toMatchObject({ wake: true, message: { text: "Withdrawn. not needed" } });
  });

  test("a person removes an agent from a group, project or room; agents and non-members cannot, and people are not removed", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const room = await send({ from: "carol", to: "#crew", text: "start" });
    await postJson(bus, `/api/conversations/${room.conversation.id}/members`, { from: "carol", ids: ["alpha", "beta", "uma"] });
    const remove = (id: string, from = "carol") => postJson(bus, `/api/conversations/${room.conversation.id}/remove`, { from, id });
    expect((await remove("beta", alpha.id)).status).toBe(403); // agents don't remove
    expect((await remove("uma")).status).toBe(400); // people leave by themselves
    expect((await answeredConversation(await remove("@Beta"))).members).toEqual(["alpha", "carol", "uma"]);
    expect((await remove("beta")).status).toBe(400); // not in it any more
    // A removed agent no longer gets its messages.
    const later = await send({ from: "carol", conversationId: room.conversation.id, text: "after" });
    expect(later.message.receipts.map((r) => r.to)).toEqual(["alpha"]);
  });

  test("members pin and unpin a conversation's messages; outsiders and other conversations' messages are refused; unpinning keeps the message", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const room = await send({ from: "carol", to: "#crew", text: "first" });
    const second = await send({ from: "carol", conversationId: room.conversation.id, text: "second" });
    const elsewhere = await send({ from: "uma", to: "#other", text: "not here" });
    await postJson(bus, `/api/conversations/${room.conversation.id}/members`, { from: "carol", ids: ["alpha"] });
    const pin = (from: string, seq: number, pinned = true) => postJson(bus, `/api/conversations/${room.conversation.id}/pinned`, { from, seq, pinned });
    const pinned = async (res: Response) => (await answeredConversation(res)).pinnedMessages?.map((p) => [p.seq, p.by]) ?? [];
    expect(await pinned(await pin("carol", second.message.seq))).toEqual([[second.message.seq, "carol"]]);
    expect(await pinned(await pin(alpha.id, room.message.seq))).toEqual([[second.message.seq, "carol"], [room.message.seq, "alpha"]]); // agents may pin; oldest pin first
    expect(await pinned(await pin("carol", second.message.seq))).toEqual([[second.message.seq, "carol"], [room.message.seq, "alpha"]]); // twice: once
    expect((await pin("uma", second.message.seq)).status).toBe(403); // not a member
    expect((await pin("carol", elsewhere.message.seq)).status).toBe(404); // not this conversation's
    expect(await pinned(await pin("carol", second.message.seq, false))).toEqual([[room.message.seq, "alpha"]]);
    // The unpinned message is still there, unchanged.
    expect((await getJson<{ message: Message }>(bus, `/api/messages/${second.message.seq}`, "carol")).message.text).toBe("second");
    // Everyone who reads the room sees the pins in its listing.
    expect((await state("carol")).conversations.find((c) => c.id === room.conversation.id)?.pinnedMessages?.map((p) => p.seq)).toEqual([room.message.seq]);
  });

  test("a writer edits and deletes its own messages: others are refused, viewers see the change, replies quote the new text, a deleted message is not handed to an agent that was offline", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    await send({ from: "alpha", to: "@carol", text: "taking part" });
    await leave(alpha.client);
    const viewer = await connectViewer();
    const room = await send({ from: "carol", to: "#crew", text: "first draft" });
    const reply = await send({ from: "uma", text: "answering", replyToSeq: room.message.seq });
    const change = (from: string, seq: number, action: "edit" | "delete", text?: string) =>
      postJson(bus, `/api/messages/${seq}/${action}`, { from, ...(text === undefined ? {} : { text }) });
    // Only its writer, signed in as itself.
    expect((await change("uma", room.message.seq, "edit", "mine now")).status).toBe(403);
    expect((await change("uma", room.message.seq, "delete")).status).toBe(403);
    const edited = (await (await change("carol", room.message.seq, "edit", "  second thoughts  ")).json()) as { message: Message };
    expect(edited.message).toMatchObject({ text: "second thoughts", seq: room.message.seq });
    expect(edited.message.editedAt).toBeNumber();
    expect((await viewer.take("changed")).message.text).toBe("second thoughts");
    // A reply's quote is the text as it is now.
    const replied = await getJson<{ message: Message }>(bus, `/api/messages/${reply.message.seq}`, "carol");
    expect(replied.message.quote?.text).toBe("second thoughts");
    expect((await change("carol", room.message.seq, "edit", "   ")).status).toBe(400); // empty: delete instead
    // Deleting: held for offline alpha, and then gone from its backlog.
    const held = await send({ from: "carol", to: "@alpha", text: "never mind this" });
    expect(held.message.receipts.map((r) => r.to)).toEqual(["alpha"]);
    const deleted = (await (await change("carol", held.message.seq, "delete")).json()) as { message: Message };
    expect(deleted.message).toMatchObject({ text: "", files: [], receipts: [] });
    expect(deleted.message.deletedAt).toBeNumber();
    expect((await change("carol", held.message.seq, "edit", "back")).status).toBe(409);
    const back = await joinPath("/tmp/x/alpha");
    const sentinel = await send({ from: "carol", to: "@alpha", text: "fresh" });
    expect((await back.client.take("deliver")).message.id).toBe(sentinel.message.id);
  });

  test("search for people: as yourself only, every conversation you may read or one of them, never one you can't", async () => {
    await joinPath("/tmp/x/alpha");
    const room = await send({ from: "carol", to: "#crew", text: "the launch checklist is pinned" });
    await send({ from: "carol", to: "#other", text: "another launch note" });
    const secret = await send({ from: "uma", to: "@{alpha}", text: "launch secret between uma and alpha" });
    const search = async (as: string, query: string) => {
      const res = await busFetch(bus, `/api/search?from=${as}&q=launch&scope=all${query}`, {}, as);
      return { status: res.status, texts: res.ok ? ((await res.json()) as { messages: Message[] }).messages.map((m) => m.text) : [] };
    };
    const all = await search("carol", "");
    expect(all.status).toBe(200);
    expect(all.texts).toContain("the launch checklist is pinned");
    expect(all.texts).toContain("another launch note");
    expect(all.texts).not.toContain("launch secret between uma and alpha"); // uma's group, not carol's
    expect((await search("carol", `&conversationId=${room.conversation.id}`)).texts).toEqual(["the launch checklist is pinned"]);
    expect((await search("carol", `&conversationId=${secret.conversation.id}`)).status).toBe(404);
    // As someone else: refused.
    expect((await busFetch(bus, "/api/search?from=uma&q=launch&scope=all", {}, "carol")).status).toBe(403);
  });

  test("a person's tabs: pins in their order, reordered only as a whole set, only by themselves, invisible to others", async () => {
    const crew = await send({ from: "carol", to: "#crew", text: "a room" });
    const dm = await send({ from: "carol", to: "@uma", text: "a DM" });
    const pin = (id: string, pinned = true) => postJson(bus, `/api/conversations/${id}/pin`, { from: "carol", pinned });
    expect((await pin(crew.conversation.id)).status).toBe(200);
    expect((await pin(dm.conversation.id)).status).toBe(200);
    expect((await state("carol")).tabs).toEqual([crew.conversation.id, dm.conversation.id]);
    const order = (o: string[], as = "carol") => busFetch(bus, "/api/tabs", { method: "POST", body: JSON.stringify({ from: as, order: o }) }, as);
    const moved = await order([dm.conversation.id, crew.conversation.id]);
    expect(moved.status).toBe(200);
    expect((await state("carol")).tabs).toEqual([dm.conversation.id, crew.conversation.id]);
    // Not the whole set, a repeat, someone else's order for carol: refused, the order unchanged.
    expect((await order([dm.conversation.id])).status).toBe(409);
    expect((await order([dm.conversation.id, dm.conversation.id])).status).toBe(409);
    expect((await busFetch(bus, "/api/tabs", { method: "POST", body: JSON.stringify({ from: "carol", order: [] }) }, "uma")).status).toBe(403);
    expect((await state("uma")).tabs ?? []).toEqual([]);
    // Unpinning removes only the tab; a new pin goes last.
    expect((await pin(dm.conversation.id, false)).status).toBe(200);
    expect((await pin(dm.conversation.id)).status).toBe(200);
    expect((await state("carol")).tabs).toEqual([crew.conversation.id, dm.conversation.id]);
    expect((await getJson<{ messages: unknown[] }>(bus, `/api/conversations/${dm.conversation.id}/messages`, "carol")).messages.length).toBe(1);
  });

  test("a person's bookmarks are their own: only messages they can read, only people, invisible to others", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const open = await send({ from: "carol", to: "#crew", text: "worth keeping" });
    const secret = await send({ from: "carol", to: "@{alpha}", text: "between carol and alpha" });
    const mark = (from: string, seq: number, bookmarked = true) => postJson(bus, "/api/bookmarks", { from, seq, bookmarked });
    const saved = (await (await mark("uma", open.message.seq)).json()) as { bookmarks: Array<{ seq: number }> };
    expect(saved.bookmarks.map((b) => b.seq)).toEqual([open.message.seq]);
    expect((await mark("uma", open.message.seq)).status).toBe(200); // twice: once
    expect((await state("uma")).bookmarks?.map((b) => b.seq)).toEqual([open.message.seq]);
    expect((await state("carol")).bookmarks ?? []).toEqual([]); // not carol's
    expect((await mark("uma", secret.message.seq)).status).toBe(404); // a conversation uma can't read
    expect((await mark(alpha.id, open.message.seq)).status).toBe(403); // people only
    expect((await (await mark("uma", open.message.seq, false)).json()) as { bookmarks: unknown[] }).toEqual({ bookmarks: [] });
    // The message itself was never touched.
    expect((await getJson<{ message: Message }>(bus, `/api/messages/${open.message.seq}`, "carol")).message.text).toBe("worth keeping");
  });

  test("a person's own tasks: taken from messages they can read, open then done, only theirs, the message untouched", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const first = await send({ from: "carol", to: "#crew", text: "check the backup" });
    const second = await send({ from: "carol", to: "#crew", text: "renew the certificate" });
    const secret = await send({ from: "carol", to: "@{alpha}", text: "between carol and alpha" });
    const take = (from: string, seq: number, taskState: string) => postJson(bus, "/api/own-tasks", { from, seq, state: taskState });
    const list = async (res: Response) => ((await res.json()) as { ownTasks: Array<{ seq: number; doneAt?: number }> }).ownTasks;
    await take("uma", first.message.seq, "open");
    expect((await list(await take("uma", second.message.seq, "open"))).map((t) => t.seq)).toEqual([second.message.seq, first.message.seq]);
    // Done goes after the open ones, and back to open on request.
    const done = await list(await take("uma", second.message.seq, "done"));
    expect(done.map((t) => [t.seq, t.doneAt !== undefined])).toEqual([[first.message.seq, false], [second.message.seq, true]]);
    expect((await list(await take("uma", second.message.seq, "open"))).find((t) => t.seq === second.message.seq)?.doneAt).toBeUndefined();
    expect((await state("uma")).ownTasks?.length).toBe(2);
    expect((await state("carol")).ownTasks ?? []).toEqual([]); // not carol's
    expect((await take("uma", secret.message.seq, "open")).status).toBe(404); // a conversation uma can't read
    expect((await take(alpha.id, first.message.seq, "open")).status).toBe(403); // people only
    expect((await take("uma", first.message.seq, "later")).status).toBe(400);
    expect((await list(await take("uma", first.message.seq, "none"))).map((t) => t.seq)).toEqual([second.message.seq]);
    // Nobody else sees a task: the message carries none.
    expect((await getJson<{ message: Message }>(bus, `/api/messages/${second.message.seq}`, "carol")).message.task).toBeUndefined();
  });

  test("seen: a person marks a conversation seen up to its newest message, never back; members see it, with who wrote last", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const dm = await send({ from: "carol", to: "@uma", text: "did you see this?" });
    const id = dm.conversation.id;
    const seen = (from: string, at: number) => postJson(bus, `/api/conversations/${id}/seen`, { from, at });
    const conv = async (who: string) => (await state(who)).conversations.find((c) => c.id === id);
    expect((await conv("carol"))?.seen?.uma).toBeUndefined();
    expect((await conv("carol"))?.lastMessageFrom).toBe("carol");
    // A time past its newest message is held at that message.
    expect((await seen("uma", Date.now() + 60_000)).status).toBe(200);
    expect((await conv("carol"))?.seen?.uma).toBe(dm.message.createdAt);
    // Never back.
    await seen("uma", 1);
    expect((await conv("carol"))?.seen?.uma).toBe(dm.message.createdAt);
    // People only, members only, a real time.
    expect((await postJson(bus, `/api/conversations/${id}/seen`, { from: alpha.id, at: Date.now() })).status).toBe(403);
    const crew = await send({ from: "carol", to: "#crew-seen", text: "only carol here" });
    expect((await postJson(bus, `/api/conversations/${crew.conversation.id}/seen`, { from: "uma", at: Date.now() })).status).toBe(403);
    expect((await seen("uma", Number.NaN)).status).toBe(400);
    // Her answer: carol sees who wrote last.
    await send({ from: "uma", conversationId: id, text: "yes" });
    expect((await conv("carol"))?.lastMessageFrom).toBe("uma");
  });

  test("a room's name people read (title) changes without its address: #address keeps reaching it; people only; empty clears", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const room = await send({ from: "carol", to: "#model-research", text: "start" });
    await postJson(bus, `/api/conversations/${room.conversation.id}/members`, { from: "carol", ids: ["alpha"] });
    const project = (from: string, body: Record<string, unknown>) =>
      postJson(bus, `/api/conversations/${room.conversation.id}/project`, { from, ...body });
    expect(slugFromTitle("Yeni Model Ekleme Şükrü & Çağrı")).toBe("yeni-model-ekleme-sukru-cagri");
    const named = await answeredConversation(await project("carol", { title: "  Model   Research " }));
    expect(named).toMatchObject({ name: "model-research", title: "Model Research", room: true });
    expect((await project(alpha.id, { title: "Mine" })).status).toBe(403); // agents don't rename
    expect((await project("carol", { title: "x".repeat(81) })).status).toBe(400);
    // The address still reaches it, and agents see the name beside it.
    const again = await send({ from: "carol", to: "#model-research", text: "still here" });
    expect(again.conversation.id).toBe(room.conversation.id);
    expect(titledLabel(again.conversation)).toBe('#model-research ("Model Research")');
    expect((await alpha.client.take("deliver")).message.text).toBe("start"); // its join context, before the name
    expect((await alpha.client.take("deliver")).conversation.title).toBe("Model Research");
    // Empty, or the address itself, gives the address back as the name.
    expect((await answeredConversation(await project("carol", { title: "" }))).title).toBeUndefined();
    expect((await answeredConversation(await project("carol", { title: "model-research" }))).title).toBeUndefined();
  });

  test("a project's Home: its first publisher (a member) owns and replaces it; anyone who may read the project reads it", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const project = await send({ from: alpha.id, to: "@@alpha", text: "my home" });
    const route = `/api/conversations/${project.conversation.id}/home`;
    const put = (from: string, text: string) =>
      busFetch(bus, route, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, text }) }, from === "carol" ? "carol" : undefined);
    expect((await busFetch(bus, route, {}, "carol")).status).toBe(404); // none yet
    expect((await put(beta.id, "# not mine")).status).toBe(403); // not a member
    expect((await put(alpha.id, "## Done\n- shipped #1")).status).toBe(200);
    expect(await (await busFetch(bus, route, {}, "carol")).json()).toMatchObject({ text: "## Done\n- shipped #1", owner: "alpha", updatedBy: "alpha" });
    // A member who is not the owner cannot replace it; the owner can.
    await send({ from: "carol", conversationId: project.conversation.id, text: "joining" });
    expect((await put("carol", "mine now")).status).toBe(403);
    expect((await put(alpha.id, "## Doing\n- the next thing")).status).toBe(200);
    expect((await put(alpha.id, "x".repeat(100_001))).status).toBe(400);
    // Only projects and rooms have one.
    const dm = await send({ from: "carol", to: "@alpha", text: "hi" });
    expect((await busFetch(bus, `/api/conversations/${dm.conversation.id}/home`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: alpha.id, text: "x" }) })).status).toBe(400);
  });

  test("a checklist by markdown (the PUT from before ids): its creator publishes it with assignees; people tick; ids and ticks survive a republish", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const project = await send({ from: alpha.id, to: "@@alpha", text: "my page" });
    await send({ from: "carol", conversationId: project.conversation.id, text: "joining" });
    await send({ from: "uma", conversationId: project.conversation.id, text: "me too" });
    const route = `/api/conversations/${project.conversation.id}/checklist`;
    const put = (text: string, from = alpha.id, assignees?: string[]) =>
      busFetch(bus, route, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, text, ...(assignees ? { assignees } : {}) }),
      }, from === "carol" || from === "uma" ? from : undefined); // people write with their session
    const tick = (item: string, done: boolean, from = "carol") => postJson(bus, `${route}/tick`, { from, item, done });
    const get = async (as = "carol") => (await busFetch(bus, route, {}, as)).json() as Promise<Checklist>;

    expect((await busFetch(bus, route, {}, "carol")).status).toBe(404); // none yet
    expect((await put("## Money\n- [ ] Approve disk cleanup · #8264\n- [ ] Top up OpenRouter", alpha.id, ["@carol"])).status).toBe(200);
    expect(await get()).toMatchObject({ creator: "alpha", assignees: ["carol"], pinned: true, version: 1 });
    const ids = (await get()).items.map((item) => item.id);
    expect((await get()).items.map((item) => [item.heading, item.text, item.owner])).toEqual([
      ["Money", "Approve disk cleanup · #8264", "alpha"],
      ["Money", "Top up OpenRouter", "alpha"],
    ]);
    // A person who is a member ticks any item (by its text, as before ids); the creator ticks its own.
    expect((await tick("Approve disk cleanup · #8264", true)).status).toBe(200);
    expect((await get()).ticks["Approve disk cleanup · #8264"]?.by).toBe("carol");
    expect((await tick("Top up OpenRouter", true, alpha.id)).status).toBe(200);
    expect((await tick("Top up OpenRouter", false, "uma")).status).toBe(200);
    expect((await tick("Not on the list", true)).status).toBe(409);
    // Only the owner replaces it: neither another member nor an outsider.
    expect((await put("- [ ] hijack", "carol")).status).toBe(403);
    const beta = await joinPath("/tmp/x/beta");
    expect((await put("- [ ] hijack", beta.id)).status).toBe(403);
    // The owner republishes without assignees: they stay. The ticked item keeps its tick; a dropped item loses its.
    await put("## Money\n- [ ] Approve disk cleanup · #8264\n- [ ] New ask");
    expect(await get()).toMatchObject({ assignees: ["carol"] });
    expect(Object.keys((await get()).ticks)).toEqual(["Approve disk cleanup · #8264"]);
    expect((await get()).items[0]?.id).toBe(ids[0]);
    await put("- [ ] New ask");
    expect((await get()).ticks).toEqual({});
    expect((await put("- [ ] x", alpha.id, ["nobody-here"])).status).toBe(400);
    // Unticking.
    await tick("New ask", true);
    await tick("New ask", false);
    expect((await get()).ticks).toEqual({});
    // A person who may not read the conversation does not see its list: a private project with carol in it.
    const hidden = await send({ from: alpha.id, to: "@@hidden", text: "x" });
    await send({ from: "carol", conversationId: hidden.conversation.id, text: "mine too" });
    await postJson(bus, `/api/conversations/${hidden.conversation.id}/project`, { from: "carol", visibility: "private" });
    await busFetch(bus, `/api/conversations/${hidden.conversation.id}/checklist`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: alpha.id, text: "- [ ] secret" }) });
    expect((await busFetch(bus, `/api/conversations/${hidden.conversation.id}/checklist`, {}, "uma")).status).toBe(404);
  });

  test("a conversation's shared files: newest first, without voice messages, only for those who may read it", async () => {
    await joinPath("/tmp/x/alpha");
    const upload = async (name: string, type: string): Promise<FileRef> => {
      const res = await busFetch(bus, `/api/files?from=carol&name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": type },
        body: new TextEncoder().encode(name),
      }, "carol");
      return ((await res.json()) as { file: FileRef }).file;
    };
    const first = await upload("plan.md", "text/markdown");
    const voice = await upload("voice-20261114-120000.webm", "audio/webm");
    const second = await upload("results.csv", "text/csv");
    const dm = await send({ from: "carol", to: "@alpha", text: "the plan", fileIds: [first.id] });
    await send({ from: "carol", conversationId: dm.conversation.id, text: "🎤 hi", fileIds: [voice.id] });
    const last = await send({ from: "carol", conversationId: dm.conversation.id, text: "and results", fileIds: [second.id] });

    const res = await getJson<SharedFilesResponse>(bus, `/api/conversations/${dm.conversation.id}/files`, "carol");
    expect(res.files.map((f) => [f.file.name, f.from, f.seq])).toEqual([
      ["results.csv", "carol", last.message.seq],
      ["plan.md", "carol", dm.message.seq],
    ]);
    // carol's DM with alpha is hers: uma does not see its files.
    expect((await busFetch(bus, `/api/conversations/${dm.conversation.id}/files`, {}, "uma")).status).toBe(404);
  });

  test("a person deletes a project for good, member or not; agents cannot; what was under it becomes a root", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const root = await send({ from: alpha.id, to: "@@stand-in", text: "made by alpha" });
    const kept = await send({ from: "carol", to: "@@kept", text: "stays" });
    const dm = await send({ from: "carol", to: "@alpha", text: "a dm" });
    const child = await send({ from: "carol", to: "@@under", text: "child" });
    await postJson(bus, `/api/conversations/${child.conversation.id}/parent`, { from: "carol", parent: "@@stand-in" });
    const del = (id: string, from: string) => postJson(bus, `/api/conversations/${id}/delete`, { from });

    expect((await del(root.conversation.id, alpha.id)).status).toBe(403); // agents cannot
    expect((await del(dm.conversation.id, "carol")).status).toBe(400); // only projects
    // Everyone left: uma (never a member) can still delete it.
    await postJson(bus, `/api/conversations/${root.conversation.id}/leave`, { from: alpha.id });
    const res = await del(root.conversation.id, "uma");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: root.conversation.id, messages: 1 });

    const after = (await state("carol")).conversations;
    expect(after.some((c) => c.id === root.conversation.id)).toBe(false);
    expect(after.find((c) => c.id === child.conversation.id)?.parentId).toBeUndefined();
    expect((await busFetch(bus, `/api/messages/${root.message.seq}`, {}, "carol")).status).toBe(404);
    expect((await del(child.conversation.id, "carol")).status).toBe(200);
    expect((await state("carol")).conversations.some((c) => c.id === kept.conversation.id)).toBe(true); // others untouched
  });

  test("live frames go only to viewers who may read the conversation", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const viewer = await connectViewer(); // carol
    await viewer.take("participants");
    await send({ from: "uma", to: "@alpha", text: "uma's own" });
    await send({ from: "carol", to: "@alpha", text: "carol's own" });
    expect((await viewer.take("message")).message.text).toBe("carol's own");
    expect(viewer.queued("message")).toBe(0);
    void alpha;
  });

  test("groups from before projects become DMs and group DMs at startup; silent ones are archived; old aliases still work", async () => {
    await bus.stop();
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = mkdtempSync(path.join(tmpdir(), "mb-server-test-"));
    // A database as the bus wrote it before projects.
    const raw = new Database(path.join(dataDir, "message-bus.sqlite"));
    raw.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('all', 'group')), addressed_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_message_at INTEGER NOT NULL, thread_key TEXT);
      CREATE TABLE conversation_members (conversation_id TEXT NOT NULL REFERENCES conversations(id), participant_id TEXT NOT NULL,
        PRIMARY KEY (conversation_id, participant_id));
      CREATE TABLE conversation_aliases (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL);
      CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id), from_id TEXT NOT NULL, from_kind TEXT NOT NULL,
        text TEXT NOT NULL, files_json TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    const now = Date.now();
    raw.query("INSERT INTO conversations VALUES ('all', 'all', '[]', 1, 1, NULL)").run();
    raw.query("INSERT INTO conversations VALUES ('g_pair', 'group', '[\"alpha\",\"carol\"]', 1, ?1, 'alpha')").run(now);
    raw.query("INSERT INTO conversations VALUES ('g_trio', 'group', '[\"alpha\",\"beta\"]', 1, ?1, 'alpha,beta')").run(now);
    raw.query("INSERT INTO conversations VALUES ('g_stale', 'group', '[\"alpha\",\"beta\",\"gamma\"]', 1, 1, 'alpha,beta,gamma')").run();
    raw.query(`INSERT INTO conversation_members VALUES ('g_pair', 'alpha'), ('g_pair', 'carol'), ('g_trio', 'alpha'), ('g_trio', 'beta'),
      ('g_trio', 'uma'), ('g_stale', 'alpha'), ('g_stale', 'beta'), ('g_stale', 'gamma')`).run();
    raw.query("INSERT INTO conversation_aliases VALUES ('g_older', 'g_pair')").run();
    raw.query("INSERT INTO messages (id, conversation_id, from_id, from_kind, text, files_json, created_at) VALUES ('m1', 'g_pair', 'carol', 'human', 'old', '[]', 1)").run();
    raw.close();

    bus = startBus({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol", "uma"] });
    const byId = new Map((await state("carol")).conversations.map((c: Conversation) => [c.id, c]));
    expect(byId.get("g_pair")).toMatchObject({ kind: "dm", members: ["alpha", "carol"] });
    expect(byId.get("g_stale")).toMatchObject({ kind: "group", archived: true });
    expect((await state("uma")).conversations.find((c: Conversation) => c.id === "g_trio")).toMatchObject({ kind: "group", members: ["alpha", "beta", "uma"] });
    const page = await getJson<MessagesResponse>(bus, "/api/conversations/g_older/messages", "carol");
    expect(page.messages.map((m) => m.text)).toEqual(["old"]);
    await joinPath("/tmp/x/alpha");
    expect((await send({ from: "carol", to: "@alpha", text: "new" })).conversation.id).toBe("g_pair");
  });

  test("unknown targets and self-only addresses are rejected", async () => {
    await joinPath("/tmp/x/alpha");
    const unknown = await post({ from: "carol", to: "@{alpha,nobody}", text: "hi" });
    expect(unknown.status).toBe(400);
    const error = await errorOf(unknown);
    expect(error).toContain("nobody");
    expect(error).toContain("alpha");
    expect(error).toContain("carol");

    expect((await post({ from: "alpha", to: "@alpha", text: "me" })).status).toBe(400);
    expect((await post({ from: "carol", to: "@all", conversationId: "all", text: "x" })).status).toBe(400);
    expect((await post({ from: "stranger", to: "@all", text: "x" })).status).toBe(400);
    expect((await post({ from: "carol", to: "@all", text: "  " })).status).toBe(400);
  });
});

describe("backlog", () => {
  test("messages for an offline agent are held and handed over, marked held, when it comes back", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    await joinPath("/tmp/x/beta");
    await send({ from: "alpha", to: "@carol", text: "taking part" }); // agents that never took part are forgotten on logoff

    const acked = await send({ from: "carol", to: "@all", text: "seen" });
    const seen = await alpha.client.take("deliver");
    expect(seen.message.id).toBe(acked.message.id);
    alpha.client.send({ type: "ack", seq: seen.message.seq });
    // Delivered but not acknowledged when the connection drops: it comes again on rejoin.
    const unacked = await send({ from: "uma", to: "@alpha", text: "not acked" });
    expect((await alpha.client.take("deliver")).message.id).toBe(unacked.message.id);
    await leave(alpha.client);

    // While it is offline, messages for it are accepted and held (an hour unless the writer chose otherwise).
    const whileAway = await send({ from: "uma", to: "@all", text: "while away" });
    expect(whileAway.message.receipts.map((r) => r.to)).toEqual(["alpha", "beta"]);
    const dm = await send({ from: "beta", to: "@alpha", text: "dm while away" });
    expect(dm.message.receipts).toEqual([{ to: "alpha", deliveredAt: null, seenAt: null }]);
    expect(dm.message.expiresAt - dm.message.createdAt).toBe(3600_000);

    const back = await joinPath("/tmp/x/alpha");
    const handed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const frame = await back.client.take("deliver");
      expect(frame.held).toBe(true);
      handed.push(frame.message.text);
    }
    expect(handed).toEqual(["not acked", "while away", "dm while away"]);
    const sentinel = await send({ from: "carol", to: "@all", text: "live again" });
    const live = await back.client.take("deliver");
    expect(live.message.id).toBe(sentinel.message.id);
    expect(live.held).toBeUndefined();
  });

  test("a held message expires: it is never handed over, its receipt says so, and the writer and viewers are told", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    await send({ from: "alpha", to: "@carol", text: "taking part" });
    await leave(alpha.client);
    const viewer = await connectViewer();
    const tooLong = await post({ from: "beta", to: "@alpha", text: "x", holdHours: 200 });
    expect(tooLong.status).toBe(400);
    // Held for 0.36 s only.
    const short = await send({ from: "beta", to: "@alpha", text: "brief", holdHours: 0.0001 });
    await Bun.sleep(500);
    const after = await getJson<{ message: Message }>(bus, `/api/messages/${short.message.seq}`);
    expect(after.message.receipts).toEqual([{ to: "alpha", deliveredAt: null, seenAt: null, expired: true }]);
    // The bus looks for expired messages every few seconds and tells the writer's agent and the website.
    expect(await beta.client.take("expired")).toEqual({ type: "expired", seq: short.message.seq, conversationId: short.conversation.id, to: "alpha" });
    expect((await viewer.take("expired")).seq).toBe(short.message.seq);
    const back = await joinPath("/tmp/x/alpha");
    const sentinel = await send({ from: "carol", to: "@alpha", text: "fresh" });
    expect((await back.client.take("deliver")).message.id).toBe(sentinel.message.id);
  }, 15_000); // the bus checks for expired messages every 5 s (EXPIRY_CHECK_MS): longer than Bun's 5 s default

  test("a brand-new agent gets no history", async () => {
    await joinPath("/tmp/x/beta");
    await send({ from: "carol", to: "@all", text: "before you came" });
    const fresh = await joinPath("/tmp/x/fresh");
    const sentinel = await send({ from: "carol", to: "@all", text: "welcome" });
    expect((await fresh.client.take("deliver")).message.id).toBe(sentinel.message.id);
  });
});

describe("http", () => {
  test("files round-trip and are attached to delivered messages", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const bytes = new Uint8Array(300_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256;
    const upload = await busFetch(bus, `/api/files?from=carol&name=${encodeURIComponent("report ü.bin")}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-test" },
      body: bytes,
    }, "carol");
    expect(upload.status).toBe(200);
    const { file } = (await upload.json()) as { file: FileRef };
    expect(file.size).toBe(bytes.length);
    expect(file.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    expect(file.mimeType).toBe("application/x-test");
    expect(file.name).toBe("report ü.bin");

    const download = await busFetch(bus, `/api/files/${file.id}`);
    expect(download.headers.get("content-type")).toBe("application/x-test");
    expect(download.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("report ü.bin")}`
    );
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);

    const sent = await send({ from: "carol", to: "@alpha", text: "", fileIds: [file.id] });
    expect(sent.message.files).toEqual([file]);
    const frame = await alpha.client.take("deliver");
    expect(frame.message.files).toEqual([file]);

    expect((await post({ from: "carol", to: "@alpha", text: "x", fileIds: ["f_missing"] })).status).toBe(400);
    expect((await busFetch(bus, "/api/files/f_missing")).status).toBe(404);
  });

  test("viewers get participants and message frames", async () => {
    const viewer = await connectViewer();
    const initial = await viewer.take("participants");
    expect(initial.participants.map((p) => p.id)).toEqual(["carol", "uma"]);

    const alpha = await joinPath("/tmp/x/alpha");
    const joined = await viewer.take("participants");
    expect(joined.participants[0]).toMatchObject({ id: "alpha", online: true, connections: 1 });

    const { message } = await send({ from: "carol", to: "@all", text: "for the website" });
    const frame = await viewer.take("message");
    expect(frame.message.id).toBe(message.id);
    expect(frame.conversation.id).toBe("all");

    await send({ from: "alpha", to: "@carol", text: "taking part" });
    await leave(alpha.client);
    const left = await viewer.take("participants");
    expect(left.participants.find((p) => p.id === "alpha")).toMatchObject({ online: false, connections: 0 });
  });

  test("an agent whose connections keep dropping is reported offline with a connection error", async () => {
    const first = await joinPath("/tmp/x/alpha");
    await send({ from: "alpha", to: "@carol", text: "taking part" }); // kept when it logs off
    await leave(first.client);
    const participant = async () => (await state()).participants.find((p) => p.id === "alpha");
    // One reconnect is normal.
    const again = await joinPath("/tmp/x/alpha");
    expect(await participant()).toMatchObject({ online: true, connections: 1 });
    expect((await participant())?.connectionError).toBeUndefined();
    await leave(again.client);

    // FLAP_DROPS (4) drops within two minutes: offline with an error even while a connection is up.
    for (let i = 0; i < 2; i++) await leave((await joinPath("/tmp/x/alpha")).client);
    const live = await joinPath("/tmp/x/alpha");
    const flapping = await participant();
    expect(flapping).toMatchObject({ online: false, connections: 1 });
    expect(flapping?.connectionError).toContain("Keeps reconnecting: 4 dropped connections");
    await leave(live.client);
  });

  test("state, paging and health", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const sent: Message[] = [];
    for (let i = 0; i < 5; i++) sent.push((await send({ from: "carol", to: "@all", text: `m${i}` })).message);
    const group = await send({ from: "uma", to: "@alpha", text: "dm" });
    await alpha.client.take("deliver");

    const snapshot = await state("uma");
    expect(snapshot.humans).toEqual(["carol", "uma"]);
    expect(snapshot.participants[0]?.id).toBe("alpha");
    expect(snapshot.conversations.map((c: Conversation) => c.id)).toEqual(["all", group.conversation.id]);
    // uma's DM with alpha is hers and alpha's: carol does not see it. The agent token does (alpha is one of its
    // agents): clients from before projects read without saying which agent they are.
    expect((await state("carol")).conversations.map((c: Conversation) => c.id)).toEqual(["all"]);
    expect((await state()).conversations.map((c: Conversation) => c.id)).toEqual(["all", group.conversation.id]);
    // Another machine's token, approved, with none of its agents in it: does not see it.
    bus.approveAgentToken("another-machine-token-0123456789abcdef");
    const other = await busFetch(bus, "/api/state", { headers: { "X-Agent-Token": "another-machine-token-0123456789abcdef" } });
    const otherState: StateResponse = await other.json();
    expect(otherState.conversations.map((c: Conversation) => c.id)).toEqual(["all"]);

    const page = await getJson<MessagesResponse>(bus, `/api/conversations/all/messages?beforeSeq=${sent[4]?.seq}&limit=2`);
    expect(page.messages.map((m) => m.text)).toEqual(["m2", "m3"]);
    expect((await busFetch(bus, "/api/conversations/g_nope/messages")).status).toBe(404);

    const health = await fetch(`${bus.url}/api/health`);
    expect(health.headers.get("access-control-allow-origin")).toBe("*");
    expect(await health.json()).toMatchObject({ ok: true, version: "2.0.0" });
  });
});

describe("delivery receipts", () => {
  /** A message with its receipts, read by `as` (a person in its conversation; carol by default). */
  const getMessage = async (seq: number, waitMs = 0, as = "carol") =>
    (await getJson<{ message: Message }>(bus, `/api/messages/${seq}?waitMs=${waitMs}`, as)).message;

  test("each recipient's ack marks only that message delivered; viewers and the writer agent get receipt frames", async () => {
    const viewer = await connectViewer();
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");

    const { message } = await send({ from: "alpha", to: "@{beta,carol}", text: "first" });
    expect(message.receipts).toEqual([{ to: "beta", deliveredAt: null, seenAt: null }]);
    const second = (await send({ from: "alpha", to: "@{beta,carol}", text: "second" })).message;
    expect((await beta.client.take("deliver")).message.seq).toBe(message.seq);
    expect((await beta.client.take("deliver")).message.seq).toBe(second.seq);

    // Acking the second message does not mark the first one.
    beta.client.send({ type: "ack", seq: second.seq });
    const toWriter = await alpha.client.take("receipt");
    expect(toWriter).toMatchObject({ seq: second.seq, to: "beta", conversationId: message.conversationId, seenAt: null });
    expect(await viewer.take("receipt")).toMatchObject({ seq: second.seq, to: "beta" });
    expect((await getMessage(message.seq)).receipts[0]?.deliveredAt).toBeNull();
    expect((await getMessage(second.seq)).receipts[0]?.deliveredAt).toBeNumber();

    // The unacked first message comes back on rejoin although a later seq was acked.
    await leave(beta.client);
    const betaAgain = await joinPath("/tmp/x/beta");
    expect((await betaAgain.client.take("deliver")).message.seq).toBe(message.seq);
  });

  test("seen marks the receipt seen (and delivered); repeats change nothing", async () => {
    const viewer = await connectViewer();
    const beta = await joinPath("/tmp/x/beta");
    const { message } = await send({ from: "carol", to: "@beta", text: "look at this" });
    await beta.client.take("deliver");

    beta.client.send({ type: "ack", seq: message.seq });
    const delivered = await viewer.take("receipt");
    expect(delivered).toMatchObject({ seq: message.seq, to: "beta", seenAt: null });

    beta.client.send({ type: "seen", seq: message.seq });
    const seen = await viewer.take("receipt");
    expect(seen.seenAt).toBeNumber();
    expect(seen.deliveredAt).toBe(delivered.deliveredAt);

    // A seen without a prior ack also counts as delivered; a repeated seen sends no frame.
    const { message: second } = await send({ from: "carol", to: "@beta", text: "and this" });
    await beta.client.take("deliver");
    beta.client.send({ type: "seen", seq: second.seq });
    beta.client.send({ type: "seen", seq: second.seq });
    const onlyOnce = await viewer.take("receipt");
    expect(onlyOnce.seq).toBe(second.seq);
    expect(onlyOnce.deliveredAt).toBe(onlyOnce.seenAt!);
    const { message: third } = await send({ from: "carol", to: "@beta", text: "third" });
    await beta.client.take("deliver");
    beta.client.send({ type: "ack", seq: third.seq });
    expect((await viewer.take("receipt")).seq).toBe(third.seq); // the repeated seen produced nothing in between
  });

  test("@all receipts list every agent but the writer, offline ones too; waitMs returns once all are delivered", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const gone = await joinPath("/tmp/x/gone");
    await send({ from: "gone", to: "@carol", text: "taking part" });
    await leave(gone.client);

    const { message } = await send({ from: "carol", to: "@all", text: "hello all" });
    expect(message.receipts.map((r) => r.to)).toEqual(["alpha", "beta", "gone"]);
    alpha.client.send({ type: "ack", seq: (await alpha.client.take("deliver")).message.seq });

    // Not everyone has it yet: the wait times out and reports beta and the offline gone pending.
    const partial = await getMessage(message.seq, 50);
    expect(partial.receipts.map((r) => [r.to, r.deliveredAt !== null])).toEqual([["alpha", true], ["beta", false], ["gone", false]]);

    const waiting = getMessage(message.seq, 10_000);
    beta.client.send({ type: "ack", seq: (await beta.client.take("deliver")).message.seq });
    const back = await joinPath("/tmp/x/gone");
    back.client.send({ type: "ack", seq: (await back.client.take("deliver")).message.seq });
    expect((await waiting).receipts.every((r) => r.deliveredAt !== null)).toBe(true);

    expect((await busFetch(bus, "/api/messages/999")).status).toBe(404);
  });

  test("conversation pages carry receipts", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const { message } = await send({ from: "uma", to: "@alpha", text: "dm" });
    alpha.client.send({ type: "ack", seq: (await alpha.client.take("deliver")).message.seq });
    await getMessage(message.seq, 10_000);
    const page = await getJson<MessagesResponse>(bus, `/api/conversations/${message.conversationId}/messages`, "uma");
    expect(page.messages[0]?.receipts[0]).toMatchObject({ to: "alpha" });
    expect(page.messages[0]?.receipts[0]?.deliveredAt).toBeNumber();
  });
});

describe("agents that never took part", () => {
  test("are forgotten when their last connection logs off; agents that wrote or are in a group stay", async () => {
    const scratch = await joinPath("/tmp/x/scratch");
    const twice = await joinPath("/tmp/x/twice");
    const twiceAgain = await joinPath("/tmp/x/twice");
    const writer = await joinPath("/tmp/x/writer");
    const addressed = await joinPath("/tmp/x/addressed");

    const all = await send({ from: "carol", to: "@all", text: "hello" });
    expect(all.message.receipts.map((r) => r.to)).toEqual(["addressed", "scratch", "twice", "writer"]);
    await send({ from: "writer", to: "@carol", text: "I wrote" });
    await send({ from: "uma", to: "@addressed", text: "you are in a group now" });

    const ids = async () => (await state()).participants.filter((p) => p.kind === "agent").map((p) => p.id);
    await leave(scratch.client);
    await leave(twice.client);
    await leave(writer.client);
    await leave(addressed.client);
    // twice still has a connection; scratch is gone, with its receipt.
    expect(await ids()).toEqual(["twice", "addressed", "writer"]);
    const after = await getJson<{ message: Message }>(bus, `/api/messages/${all.message.seq}`);
    expect(after.message.receipts.map((r) => r.to)).toEqual(["addressed", "twice", "writer"]);

    await leave(twiceAgain.client);
    expect(await ids()).toEqual(["addressed", "writer"]);
    const unknown = await post({ from: "carol", to: "@scratch", text: "still there?" });
    expect(unknown.status).toBe(400);

    // A returning folder simply joins again under the same id.
    expect((await joinPath("/tmp/x/scratch")).id).toBe("scratch");
  });

  test("are swept at server start (nobody is connected then)", async () => {
    const idle = await joinPath("/tmp/x/idle");
    const active = await joinPath("/tmp/x/active");
    await send({ from: "active", to: "@carol", text: "hi" });
    // Stop without a clean logoff for idle: the server stops with both connected.
    clients.splice(clients.indexOf(idle.client), 1);
    clients.splice(clients.indexOf(active.client), 1);
    await bus.stop();
    bus = startBus({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol", "uma"] });
    expect((await state()).participants.filter((p) => p.kind === "agent").map((p) => p.id)).toEqual(["active"]);
  });
});

describe("agent tokens", () => {
  test("an id belongs to the first approved token that joins as it: another approved token cannot join or write as it", async () => {
    bus.approveAgentToken("token-a");
    bus.approveAgentToken("token-b");
    const owner = await joinAgent({ host: "h1", harness: "omp", path: "/tmp/x/alpha", token: "token-a" });
    expect(owner.id).toBe("alpha");

    // Same folder, another token: refused (4401), with how to free the id.
    const thief = await Client.connect(agentSocketUrl(bus, { host: "h1", harness: "omp", path: "/tmp/x/alpha", token: "token-b" }));
    expect((await thief.take("error")).error).toContain("agent-bus reset-agent alpha");
    await thief.closedPromise;
    // No token at all: refused whatever the id.
    const anonymous = await Client.connect(wsUrl(`/ws/agent?${new URLSearchParams({ host: "h1", harness: "omp", path: "/tmp/x/other" })}`));
    expect((await anonymous.take("error")).error).toContain("sends no agent token");
    await anonymous.closedPromise;

    // HTTP writes as a bound agent need its token.
    const write = (headers: Record<string, string>) =>
      fetch(`${bus.url}/api/messages`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ from: "alpha", to: "@carol", text: "hi" }) });
    expect((await write({})).status).toBe(401);
    expect((await write({ "X-Agent-Token": "token-b" })).status).toBe(401);
    expect((await write(identity(bus, "carol"))).status).toBe(403);
    expect((await write({ "X-Agent-Token": "token-a" })).status).toBe(200);
    expect((await setSetting("alpha", "all", "wake")).status).toBe(401);

    // Nobody writes as the bus's own @resources (403 once it exists; unknown before its first notice).
    expect([400, 403]).toContain((await post({ from: "resources", to: "@carol", text: "your GPU is mine" })).status);
  });
});

describe("agents offline for a long time", () => {
  test("are forgotten after forgetOfflineDays (default 15): record and pending receipts go, their messages stay; 0 keeps them", async () => {
    const old = await joinPath("/tmp/x/old");
    const recent = await joinPath("/tmp/x/recent");
    const wrote = await send({ from: "old", to: "@carol", text: "my last words" });
    await send({ from: "recent", to: "@carol", text: "still around" });
    await leave(old.client);
    await leave(recent.client);
    await bus.stop();
    const raw = new Database(path.join(dataDir, "message-bus.sqlite"));
    const day = 24 * 3600_000;
    raw.query("UPDATE participants SET last_seen_at = ?2 WHERE id = ?1").run("old", Date.now() - 16 * day);
    raw.query("UPDATE participants SET last_seen_at = ?2 WHERE id = ?1").run("recent", Date.now() - 14 * day);
    raw.query("INSERT INTO receipts (seq, recipient, delivered_at) VALUES (?1, 'old', NULL)").run(wrote.message.seq);
    raw.close();
    const agentIds = async () => (await state()).participants.filter((p) => p.kind === "agent").map((p) => p.id);

    bus = startBus({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol", "uma"], forgetOfflineDays: 0 });
    expect(await agentIds()).toEqual(["old", "recent"]);
    await bus.stop();

    bus = startBus({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol", "uma"] });
    expect(await agentIds()).toEqual(["recent"]);
    const kept = await getJson<{ message: Message }>(bus, `/api/messages/${wrote.message.seq}`, "carol");
    expect(kept.message.text).toBe("my last words");
    expect(kept.message.receipts.map((r) => r.to)).toEqual([]);
    // Its conversation is still there, but nobody can write to the forgotten agent.
    const reply = await post({ from: "carol", conversationId: wrote.conversation.id, text: "hello?" });
    expect(reply.status).toBe(409);
    expect(await errorOf(reply)).toContain("@old is no longer on the bus");
  });
});

describe("reply quotes", () => {
  test("a replyToSeq message carries a quote of the original, in pages, deliveries and after restart", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const long = "x".repeat(400);
    const original = (await send({ from: "carol", to: "@alpha", text: `please check run 7 ${long}` })).message;
    await alpha.client.take("deliver");

    const reply = await send({ from: "alpha", replyToSeq: original.seq, text: "run 7 is fine" });
    expect(reply.message.quote?.seq).toBe(original.seq);
    expect(reply.message.quote?.from).toBe("carol");
    expect(reply.message.quote?.text.length).toBe(280);
    expect(reply.message.quote?.text.endsWith("…")).toBe(true);
    expect(reply.message.quote?.files).toBe(0);

    // Agents receive the quote with the delivery.
    const human = await send({ from: "carol", replyToSeq: reply.message.seq, text: "thanks" });
    const delivered = await alpha.client.take("deliver");
    expect(delivered.message.seq).toBe(human.message.seq);
    expect(delivered.message.quote).toEqual({ seq: reply.message.seq, from: "alpha", text: "run 7 is fine", files: 0 });

    // Ordinary messages have no quote; pages carry quotes.
    const plain = await send({ from: "carol", to: "@alpha", text: "no quote" });
    expect(plain.message.quote).toBeUndefined();
    const page = await getJson<MessagesResponse>(bus, `/api/conversations/${original.conversationId}/messages`, "carol");
    expect(page.messages.map((m) => m.quote?.seq ?? null)).toEqual([null, original.seq, reply.message.seq, null]);

    // The quote survives a restart (it is stored as the replied-to number and resolved on read).
    clients.splice(clients.indexOf(alpha.client), 1);
    await bus.stop();
    bus = startBus({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol", "uma"] });
    const after = await getJson<{ message: Message }>(bus, `/api/messages/${human.message.seq}`, "carol");
    expect(after.message.quote?.seq).toBe(reply.message.seq);
  });
});

describe("checklists with items (Ümit #12364, codex-ui #12379)", () => {
  /** A room with agents alpha and beta and people carol and uma in it; its checklist's routes. */
  async function room() {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const project = await send({ from: alpha.id, to: "@@launch", text: "launch prep" });
    const id = project.conversation.id;
    for (const from of [beta.id, "carol", "uma"]) await send({ from, conversationId: id, text: "here" });
    const instruction = await send({ from: "carol", conversationId: id, text: "Prepare the launch: notes, deploy" });
    const route = `/api/conversations/${id}/checklist`;
    const edit = (from: string, base: number, ops: unknown[]) => postJson(bus, `${route}/edit`, { from, base, ops });
    const tick = (from: string, item: string, done: boolean, base?: number) =>
      postJson(bus, `${route}/tick`, { from, id: item, done, ...(base === undefined ? {} : { base }) });
    const pin = (from: string, pinned: boolean) => postJson(bus, `${route}/pin`, { from, pinned });
    const get = async (): Promise<Checklist> => (await busFetch(bus, route, {}, "carol")).json() as Promise<Checklist>;
    return { alpha: alpha.id, beta: beta.id, id, seq: instruction.message.seq, route, edit, tick, pin, get };
  }

  test("two agents adding on the same version: one gets 409 with the list, rereads and reapplies; both items are there", async () => {
    const { alpha, beta, seq, edit, get } = await room();
    const heading = `#${seq} Launch prep`;
    const created = await edit(alpha, 0, [{ op: "add", heading, text: "Write release notes", source: seq }]);
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ version: 1, pinned: true, creator: alpha, items: [{ id: "i1", heading, text: "Write release notes", owner: alpha, source: seq }] });
    expect((await edit(beta, 0, [{ op: "add", text: "late creator" }])).status).toBe(409); // it exists now

    const [a, b] = await Promise.all([
      edit(alpha, 1, [{ op: "add", heading, text: "Tag the release", source: seq }]),
      edit(beta, 1, [{ op: "add", heading, text: "Deploy to staging", source: seq }]),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const [loser, lost] = a.status === 409 ? [alpha, a] : [beta, b];
    const conflict = (await lost.json()) as { error: string; checklist: Checklist };
    expect(conflict.error).toContain("changed meanwhile");
    expect(conflict.checklist.version).toBe(2);
    // The loser reapplies its own change on the version it got back.
    const text = loser === alpha ? "Tag the release" : "Deploy to staging";
    expect((await edit(loser, conflict.checklist.version, [{ op: "add", heading, text, source: seq }])).status).toBe(200);
    const list = await get();
    expect(list.version).toBe(3);
    expect(list.items.map((item) => item.text).sort()).toEqual(["Deploy to staging", "Tag the release", "Write release notes"]);
    expect(new Set(list.items.map((item) => item.id)).size).toBe(3);
    expect(list.text).toStartWith(`## ${heading}\n- [ ] Write release notes`);
  });

  test("a stale agent edit racing with a person's tick: the edit 409s, the tick survives the reapplied edit", async () => {
    const { alpha, edit, tick, get } = await room();
    await edit(alpha, 0, [{ op: "add", text: "Write release notes" }]);
    const read = await get(); // alpha reads version 1
    expect((await tick("carol", "i1", true)).status).toBe(200); // carol ticks meanwhile: version 2
    const stale = await edit(alpha, read.version, [{ op: "update", id: "i1", text: "Write the release notes" }]);
    expect(stale.status).toBe(409);
    const conflict = (await stale.json()) as { checklist: Checklist };
    expect(conflict.checklist.items[0]?.done?.by).toBe("carol");
    expect((await edit(alpha, conflict.checklist.version, [{ op: "update", id: "i1", text: "Write the release notes" }])).status).toBe(200);
    expect((await get()).items).toEqual([expect.objectContaining({ id: "i1", text: "Write the release notes", done: expect.objectContaining({ by: "carol" }) })]);
    // A tick on a version that moved on 409s too, when it names one.
    expect((await tick("carol", "i1", false, 1)).status).toBe(409);
  });

  test("rewording or moving an item keeps its id and done state; blocked is set and cleared", async () => {
    const { alpha, edit, tick, get } = await room();
    await edit(alpha, 0, [{ op: "add", heading: "A", text: "first" }, { op: "add", heading: "B", text: "second" }]);
    expect((await tick(alpha, "i1", true)).status).toBe(200);
    let list = await get();
    const res = await edit(alpha, list.version, [
      { op: "update", id: "i1", text: "first, reworded", heading: "B" },
      { op: "update", id: "i2", blocked: "needs the deploy token" },
    ]);
    expect(res.status).toBe(200);
    list = await get();
    expect(list.items.map((item) => [item.id, item.heading, item.text, item.blocked, item.done?.by])).toEqual([
      ["i2", "B", "second", "needs the deploy token", undefined],
      ["i1", "B", "first, reworded", undefined, alpha],
    ]);
    await edit(alpha, list.version, [{ op: "update", id: "i2", blocked: "" }, { op: "remove", id: "i1" }]);
    list = await get();
    expect(list.items).toEqual([{ id: "i2", heading: "B", text: "second", owner: alpha }]);
    // Ids are never reused.
    await edit(alpha, list.version, [{ op: "add", text: "third" }]);
    expect((await get()).items.map((item) => item.id)).toEqual(["i3", "i2"]);
    // Bad operations change nothing: all or none.
    const before = (await get()).version;
    expect((await edit(alpha, before, [{ op: "add", text: "fourth" }, { op: "update", id: "i99", text: "x" }])).status).toBe(400);
    expect((await edit(alpha, before, [{ op: "add", text: "two\nlines" }])).status).toBe(400);
    expect((await get()).version).toBe(before);
  });

  test("an agent changes and ticks only its own items and never unticks a person's tick; people tick and change any", async () => {
    const { alpha, beta, edit, tick, get } = await room();
    await edit(alpha, 0, [{ op: "add", text: "alpha's step" }]);
    await edit(beta, 1, [{ op: "add", text: "beta's step" }]);
    let version = (await get()).version;
    // beta may not touch alpha's item: update, remove, tick.
    const denied = await edit(beta, version, [{ op: "update", id: "i1", text: "mine now" }]);
    expect(denied.status).toBe(403);
    expect(await errorOf(denied)).toContain(`@${alpha}`);
    expect((await edit(beta, version, [{ op: "remove", id: "i1" }])).status).toBe(403);
    expect((await tick(beta, "i1", true)).status).toBe(403);
    // A person who is a member ticks any item; the owning agent may not untick it.
    expect((await tick("carol", "i1", true)).status).toBe(200);
    const untick = await tick(alpha, "i1", false);
    expect(untick.status).toBe(403);
    expect(await errorOf(untick)).toContain("only people untick it");
    // Ticking it again keeps the person's tick.
    expect((await tick(alpha, "i1", true)).status).toBe(200);
    expect((await get()).items[0]?.done?.by).toBe("carol");
    // An agent ticks and unticks its own.
    expect((await tick(beta, "i2", true)).status).toBe(200);
    expect((await tick(beta, "i2", false)).status).toBe(200);
    expect((await get()).items[1]?.done).toBeUndefined();
    // People change and remove any item; they untick any tick.
    version = (await get()).version;
    expect((await edit("uma", version, [{ op: "update", id: "i2", text: "beta's step, as uma says" }])).status).toBe(200);
    expect((await tick("uma", "i1", false)).status).toBe(200);
    // Agents outside the conversation do nothing.
    const gamma = await joinPath("/tmp/x/gamma");
    expect((await edit(gamma.id, (await get()).version, [{ op: "add", text: "intruder" }])).status).toBe(403);
    expect((await tick(gamma.id, "i2", true)).status).toBe(403);
  });

  test("pinned on creation; only people unpin and pin; an agent's edit leaves an unpinned list unpinned", async () => {
    const { alpha, route, edit, pin, get } = await room();
    await edit(alpha, 0, [{ op: "add", text: "step" }]);
    expect((await get()).pinned).toBe(true);
    expect((await pin(alpha, false)).status).toBe(403);
    const unpinned = await pin("carol", false);
    expect(await unpinned.json()).toMatchObject({ pinned: false, version: 2 });
    expect((await edit(alpha, 2, [{ op: "add", text: "another step" }])).status).toBe(200);
    const put = await busFetch(bus, route, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: alpha, text: "- [ ] step\n- [ ] another step\n- [x] done" }) });
    expect(put.status).toBe(200);
    expect(await get()).toMatchObject({ pinned: false, version: 4 });
    // Done for all items does not unpin either; a person pins it again.
    expect((await pin("uma", true)).status).toBe(200);
    expect(await get()).toMatchObject({ pinned: true, version: 5 });
  });

  test("the markdown PUT keeps other agents' items and the ids of matching lines; only its creator uses it", async () => {
    const { alpha, beta, route, edit, get } = await room();
    const put = (text: string) => busFetch(bus, route, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: alpha, text }) });
    expect((await put("## Today\n- [ ] one\n- [ ] two")).status).toBe(200);
    await edit(beta, 1, [{ op: "add", heading: "Today", text: "beta's" }]);
    expect((await put("## Today\n- [ ] two\n- [ ] three")).status).toBe(200);
    const list = await get();
    expect(list.items.map((item) => [item.id, item.text, item.owner])).toEqual([
      ["i2", "two", alpha],
      ["i4", "three", alpha],
      ["i3", "beta's", beta],
    ]);
    expect(list.text).toBe("## Today\n- [ ] two\n- [ ] three\n- [ ] beta's");
    // Only its creator replaces it, with the current version when it names one.
    expect((await busFetch(bus, route, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: beta, text: "- [ ] x" }) })).status).toBe(403);
    expect((await busFetch(bus, route, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: alpha, text: "- [ ] x", base: 1 }) })).status).toBe(409);
  });

  /** Stops the bus, stores `text` as a checklist of `id` the way the bus did before items, and starts it again. */
  async function storedAsMarkdown(id: string, owner: string, text: string, ticks: Record<string, { by: string; at: number }>): Promise<void> {
    await bus.stop();
    // The table as it was before items: no items, version, pinned, next_id, title or intro columns.
    const raw = new Database(path.join(dataDir, "message-bus.sqlite"));
    raw.exec("DROP TABLE checklists");
    raw.exec(`CREATE TABLE checklists (conversation_id TEXT PRIMARY KEY, text TEXT NOT NULL, ticks_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, owner TEXT, assignees_json TEXT)`);
    raw.query("INSERT INTO checklists VALUES (?1, ?2, ?3, 2000, ?4, ?4, '[\"carol\"]')").run(id, text, JSON.stringify(ticks), owner);
    raw.close();
    bus = startBus({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol", "uma"] });
  }

  test("a checklist stored as markdown migrates at startup: ids, ticks by text, [x], headings, pinned, owned by its owner", async () => {
    const { alpha, id, get } = await room();
    const ticks = { "Approve disk cleanup · #8264": { by: "carol", at: 1000 } };
    await storedAsMarkdown(id, alpha, "## Money\n- [ ] Approve disk cleanup · #8264\nA note\n- [x] Top up OpenRouter\n\n## Later\n- [ ] Rotate keys", ticks);
    const list = await get();
    expect(list).toMatchObject({ version: 1, pinned: true, creator: alpha, assignees: ["carol"] });
    expect(list.items).toEqual([
      { id: "i1", heading: "Money", text: "Approve disk cleanup · #8264", owner: alpha, detail: "A note", done: { by: "carol", at: 1000 } },
      { id: "i2", heading: "Money", text: "Top up OpenRouter", owner: alpha, done: { by: alpha, at: 2000 } },
      { id: "i3", heading: "Later", text: "Rotate keys", owner: alpha },
    ]);
    // New items continue the ids.
    expect((await postJson(bus, `/api/conversations/${id}/checklist/edit`, { from: "carol", base: 1, ops: [{ op: "add", text: "new" }] })).status).toBe(200);
    expect((await get()).items[0]).toMatchObject({ id: "i4", text: "new", owner: "carol" });
  });

  test("no text is lost: a title, an intro and the lines under items survive the migration, the derived markdown and a PUT", async () => {
    const { alpha, id, route, get } = await room();
    // The two shapes of the live bus's lists: an intro under the `# Title`; indented and plain lines under an item.
    const original = [
      "# Hilde Hub launch",
      "Target: 1–2 working days … No public publication authorised by this list.",
      "_Updated 2026-11-18 16:30 by Ali … Ali archives it and tells whoever asked._",
      "",
      "## Review",
      "- [x] Website review",
      "  UI review closed by codex-ui at agent-hub 20aa64d (17 Nov), …",
      "  and the phone pass after it.",
      "- [ ] Docs pass",
      "A plain line under an item",
      "Another plain line",
      "",
      "## Publish",
      "- [ ] Tag the release",
    ].join("\n");
    await storedAsMarkdown(id, alpha, original, {});
    const list = await get();
    expect(list.title).toBe("Hilde Hub launch");
    expect(list.intro).toBe("Target: 1–2 working days … No public publication authorised by this list.\n_Updated 2026-11-18 16:30 by Ali … Ali archives it and tells whoever asked._");
    expect(list.items.map((item) => [item.id, item.heading, item.text, item.detail, item.done?.by])).toEqual([
      ["i1", "Review", "Website review", "UI review closed by codex-ui at agent-hub 20aa64d (17 Nov), …\nand the phone pass after it.", alpha],
      ["i2", "Review", "Docs pass", "A plain line under an item\nAnother plain line", undefined],
      ["i3", "Publish", "Tag the release", undefined, undefined],
    ]);
    // Every non-blank line of the original is in the derived markdown.
    const derived = new Set(list.text.split("\n").map((line) => line.trim()));
    for (const line of original.split("\n").filter((l) => l.trim())) expect(derived).toContain(line.trim());

    // Writing the derived markdown back changes nothing but the version.
    const put = (text: string) => busFetch(bus, route, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: alpha, text }) });
    expect((await put(list.text)).status).toBe(200);
    const again = await get();
    expect({ ...again, version: 0, updatedAt: 0 }).toEqual({ ...list, version: 0, updatedAt: 0 });
    // A PUT with other lines under an item replaces its detail; one with none keeps it.
    expect((await put("# Hilde Hub launch\n- [x] Website review\n  closed for good\n- [ ] Docs pass")).status).toBe(200);
    const replaced = await get();
    expect(replaced.items.map((item) => [item.id, item.detail])).toEqual([["i1", "closed for good"], ["i2", "A plain line under an item\nAnother plain line"]]);
    expect(replaced.intro).toBeUndefined();
  });

  test("agents set and clear an item's detail with add and update", async () => {
    const { alpha, edit, get } = await room();
    await edit(alpha, 0, [{ op: "add", text: "Deploy", detail: "staging first\n  then production" }]);
    expect((await get()).items[0]?.detail).toBe("staging first\n  then production");
    expect((await get()).text).toBe("- [ ] Deploy\n  staging first\n    then production");
    await edit(alpha, 1, [{ op: "update", id: "i1", detail: "" }]);
    expect((await get()).items[0]?.detail).toBeUndefined();
  });
});
