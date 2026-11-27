// agent-bus rename-agent (Can #13874, #13877): an agent's id changes everywhere, its project follows, the old id stays
// an alias, and with --path the harness started in the new folder joins as the renamed agent.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MessagesResponse, PostMessageResponse, StateResponse } from "@agent-bus/protocol";
import { renameAgent, type BusServerHandle } from "@agent-bus/server";
import { agentSocketUrl, getJson, postJson, startBus } from "./helpers";

const dataDir = mkdtempSync(path.join(tmpdir(), "mb-rename-test-"));
let bus: BusServerHandle | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await bus?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const start = (): BusServerHandle => (bus = startBus({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol"] }));

/** Joins an agent from `folder`: its id, or the close reason when the bus refuses it. */
function join(b: BusServerHandle, folder: string, harness = "omp"): Promise<{ id?: string; refused?: string }> {
  const ws = new WebSocket(agentSocketUrl(b, { host: "h1", harness, path: folder }));
  sockets.push(ws);
  return new Promise((resolve) => {
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; id?: string };
      if (frame.type === "joined") resolve({ id: frame.id });
    });
    ws.addEventListener("close", (event) => resolve({ refused: event.reason }));
  });
}

async function send(b: BusServerHandle, body: Record<string, unknown>): Promise<PostMessageResponse> {
  const res = await postJson(b, "/api/messages", body);
  if (!res.ok) throw new Error(`POST /api/messages ${res.status}: ${await res.text()}`);
  return (await res.json()) as PostMessageResponse;
}

test("rename-agent: history, project, aliases and the moved folder all follow the new id", async () => {
  let b = start();
  const project = await send(b, { from: "carol", to: "@@turkce", text: "the reading benchmark" });
  expect((await join(b, "/tmp/x/turkce")).id).toBe("turkce");
  expect((await join(b, "/tmp/x/beta")).id).toBe("beta");
  await send(b, { from: "turkce", conversationId: project.conversation.id, text: "joining my project", wake: [] });
  const group = await send(b, { from: "carol", to: "@{turkce,beta}", text: "plan" });
  await send(b, { from: "turkce", conversationId: group.conversation.id, text: "reading runs are going", wake: [] });
  for (const ws of sockets.splice(0)) ws.close();
  await b.stop();

  const db = new Database(path.join(dataDir, "message-bus.sqlite"), { strict: true });
  const result = renameAgent(db, "turkce", "jack", "/tmp/x/jack");
  expect(() => renameAgent(db, "beta", "jack")).toThrow("@jack is taken");
  expect(() => renameAgent(db, "beta", "turkce")).toThrow("old name of another agent");
  db.close();
  expect(result.project).toBe("jack");
  expect(result.messages).toBe(2);

  b = start();
  const state = await getJson<StateResponse>(b, "/api/state", "carol");
  const ids = state.participants.map((p) => p.id);
  expect(ids).toContain("jack");
  expect(ids).not.toContain("turkce");

  // Its history and memberships carry the new id.
  const page = await getJson<MessagesResponse>(b, `/api/conversations/${group.conversation.id}/messages`, "carol");
  expect(page.messages.map((m) => m.from)).toEqual(["carol", "jack"]);
  expect(state.conversations.find((c) => c.id === group.conversation.id)?.members).toEqual(["beta", "carol", "jack"]);

  // The old id still reaches it: in a mention, a wake list, an address and the project's old name.
  expect((await send(b, { from: "beta", conversationId: group.conversation.id, text: "over to you", wake: ["turkce"] })).message.wake).toEqual(["jack"]);
  // beta wrote last, so without the mention the rule would wake beta.
  expect((await send(b, { from: "carol", conversationId: group.conversation.id, text: "@turkce how far?" })).message.wake).toEqual(["jack"]);
  expect((await send(b, { from: "carol", to: "@turkce", text: "a DM" })).conversation.members).toEqual(["carol", "jack"]);
  const viaOldName = await send(b, { from: "carol", to: "@@turkce", text: "still here" });
  expect(viaOldName.conversation.id).toBe(project.conversation.id);
  expect(viaOldName.conversation.name).toBe("jack");

  // The old folder's session is refused; the new folder joins as the renamed agent.
  expect((await join(b, "/tmp/x/turkce")).refused).toContain("renamed to @jack");
  expect((await join(b, "/tmp/x/jack")).id).toBe("jack");
});

test("rename-agent: a second harness in the folder does not take the renamed agent's old address", async () => {
  let b = start();
  expect((await join(b, "/tmp/x/webapp")).id).toBe("webapp");
  expect((await join(b, "/tmp/x/webapp", "codex")).id).toBe("webapp-codex");
  // An agent that has written stays known after it disconnects.
  await send(b, { from: "webapp", to: "@carol", text: "hi", wake: [] });
  await send(b, { from: "webapp-codex", to: "@carol", text: "hi", wake: [] });
  for (const ws of sockets.splice(0)) ws.close();
  await b.stop();

  const db = new Database(path.join(dataDir, "message-bus.sqlite"), { strict: true });
  renameAgent(db, "webapp-codex", "reviewer", "/tmp/x/reviewer");
  db.close();

  b = start();
  expect((await join(b, "/tmp/x/webapp")).id).toBe("webapp");
  // Codex starts again beside webapp: a new agent, not the old address that still reaches @reviewer.
  const again = await join(b, "/tmp/x/webapp", "codex");
  expect(again.id).toBe("webapp-codex-2");
  expect((await send(b, { from: "carol", to: "@webapp-codex", text: "old address" })).conversation.members).toEqual(["carol", "reviewer"]);
});
