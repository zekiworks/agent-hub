// Bundled to dist/hook.mjs. Every Cursor hook runs `node dist/hook.mjs <event> agent-bus-cursor-hook`, posts the event
// to the daemon, and prints the daemon's answer. When the daemon is down or slow the hook prints `{}` (nothing to add)
// so it cannot hold the chat up or deny a tool.
import { relayHook } from "../../client/src/hook-socket";
import { daemonSocketPath } from "./socket";
import type { HookInput } from "./daemon";

const event = process.argv[2] ?? "";

void relayHook("{}", (input) => {
  const payload = JSON.parse(input || "{}") as HookInput;
  // User hooks run with cwd ~/.cursor. The project is the env var, if the payload did not name a workspace.
  if ((!payload.workspace_roots || payload.workspace_roots.length === 0) && process.env.CURSOR_PROJECT_DIR) {
    payload.workspace_roots = [process.env.CURSOR_PROJECT_DIR];
  }
  return { socketPath: daemonSocketPath(), body: JSON.stringify({ event, input: payload }) };
});
