// Installs the shared stdio MCP bridge into harness-native user configuration without replacing unrelated servers.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
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
  writePrivateJson,
  type InstallOptions,
  type InstallStatus,
} from "../../client/src/install";

export type UniversalAdapterName = "qwen" | "grok";

export interface UniversalInstallOptions extends InstallOptions {
  /** Grok only: turn leader mode on (`--leader`) or leave it as it is without asking (`--no-leader`). */
  leader?: boolean;
}

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
  /** Grok: present when this install turned leader mode on; `replaced` is the `use_leader = false` line it replaced. */
  leader?: { replaced?: string };
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
function managedQwenHook(hook: unknown): boolean {
  const command = object(hook).command;
  return managedEntry(hook) || (typeof command === "string" && command.endsWith(` ${QWEN_HOOK_MARKER}`));
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Removes only Agent Hub's hooks from UserPromptSubmit, one by one: a definition that also holds the person's hooks
 * keeps them, in order, with its other fields; one left with no hooks goes. Returns whether any was present.
 */
function removeManagedQwenHooks(config: Record<string, unknown>): boolean {
  const hooks = object(config.hooks);
  const definitions = hooks.UserPromptSubmit;
  if (!Array.isArray(definitions)) return false;
  let removed = false;
  const kept = definitions.flatMap((definition) => {
    const nested = object(definition).hooks;
    if (!Array.isArray(nested) || !nested.some(managedQwenHook)) return [definition];
    removed = true;
    const theirs = nested.filter((hook) => !managedQwenHook(hook));
    return theirs.length > 0 ? [{ ...object(definition), hooks: theirs }] : [];
  });
  if (!removed) return false;
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
  snapshot: string,
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
  // The snapshot first: a settings file is never left edited without the record that undoes the edit.
  writePrivateJson(snapshot, { originalExists, original, installed: jsonText(config) });
  writeJson(file, config);
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
/** Marks the `use_leader = true` line an install wrote, and a `[cli]` header it added because the file had none. */
const LEADER_MARK = "# agent-bus:grok leader";
const LEADER_LINE = new RegExp(`^\\s*(?:cli\\s*\\.\\s*)?use_leader\\s*=\\s*true\\s*${LEADER_MARK}\\s*$`);
const LEADER_HEADER = new RegExp(`^\\s*\\[\\s*cli\\s*\\]\\s*${LEADER_MARK}\\s*$`);

/**
 * Removes Agent Hub's MCP block, leaving a line break in its place so the settings on either side stay on their own
 * lines. Installs before 27 Nov kept a `[cli]` table at the end of the block; the person's keys there survive as their
 * own `[cli]` table, and only an unchanged `use_leader = true` (Agent Hub's) goes.
 */
function stripGrokBlock(text: string): string {
  return text.replace(GROK_BLOCK, (block) => {
    const cli = /\n\[cli\]\n([\s\S]*?)# agent-bus:grok end/.exec(block);
    const kept = cli?.[1]!.split("\n").filter((line) => line.trim() !== "" && line.trim() !== "use_leader = true") ?? [];
    return kept.length ? `\n\n[cli]\n${kept.join("\n")}\n` : "\n";
  });
}

const BY_HAND = "If Grok reads it fine, add the [mcp_servers.agent-hub] block by hand (see docs/harnesses/universal-mcp.md).";

type Toml = Record<string, unknown>;

/**
 * Parses `text` with Bun, or throws so nothing is written: Agent Hub never leaves a config.toml it cannot read. Bun's
 * parser may reject a file Grok reads, so the message says so instead of calling the file invalid.
 */
function parseToml(text: string, subject: string, hint: string): Toml {
  try {
    return Bun.TOML.parse(text) as Toml;
  } catch (error) {
    throw new Error(`Bun could not parse ${subject} (${error instanceof Error ? error.message : String(error)}); nothing was changed. ${hint}`);
  }
}

/** `cli.use_leader` as Grok reads it. */
const leaderOf = (config: Toml): unknown => object(config.cli).use_leader;

/**
 * A parsed config without the two values Agent Hub may change: its MCP server and `cli.use_leader`. Copies only the
 * two tables it edits: TOML dates parse to Temporal objects, which structuredClone cannot copy.
 */
function withoutOurs(config: Toml): Toml {
  const copy: Toml = { ...config };
  for (const [table, key] of [["mcp_servers", "agent-hub"], ["cli", "use_leader"]] as const) {
    if (copy[table] === undefined) continue;
    const rest = { ...object(copy[table]) };
    delete rest[key];
    if (Object.keys(rest).length > 0) copy[table] = rest;
    else delete copy[table];
  }
  return copy;
}

/** The index just past the TOML string starting at `start` (basic, literal, or their multi-line forms); -1 if open. */
function skipTomlString(line: string, start: number): number {
  const quote = line[start]!;
  const triple = quote.repeat(3);
  if (line.startsWith(triple, start)) {
    let end = line.indexOf(triple, start + 3);
    if (quote === '"') while (end > 0 && line[end - 1] === "\\") end = line.indexOf(triple, end + 1);
    if (end < 0) return -1;
    end += 3;
    for (let extra = 0; extra < 2 && line[end] === quote; extra++) end++; // it may end in up to two more quotes
    return end;
  }
  for (let at = start + 1; at < line.length; at++) {
    if (quote === '"' && line[at] === "\\") at++;
    else if (line[at] === quote) return at + 1;
  }
  return -1;
}

/**
 * `line` (`cli = { … }`) with leader mode on, every other token kept verbatim: the `use_leader` value directly inside
 * cli's braces becomes `true`, or `use_leader = true` goes first in them. Reads the inline table token by token, so
 * strings and nested tables are left alone. Undefined when the line is not a one-line inline table this can read.
 */
function inlineLeaderLine(line: string): string | undefined {
  const head = new RegExp(`^\\s*${tomlKey("cli")}\\s*=\\s*\\{`).exec(line);
  if (!head) return undefined;
  const open = head[0].length - 1;
  const pairs: Array<[number, number]> = [];
  let pairStart = open + 1;
  let depth = 0;
  let close = -1;
  for (let at = open; at < line.length && close < 0; at++) {
    const char = line[at]!;
    if (char === '"' || char === "'") {
      const end = skipTomlString(line, at);
      if (end < 0) return undefined;
      at = end - 1;
    } else if (char === "#") return undefined;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) {
        pairs.push([pairStart, at]);
        close = at;
      }
    } else if (char === "," && depth === 1) {
      pairs.push([pairStart, at]);
      pairStart = at + 1;
    }
  }
  if (close < 0) return undefined;
  const setting = new RegExp(`^(\\s*${tomlKey("use_leader")}\\s*=\\s*)(.*?)(\\s*)$`);
  for (const [start, end] of pairs) {
    const pair = setting.exec(line.slice(start, end));
    if (pair) return `${line.slice(0, start)}${pair[1]}true${pair[3]}${line.slice(end)}`;
  }
  const inner = line.slice(open + 1, close);
  if (inner.trim() === "") return `${line.slice(0, open)}{ use_leader = true }${line.slice(close + 1)}`;
  return `${line.slice(0, open + 1)} use_leader = true,${/^\s/.test(inner) ? "" : " "}${line.slice(open + 1)}`;
}

/**
 * What to tell a person whose `cli` is an inline table (line `index` of `base`): the line to write, checked to parse to
 * the same config with only `cli.use_leader` changed, to true; or, when there is no such line, the key to set.
 */
function inlineLeaderEdit(base: string, parsedBase: Toml, index: number): string {
  const lines = base.split("\n");
  const line = inlineLeaderLine(lines[index]!);
  if (line !== undefined) {
    lines[index] = line;
    try {
      const after = Bun.TOML.parse(lines.join("\n")) as Toml;
      if (leaderOf(after) === true && Bun.deepEquals(withoutOurs(parsedBase), withoutOurs(after))) {
        return `change that line to \`${line.trim()}\``;
      }
    } catch {
      // Falls through to the key to set.
    }
  }
  return "inside cli = { … } set use_leader = true";
}

/**
 * Throws unless the edited config differs from the one before only where Agent Hub meant to change it: its MCP server
 * there (install) or gone (uninstall), `cli.use_leader` equal to `leader.value` (null: not checked), all else equal.
 */
function checkGrokEdit(file: string, before: Toml, after: Toml, server: boolean, leader: { value: unknown } | null, hint: string): void {
  const ok = Bun.deepEquals(withoutOurs(before), withoutOurs(after))
    && (object(after.mcp_servers)["agent-hub"] !== undefined) === server
    && (leader === null || leaderOf(after) === leader.value);
  if (!ok) throw new Error(`Agent Hub could not edit ${file} without changing other settings; nothing was changed. ${hint}`);
}

/** A TOML key as a regex: bare, "basic-quoted" or 'literal-quoted'. */
const tomlKey = (name: string): string => `(?:${name}|"${name}"|'${name}')`;
const CLI_FALSE = new RegExp(`^\\s*${tomlKey("use_leader")}\\s*=\\s*false\\b`);
const ROOT_FALSE = new RegExp(`^\\s*${tomlKey("cli")}\\s*\\.\\s*${tomlKey("use_leader")}\\s*=\\s*false\\b`);
const ROOT_DOTTED = new RegExp(`^\\s*${tomlKey("cli")}\\s*\\.`);
const ROOT_INLINE = new RegExp(`^\\s*${tomlKey("cli")}\\s*=`);

/**
 * Where to edit Grok's `use_leader` in a config.toml (line numbers), read line by line, skipping multi-line strings.
 * Only for placing the edit: the value Grok sees comes from the parsed file, and every edit is checked against it.
 */
interface LeaderScan {
  /** The `[cli]` header line. */
  cliHeader?: number;
  /** A `use_leader = false` line: under `[cli]`, or a root `cli.use_leader = false`. */
  falseLine?: number;
  falseDotted?: boolean;
  /** The last root `cli.KEY = …` line: `cli` is then a dotted-key table and must not get a `[cli]` header. */
  rootDotted?: number;
  /** `cli = { … }` at the root: an inline table, which cannot take another key. */
  inline?: number;
}

function scanLeader(text: string): LeaderScan {
  const scan: LeaderScan = {};
  let table: string | undefined = "";
  let inString: string | undefined;
  text.split("\n").forEach((line, i) => {
    const quotes = line.match(/"""|'''/g) ?? [];
    if (inString) {
      if (quotes.filter((quote) => quote === inString).length % 2 === 1) inString = undefined;
      return;
    }
    const opening = quotes[0];
    if (opening && quotes.filter((quote) => quote === opening).length % 2 === 1) inString = opening;
    if (/^\s*\[\[/.test(line)) {
      table = undefined;
      return;
    }
    const header = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1]!.split(".").map((part) => part.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2")).join(".");
      if (table === "cli") scan.cliHeader ??= i;
      return;
    }
    if (table === "cli" ? CLI_FALSE.test(line) : table === "" && ROOT_FALSE.test(line)) {
      scan.falseLine = i;
      scan.falseDotted = table === "";
    }
    if (table === "" && ROOT_DOTTED.test(line)) scan.rootDotted = i;
    if (table === "" && ROOT_INLINE.test(line)) scan.inline = i;
  });
  return scan;
}

/**
 * Sets `use_leader = true` in the user's own `[cli]` table (or root `cli.` keys) when there is one; otherwise adds a
 * `[cli]` table at the end of the file, outside the MCP block, so keys the person adds to it later stay theirs. The
 * file stays valid TOML. `inline`: `cli` is an inline table (`cli = {…}`), which takes no further key; its line number.
 */
function setLeader(text: string): { text: string; replaced?: string } | { inline: number } {
  const scan = scanLeader(text);
  const lines = text.split("\n");
  if (scan.falseLine !== undefined) {
    const replaced = lines[scan.falseLine]!;
    lines[scan.falseLine] = `${/^\s*/.exec(replaced)![0]}${scan.falseDotted ? "cli." : ""}use_leader = true ${LEADER_MARK}`;
    return { text: lines.join("\n"), replaced };
  }
  if (scan.inline !== undefined) return { inline: scan.inline };
  if (scan.cliHeader !== undefined) lines.splice(scan.cliHeader + 1, 0, `use_leader = true ${LEADER_MARK}`);
  else if (scan.rootDotted !== undefined) lines.splice(scan.rootDotted + 1, 0, `cli.use_leader = true ${LEADER_MARK}`);
  else return { text: `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}[cli] ${LEADER_MARK}\nuse_leader = true ${LEADER_MARK}\n` };
  return { text: lines.join("\n") };
}

/**
 * Takes back the `use_leader = true` line an install wrote, if it is still there and still true: puts back the line it
 * replaced, or removes it, and then the `[cli]` header the install added if the person put nothing under it.
 */
function revertLeader(text: string, replaced?: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => LEADER_LINE.test(line));
  if (index < 0) return text;
  if (replaced === undefined) lines.splice(index, 1);
  else lines[index] = replaced;
  const header = lines.findIndex((line) => LEADER_HEADER.test(line));
  if (header >= 0) {
    let end = header + 1;
    while (end < lines.length && lines[end]!.trim() === "") end++;
    if (end === lines.length || /^\s*\[/.test(lines[end]!)) {
      let start = header;
      // At the end of the file, the blank line that separated the table goes too.
      if (end === lines.length) while (start > 0 && lines[start - 1]!.trim() === "") start--;
      lines.splice(start, end - start, ...(end === lines.length && start > 0 ? [""] : []));
    }
  }
  return lines.join("\n");
}

const leaderLater = (file: string): string =>
  `To turn it on later: agent-bus install grok --leader, start Grok with grok --leader, or set use_leader = true under [cli] in ${file}.`;

/** Asks a yes/no question on the terminal (/dev/tty, so it works under `curl | sh` too); undefined when there is none. */
function askTerminal(lines: string[], question: string): boolean | undefined {
  if (!process.stdin.isTTY && !process.stdout.isTTY && !process.stderr.isTTY) return undefined;
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return undefined;
  }
  try {
    writeSync(fd, `${lines.join("\n")}\n${question} [y/N] `);
    const buffer = Buffer.alloc(256);
    let answer = "";
    while (!answer.includes("\n")) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      answer += buffer.toString("utf8", 0, read);
    }
    return /^\s*y/i.test(answer);
  } finally {
    closeSync(fd);
  }
}

/** What a Grok install will write, worked out before anything is written. */
interface GrokPlan {
  file: string;
  /** The config to write the MCP block after: the current file without the block, leader setting already applied. */
  base: string;
  /** The current file, parsed: the install may change only Agent Hub's server and `cli.use_leader` in it. */
  parsed: Toml;
  /** `cli.use_leader` the written file must have. */
  leaderValue: unknown;
  /** What uninstall restores when the file is untouched since this install: the config without any of our changes. */
  originalExists: boolean;
  original: string;
  /** Present while a `use_leader = true` line in the file is Agent Hub's: the record uninstall reverts it with. */
  leader?: { replaced?: string };
  /** This install turned leader mode on. */
  turnedOn?: boolean;
}

/**
 * Grok reads MCP servers from `[mcp_servers.<name>]` in its config.toml. A plugin under ~/.grok/plugins is not enough:
 * user plugins start disabled (seen with grok 1.0.45, 24 Nov). It wakes for Hub messages only in leader mode, which
 * changes how every Grok session on the machine runs, so the person decides: asked on a terminal, else `--leader`.
 * The leader setting lives in the person's `[cli]` table, never in the MCP block, and is read from the file as it is
 * now: a value the person changed since an earlier install is theirs.
 */
function planGrok(definition: Definition, opts: UniversalInstallOptions, previous?: ConfigSnapshot): GrokPlan {
  const file = definition.config!;
  const existed = existsSync(file);
  const before = existed ? readFileSync(file, "utf8") : "";
  const parsed = parseToml(before, file, BY_HAND);
  const stripped = stripGrokBlock(before);
  const base = stripped !== before && stripped.trim() === "" ? "" : stripped;
  const parsedBase = parseToml(base, file, BY_HAND);
  if (object(parsedBase.mcp_servers)["agent-hub"] !== undefined) {
    throw new Error(`${file} already has an agent-hub MCP server not written by Agent Hub; not replacing it`);
  }
  const untouched = previous !== undefined && before === previous.installed;
  const ours = base.split("\n").some((line) => LEADER_LINE.test(line));
  const value = leaderOf(parsedBase);
  const plan: GrokPlan = {
    file,
    base,
    parsed,
    leaderValue: value,
    originalExists: untouched ? previous.originalExists : existed,
    original: untouched ? previous.original : ours ? revertLeader(base, previous?.leader?.replaced) : base,
    ...(ours ? { leader: { replaced: previous?.leader?.replaced } } : {}),
  };
  if (value === true) {
    console.log(`Grok leader mode is already on in ${file}, so Grok wakes for Agent Hub messages.`);
    return plan;
  }
  if (value === undefined && previous?.leader && leaderOf(parsed) === true) {
    // An install before 27 Nov kept the setting inside the MCP block; it moves to the person's config, still on.
    const set = setLeader(base);
    if ("text" in set) {
      console.log(`Grok leader mode is already on in ${file}, so Grok wakes for Agent Hub messages.`);
      return { ...plan, base: set.text, leaderValue: true, leader: {} };
    }
  }
  const turnOn = opts.leader ?? askTerminal([
    "Grok wakes for Agent Hub messages only in leader mode, and it is off.",
    "In leader mode one Grok process, the leader, owns every Grok session on this machine.",
  ], `Turn on leader mode in ${file}?`);
  if (turnOn === undefined) {
    console.log(`Grok leader mode is off, so Grok reads Agent Hub messages only when it next calls message-bus. ${leaderLater(file)}`);
    return plan;
  }
  if (!turnOn) {
    console.log(`Leaving Grok leader mode off. ${leaderLater(file)}`);
    return plan;
  }
  const set = setLeader(base);
  if ("inline" in set) {
    // Asked for and not possible: fail, never install with leader mode silently still off.
    throw new Error(
      `${file} sets cli as an inline table, which Agent Hub does not edit; nothing was changed. To turn leader mode on, ` +
        `${inlineLeaderEdit(base, parsedBase, set.inline)}, then run this again, or start Grok with grok --leader.`,
    );
  }
  return { ...plan, base: set.text, leaderValue: true, leader: { replaced: set.replaced }, turnedOn: true };
}

/**
 * The config.toml this install writes, checked before anything is written: Bun parses it, it has Agent Hub's server
 * and the intended `cli.use_leader`, and every other value is as it was.
 */
function grokInstalled(name: UniversalAdapterName, plan: GrokPlan, target: string, url: string): string {
  const { file, base } = plan;
  const args = argsFor(name, target, url).map((value) => JSON.stringify(value)).join(", ");
  const body = `${GROK_BEGIN}\n[mcp_servers.agent-hub]\ncommand = ${JSON.stringify(jsRuntime())}\nargs = [${args}]\n${GROK_END}\n`;
  const installed = `${base}${base && !base.endsWith("\n") ? "\n" : ""}${base ? "\n" : ""}${body}`;
  const after = parseToml(installed, `${file} with Agent Hub's block added`, BY_HAND);
  checkGrokEdit(file, plan.parsed, after, true, { value: plan.leaderValue }, BY_HAND);
  return installed;
}

function writeGrokEntry(plan: GrokPlan, installed: string, snapshot: string): void {
  const { file, originalExists, original, leader } = plan;
  mkdirSync(path.dirname(file), { recursive: true });
  writePrivateJson(snapshot, { originalExists, original, installed, ...(leader ? { leader } : {}) });
  writeFileSync(file, installed);
  if (plan.turnedOn) console.log(`Grok leader mode is on: use_leader = true under [cli] in ${file}.`);
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
  // Edited since install: the user's changes stay; only Agent Hub's block and its own unchanged leader line go. A file
  // with neither is left byte for byte, and a hand-written [mcp_servers.agent-hub] (no markers) stays.
  const withoutBlock = stripGrokBlock(current);
  const stripped = revertLeader(withoutBlock, snapshot?.leader?.replaced);
  if (stripped === current) return;
  const cleaned = withoutBlock === current ? stripped : stripped.replace(/\n+$/, "\n");
  let parsed: Toml | undefined;
  try {
    parsed = Bun.TOML.parse(current) as Toml;
  } catch {
    // Already unreadable: removing Agent Hub's lines cannot make it worse.
  }
  if (parsed) {
    const hint = `If Grok reads it fine, delete the lines from "${GROK_BEGIN}" to "${GROK_END}" by hand.`;
    const handWritten = withoutBlock === current && object(parsed.mcp_servers)["agent-hub"] !== undefined;
    checkGrokEdit(file, parsed, parseToml(cleaned, `${file} with Agent Hub's block removed`, hint), handWritten, null, hint);
  }
  writeFileSync(file, cleaned === "\n" ? "" : cleaned);
}

export async function installUniversal(name: UniversalAdapterName, opts: UniversalInstallOptions): Promise<void> {
  const definition = DEFINITIONS[name];
  const target = targetDir(name, opts);
  const owned = manifestName(manifest(target)) === ownedName(name);
  if (existsSync(target) && !owned) throw new Error(`${target} exists and is not the ${ownedName(name)} plugin; not touching it.`);
  const previous = owned ? readConfigSnapshot(target) : undefined;
  const url = installBusUrl(configFile(target), opts.url);
  // Asked, and the new config.toml checked, before anything is written.
  const grok = definition.kind === "grok" ? planGrok(definition, opts, previous) : undefined;
  const grokText = grok ? grokInstalled(name, grok, target, url) : undefined;
  // Built beside the installed adapter, which keeps working, with its snapshot, until the new one is complete and the
  // harness config points at it; a failure removes only the staging folder, so a plain retry works.
  const staging = `${target}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  mkdirSync(staging, { mode: 0o700 });
  chmodSync(staging, 0o700);
  try {
    const entries: Array<[string, string]> =
      name === "qwen" ? [["src/server.ts", "server"], ["src/inbox-hook.ts", "inbox-hook"]] : [["src/server.ts", "server"]];
    await bundleForNode(root, staging, entries);
    writeJson(manifest(staging), { name: ownedName(name), version: "0.2.0", private: true });
    writeJson(configFile(staging), { busUrl: url, harness: name });
    writeMetadata(staging, "message-bus", `${definition.title} bridge for Agent Hub.`);
    // The harness config names the final paths (under `target`); the snapshot goes with the new adapter.
    if (grok) writeGrokEntry(grok, grokText!, configSnapshotFile(staging));
    else setJsonEntry(name, definition, target, url, configSnapshotFile(staging), previous);
    const old = `${target}.old-${process.pid}`;
    rmSync(old, { recursive: true, force: true });
    if (existsSync(target)) renameSync(target, old);
    try {
      renameSync(staging, target);
    } catch (error) {
      if (existsSync(old)) renameSync(old, target);
      throw error;
    }
    rmSync(old, { recursive: true, force: true });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
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
  if (installed && definition.kind === "grok") {
    const text = existsSync(definition.config!) ? readFileSync(definition.config!, "utf8") : "";
    let config: Toml | undefined;
    try {
      config = Bun.TOML.parse(text) as Toml;
    } catch {
      notes.push(`Bun could not parse ${definition.config}`);
    }
    if (config && !text.includes(GROK_BEGIN)) notes.push(`MCP entry missing from ${definition.config}`);
    else if (config && leaderOf(config) === true) notes.push("idle wake: leader mode on");
    else if (config) notes.push("no idle wake: leader mode off (agent-bus install grok --leader, or grok --leader)");
  }
  return { installed, where: target, busUrl: configBusUrl(configFile(target)), notes };
}

export const universalDefinition = (name: UniversalAdapterName): Readonly<Definition> => DEFINITIONS[name];
