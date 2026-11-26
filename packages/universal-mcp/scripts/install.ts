// Installs the shared stdio MCP bridge into harness-native user configuration without replacing unrelated servers.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bundleForNode,
  configBusUrl,
  installBusUrl,
  jsRuntime,
  manifestName,
  removeOwnedDir,
  writeJson,
  writeMetadata,
  type InstallOptions,
  type InstallStatus,
} from "../../client/src/install";

export type UniversalAdapterName = "qwen" | "grok";

interface Definition {
  title: string;
  command: string;
  kind: "json" | "grok";
  config: string;
  key?: "mcpServers";
}

const DEFINITIONS: Record<UniversalAdapterName, Definition> = {
  qwen: { title: "Qwen Code", command: "qwen", kind: "json", config: path.join(os.homedir(), ".qwen", "settings.json"), key: "mcpServers" },
  grok: { title: "Grok Build", command: "grok", kind: "grok", config: path.join(process.env.GROK_HOME || path.join(os.homedir(), ".grok"), "config.toml") },
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

function readConfigSnapshot(target: string): ConfigSnapshot | undefined {
  try {
    const value = JSON.parse(readFileSync(configSnapshotFile(target), "utf8")) as Partial<ConfigSnapshot>;
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

export async function installUniversal(name: UniversalAdapterName, opts: InstallOptions): Promise<void> {
  const definition = DEFINITIONS[name];
  const target = targetDir(name, opts);
  const owned = manifestName(manifest(target)) === ownedName(name);
  const previous = owned ? readConfigSnapshot(target) : undefined;
  const url = installBusUrl(configFile(target), opts.url);
  removeOwnedDir(target, manifest(target), ownedName(name), "plugin");
  mkdirSync(target, { recursive: true });
  const entries: Array<[string, string]> =
    name === "qwen" ? [["src/server.ts", "server"], ["src/inbox-hook.ts", "inbox-hook"]] : [["src/server.ts", "server"]];
  await bundleForNode(root, target, entries);
  writeJson(manifest(target), { name: ownedName(name), version: "0.2.0", private: true });
  writeJson(configFile(target), { busUrl: url, harness: name });
  writeMetadata(target, "message-bus", `${definition.title} bridge for Agent Hub.`);
  if (definition.kind === "json") setJsonEntry(name, definition, target, url, previous);
  else setGrokEntry(name, definition, target, url, previous);
  if (definition.kind === "grok") {
    console.log("Grok wakes for Agent Hub messages only in leader mode: set `[cli] use_leader = true` in its config.toml or start it with `grok --leader`.");
  }
  console.log(`Installed ${definition.title} Agent Hub adapter in ${target} (Hub ${url}).`);
}

export async function uninstallUniversal(name: UniversalAdapterName, opts: InstallOptions): Promise<void> {
  const definition = DEFINITIONS[name];
  const target = targetDir(name, opts);
  const owned = manifestName(manifest(target)) === ownedName(name);
  const snapshot = owned ? readConfigSnapshot(target) : undefined;
  if (definition.kind === "json") removeJsonEntry(definition, snapshot);
  else removeGrokEntry(definition, snapshot);
  removeOwnedDir(target, manifest(target), ownedName(name), "plugin");
  console.log(`Removed ${definition.title} Agent Hub adapter.`);
}

export function statusUniversal(name: UniversalAdapterName, opts: InstallOptions): InstallStatus {
  const definition = DEFINITIONS[name];
  const target = targetDir(name, opts);
  const installed = manifestName(manifest(target)) === ownedName(name) && existsSync(serverFile(target));
  const notes: string[] = [];
  if (installed && definition.kind === "json") {
    const servers = object(readJson(definition.config!)[definition.key!]);
    if (!managedEntry(servers["agent-hub"])) notes.push(`MCP entry missing from ${definition.config}`);
    if (name === "qwen" && !removeManagedQwenHooks(readJson(definition.config!))) {
      notes.push(`Inbox hook missing from ${definition.config}`);
    }
  }
  if (installed && definition.kind === "grok" && !(existsSync(definition.config!) && readFileSync(definition.config!, "utf8").includes(GROK_BEGIN))) {
    notes.push(`MCP entry missing from ${definition.config}`);
  }
  return { installed, where: target, busUrl: configBusUrl(configFile(target)), notes };
}

export const universalDefinition = (name: UniversalAdapterName): Readonly<Definition> => DEFINITIONS[name];
