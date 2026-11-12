// What `agent-bus install cursor` merges into ~/.cursor/hooks.json and ~/.cursor/mcp.json. Entries are found again by
// HOOK_MARK / DAEMON_MARK, so install and uninstall leave every other hook and MCP server in those files alone.
import * as os from "node:os";
import * as path from "node:path";

/** In the hook command. Cursor strips `//` from hooks.json even inside quotes, so this mark has none. */
export const HOOK_MARK = "agent-bus-cursor-hook";
/** An extra argv on the MCP server, so the mcp.json entry is recognisable without reading the path. */
export const DAEMON_MARK = "agent-bus-cursor-daemon";

export const HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "stop",
  "afterAgentResponse",
  "afterAgentThought",
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Cursor's config directory. Tests point this at a temp folder. */
export function cursorHome(): string {
  return process.env.AGENT_BUS_CURSOR_HOME || path.join(os.homedir(), ".cursor");
}

export interface HookEntry {
  command?: string;
  timeout?: number;
  loop_limit?: number | null;
  [key: string]: unknown;
}

export interface HooksFile {
  version?: number;
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

/** A shell command Cursor can run. Each token is quoted; the mark is the last token so the script can ignore it. */
export function hookCommand(node: string, script: string, event: string): string {
  return [node, script, event, HOOK_MARK].map((part) => JSON.stringify(part)).join(" ");
}

export function isOurHook(command: unknown): boolean {
  return typeof command === "string" && command.includes(HOOK_MARK);
}

export function ourHookEntries(node: string, script: string): Record<string, HookEntry> {
  const entries: Record<string, HookEntry> = {};
  for (const event of HOOK_EVENTS) {
    const entry: HookEntry = { command: hookCommand(node, script, event), timeout: 5 };
    // A wake that arrives as a turn ends is one follow-up. Cursor's default cap is 5 per conversation.
    if (event === "stop") entry.loop_limit = null;
    entries[event] = entry;
  }
  return entries;
}

function keptHooks(list: unknown): HookEntry[] {
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => !isOurHook((entry as HookEntry | undefined)?.command));
}

/** Puts our hook on each event, replacing any earlier agent-bus entries and keeping everything else. */
export function mergeHooks(file: HooksFile, entries: Record<string, HookEntry>): HooksFile {
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, list] of Object.entries(file.hooks ?? {})) {
    const kept = keptHooks(list);
    if (kept.length > 0) hooks[event] = kept;
  }
  for (const [event, entry] of Object.entries(entries)) hooks[event] = [...(hooks[event] ?? []), entry];
  return { ...file, version: typeof file.version === "number" ? file.version : 1, hooks };
}

export function stripHooks(file: HooksFile): HooksFile {
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, list] of Object.entries(file.hooks ?? {})) {
    const kept = keptHooks(list);
    if (kept.length > 0) hooks[event] = kept;
  }
  return { ...file, hooks };
}

/** True when the file has nothing left but our wrapper (`version` and an empty `hooks`). Safe to delete. */
export function hooksVacant(file: HooksFile): boolean {
  if (Object.keys(file.hooks ?? {}).length > 0) return false;
  return Object.keys(file).every((key) => key === "version" || key === "hooks");
}

export interface McpServerConfig {
  command: string;
  args: string[];
  [key: string]: unknown;
}

export interface McpFile {
  mcpServers?: Record<string, McpServerConfig | undefined>;
  [key: string]: unknown;
}

export const MCP_SERVER = "message-bus";

export function isOurMcp(server: { args?: unknown } | undefined): boolean {
  return Array.isArray(server?.args) && (server.args as unknown[]).includes(DAEMON_MARK);
}

export function mergeMcp(file: McpFile, server: McpServerConfig, force: boolean): McpFile {
  const servers = { ...(file.mcpServers ?? {}) };
  const current = servers[MCP_SERVER];
  if (current && !isOurMcp(current) && !force) {
    throw new Error(`mcp.json already has a ${MCP_SERVER} server that agent-bus did not write; not touching it (--force replaces it).`);
  }
  servers[MCP_SERVER] = server;
  return { ...file, mcpServers: servers };
}

export function stripMcp(file: McpFile): McpFile {
  const servers = { ...(file.mcpServers ?? {}) };
  if (isOurMcp(servers[MCP_SERVER])) delete servers[MCP_SERVER];
  return { ...file, mcpServers: servers };
}

export function mcpVacant(file: McpFile): boolean {
  if (Object.keys(file.mcpServers ?? {}).length > 0) return false;
  return Object.keys(file).every((key) => key === "mcpServers");
}
