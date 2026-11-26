import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { StateResponse } from "@agent-bus/protocol";
import type { BusServerHandle } from "@agent-bus/server";
import { getJson, postJson, startBus, TEST_TOKEN } from "./helpers";

const repo = resolve(import.meta.dir, "..");
const homes: string[] = [];

async function agentBus(home: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, "run", "packages/cli/src/bin.ts", ...args], {
    cwd: repo,
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${stdout}${stderr}`);
}

async function runHook(home: string, cwd: string): Promise<string> {
  const settings = JSON.parse(readFileSync(join(home, ".qwen", "settings.json"), "utf8"));
  const command = settings.hooks.UserPromptSubmit
    .flatMap((definition: { hooks?: unknown[] }) => definition.hooks ?? [])
    .find((hook: { command?: string }) => hook.command?.endsWith(" --managed-by agent-bus"));
  if (!command) throw new Error("Installed Qwen hook is missing");
  const child = Bun.spawn(["/bin/sh", "-c", command.command], {
    cwd,
    env: { ...process.env, HOME: home, AGENT_BUS_JOIN_FROM_TMP: "1" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "continue" }));
  child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${stdout}${stderr}`);
  if (stderr.includes("[agent-hub] Qwen Inbox hook:")) throw new Error(stderr);
  return stdout;
}

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "agent-hub-universal-mcp-"));
  homes.push(value);
  return value;
}

afterEach(() => {
  for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("universal MCP adapter configuration", () => {
  test("Qwen reinstall and uninstall restore the prior settings byte for byte", async () => {
    const root = home();
    const settings = join(root, ".qwen", "settings.json");
    const before = `{
  "theme": "dark",
  "mcpServers": {
    "existing-tool": {
      "command": "printf",
      "args": ["keep-me"]
    }
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "my-existing-hook"
          }
        ]
      }
    ]
  }
}
`;
    await Bun.write(settings, before);

    await agentBus(root, "install", "qwen", "--url", "http://127.0.0.1:7800", "--build-only");
    const first = JSON.parse(readFileSync(settings, "utf8"));
    expect(first.hooks.UserPromptSubmit).toHaveLength(2);
    expect(first.hooks.UserPromptSubmit[1].hooks[0].command).toEndWith(" --managed-by agent-bus");
    expect(existsSync(join(root, ".agent-bus", "adapters", "qwen", "inbox-hook.mjs"))).toBe(true);
    await agentBus(root, "install", "qwen", "--url", "http://127.0.0.1:7800", "--build-only");
    const second = JSON.parse(readFileSync(settings, "utf8"));
    expect(second.hooks.UserPromptSubmit).toHaveLength(2);
    await agentBus(root, "uninstall", "qwen");

    expect(readFileSync(settings, "utf8")).toBe(before);
  }, 30_000);

  test("Qwen uninstall removes a settings file created only for Agent Hub", async () => {
    const root = home();
    const settings = join(root, ".qwen", "settings.json");

    await agentBus(root, "install", "qwen", "--url", "http://127.0.0.1:7800", "--build-only");
    expect(existsSync(settings)).toBe(true);
    await agentBus(root, "uninstall", "qwen");

    expect(existsSync(settings)).toBe(false);
  }, 30_000);

  test("Grok reinstall and uninstall restore config.toml byte for byte", async () => {
    const root = home();
    const config = join(root, ".grok", "config.toml");
    const before = `[models]\ndefault = "dspark"\n\n[mcp_servers.other]\ncommand = "printf"\nargs = ["keep-me"]`;
    await Bun.write(config, before);

    await agentBus(root, "install", "grok", "--url", "http://127.0.0.1:7800", "--build-only");
    const installed = readFileSync(config, "utf8");
    expect(installed.startsWith(`${before}\n`)).toBe(true);
    expect(installed).toContain("[mcp_servers.agent-hub]");
    await agentBus(root, "install", "grok", "--url", "http://127.0.0.1:7800", "--build-only");
    expect(readFileSync(config, "utf8")).toBe(installed);
    await agentBus(root, "uninstall", "grok");

    expect(readFileSync(config, "utf8")).toBe(before);
  }, 30_000);

  test("Grok uninstall keeps settings added while installed", async () => {
    const root = home();
    const config = join(root, ".grok", "config.toml");
    await Bun.write(config, "[models]\ndefault = \"dspark\"\n");
    await agentBus(root, "install", "grok", "--url", "http://127.0.0.1:7800", "--build-only");
    await Bun.write(config, `${readFileSync(config, "utf8")}\n[ui]\ntheme = "dark"\n`);
    await agentBus(root, "uninstall", "grok");

    const after = readFileSync(config, "utf8");
    expect(after).not.toContain("agent-hub");
    expect(after).toContain("[models]");
    expect(after).toContain("theme = \"dark\"");
  }, 30_000);

  test("Qwen hook injects each unseen Inbox message once before a turn", async () => {
    const root = home();
    const project = repo;
    const dataDir = join(root, "bus");
    mkdirSync(join(root, ".agent-bus"), { recursive: true });
    await Bun.write(join(root, ".agent-bus", "agent-token"), `${TEST_TOKEN}\n`);
    const bus: BusServerHandle = startBus({ host: "127.0.0.1", port: 0, dataDir, humans: ["carol"] });
    let bridge: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await agentBus(root, "install", "qwen", "--url", bus.url, "--build-only");
      const settings = JSON.parse(readFileSync(join(root, ".qwen", "settings.json"), "utf8"));
      const server = settings.mcpServers["agent-hub"];
      bridge = Bun.spawn([server.command, ...server.args], {
        cwd: project,
        env: { ...process.env, HOME: root, AGENT_BUS_JOIN_FROM_TMP: "1" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      let agent: StateResponse["participants"][number] | undefined;
      for (let attempt = 0; attempt < 50 && !agent; attempt += 1) {
        const state = await getJson<StateResponse>(bus, "/api/state", "carol");
        agent = state.participants.find((participant) => participant.kind === "agent" && participant.path === repo);
        if (!agent) await Bun.sleep(10);
      }
      if (!agent) throw new Error("Qwen MCP bridge did not join the test bus");
      expect(await runHook(root, project)).toBe("");

      const sent = await postJson(bus, "/api/messages", {
        from: "carol",
        to: `@${agent.id}`,
        text: "Please review the release notes.",
      });
      if (!sent.ok) throw new Error(await sent.text());
      expect(await runHook(root, project)).toContain("Please review the release notes.");
      expect(await runHook(root, project)).toBe("");
    } finally {
      if (bridge) {
        const stdin = bridge.stdin;
        if (stdin && typeof stdin !== "number") stdin.end();
        await bridge.exited;
      }
      await bus.stop();
    }
  }, 30_000);

  test("twin bridges of one window share one bus session, and the survivor takes over", async () => {
    const root = home();
    const project = repo;
    mkdirSync(join(root, ".agent-bus"), { recursive: true });
    await Bun.write(join(root, ".agent-bus", "agent-token"), `${TEST_TOKEN}\n`);
    const bus: BusServerHandle = startBus({ host: "127.0.0.1", port: 0, dataDir: join(root, "bus"), humans: ["carol"] });
    const bridges: Array<ReturnType<typeof Bun.spawn>> = [];
    const connections = async (): Promise<number> => {
      const state = await getJson<StateResponse>(bus, "/api/state", "carol");
      return state.participants.find((participant) => participant.kind === "agent" && participant.path === project)?.connections ?? 0;
    };
    const until = async (what: string, ok: () => Promise<boolean>): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await ok()) return;
        await Bun.sleep(50);
      }
      throw new Error(`Timed out waiting for ${what}`);
    };
    type McpReply = { result?: unknown; error?: { message: string } };
    const mcpClient = (child: ReturnType<typeof Bun.spawn>) => {
      let nextId = 0;
      const waiting = new Map<number, (message: McpReply) => void>();
      void (async () => {
        const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let at = buffer.indexOf("\n");
          while (at >= 0) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            at = buffer.indexOf("\n");
            if (!line.trim()) continue;
            const message = JSON.parse(line) as { id?: number } & McpReply;
            const resolve = message.id === undefined ? undefined : waiting.get(message.id);
            if (resolve) {
              waiting.delete(message.id as number);
              resolve(message);
            }
          }
        }
      })();
      return (method: string, params?: unknown): Promise<McpReply> => {
        const id = (nextId += 1);
        (child.stdin as { write(chunk: string): void }).write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        return new Promise((resolve, reject) => {
          waiting.set(id, resolve);
          setTimeout(() => reject(new Error(`The bridge did not answer ${method}`)), 10_000);
        });
      };
    };
    const inboxOk = async (call: ReturnType<typeof mcpClient>): Promise<boolean> => {
      const reply = await call("tools/call", { name: "message-bus", arguments: { op: "inbox" } });
      return reply.result !== undefined && (reply.result as { isError?: boolean }).isError !== true;
    };
    try {
      await agentBus(root, "install", "qwen", "--url", bus.url, "--build-only");
      const server = JSON.parse(readFileSync(join(root, ".qwen", "settings.json"), "utf8")).mcpServers["agent-hub"];
      const spawnBridge = (): ReturnType<typeof Bun.spawn> => {
        const child = Bun.spawn([server.command, ...server.args], {
          cwd: project,
          env: { ...process.env, HOME: root, AGENT_BUS_JOIN_FROM_TMP: "1" },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        bridges.push(child);
        return child;
      };

      const first = spawnBridge();
      await until("the first bridge to join the bus", async () => (await connections()) === 1);

      // The harness starts the same server again for the same window: same parent, folder and bus.
      const second = spawnBridge();
      const call = mcpClient(second);
      const hello = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      expect((hello.result as { serverInfo: { name: string } }).serverInfo.name).toBe("message-bus");
      // The twin has no bus connection of its own; a working call is served through the primary.
      expect(await inboxOk(call)).toBe(true);
      await Bun.sleep(200);
      expect(await connections()).toBe(1);

      // The harness closes the primary's connection: the twin takes the bus session over.
      const stdin = first.stdin;
      if (stdin && typeof stdin !== "number") stdin.end();
      await first.exited;
      await until("the twin to take over the bus session", async () => (await connections()) === 1 && (await inboxOk(call)));
    } finally {
      for (const child of bridges) {
        const stdin = child.stdin;
        if (stdin && typeof stdin !== "number") stdin.end();
      }
      await Promise.all(bridges.map((child) => child.exited));
      await bus.stop();
    }
  }, 30_000);
});
