// Installs the shared stdio MCP bridge into harness-native user configuration without replacing unrelated servers.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bundleForNode,
  configBusUrl,
  installBusUrl,
  isOwnedFile,
  jsRuntime,
  manifestName,
  removeOwnedDir,
  writeJson,
  writeMetadata,
  writeOwnedFile,
  type InstallOptions,
  type InstallStatus,
} from "../../client/src/install";

export type UniversalAdapterName = "qwen" | "kimi" | "grok" | "deepseek" | "muse" | "vibe" | "mini-swe-agent" | "devin";

interface Definition {
  title: string;
  command: string;
  kind: "json" | "kimi" | "grok" | "deepseek" | "vibe" | "mini";
  config?: string;
  key?: "mcpServers" | "mcp_servers";
  /** Kimi Code only: the config.toml whose [[hooks]] run the Inbox hook. */
  hooks?: string;
  muse?: boolean;
}

const xdg = (): string => process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const DEFINITIONS: Record<UniversalAdapterName, Definition> = {
  qwen: { title: "Qwen Code", command: "qwen", kind: "json", config: path.join(os.homedir(), ".qwen", "settings.json"), key: "mcpServers" },
  // Kimi Code 2.x reads $KIMI_CODE_HOME (~/.kimi-code); ~/.kimi is the pre-2.0 home it migrates from once (@qwen-kimi #16774).
  kimi: {
    title: "Kimi Code CLI",
    command: "kimi",
    kind: "kimi",
    config: path.join(process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code"), "mcp.json"),
    key: "mcpServers",
    hooks: path.join(process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code"), "config.toml"),
  },
  grok: { title: "Grok Build", command: "grok", kind: "grok", config: path.join(process.env.GROK_HOME || path.join(os.homedir(), ".grok"), "config.toml") },
  deepseek: { title: "DeepSeek Harness", command: "dsh", kind: "deepseek" },
  muse: { title: "Muse Code", command: "muse", kind: "json", config: path.join(xdg(), "muse", "settings.json"), key: "mcp_servers", muse: true },
  vibe: { title: "Mistral Vibe", command: "vibe", kind: "vibe" },
  "mini-swe-agent": { title: "mini-SWE-agent", command: "agent-bus-mini", kind: "mini" },
  devin: { title: "Devin CLI", command: "devin", kind: "json", config: path.join(xdg(), "devin", "mcp_config.json"), key: "mcpServers" },
};

const root = path.resolve(import.meta.dir, "..");
const targetDir = (name: UniversalAdapterName, opts: InstallOptions): string =>
  path.resolve(opts.dir ?? path.join(os.homedir(), ".agent-bus", "adapters", name));
const manifest = (target: string): string => path.join(target, "package.json");
const ownedName = (name: UniversalAdapterName): string => `@agent-bus/${name}-mcp`;
const serverFile = (target: string): string => path.join(target, "server.mjs");
const inboxHookFile = (target: string): string => path.join(target, "inbox-hook.mjs");
const configFile = (target: string): string => path.join(target, "config.json");
const configSnapshotFile = (target: string): string => path.join(target, "config-snapshot.json");
/** Kimi Code's hooks live in a second file (config.toml), so they get a snapshot of their own. */
const hooksSnapshotFile = (target: string): string => path.join(target, "config-snapshot-hooks.json");

/** The harness config file's exact bytes before install and as installed, so uninstall can restore them untouched. */
interface ConfigSnapshot {
  originalExists: boolean;
  original: string;
  installed: string;
}
const argsFor = (name: UniversalAdapterName, target: string, url: string): string[] => [
  serverFile(target), "--harness", name, "--url", url, "--managed-by", "agent-bus",
];

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return object(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(`Cannot update ${file}: ${(error as Error).message}`);
  }
}

function managedEntry(value: unknown): boolean {
  const args = object(value).args;
  return Array.isArray(args) && args.includes("--managed-by") && args.includes("agent-bus");
}

const QWEN_HOOK_MARKER = "--managed-by agent-bus";

/** Agent Hub's hook: the shell-form command it writes, or the exec form (`args`) installed before 24 Nov. */
function managedQwenHook(value: unknown): boolean {
  const hooks = object(value).hooks;
  return Array.isArray(hooks) && hooks.some((hook) => {
    const command = object(hook).command;
    return managedEntry(hook) || (typeof command === "string" && command.endsWith(` ${QWEN_HOOK_MARKER}`));
  });
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Removes only Agent Hub's UserPromptSubmit definition; returns whether one was present. */
function removeManagedQwenHooks(config: Record<string, unknown>): boolean {
  const hooks = object(config.hooks);
  const definitions = hooks.UserPromptSubmit;
  if (!Array.isArray(definitions)) return false;
  const kept = definitions.filter((definition) => !managedQwenHook(definition));
  if (kept.length === definitions.length) return false;
  if (kept.length > 0) hooks.UserPromptSubmit = kept;
  else delete hooks.UserPromptSubmit;
  if (Object.keys(hooks).length > 0) config.hooks = hooks;
  else delete config.hooks;
  return true;
}

function addQwenHook(config: Record<string, unknown>, target: string, url: string): void {
  removeManagedQwenHooks(config);
  const hooks = object(config.hooks);
  const definitions = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
  definitions.push({
    hooks: [{
      type: "command",
      // Shell form: Qwen Code 0.28 ignores `args` (exec form exists only in the 1.0 previews), and both run this.
      command: [jsRuntime(), inboxHookFile(target), "--harness", "qwen", "--url", url].map(shellQuote).join(" ") + ` ${QWEN_HOOK_MARKER}`,
      timeout: 15,
      statusMessage: "Checking Agent Hub Inbox",
    }],
  });
  hooks.UserPromptSubmit = definitions;
  config.hooks = hooks;
}

const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function readConfigSnapshot(target: string, file = configSnapshotFile(target)): ConfigSnapshot | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<ConfigSnapshot>;
    return typeof value.originalExists === "boolean" && typeof value.original === "string" && typeof value.installed === "string"
      ? value as ConfigSnapshot
      : undefined;
  } catch {
    return undefined;
  }
}

function setJsonEntry(
  name: UniversalAdapterName,
  definition: Definition,
  target: string,
  url: string,
  previous?: ConfigSnapshot
): void {
  const file = definition.config!;
  const existed = existsSync(file);
  const before = existed ? readFileSync(file, "utf8") : "";
  const config = readJson(file);
  const servers = object(config[definition.key!]);
  if (servers["agent-hub"] !== undefined && !managedEntry(servers["agent-hub"])) {
    throw new Error(`${file} already has an agent-hub MCP server not written by Agent Hub; not replacing it`);
  }
  const hadManagedEntry = managedEntry(servers["agent-hub"]);
  const hadManagedHook = name === "qwen" && removeManagedQwenHooks(config);
  let originalExists = existed;
  let original = before;
  if (previous && before === previous.installed) {
    originalExists = previous.originalExists;
    original = previous.original;
  } else if (hadManagedEntry || hadManagedHook) {
    // An orphaned or edited prior install has no exact usable snapshot. Preserve its current user settings, but not
    // stale Agent Hub entries that this install replaces.
    if (hadManagedEntry) delete servers["agent-hub"];
    config[definition.key!] = servers;
    original = jsonText(config);
  }
  const entry: Record<string, unknown> = { command: jsRuntime(), args: argsFor(name, target, url) };
  mkdirSync(path.dirname(file), { recursive: true });
  if (definition.muse) Object.assign(entry, { transport: "stdio", enabled: true, mode: "optional" });
  servers["agent-hub"] = entry;
  config[definition.key!] = servers;
  if (name === "qwen") addQwenHook(config, target, url);
  writeJson(file, config);
  writeJson(configSnapshotFile(target), { originalExists, original, installed: readFileSync(file, "utf8") });
}

function removeJsonEntry(definition: Definition, snapshot?: ConfigSnapshot): void {
  const file = definition.config!;
  if (!existsSync(file)) return;
  const current = readFileSync(file, "utf8");
  if (snapshot && current === snapshot.installed) {
    if (snapshot.originalExists) writeFileSync(file, snapshot.original);
    else rmSync(file);
    return;
  }
  const config = readJson(file);
  const servers = object(config[definition.key!]);
  const hadManagedEntry = managedEntry(servers["agent-hub"]);
  const hadManagedHook = definition.command === "qwen" && removeManagedQwenHooks(config);
  if (!hadManagedEntry && !hadManagedHook) return;
  if (hadManagedEntry) delete servers["agent-hub"];
  config[definition.key!] = servers;
  writeJson(file, config);
}

const KIMI_HOOKS_BEGIN = "# agent-bus:kimi begin";
const KIMI_HOOKS_END = "# agent-bus:kimi end";
const KIMI_HOOKS_BLOCK = /\n*# agent-bus:kimi begin\n[\s\S]*?# agent-bus:kimi end\n?/g;

/**
 * Kimi Code 2.x runs [[hooks]] from config.toml: the UserPromptSubmit one injects unseen deliveries before a turn,
 * the Stop one continues the turn when a message wakes the agent. Both run the shared Inbox hook.
 */
function setKimiHooks(definition: Definition, target: string, url: string, previous?: ConfigSnapshot): void {
  const file = definition.hooks!;
  const existed = existsSync(file);
  const before = existed ? readFileSync(file, "utf8") : "";
  const withoutOurs = before.replace(KIMI_HOOKS_BLOCK, "");
  let originalExists = existed;
  let original = before;
  if (previous && before === previous.installed) {
    originalExists = previous.originalExists;
    original = previous.original;
  } else if (withoutOurs !== before) {
    original = withoutOurs;
  }
  const command = [jsRuntime(), inboxHookFile(target), "--harness", "kimi", "--url", url].map(shellQuote).join(" ") + ` ${QWEN_HOOK_MARKER}`;
  const body =
    `${KIMI_HOOKS_BEGIN}\n` +
    `[[hooks]]\nevent = "UserPromptSubmit"\ncommand = ${JSON.stringify(command)}\ntimeout = 15\n\n` +
    `[[hooks]]\nevent = "Stop"\ncommand = ${JSON.stringify(command)}\ntimeout = 15\n` +
    `${KIMI_HOOKS_END}\n`;
  const base = existed ? original : "";
  const installed = `${base}${base && !base.endsWith("\n") ? "\n" : ""}${base ? "\n" : ""}${body}`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, installed);
  writeJson(hooksSnapshotFile(target), { originalExists, original, installed });
}

function removeKimiHooks(definition: Definition, snapshot?: ConfigSnapshot): void {
  const file = definition.hooks!;
  if (!existsSync(file)) return;
  const current = readFileSync(file, "utf8");
  if (snapshot && current === snapshot.installed) {
    if (snapshot.originalExists) writeFileSync(file, snapshot.original);
    else rmSync(file);
    return;
  }
  const cleaned = current.replace(KIMI_HOOKS_BLOCK, "\n").replace(/\n+$/, "\n");
  if (cleaned !== current) writeFileSync(file, cleaned === "\n" ? "" : cleaned);
}

const GROK_BEGIN = "# agent-bus:grok begin";
const GROK_END = "# agent-bus:grok end";
const GROK_BLOCK = /\n*# agent-bus:grok begin\n[\s\S]*?# agent-bus:grok end\n?/g;

/**
 * Grok reads MCP servers from `[mcp_servers.<name>]` in its config.toml. A plugin under ~/.grok/plugins is not enough:
 * user plugins start disabled (seen with grok 1.0.45, 24 Nov).
 */
function setGrokEntry(name: UniversalAdapterName, definition: Definition, target: string, url: string, previous?: ConfigSnapshot): void {
  const file = definition.config!;
  const existed = existsSync(file);
  const before = existed ? readFileSync(file, "utf8") : "";
  const withoutOurs = before.replace(GROK_BLOCK, "");
  if (/^\s*\[mcp_servers\.(?:agent-hub|"agent-hub")\]/m.test(withoutOurs)) {
    throw new Error(`${file} already has an agent-hub MCP server not written by Agent Hub; not replacing it`);
  }
  let originalExists = existed;
  let original = before;
  if (previous && before === previous.installed) {
    originalExists = previous.originalExists;
    original = previous.original;
  } else if (withoutOurs !== before) {
    original = withoutOurs;
  }
  const args = argsFor(name, target, url).map((value) => JSON.stringify(value)).join(", ");
  const body = `${GROK_BEGIN}\n[mcp_servers.agent-hub]\ncommand = ${JSON.stringify(jsRuntime())}\nargs = [${args}]\n${GROK_END}\n`;
  const base = existed ? original : "";
  const installed = `${base}${base && !base.endsWith("\n") ? "\n" : ""}${base ? "\n" : ""}${body}`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, installed);
  writeJson(configSnapshotFile(target), { originalExists, original, installed });
}

function removeGrokEntry(definition: Definition, snapshot?: ConfigSnapshot): void {
  const file = definition.config!;
  if (!existsSync(file)) return;
  const current = readFileSync(file, "utf8");
  if (snapshot && current === snapshot.installed) {
    if (snapshot.originalExists) writeFileSync(file, snapshot.original);
    else rmSync(file);
    return;
  }
  const cleaned = current.replace(GROK_BLOCK, "\n").replace(/\n+$/, "\n");
  if (cleaned !== current) writeFileSync(file, cleaned === "\n" ? "" : cleaned);
}

const block = (file: string, start: string, end: string, body?: string): void => {
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  const pattern = new RegExp(`${start.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\n?`, "g");
  const clean = old.replace(pattern, "").trimEnd();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${clean}${clean ? "\n\n" : ""}${body ? `${start}\n${body.trimEnd()}\n${end}\n` : ""}`);
};

function configureText(name: UniversalAdapterName, definition: Definition, target: string, url: string): void {
  const command = JSON.stringify(jsRuntime());
  const args = argsFor(name, target, url).map((value) => JSON.stringify(value)).join(", ");
  if (definition.kind === "deepseek") {
    const file = path.join(os.homedir(), ".dsh", "cordis.patch.yml");
    // A new DSH profile may contain only `[]`; appending a patch item after that is invalid YAML.
    if (existsSync(file) && readFileSync(file, "utf8").trim() === "[]") writeFileSync(file, "");
    block(file, "# agent-bus:deepseek begin", "# agent-bus:deepseek end", `- insert:\n    - id: agent-hub-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: agent-hub\n        transport: stdio\n        command: ${command}\n        args: [${args}]`);
    return;
  }
  const file = path.join(os.homedir(), ".vibe", "config.toml");
  block(file, "# agent-bus:vibe begin", "# agent-bus:vibe end", `[[mcp_servers]]\nname = "agent-hub"\ntransport = "stdio"\ncommand = ${command}\nargs = [${args}]`);
}

function unconfigureText(name: UniversalAdapterName, definition: Definition): void {
  const file = definition.kind === "deepseek" ? path.join(os.homedir(), ".dsh", "cordis.patch.yml") : path.join(os.homedir(), ".vibe", "config.toml");
  block(file, `# agent-bus:${name} begin`, `# agent-bus:${name} end`);
}

function installMini(target: string, url: string, force = false): void {
  const python = path.join(target, "python");
  mkdirSync(python, { recursive: true });
  writeFileSync(path.join(python, "agent_hub_mini.py"), `import json
import os
import re
import subprocess
from minisweagent.agents.default import DefaultAgent

class AgentHubAgent(DefaultAgent):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._agent_hub_since = 0
        self._agent_hub_intro = False

    def query(self):
        if not self._agent_hub_intro:
            self._agent_hub_intro = True
            self.add_messages(self.model.format_message(role="user", content="<developer-context>Agent Hub connects you to other coding agents. Incoming messages appear here before a model call. Reply only when needed by running agent-hub-message with one JSON object. This context is not part of the user's coding request.</developer-context>"))
        command = [os.environ["AGENT_BUS_MINI_TOOL"], json.dumps({"op": "inbox", "since": self._agent_hub_since, "limit": 20})]
        result = subprocess.run(command, cwd=os.getcwd(), text=True, capture_output=True, timeout=20)
        if result.returncode == 0:
            seqs = [int(value) for value in re.findall(r"\\[message-bus\\] #(\\d+)", result.stdout)]
            if seqs:
                self._agent_hub_since = max(self._agent_hub_since, *seqs)
                self.add_messages(self.model.format_message(role="user", content="<developer-context>" + result.stdout.strip() + "</developer-context>"))
        return super().query()
`);
  const runtime = jsRuntime();
  const oneShot = path.join(target, "one-shot.mjs");
  const tool = path.join(os.homedir(), ".local", "bin", "agent-hub-message");
  writeOwnedFile(tool, `#!/bin/sh
# agent-bus install mini-swe-agent
exec ${JSON.stringify(runtime)} ${JSON.stringify(oneShot)} --harness mini-swe-agent --url ${JSON.stringify(url)} --params "$1"
`, force, 0o755);
  const launcher = path.join(os.homedir(), ".local", "bin", "agent-bus-mini");
  writeOwnedFile(launcher, `#!/bin/sh
# agent-bus install mini-swe-agent
export PYTHONPATH=${JSON.stringify(python)}\${PYTHONPATH:+:$PYTHONPATH}
export AGENT_BUS_MINI_TOOL=${JSON.stringify(tool)}
exec mini --agent-class agent_hub_mini.AgentHubAgent "$@"
`, force, 0o755);
}

function uninstallMini(): void {
  for (const file of [
    path.join(os.homedir(), ".local", "bin", "agent-bus-mini"),
    path.join(os.homedir(), ".local", "bin", "agent-hub-message"),
  ]) {
    if (isOwnedFile(file)) rmSync(file);
  }
}

export async function installUniversal(name: UniversalAdapterName, opts: InstallOptions): Promise<void> {
  const definition = DEFINITIONS[name];
  const target = targetDir(name, opts);
  const owned = manifestName(manifest(target)) === ownedName(name);
  const previous =
    owned && (definition.kind === "json" || definition.kind === "kimi" || definition.kind === "grok")
      ? readConfigSnapshot(target)
      : undefined;
  const previousHooks = owned && definition.kind === "kimi" ? readConfigSnapshot(target, hooksSnapshotFile(target)) : undefined;
  const url = installBusUrl(configFile(target), opts.url);
  removeOwnedDir(target, manifest(target), ownedName(name), "plugin");
  mkdirSync(target, { recursive: true });
  const entries: Array<[string, string]> =
    definition.kind === "mini"
      ? [["src/one-shot.ts", "one-shot"]]
      : name === "qwen" || name === "kimi"
        ? [["src/server.ts", "server"], ["src/inbox-hook.ts", "inbox-hook"]]
        : [["src/server.ts", "server"]];
  await bundleForNode(root, target, entries);
  writeJson(manifest(target), { name: ownedName(name), version: "0.2.0", private: true });
  writeJson(configFile(target), { busUrl: url, harness: name });
  writeMetadata(target, "message-bus", `${definition.title} bridge for Agent Hub.`);
  if (definition.kind === "json") setJsonEntry(name, definition, target, url, previous);
  else if (definition.kind === "kimi") {
    setJsonEntry(name, definition, target, url, previous);
    setKimiHooks(definition, target, url, previousHooks);
  }
  else if (definition.kind === "grok") setGrokEntry(name, definition, target, url, previous);
  else if (definition.kind === "mini") installMini(target, url, opts.force);
  else configureText(name, definition, target, url);
  if (definition.kind === "grok") {
    console.log("Grok wakes for Agent Hub messages only in leader mode: set `[cli] use_leader = true` in its config.toml or start it with `grok --leader`.");
  }
  console.log(`Installed ${definition.title} Agent Hub adapter in ${target} (bus ${url}).`);
}

export async function uninstallUniversal(name: UniversalAdapterName, opts: InstallOptions): Promise<void> {
  const definition = DEFINITIONS[name];
  const target = targetDir(name, opts);
  const owned = manifestName(manifest(target)) === ownedName(name);
  const snapshot = owned ? readConfigSnapshot(target) : undefined;
  if (definition.kind === "json") removeJsonEntry(definition, snapshot);
  else if (definition.kind === "kimi") {
    removeJsonEntry(definition, snapshot);
    removeKimiHooks(definition, owned ? readConfigSnapshot(target, hooksSnapshotFile(target)) : undefined);
  }
  else if (definition.kind === "grok") removeGrokEntry(definition, snapshot);
  else if (definition.kind === "mini") uninstallMini();
  else unconfigureText(name, definition);
  removeOwnedDir(target, manifest(target), ownedName(name), "plugin");
  console.log(`Removed ${definition.title} Agent Hub adapter.`);
}

export function statusUniversal(name: UniversalAdapterName, opts: InstallOptions): InstallStatus {
  const definition = DEFINITIONS[name];
  const target = targetDir(name, opts);
  const installed = manifestName(manifest(target)) === ownedName(name) &&
    existsSync(definition.kind === "mini" ? path.join(target, "one-shot.mjs") : serverFile(target));
  const notes: string[] = [];
  if (installed && definition.kind === "json") {
    const servers = object(readJson(definition.config!)[definition.key!]);
    if (!managedEntry(servers["agent-hub"])) notes.push(`MCP entry missing from ${definition.config}`);
    if (name === "qwen" && !removeManagedQwenHooks(readJson(definition.config!))) {
      notes.push(`Inbox hook missing from ${definition.config}`);
    }
  }
  if (installed && definition.kind === "mini" && !isOwnedFile(path.join(os.homedir(), ".local", "bin", "agent-bus-mini"))) {
    notes.push("agent-bus-mini launcher is missing; install again");
  }
  if (installed && definition.kind === "kimi") {
    const servers = object(readJson(definition.config!)[definition.key!]);
    if (!managedEntry(servers["agent-hub"])) notes.push(`MCP entry missing from ${definition.config}`);
    if (!(existsSync(definition.hooks!) && readFileSync(definition.hooks!, "utf8").includes(KIMI_HOOKS_BEGIN))) {
      notes.push(`Inbox hook missing from ${definition.hooks}`);
    }
  }
  if (installed && definition.kind === "grok" && !(existsSync(definition.config!) && readFileSync(definition.config!, "utf8").includes(GROK_BEGIN))) {
    notes.push(`MCP entry missing from ${definition.config}`);
  }
  return { installed, where: target, busUrl: configBusUrl(configFile(target)), notes };
}

export const universalDefinition = (name: UniversalAdapterName): Readonly<Definition> => DEFINITIONS[name];
