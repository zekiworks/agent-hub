// A self-contained V2 plugin package in OpenCode's auto-discovered global plugins directory.
// No edits to opencode.json(c), no link back to this checkout, no runtime dependency installation.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bundleForNode, configBusUrl, installBusUrl, manifestName, removeOwnedDir, writeJson, writeMetadata,
  type InstallOptions, type InstallStatus,
} from "../../client/src/install";

const NAME = "@agent-bus/opencode-plugin";
const root = path.resolve(import.meta.dir, "..");
const defaultDir = (): string => path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode", "plugins", "agent-bus"
);
const targetDir = (opts: InstallOptions): string => path.resolve(opts.dir ?? defaultDir());
const manifestOf = (dir: string): string => path.join(dir, "package.json");

export async function install(opts: InstallOptions): Promise<void> {
  const target = targetDir(opts);
  const busUrl = installBusUrl(path.join(target, "config.json"), opts.url);
  removeOwnedDir(target, manifestOf(target), NAME, "plugin");
  mkdirSync(target, { recursive: true });
  await bundleForNode(root, path.join(target, "dist"), [["src/index.ts", "plugin"]]);
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  writeJson(manifestOf(target), { name: NAME, version, type: "module", exports: "./index.js" });
  writeJson(path.join(target, "config.json"), { busUrl });
  // Keep the installed URL local to this plugin: never mutate the shared server's process environment.
  await Bun.write(path.join(target, "index.js"), [
    "// agent-bus install opencode: OpenCode V2 message-bus plugin.",
    'import { readFileSync } from "node:fs";',
    'import plugin from "./dist/plugin.mjs";',
    'const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));',
    "export default {",
    "  ...plugin,",
    "  setup(ctx) { return plugin.setup({ ...ctx, options: { busUrl: config.busUrl, ...ctx.options } }); },",
    "};",
    "",
  ].join("\n"));
  writeMetadata(target, "opencode", "OpenCode V2 server plugin: main sessions join the LAN message bus.");
  console.log(`Built ${target} (bus ${busUrl}).`);
  if (target === path.resolve(defaultDir())) {
    console.log("OpenCode V2 discovers this global plugin automatically; config directory changes reload it.");
  } else {
    console.log(`To load it, add ${JSON.stringify(target)} to plugins in opencode.json(c).`);
  }
}

export async function uninstall(opts: InstallOptions): Promise<void> {
  const target = targetDir(opts);
  removeOwnedDir(target, manifestOf(target), NAME, "plugin");
  console.log(`Removed ${target}.`);
}

export function status(opts: InstallOptions): InstallStatus {
  const target = targetDir(opts);
  const installed = manifestName(manifestOf(target)) === NAME;
  const notes: string[] = [];
  if (installed && !existsSync(path.join(target, "dist", "plugin.mjs"))) notes.push("plugin bundle is missing; install again");
  if (installed && target !== path.resolve(defaultDir())) notes.push("custom directory: add it to plugins in opencode.json(c)");
  if (existsSync(target) && !installed) notes.push("not written by agent-bus; not touching it");
  return { installed, where: target, busUrl: configBusUrl(path.join(target, "config.json")), notes };
}
