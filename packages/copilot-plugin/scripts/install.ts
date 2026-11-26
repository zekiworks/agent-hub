// Installs the message-bus extension for GitHub Copilot (`agent-bus install copilot`): a self-contained Copilot CLI
// extension in the user's extensions directory ($COPILOT_HOME/extensions, default ~/.copilot/extensions), so every
// Copilot CLI and Copilot app session joins the bus. No repository files are touched, no link back to this checkout.
//
// The extension is a copy: reinstall to update when the checkout changes. Copilot loads it for new sessions;
// `/clear`, a restart, or extensions_reload picks up a reinstall in a running one.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bundleForNode, configBusUrl, installBusUrl, manifestName, removeOwnedDir, writeJson, writeMetadata,
  type InstallOptions, type InstallStatus,
} from "../../client/src/install";

const NAME = "@agent-bus/copilot-plugin";
const root = path.resolve(import.meta.dir, "..");
const copilotHome = (): string => process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
const defaultDir = (): string => path.join(copilotHome(), "extensions", "agent-bus");
const targetDir = (opts: InstallOptions): string => path.resolve(opts.dir ?? defaultDir());
const manifestOf = (dir: string): string => path.join(dir, "package.json");

export async function install(opts: InstallOptions): Promise<void> {
  const target = targetDir(opts);
  const busUrl = installBusUrl(path.join(target, "config.json"), opts.url);
  removeOwnedDir(target, manifestOf(target), NAME, "plugin");
  mkdirSync(target, { recursive: true });
  // The CLI resolves @github/copilot-sdk for extension processes: never bundle it.
  await bundleForNode(root, path.join(target, "dist"), [["src/extension-main.ts", "extension"]], ["@github/copilot-sdk/extension"]);
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  writeJson(manifestOf(target), { name: NAME, version, private: true, type: "module" });
  writeJson(path.join(target, "config.json"), { busUrl });
  await Bun.write(path.join(target, "extension.mjs"),
    '// agent-bus install copilot: the message-bus Copilot extension.\nimport "./dist/extension.mjs";\n');
  writeMetadata(target, "copilot", "Copilot CLI extension: Copilot CLI and Copilot app sessions join the LAN's Agent Hub.");
  console.log(`Built ${target} (Hub ${busUrl}).`);
  if (target === path.resolve(defaultDir())) {
    console.log("Copilot loads it for new sessions; restart the Copilot app (or /clear a CLI session) to load it now.");
  } else {
    console.log(`Copilot loads user extensions from ${path.dirname(defaultDir())}; this directory is not loaded.`);
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
  if (installed && !existsSync(path.join(target, "dist", "extension.mjs"))) notes.push("extension bundle is missing; install again");
  if (installed && target !== path.resolve(defaultDir())) notes.push("custom directory: Copilot does not load it");
  if (existsSync(target) && !installed) notes.push("not written by agent-bus; not touching it");
  return { installed, where: target, busUrl: configBusUrl(path.join(target, "config.json")), notes };
}
