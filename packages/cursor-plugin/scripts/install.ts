// Installs Cursor support (`agent-bus install cursor`): builds the MCP server and the hook into self-contained JS,
// then registers them in ~/.cursor/hooks.json and ~/.cursor/mcp.json. Both files are shared with anything else the
// user configured; only entries this install wrote are replaced or removed.
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
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
import {
  cursorHome,
  DAEMON_MARK,
  hooksVacant,
  isOurHook,
  isOurMcp,
  MCP_SERVER,
  mcpVacant,
  mergeHooks,
  mergeMcp,
  ourHookEntries,
  stripHooks,
  stripMcp,
  type HooksFile,
  type McpFile,
} from "../src/config";

const PLUGIN = "message-bus";
const root = path.resolve(import.meta.dir, "..");

function pluginDir(opts: InstallOptions): string {
  return path.resolve(opts.dir ?? path.join(os.homedir(), ".agent-bus", "cursor-plugin"));
}

function removeOld(target: string): void {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(target);
    return;
  }
  removeOwnedDir(target, path.join(target, "plugin.json"), PLUGIN, "plugin");
}

function readObject(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not plain JSON; not touching it.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file} is not a JSON object; not touching it.`);
  }
  return value as Record<string, unknown>;
}

function hooksRegistered(file: string): boolean {
  const value = readObject(file);
  if (!value) return false;
  const hooks = (value as HooksFile).hooks ?? {};
  return Object.values(hooks).some((list) => Array.isArray(list) && list.some((entry) => isOurHook(entry?.command)));
}

function mcpRegistered(file: string): boolean {
  const value = readObject(file);
  if (!value) return false;
  return isOurMcp((value as McpFile).mcpServers?.[MCP_SERVER]);
}

/** Writes `file`, or removes it when `vacant` (we created it, and nothing else is left in it). */
function writeOrRemove(file: string, value: unknown, vacant: boolean, existed: boolean): void {
  if (vacant && existed) {
    unlinkSync(file);
    return;
  }
  if (vacant && !existed) return;
  writeJson(file, value);
}

export async function install(opts: InstallOptions): Promise<void> {
  const target = pluginDir(opts);
  const busUrl = installBusUrl(path.join(target, "config.json"), opts.url);
  const node = jsRuntime();
  const home = cursorHome();
  const hooksFile = path.join(home, "hooks.json");
  const mcpFile = path.join(home, "mcp.json");

  // Validate the shared files before replacing the bundle, so a bad hooks.json does not leave a half-updated install.
  const hooksExisted = existsSync(hooksFile);
  const mcpExisted = existsSync(mcpFile);
  const hooks = (readObject(hooksFile) ?? {}) as HooksFile;
  const mcp = (readObject(mcpFile) ?? {}) as McpFile;
  const nextHooks = mergeHooks(hooks, ourHookEntries(node, path.join(target, "dist", "hook.mjs")));
  const nextMcp = mergeMcp(
    mcp,
    { command: node, args: [path.join(target, "dist", "daemon.mjs"), DAEMON_MARK] },
    opts.force === true
  );

  removeOld(target);
  await bundleForNode(root, path.join(target, "dist"), [
    ["src/daemon-main.ts", "daemon"],
    ["src/hook.ts", "hook"],
  ]);
  writeJson(path.join(target, "plugin.json"), {
    name: PLUGIN,
    version: "1.0.0",
    description: "Puts Cursor chats on the LAN message bus and exposes the message-bus tool.",
  });
  writeJson(path.join(target, "config.json"), { busUrl });
  writeMetadata(target, "cursor", "Cursor MCP server and hooks that put this machine's Cursor chats on the message bus.");

  if (opts.buildOnly) {
    console.log(`Built ${target} (bus ${busUrl}, runtime ${node}); not registered with Cursor.`);
    return;
  }
  mkdirSync(home, { recursive: true });
  writeOrRemove(hooksFile, nextHooks, false, hooksExisted);
  writeOrRemove(mcpFile, nextMcp, false, mcpExisted);
  console.log(`Installed ${target} (bus ${busUrl}, runtime ${node}).`);
  console.log(`Registered hooks and the message-bus MCP server in ${home}. Reload Cursor and allow the tool when asked.`);
}

export async function uninstall(opts: InstallOptions): Promise<void> {
  const target = pluginDir(opts);
  const home = cursorHome();
  const hooksFile = path.join(home, "hooks.json");
  const mcpFile = path.join(home, "mcp.json");
  const hooksExisted = existsSync(hooksFile);
  const mcpExisted = existsSync(mcpFile);
  if (hooksExisted) {
    const next = stripHooks((readObject(hooksFile) ?? {}) as HooksFile);
    writeOrRemove(hooksFile, next, hooksVacant(next), true);
  }
  if (mcpExisted) {
    const next = stripMcp((readObject(mcpFile) ?? {}) as McpFile);
    writeOrRemove(mcpFile, next, mcpVacant(next), true);
  }
  removeOld(target);
  console.log(`Removed ${target} and its Cursor hooks and MCP server.`);
}

export function status(opts: InstallOptions): InstallStatus {
  const target = pluginDir(opts);
  const installed = manifestName(path.join(target, "plugin.json")) === PLUGIN;
  const notes: string[] = [];
  if (installed) {
    const home = cursorHome();
    try {
      if (!hooksRegistered(path.join(home, "hooks.json"))) notes.push("built, but not registered in Cursor's hooks.json");
    } catch (err) {
      notes.push((err as Error).message);
    }
    try {
      if (!mcpRegistered(path.join(home, "mcp.json"))) notes.push("built, but not registered in Cursor's mcp.json");
    } catch (err) {
      notes.push((err as Error).message);
    }
    notes.push("reload Cursor and allow the message-bus tool when asked");
  }
  return { installed, where: target, busUrl: configBusUrl(path.join(target, "config.json")), notes };
}
