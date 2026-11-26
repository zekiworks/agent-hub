import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { StateResponse } from "@agent-bus/protocol";
import type { BusServerHandle } from "@agent-bus/server";
import { getJson, postJson, startBus, TEST_TOKEN } from "./helpers";

const repo = resolve(import.meta.dir, "..");
const homes: string[] = [];

async function agentBus(home: string, ...args: string[]): Promise<string> {
  const { code, output } = await run(home, args);
  if (code !== 0) throw new Error(output);
  return output;
}

/** Runs agent-bus; with `tty`, inside a pseudo-terminal (util-linux `script`) that types `tty` as the answer. */
async function run(home: string, args: string[], tty?: string): Promise<{ code: number; output: string }> {
  const command = [process.execPath, "run", "packages/cli/src/bin.ts", ...args];
  const { GROK_HOME: _, ...env } = process.env;
  const child = Bun.spawn(
    tty === undefined ? command : ["script", "-qec", command.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" "), "/dev/null"],
    { cwd: repo, env: { ...env, HOME: home }, stdin: tty === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" },
  );
  if (tty !== undefined && child.stdin) {
    child.stdin.write(tty);
    child.stdin.end();
  }
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: `${stdout}${stderr}` };
}

/** Bun's TOML parser: throws unless the file is valid TOML. */
type GrokConfig = { cli?: { use_leader?: boolean; theme?: string }; mcp_servers?: Record<string, unknown>; models?: unknown };
const toml = (file: string): GrokConfig => Bun.TOML.parse(readFileSync(file, "utf8")) as GrokConfig;

const PROMPT = "Turn on leader mode in";
const INSTALL_GROK = ["install", "grok", "--url", "http://127.0.0.1:7800", "--build-only"];

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

  test("Grok leader mode: yes on a terminal adds [cli] to the owned block; uninstall restores the file byte for byte", async () => {
    const root = home();
    const config = join(root, ".grok", "config.toml");
    const before = `[models]\ndefault = "dspark"\n`;
    await Bun.write(config, before);

    const { code, output } = await run(root, INSTALL_GROK, "y\n");
    expect(code).toBe(0);
    expect(output).toContain("Grok wakes for Agent Hub messages only in leader mode, and it is off.");
    expect(output).toContain("one Grok process, the leader, owns every Grok session on this machine");
    expect(output).toContain(`${PROMPT} ${config}? [y/N]`);
    expect(output).toContain("Grok leader mode is on");
    const parsed = toml(config);
    expect(parsed.cli?.use_leader).toBe(true);
    expect(parsed.mcp_servers?.["agent-hub"]).toBeDefined();
    const installed = readFileSync(config, "utf8");
    // Reinstalling keeps the leader mode the person turned on, without asking again.
    const again = await agentBus(root, ...INSTALL_GROK, "--no-leader");
    expect(again).not.toContain(PROMPT);
    expect(readFileSync(config, "utf8")).toBe(installed);

    await agentBus(root, "uninstall", "grok");
    expect(readFileSync(config, "utf8")).toBe(before);
  }, 30_000);

  test("Grok leader mode: yes with an existing [cli] sets it there; uninstall after an edit reverts only that", async () => {
    const root = home();
    const config = join(root, ".grok", "config.toml");
    await Bun.write(config, `[cli]\ntheme = "light"\n\n[models]\ndefault = "dspark"\n`);

    const { code, output } = await run(root, INSTALL_GROK, "yes\n");
    expect(code).toBe(0);
    expect(output).toContain(PROMPT);
    expect(toml(config).cli).toEqual({ theme: "light", use_leader: true });
    expect(readFileSync(config, "utf8").match(/^\[cli\]/gm)).toHaveLength(1);

    await Bun.write(config, `${readFileSync(config, "utf8")}\n[ui]\ntheme = "dark"\n`);
    await agentBus(root, "uninstall", "grok");
    const after = readFileSync(config, "utf8");
    expect(after).toBe(`[cli]\ntheme = "light"\n\n[models]\ndefault = "dspark"\n\n[ui]\ntheme = "dark"\n`);
    expect(toml(config).cli).toEqual({ theme: "light" });
  }, 30_000);

  test("Grok leader mode: --leader without a terminal replaces use_leader = false; uninstall after an edit puts it back", async () => {
    const root = home();
    const config = join(root, ".grok", "config.toml");
    await Bun.write(config, `[cli]\nuse_leader = false\n`);

    const output = await agentBus(root, ...INSTALL_GROK, "--leader");
    expect(output).not.toContain(PROMPT);
    expect(toml(config).cli?.use_leader).toBe(true);
    await Bun.write(config, `${readFileSync(config, "utf8")}\n[ui]\ntheme = "dark"\n`);
    await agentBus(root, "uninstall", "grok");
    expect(readFileSync(config, "utf8")).toBe(`[cli]\nuse_leader = false\n\n[ui]\ntheme = "dark"\n`);
    expect(toml(config).cli?.use_leader).toBe(false);

    // Root dotted cli keys: the setting joins them, never a second [cli] table.
    await Bun.write(config, `cli.theme = "light"\n\n[models]\ndefault = "dspark"\n`);
    await agentBus(root, ...INSTALL_GROK, "--leader");
    expect(toml(config).cli).toEqual({ theme: "light", use_leader: true });
  }, 30_000);

  test("Grok leader mode: a [cli] table the install added stays the person's once edited, on reinstall and uninstall", async () => {
    const before = `[models]\ndefault = "dspark"\n`;
    const edits: Array<[string, string, Record<string, unknown>]> = [
      // Turned off and a key added: all theirs now.
      ["reinstall", 'use_leader = false\ntheme = "light"', { use_leader: false, theme: "light" }],
      ["uninstall", 'use_leader = false\ntheme = "light"', { use_leader: false, theme: "light" }],
      // A key added, the setting left alone: the setting is still Agent Hub's to take back on uninstall.
      ["uninstall", `use_leader = true # agent-bus:grok leader\ntheme = "light"`, { theme: "light" }],
    ];
    for (const [operation, replacement, cli] of edits) {
      const root = home();
      const config = join(root, ".grok", "config.toml");
      await Bun.write(config, before);
      await agentBus(root, ...INSTALL_GROK, "--leader");
      const installed = readFileSync(config, "utf8");
      expect(installed.slice(installed.indexOf("# agent-bus:grok begin"))).not.toContain("[cli]");
      expect(toml(config).cli?.use_leader).toBe(true);
      await Bun.write(config, installed.replace("use_leader = true # agent-bus:grok leader", replacement));

      if (operation === "reinstall") {
        const output = await agentBus(root, ...INSTALL_GROK, "--no-leader");
        expect(output).toContain("Leaving Grok leader mode off.");
        expect(toml(config).cli).toEqual(cli);
        expect(readFileSync(config, "utf8").match(/^\[cli\]/gm)).toHaveLength(1);
      }
      await agentBus(root, "uninstall", "grok");
      expect(readFileSync(config, "utf8")).not.toContain("agent-hub");
      expect(toml(config)).toEqual({ models: { default: "dspark" }, cli });
    }
  }, 60_000);

  test("Grok leader mode: a [cli] table inside the block (installs before 27 Nov) keeps the person's keys", async () => {
    const before = `[models]\ndefault = "dspark"\n`;
    const legacy = (text: string, cli: string): string => text.replace("# agent-bus:grok end", `[cli]\n${cli}# agent-bus:grok end`);
    for (const operation of ["untouched", "reinstall", "uninstall"]) {
      const root = home();
      const config = join(root, ".grok", "config.toml");
      const snapshotFile = join(root, ".agent-bus", "adapters", "grok", "config-snapshot.json");
      await Bun.write(config, before);
      await agentBus(root, ...INSTALL_GROK, "--no-leader");
      // What the earlier install wrote: leader mode on, in the block.
      const old = legacy(readFileSync(config, "utf8"), "use_leader = true\n");
      await Bun.write(snapshotFile, JSON.stringify({ ...JSON.parse(readFileSync(snapshotFile, "utf8")), installed: old, leader: {} }));
      await Bun.write(config, operation === "untouched" ? old : old.replace("use_leader = true\n", 'use_leader = false\ntheme = "light"\n'));

      if (operation === "untouched") {
        // Still on, now in a [cli] table of the person's config; uninstall restores the file from before.
        await agentBus(root, ...INSTALL_GROK, "--no-leader");
        const installed = readFileSync(config, "utf8");
        expect(toml(config).cli?.use_leader).toBe(true);
        expect(installed.slice(installed.indexOf("# agent-bus:grok begin"))).not.toContain("[cli]");
        await agentBus(root, "uninstall", "grok");
        expect(readFileSync(config, "utf8")).toBe(before);
        continue;
      }
      if (operation === "reinstall") {
        await agentBus(root, ...INSTALL_GROK, "--no-leader");
        expect(toml(config).cli).toEqual({ use_leader: false, theme: "light" });
        expect(readFileSync(config, "utf8").match(/^\[cli\]/gm)).toHaveLength(1);
      }
      await agentBus(root, "uninstall", "grok");
      expect(readFileSync(config, "utf8")).toBe(`${before}\n[cli]\nuse_leader = false\ntheme = "light"\n`);
      expect(toml(config).cli).toEqual({ use_leader: false, theme: "light" });
    }
  }, 60_000);

  test("Grok leader mode: already on is reported and left alone", async () => {
    const root = home();
    const config = join(root, ".grok", "config.toml");
    for (const before of [`[cli]\nuse_leader = true\n`, `cli.use_leader = true\n\n[models]\ndefault = "dspark"\n`]) {
      await Bun.write(config, before);
      const { code, output } = await run(root, INSTALL_GROK, "n\n");
      expect(code).toBe(0);
      expect(output).toContain("Grok leader mode is already on");
      expect(output).not.toContain(PROMPT);
      expect(toml(config).cli?.use_leader).toBe(true);
      expect(readFileSync(config, "utf8").startsWith(before)).toBe(true);
      await agentBus(root, "uninstall", "grok");
      expect(readFileSync(config, "utf8")).toBe(before);
    }
  }, 30_000);

  test("Grok leader mode: no, --no-leader, or no terminal leave it off and say how to turn it on", async () => {
    const root = home();
    const config = join(root, ".grok", "config.toml");
    const before = `[models]\ndefault = "dspark"\n`;
    await Bun.write(config, before);

    const no = await run(root, INSTALL_GROK, "n\n");
    expect(no.code).toBe(0);
    expect(no.output).toContain(PROMPT);
    expect(no.output).toContain("Leaving Grok leader mode off. To turn it on later: agent-bus install grok --leader");
    expect(toml(config).cli).toBeUndefined();

    const flag = await agentBus(root, ...INSTALL_GROK, "--no-leader");
    expect(flag).not.toContain(PROMPT);
    expect(flag).toContain("Leaving Grok leader mode off.");
    expect(toml(config).cli).toBeUndefined();

    const quiet = await agentBus(root, ...INSTALL_GROK);
    expect(quiet).not.toContain(PROMPT);
    expect(quiet).toContain("Grok leader mode is off");
    expect(toml(config).cli).toBeUndefined();
    const doctor = await run(root, ["doctor", "--url", "http://127.0.0.1:9"]);
    expect(doctor.output).toContain("no idle wake: leader mode off");

    await expect(agentBus(root, "install", "qwen", "--leader")).rejects.toThrow("--leader is for grok only");
    await agentBus(root, "uninstall", "grok");
    expect(readFileSync(config, "utf8")).toBe(before);
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
