// Bundled to dist/daemon.mjs. Cursor starts it as the message-bus MCP server. The first process owns the bus agents
// and the hook socket; a later one (another window) only forwards tool calls to it.
import { serveHookSocket, type HookSocket } from "../../client/src/hook-socket";
import { serveStdio, writeStdout } from "../../client/src/mcp";
import { pluginLog } from "../../client/src/runtime";
import { CursorMcp, Daemon, type HookInput } from "./daemon";
import { claimDaemon, daemonAlive, daemonSocketPath, postDaemon, releaseDaemon, stateFilePath } from "./socket";

const log = pluginLog();

async function waitForDaemon(socketPath: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    if (await daemonAlive(socketPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function answer(daemon: Daemon, body: string): Promise<unknown> {
  let event = "";
  try {
    const msg = JSON.parse(body) as { event?: string; input?: HookInput; args?: Record<string, unknown> };
    event = msg.event ?? "";
    if (event === "ping") return { ok: true };
    if (event === "tool") {
      try {
        return { text: await daemon.callTool(msg.args ?? {}) };
      } catch (err) {
        return { error: (err as Error).message };
      }
    }
    if (!event) return {};
    return await daemon.hook(event, msg.input ?? {});
  } catch (err) {
    log(`hook ${event || "?"} failed: ${(err as Error).message}`);
    return {};
  }
}

function serveProxy(socketPath: string): void {
  const mcp = new CursorMcp(writeStdout, async (args) => {
    // op=wait blocks. The socket stays quiet until it returns, so the usual few-second hook timeout would kill it.
    const res = (await postDaemon(
      socketPath,
      { event: "tool", args },
      args.op === "wait" ? 50 * 60_000 : 3000
    )) as { text?: string; error?: string };
    if (typeof res?.error === "string") throw new Error(res.error);
    if (typeof res?.text !== "string") throw new Error("The message-bus daemon did not answer this call.");
    return res.text;
  });
  serveStdio(mcp, () => process.exit(0));
}

export async function main(): Promise<void> {
  const socketPath = daemonSocketPath();
  const lockFile = `${socketPath}.lock`;
  if (!claimDaemon(lockFile)) {
    const up = await waitForDaemon(socketPath);
    if (!up) log("message-bus daemon is not answering; tool calls fail until it does");
    serveProxy(socketPath);
    return;
  }

  const daemon = new Daemon(stateFilePath(), log);
  let hooks: HookSocket | undefined;
  try {
    hooks = serveHookSocket(socketPath, (body) => answer(daemon, body));
  } catch (err) {
    releaseDaemon(lockFile);
    daemon.close();
    throw err;
  }
  let ended = false;
  const shutdown = (): void => {
    if (ended) return;
    ended = true;
    daemon.close();
    hooks?.close();
    releaseDaemon(lockFile);
    setTimeout(() => process.exit(0), 200);
  };
  serveStdio(new CursorMcp(writeStdout, (args) => daemon.callTool(args)), shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  log(`daemon started: bus ${daemon.url}, hooks on ${socketPath}`);
}

void main().catch((err: Error) => {
  log(`daemon failed: ${err.message}`);
  process.exit(1);
});
