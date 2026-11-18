// Bundled to `dist/extension.mjs` of the installed extension (`<copilot home>/extensions/agent-bus/`); the root's
// extension.mjs imports it. The bus URL comes from the root's config.json (AGENT_BUS_URL overrides it).
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import { pluginBusUrl, pluginLog } from "../../client/src/runtime";
import type { JoinSession } from "./copilot";
import { start } from "./extension";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const log = pluginLog(path.join(os.homedir(), ".agent-bus", "logs", "copilot.log"));
const binding = await start(joinSession as unknown as JoinSession, { busUrl: pluginBusUrl(root), log }).catch((error) => {
  log(`start failed: ${error instanceof Error ? error.stack : error}`);
  return undefined;
});

let ended = false;
const shutdown = (): void => {
  if (ended) return;
  ended = true;
  binding?.close();
  setTimeout(() => process.exit(0), 150);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
// The CLI talks to the extension over stdio: when it goes without a signal (killed, crashed), stdin ends. Without this
// the bus connection would keep the process, and an orphaned session, alive.
process.stdin.once("end", shutdown);
