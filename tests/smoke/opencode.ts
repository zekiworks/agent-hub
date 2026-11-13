// Real OpenCode V2, isolated HOME/config/database, built plugin, scratch bus and fake model: no credentials or cost.
// Run with: bun tests/smoke/opencode.ts
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createBusServer } from "../../packages/server/src/index";
import { install } from "../../packages/opencode-plugin/scripts/install";
import { agentToken, BusConnection } from "../../packages/client/src/connection";

const tmp = path.join(tmpdir(), "opencode");
mkdirSync(tmp, { recursive: true });
const dir = mkdtempSync(path.join(tmp, "agent-hub-smoke-"));
const project = path.join(dir, "project");
const config = path.join(dir, "config");
const tokenFile = path.join(dir, "agent-token");
process.env.AGENT_BUS_TOKEN_FILE = tokenFile;
const token = agentToken();
const bus = createBusServer({ host: "127.0.0.1", port: 0, dataDir: path.join(dir, "bus"), humans: ["carol"] });
bus.approveAgentToken(token);
const human = bus.signIn("carol");
const requests: Record<string, unknown>[] = [];
const replied = new Set<number>();
let ranShell = false;
const model = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const body = await req.json() as Record<string, unknown>;
    requests.push(body);
    const history = JSON.stringify(body.messages);
    const tools = body.tools as Array<{ function?: { name: string } }> | undefined;
    let call: { name: string; arguments: string } | undefined;
    if (tools?.some((tool) => tool.function?.name === "execute")) {
      if (history.includes("run busy smoke") && !ranShell) {
        ranShell = true;
        call = { name: "shell", arguments: JSON.stringify({ command: "sleep 1" }) };
      } else {
        const seq = [...history.matchAll(/\[message-bus\] #(\d+) @/g)].map((match) => Number(match[1])).find((n) => !replied.has(n));
        if (seq !== undefined) {
          replied.add(seq);
          call = { name: "execute", arguments: JSON.stringify({
            code: `return await tools["message-bus"]({op:"reply", message_id:${seq}, message:"native-tool-reply-${seq}"});`,
          }) };
        }
      }
    }
    const toolCall = call ? { id: `call_${requests.length}`, type: "function", function: call } : undefined;
    const finish = toolCall ? "tool_calls" : "stop";
    const data = {
      id: `chatcmpl_${requests.length}`, object: "chat.completion", created: 1, model: "fake",
      choices: [{ index: 0, message: toolCall ? { role: "assistant", tool_calls: [toolCall] } : { role: "assistant", content: "smoke done" }, finish_reason: finish }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    };
    if (!body.stream) return Response.json(data);
    const chunk = {
      id: data.id, object: "chat.completion.chunk", created: 1, model: "fake",
      choices: [{ index: 0, delta: toolCall ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] } : { role: "assistant", content: "smoke done" }, finish_reason: null }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({
      ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: data.usage,
    })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  },
});
let child: ReturnType<typeof Bun.spawn> | undefined;
let output = "";
let consume: Promise<void> | undefined;
let other: BusConnection | undefined;
const busHeaders = { "X-Agent-Token": token };
const state = async () => (await (await fetch(`${bus.url}/api/state`, { headers: busHeaders })).json()) as {
  participants: Array<{ id: string; online: boolean; status?: { state: string } }>;
};
async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}\n${output}`);
    await Bun.sleep(25);
  }
}
async function post(text: string) {
  const res = await fetch(`${bus.url}/api/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${human}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "carol", to: "@project", text }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { message: { seq: number } };
}

try {
  mkdirSync(project);
  mkdirSync(path.join(dir, "home"));
  await install({ dir: path.join(config, "opencode", "plugins", "agent-bus"), url: bus.url, buildOnly: true });
  writeFileSync(path.join(config, "opencode", "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "smoke/fake",
    snapshots: false,
    providers: {
      smoke: {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fake" },
        models: { fake: { capabilities: { tools: true }, limit: { context: 128000, output: 4096 } } },
      },
    },
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("OPENCODE_") && !/API_KEY|AUTH_TOKEN/.test(key)
  ));
  child = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project,
    env: {
      ...env, HOME: path.join(dir, "home"), XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: path.join(dir, "data"), XDG_STATE_HOME: path.join(dir, "state"),
      XDG_CACHE_HOME: path.join(dir, "cache"), OPENCODE_DB: path.join(dir, "opencode.db"),
      OPENCODE_PASSWORD: "agent-hub-smoke",
      AGENT_BUS_TOKEN_FILE: tokenFile, AGENT_BUS_URL: bus.url, AGENT_BUS_JOIN_FROM_TMP: "1",
    },
    stdout: "pipe", stderr: "pipe",
  });
  consume = Promise.all([child.stdout, child.stderr].map(async (stream) => {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output += new TextDecoder().decode(value);
    }
  })).then(() => {});
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output), "server start");
  const url = /http:\/\/127\.0\.0\.1:\d+/.exec(output)![0];
  const api = async (route: string, body?: object) => {
    const res = await fetch(`${url}${route}`, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json", "x-opencode-directory": project,
        Authorization: `Basic ${Buffer.from("opencode:agent-hub-smoke").toString("base64")}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    assert.ok(res.ok, `${route}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  const created = await api("/api/session", { location: { directory: project }, title: "agent-hub smoke" });
  const sessionID = created.data?.id ?? created.id;
  assert.ok(sessionID, JSON.stringify(created));
  await api(`/api/session/${sessionID}/prompt`, { text: "hello" });
  await until(async () => (await state()).participants.some((p) => p.id === "project" && p.online && p.status?.state === "idle"), "idle bus join");
  const before = requests.length;
  const { message } = await post("native idle wake smoke");
  await until(() => requests.slice(before).some((request) => JSON.stringify(request).includes("native idle wake smoke")), "native wake reaches model");
  await until(async () => {
    const res = await fetch(`${bus.url}/api/messages/${message.seq}`, { headers: busHeaders });
    const body = await res.json() as { message: { receipts: Array<{ seenAt: number | null }> } };
    return body.message.receipts.some((receipt) => receipt.seenAt !== null);
  }, "seen receipt");
  const reply = async (seq: number): Promise<boolean> => {
    const res = await fetch(`${bus.url}/api/search?from=carol&q=native-tool-reply-${seq}`, { headers: busHeaders });
    const body = await res.json() as { messages: unknown[] };
    return body.messages.length > 0;
  };
  await until(() => reply(message.seq), "real Code Mode tool reply");
  await until(async () => (await state()).participants.some((p) => p.id === "project" && p.status?.state === "idle"), "idle after reply");

  await api(`/api/session/${sessionID}/prompt`, { text: "run busy smoke" });
  await until(async () => (await state()).participants.some((p) => p.id === "project" && (p.status as { tool?: string })?.tool === "shell"), "running shell status");
  const busy = await post("arrived during shell");
  await until(() => reply(busy.message.seq), "delivery during a running tool");
  await until(async () => (await state()).participants.some((p) => p.id === "project" && p.status?.state === "idle"), "idle after busy delivery");

  other = new BusConnection({ url: bus.url, host: "smoke", harness: "raw", name: "other", token, onDeliver: async () => {} });
  other.connect();
  await until(() => other!.connected, "other agent");
  const quietStart = requests.length;
  await other.write({ to: "@all" }, "quiet broadcast smoke");
  await Bun.sleep(500);
  assert.equal(requests.length, quietStart, "agent broadcast must not wake an idle session");
  await api(`/api/session/${sessionID}/prompt`, { text: "flush quiet smoke" });
  await until(() => requests.slice(quietStart).some((request) => JSON.stringify(request).includes("quiet broadcast smoke")), "quiet broadcast joins next turn");
  assert.ok(requests.some((request) => JSON.stringify(request).includes("message-bus")), "tool is advertised to the model");
  console.log("PASS: OpenCode V2 installed plugin, idle wake, busy delivery, quiet broadcast, seen receipt, Code Mode reply, status.");
} finally {
  other?.close();
  child?.kill();
  if (child) await child.exited;
  await consume;
  model.stop(true);
  await bus.stop();
  if (process.env.KEEP_SMOKE) {
    writeFileSync(path.join(dir, "requests.json"), JSON.stringify(requests, null, 2));
    console.log(`Kept ${dir}`);
  }
  else rmSync(dir, { recursive: true, force: true });
}
