import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
type GrokConfig = { cli?: { use_leader?: boolean; [key: string]: unknown }; mcp_servers?: Record<string, unknown>; [table: string]: unknown };
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

  test("Qwen reinstall and uninstall keep the person's hooks inside a definition that also holds Agent Hub's", async () => {
    const root = home();
    const settings = join(root, ".qwen", "settings.json");
    const first = { hooks: [{ type: "command", command: "echo first" }] };
    await Bun.write(settings, JSON.stringify({ hooks: { UserPromptSubmit: [first] } }));
    const install = ["install", "qwen", "--url", "http://127.0.0.1:7800", "--build-only"];
    await agentBus(root, ...install);

    // The person adds their own hooks, and a field, to Agent Hub's definition.
    const managedCommand = (hook: { command?: string }): boolean => hook.command?.endsWith(" --managed-by agent-bus") === true;
    const config = JSON.parse(readFileSync(settings, "utf8"));
    const definitions = config.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command?: string }> }>;
    const ours = definitions.find((definition) => definition.hooks.some(managedCommand))!;
    const before = { type: "command", command: "echo mine-before" };
    const after = { type: "command", command: "echo mine-after" };
    Object.assign(ours, { matcher: "*", hooks: [before, ...ours.hooks, after] });
    writeFileSync(settings, JSON.stringify(config, null, 2));
    const mixed = { matcher: "*", hooks: [before, after] };

    await agentBus(root, ...install);
    const reinstalled = JSON.parse(readFileSync(settings, "utf8"));
    const now = reinstalled.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command?: string }> }>;
    expect(now.slice(0, 2)).toEqual([first, mixed]);
    expect(now).toHaveLength(3);
    expect(now[2]!.hooks.filter(managedCommand)).toHaveLength(1);
    const doctor = await run(root, ["doctor", "--url", "http://127.0.0.1:9"]);
    expect(doctor.output).toContain("qwen:");
    expect(doctor.output).not.toContain("Inbox hook missing");

    // Edited again, so uninstall takes out only Agent Hub's entries.
    writeFileSync(settings, JSON.stringify({ ...reinstalled, theme: "dark" }, null, 2));
    await agentBus(root, "uninstall", "qwen");
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ hooks: { UserPromptSubmit: [first, mixed] }, mcpServers: {}, theme: "dark" });
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

  test("a reinstall whose bundle fails leaves the installed adapter and its 0600 snapshot, and a retry works", async () => {
    const cases: Array<[string, string, string]> = [
      ["qwen", join(".qwen", "settings.json"), `{\n  "theme": "dark"\n}\n`],
      ["grok", join(".grok", "config.toml"), `[models]\ndefault = "dspark"\n`],
    ];
    for (const [harness, relative, before] of cases) {
      const root = home();
      const config = join(root, relative);
      const adapters = join(root, ".agent-bus", "adapters");
      const adapter = join(adapters, harness);
      const snapshot = join(adapter, "config-snapshot.json");
      await Bun.write(config, before);
      const install = ["install", harness, "--url", "http://127.0.0.1:7800", "--build-only", ...(harness === "grok" ? ["--no-leader"] : [])];
      await agentBus(root, ...install);
      const installed = readFileSync(config, "utf8");
      const snapshotText = readFileSync(snapshot, "utf8");

      // Bun.build fails, as when the checkout is broken or the disk is full.
      const preload = join(root, "fail-build.ts");
      await Bun.write(preload, `(Bun as { build: unknown }).build = async () => { throw new Error("injected bundle failure"); };\n`);
      const child = Bun.spawn([process.execPath, "run", "--preload", preload, "packages/cli/src/bin.ts", ...install, "--url", "http://127.0.0.1:7801"], {
        cwd: repo,
        env: { ...process.env, HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("injected bundle failure");
      expect(readdirSync(adapters)).toEqual([harness]);
      expect(existsSync(join(adapter, "package.json"))).toBe(true);
      expect(existsSync(join(adapter, "server.mjs"))).toBe(true);
      expect(readFileSync(snapshot, "utf8")).toBe(snapshotText);
      expect((statSync(snapshot).mode & 0o777).toString(8)).toBe("600");
      expect(readFileSync(config, "utf8")).toBe(installed);

      // The ordinary retry works, and the snapshot it keeps still undoes the whole install.
      await agentBus(root, ...install);
      expect(readdirSync(adapters)).toEqual([harness]);
      expect((statSync(snapshot).mode & 0o777).toString(8)).toBe("600");
      expect((statSync(adapter).mode & 0o777).toString(8)).toBe("700");
      await agentBus(root, "uninstall", harness);
      expect(readFileSync(config, "utf8")).toBe(before);
    }
  }, 60_000);

  test("a 0600 harness config stays 0600, and its snapshot is 0600, under umask 022", async () => {
    const mode = (file: string): string => (statSync(file).mode & 0o777).toString(8);
    const previous = process.umask(0o022);
    try {
      const cases: Array<[string, string, string]> = [
        ["qwen", join(".qwen", "settings.json"), `{\n  "mcpServers": { "other": { "command": "x", "env": { "TOKEN": "secret" } } }\n}\n`],
        ["grok", join(".grok", "config.toml"), `[mcp_servers.other]\ncommand = "x"\nenv = { TOKEN = "secret" }\n`],
      ];
      for (const [harness, relative, before] of cases) {
        for (const edited of [false, true]) {
          const root = home();
          const config = join(root, relative);
          const snapshot = join(root, ".agent-bus", "adapters", harness, "config-snapshot.json");
          mkdirSync(join(config, ".."), { recursive: true });
          writeFileSync(config, before);
          chmodSync(config, 0o600);
          const install = ["install", harness, "--url", "http://127.0.0.1:7800", "--build-only", ...(harness === "grok" ? ["--no-leader"] : [])];

          await agentBus(root, ...install);
          expect(mode(config)).toBe("600");
          expect(mode(snapshot)).toBe("600");
          // A snapshot left readable by an earlier install is private again after a reinstall.
          chmodSync(snapshot, 0o644);
          await agentBus(root, ...install);
          expect(mode(snapshot)).toBe("600");
          expect(mode(config)).toBe("600");

          if (edited) writeFileSync(config, harness === "grok" ? `${readFileSync(config, "utf8")}[ui]\ntheme = "dark"\n` : readFileSync(config, "utf8").replace('"other"', '"another"'));
          await agentBus(root, "uninstall", harness);
          expect(mode(config)).toBe("600");
          if (!edited) expect(readFileSync(config, "utf8")).toBe(before);
        }
      }
    } finally {
      process.umask(previous);
    }
  }, 60_000);

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

  test("Grok: a table written right after the block stays on its own line through reinstall and uninstall", async () => {
    const before = `[models]\ndefault = "dspark"\n`;
    for (const leader of ["--leader", "--no-leader"]) {
      const root = home();
      const config = join(root, ".grok", "config.toml");
      await Bun.write(config, before);
      await agentBus(root, ...INSTALL_GROK, leader);
      expect(readFileSync(config, "utf8").endsWith("# agent-bus:grok end\n")).toBe(true);
      await Bun.write(config, `${readFileSync(config, "utf8")}[ui]\ntheme = "dark"\n`);
      const cli = leader === "--leader" ? { use_leader: true } : undefined;

      await agentBus(root, ...INSTALL_GROK);
      const reinstalled = readFileSync(config, "utf8");
      expect(reinstalled).toContain("\n[ui]\n");
      const parsed = toml(config);
      expect(parsed.mcp_servers?.["agent-hub"]).toBeDefined();
      expect({ models: parsed.models, ui: parsed.ui, cli: parsed.cli }).toEqual({ models: { default: "dspark" }, ui: { theme: "dark" }, cli });

      // Edited again, so uninstall removes just the block (and the installer's leader setting).
      await Bun.write(config, `${reinstalled}[ui.colors]\naccent = "red"\n`);
      await agentBus(root, "uninstall", "grok");
      expect(readFileSync(config, "utf8")).not.toContain("agent-hub");
      expect(toml(config)).toEqual({ models: { default: "dspark" }, ui: { theme: "dark", colors: { accent: "red" } } });
    }
  }, 60_000);

  test("Grok leader mode: quoted cli and use_leader keys are found, not duplicated", async () => {
    const inputs: Array<[string, string]> = [
      [`[cli]\n"use_leader" = false\n`, `"use_leader" = false`],
      [`[cli]\n'use_leader' = false\n`, `'use_leader' = false`],
      [`["cli"]\nuse_leader = false\n`, `use_leader = false`],
      [`"cli".use_leader = false\n\n[models]\ndefault = "dspark"\n`, `"cli".use_leader = false`],
      [`cli.'use_leader' = false\n\n[models]\ndefault = "dspark"\n`, `cli.'use_leader' = false`],
      [`'cli'."use_leader" = false\n\n[models]\ndefault = "dspark"\n`, `'cli'."use_leader" = false`],
    ];
    for (const [before, line] of inputs) {
      const root = home();
      const config = join(root, ".grok", "config.toml");
      await Bun.write(config, before);
      await agentBus(root, ...INSTALL_GROK, "--leader");
      expect(toml(config).cli?.use_leader).toBe(true);
      const installed = readFileSync(config, "utf8");
      const again = await agentBus(root, ...INSTALL_GROK, "--leader");
      expect(again).toContain("already on");
      expect(readFileSync(config, "utf8")).toBe(installed);
      await agentBus(root, "uninstall", "grok");
      expect(readFileSync(config, "utf8")).toBe(before);

      // Through an edit: reinstall keeps the setting, uninstall puts the person's quoted line back.
      await agentBus(root, ...INSTALL_GROK, "--leader");
      await Bun.write(config, `${readFileSync(config, "utf8")}[ui]\ntheme = "dark"\n`);
      await agentBus(root, ...INSTALL_GROK, "--no-leader");
      expect(toml(config).cli?.use_leader).toBe(true);
      await agentBus(root, "uninstall", "grok");
      expect(readFileSync(config, "utf8").split("\n")).toContain(line);
      expect(toml(config).cli?.use_leader).toBe(false);
      expect(toml(config).ui).toEqual({ theme: "dark" });
    }
  }, 120_000);

  test("Grok: a config.toml Bun cannot parse, before or after the change, is refused and left unchanged", async () => {
    const cases: Array<[string, string]> = [
      [`[models]\ndefault = "a"\ndefault = "b"\n`, " ("],
      // An inline mcp_servers table cannot take the [mcp_servers.agent-hub] block.
      [`mcp_servers = { other = { command = "mine" } }\n`, " with Agent Hub's block added ("],
    ];
    for (const [before, subject] of cases) {
      const root = home();
      const config = join(root, ".grok", "config.toml");
      await Bun.write(config, before);
      const { code, output } = await run(root, [...INSTALL_GROK, "--leader"]);
      expect(code).not.toBe(0);
      expect(output).toContain(`Bun could not parse ${config}${subject}`);
      expect(output).toContain(
        "nothing was changed. If Grok reads it fine, add the [mcp_servers.agent-hub] block by hand (see docs/harnesses/universal-mcp.md).",
      );
      expect(readFileSync(config, "utf8")).toBe(before);
      expect(existsSync(join(root, ".agent-bus", "adapters", "grok"))).toBe(false);
    }

    // Another agent-hub server, as a key of [mcp_servers]: not Agent Hub's, so not replaced.
    const root = home();
    const config = join(root, ".grok", "config.toml");
    const theirs = `[mcp_servers]\n"agent-hub" = { command = "mine" }\n`;
    await Bun.write(config, theirs);
    const conflict = await run(root, [...INSTALL_GROK, "--leader"]);
    expect(conflict.code).not.toBe(0);
    expect(conflict.output).toContain("already has an agent-hub MCP server not written by Agent Hub");
    expect(readFileSync(config, "utf8")).toBe(theirs);

    // A broken line inside Agent Hub's own block: the file as it is fails to parse, so reinstall changes nothing.
    await Bun.write(config, `[models]\ndefault = "a"\n`);
    await agentBus(root, ...INSTALL_GROK, "--no-leader");
    const broken = readFileSync(config, "utf8").replace("# agent-bus:grok end", "broken =\n# agent-bus:grok end");
    await Bun.write(config, broken);
    const again = await run(root, [...INSTALL_GROK, "--leader"]);
    expect(again.code).not.toBe(0);
    expect(again.output).toContain(`Bun could not parse ${config} (`);
    expect(readFileSync(config, "utf8")).toBe(broken);
    // doctor reports only that Bun could not parse it, not a leader-mode verdict it cannot know.
    const doctor = await run(root, ["doctor", "--url", "http://127.0.0.1:9"]);
    expect(doctor.output).toContain(`Bun could not parse ${config}`);
    expect(doctor.output).not.toContain("leader mode");
  }, 30_000);

  test("Grok: an [mcp_servers.agent-hub] block added by hand, without the markers, is the person's", async () => {
    const root = home();
    const config = join(root, ".grok", "config.toml");
    const before = `[mcp_servers.agent-hub]\ncommand = "/home/YOU/.bun/bin/bun"\nargs = ["/home/YOU/agent-hub/packages/universal-mcp/src/server.ts", "--harness", "grok", "--url", "http://127.0.0.1:7800"]\n`;
    await Bun.write(config, before);
    const install = await run(root, [...INSTALL_GROK, "--leader"]);
    expect(install.code).not.toBe(0);
    expect(install.output).toContain("already has an agent-hub MCP server not written by Agent Hub");
    await agentBus(root, "uninstall", "grok");
    expect(readFileSync(config, "utf8")).toBe(before);
    // Also when it ends in a blank line: nothing of Agent Hub's there, so not a byte changes.
    await Bun.write(config, `${before}\n`);
    await agentBus(root, "uninstall", "grok");
    expect(readFileSync(config, "utf8")).toBe(`${before}\n`);
  }, 30_000);

  test("Grok uninstall leaves a config with nothing of Agent Hub's byte for byte, blank last line included", async () => {
    const root = home();
    const config = join(root, ".grok", "config.toml");
    const before = `[models]\ndefault = "a"\n\n`;
    await Bun.write(config, before);
    await agentBus(root, "uninstall", "grok");
    expect(readFileSync(config, "utf8")).toBe(before);

    // Installed, then the person took the block out themselves.
    await agentBus(root, ...INSTALL_GROK, "--no-leader");
    await Bun.write(config, before);
    await agentBus(root, "uninstall", "grok");
    expect(readFileSync(config, "utf8")).toBe(before);
  }, 30_000);

  test("Grok uninstall takes back its leader line even when the block was replaced by a hand-written server", async () => {
    const root = home();
    const config = join(root, ".grok", "config.toml");
    await Bun.write(config, `[models]\ndefault = "a"\n`);
    await agentBus(root, ...INSTALL_GROK, "--leader");
    const server = `[mcp_servers.agent-hub]\ncommand = "/home/YOU/.bun/bin/bun"\nargs = ["server.ts"]\n`;
    await Bun.write(config, readFileSync(config, "utf8").replace(/# agent-bus:grok begin\n[\s\S]*# agent-bus:grok end\n/, server));
    expect(toml(config).cli?.use_leader).toBe(true);

    await agentBus(root, "uninstall", "grok");
    expect(toml(config)).toEqual({ models: { default: "a" }, mcp_servers: { "agent-hub": { command: "/home/YOU/.bun/bin/bun", args: ["server.ts"] } } });
    expect(readFileSync(config, "utf8")).toContain(server);
  }, 30_000);

  test("Grok leader mode: --leader with an inline cli table fails, changes nothing, and gives the line to write", async () => {
    const inputs: Array<[string, string]> = [
      [`cli = { use_leader = false }`, `cli = { use_leader = true }`],
      [`cli = { theme = "light" }`, `cli = { use_leader = true, theme = "light" }`],
      [`cli = {}`, `cli = { use_leader = true }`],
      // Every other token stays as written: a float stays a float, a date a date, a string's text untouched.
      [`cli = { scale = 1.0, use_leader = false }`, `cli = { scale = 1.0, use_leader = true }`],
      [`cli = { size = 1e3, use_leader = false }`, `cli = { size = 1e3, use_leader = true }`],
      [`cli = { since = 1979-05-27, use_leader = false }`, `cli = { since = 1979-05-27, use_leader = true }`],
      [`cli = { description = "use_leader = false", use_leader = false }`, `cli = { description = "use_leader = false", use_leader = true }`],
      // Nested inline tables keep their own use_leader; strings with braces and commas are skipped whole.
      [
        `cli = { note = 'a, b }', ui = { use_leader = false, colors = { accent = "red" } }, use_leader = false } # mine`,
        `cli = { note = 'a, b }', ui = { use_leader = false, colors = { accent = "red" } }, use_leader = true } # mine`,
      ],
      [`cli = { ui = { use_leader = false } }`, `cli = { use_leader = true, ui = { use_leader = false } }`],
    ];
    for (const [line, fixed] of inputs) {
      const root = home();
      const config = join(root, ".grok", "config.toml");
      const before = `${line}\n\n[models]\ndefault = "dspark"\n`;
      await Bun.write(config, before);
      const leader = await run(root, [...INSTALL_GROK, "--leader"]);
      expect(leader.code).not.toBe(0);
      expect(leader.output).toContain("sets cli as an inline table, which Agent Hub does not edit; nothing was changed");
      expect(leader.output).toContain(`change that line to \`${fixed}\``);
      expect(readFileSync(config, "utf8")).toBe(before);
      expect(toml(config).cli?.use_leader).not.toBe(true);
      expect(existsSync(join(root, ".agent-bus", "adapters", "grok"))).toBe(false);

      // Leaving leader mode alone works; the suggested line is valid TOML that turns it on.
      await agentBus(root, ...INSTALL_GROK, "--no-leader");
      expect(toml(config).cli?.use_leader).not.toBe(true);
      const cliBefore = toml(config).cli;
      await Bun.write(config, readFileSync(config, "utf8").replace(line, fixed));
      expect(toml(config).cli).toEqual({ ...cliBefore, use_leader: true });
      expect(await agentBus(root, ...INSTALL_GROK, "--leader")).toContain("already on");
    }

    // No line that sets only cli.use_leader (use_leader is itself a table here): the key to set, not a line.
    const root = home();
    const config = join(root, ".grok", "config.toml");
    const before = `cli = { use_leader.x = 1 }\n`;
    await Bun.write(config, before);
    const leader = await run(root, [...INSTALL_GROK, "--leader"]);
    expect(leader.code).not.toBe(0);
    expect(leader.output).toContain("To turn leader mode on, inside cli = { … } set use_leader = true, then run this again");
    expect(readFileSync(config, "utf8")).toBe(before);

    // Dates elsewhere do not stop the check that only use_leader changed.
    await Bun.write(config, `[cli]\nsince = 1979-05-27T07:32:00Z\n`);
    await agentBus(root, ...INSTALL_GROK, "--leader");
    expect(toml(config).cli?.use_leader).toBe(true);
    expect(String(toml(config).cli?.since)).toBe("1979-05-27T07:32:00Z");
  }, 120_000);

  test("Grok leader mode: use_leader inside a multi-line string is text, not the setting", async () => {
    for (const quote of [`"""`, `'''`]) {
      const root = home();
      const config = join(root, ".grok", "config.toml");
      const before = `[cli]\ndescription = ${quote}\nuse_leader = false\n${quote}\n\n[models]\ndefault = "dspark"\n`;
      await Bun.write(config, before);
      const status = await run(root, [...INSTALL_GROK, "--leader"]);
      expect(status.code).toBe(0);
      expect(status.output).toContain("Grok leader mode is on");
      expect(toml(config).cli).toEqual({ description: "use_leader = false\n", use_leader: true });
      await agentBus(root, "uninstall", "grok");
      expect(readFileSync(config, "utf8")).toBe(before);

      // Through an edit: uninstall takes back only Agent Hub's line.
      await agentBus(root, ...INSTALL_GROK, "--leader");
      await Bun.write(config, `${readFileSync(config, "utf8")}[ui]\ntheme = "dark"\n`);
      await agentBus(root, "uninstall", "grok");
      expect(toml(config)).toEqual({ cli: { description: "use_leader = false\n" }, models: { default: "dspark" }, ui: { theme: "dark" } });
    }
  }, 60_000);

  test("Grok leader mode: a quoted use_leader = true counts as on, for install and doctor", async () => {
    for (const before of [`[cli]\n"use_leader" = true\n`, `'cli'.'use_leader' = true\n`]) {
      const root = home();
      const config = join(root, ".grok", "config.toml");
      await Bun.write(config, before);
      const output = await agentBus(root, ...INSTALL_GROK);
      expect(output).toContain("Grok leader mode is already on");
      expect(output).not.toContain(PROMPT);
      expect(readFileSync(config, "utf8").startsWith(before)).toBe(true);
      const doctor = await run(root, ["doctor", "--url", "http://127.0.0.1:9"]);
      expect(doctor.output).toContain("idle wake: leader mode on");
      expect(doctor.output).not.toContain("leader mode off");
      await agentBus(root, "uninstall", "grok");
      expect(readFileSync(config, "utf8")).toBe(before);
    }
  }, 30_000);

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
