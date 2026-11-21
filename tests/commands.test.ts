// Slash commands (Can #14261): a person's `/status-update` goes to its extension with who typed it, where, and the agent
// whose page it was; agents and conversations the person cannot read are refused.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandBody, PostMessageResponse } from "@agent-bus/protocol";
import type { BusServerHandle } from "@agent-bus/server";
import { agentSocketUrl, busFetch, postJson, startBus } from "./helpers";

const dataDir = mkdtempSync(path.join(tmpdir(), "mb-commands-test-"));
const got: CommandBody[] = [];
const ext = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    got.push((await req.json()) as CommandBody);
    return Response.json({ note: `asked ${got.at(-1)!.agent ?? "nobody"}` });
  },
});
let bus: BusServerHandle | undefined;
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of sockets) ws.close();
  bus?.stop();
  ext.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

async function join(b: BusServerHandle, folder: string): Promise<void> {
  const ws = new WebSocket(agentSocketUrl(b, { host: "h1", harness: "omp", path: folder }));
  sockets.push(ws);
  await new Promise<void>((resolve) => ws.addEventListener("message", (e) => JSON.parse(String(e.data)).type === "joined" && resolve()));
}

test("a person's slash command reaches its extension with the agent of the page; others are refused", async () => {
  const b = (bus = startBus({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    humans: ["carol", "uma"],
    extensions: { status: `http://127.0.0.1:${ext.port}` },
    commands: { "status-update": "status" },
  }));
  await join(b, "/tmp/x/alpha");
  const send = async (body: object) => (await (await postJson(b, "/api/messages", body)).json()) as PostMessageResponse;
  const command = (as: string | undefined, conversationId: string, name = "status-update") =>
    busFetch(b, `/api/commands/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, text: "now" }) }, as);

  const dm = await send({ from: "carol", to: "@alpha", text: "hi" });
  const project = await send({ from: "alpha", to: "@@alpha", text: "my page", wake: [] });
  const room = await send({ from: "carol", to: "#launch", text: "a room" });

  expect(await (await command("carol", dm.conversation.id)).json()).toEqual({ note: "asked alpha" });
  expect(got.at(-1)).toMatchObject({ v: 1, command: "status-update", caller: { id: "carol", kind: "human" }, agent: "alpha", text: "now" });
  await send({ from: "carol", conversationId: project.conversation.id, text: "joining" });
  expect(await (await command("carol", project.conversation.id)).json()).toEqual({ note: "asked alpha" });
  // A room is nobody's page.
  expect(await (await command("carol", room.conversation.id)).json()).toEqual({ note: "asked nobody" });
  expect(got.at(-1)?.agent).toBeUndefined();

  const before = got.length;
  expect((await command("uma", dm.conversation.id)).status).toBe(404); // not hers to read
  expect((await command(undefined, dm.conversation.id)).status).toBe(403); // agents do not type slash commands
  expect((await command("carol", dm.conversation.id, "unknown")).status).toBe(404);
  expect(got.length).toBe(before);
});
