// `agent-bus wait`: the waiter a Cursor chat leaves running in the background so that a bus message can wake it.
// Cursor cannot start a turn in an idle chat from outside, but it starts one when a background command the chat ran
// finishes. This command finishes when the next bus message for the chat's folder arrives, and prints it.
// It asks the Cursor plugin's daemon (the hook socket) and keeps asking while the daemon is down for a moment (Cursor
// restarts its MCP servers now and then) or the folder's chat is not on the bus yet. If the socket stays unreachable
// (above all: the command runs in Cursor's sandbox, which cannot reach it), it exits with the reason, so the chat
// learns it at once instead of waiting for nothing.
import { request } from "node:http";
import { daemonSocketPath } from "./socket";

const RETRY_MS = 5000;
/** How long the daemon may stay unreachable before the waiter gives up and says why. */
const GIVE_UP_MS = 30_000;

interface ListenAnswer {
  text?: string;
  already?: boolean;
  absent?: boolean;
}

function listen(socketPath: string, cwd: string): Promise<ListenAnswer> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/hook", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let out = "";
      res.on("data", (chunk: Buffer | string) => (out += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(out || "{}") as ListenAnswer);
        } catch {
          reject(new Error("the daemon's answer was not JSON"));
        }
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify({ event: "listen", cwd }));
  });
}

/** Blocks until a bus message for this folder's chat arrives; prints it and returns 0 (1 when the plugin is out of reach). */
export async function runWait(cwd: string): Promise<number> {
  const socketPath = daemonSocketPath();
  let unreachableSince: number | undefined;
  for (;;) {
    let answer: ListenAnswer;
    try {
      answer = await listen(socketPath, cwd);
      unreachableSince = undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
      unreachableSince ??= Date.now();
      // Not allowed to reach it at all: retrying cannot help. Gone for a while: not a restart.
      if (code === "EPERM" || code === "EACCES" || Date.now() - unreachableSince > GIVE_UP_MS) {
        process.stderr.write(
          `agent-bus wait: cannot reach the Cursor plugin at ${socketPath} (${code}). If this shell runs in Cursor's ` +
            "sandbox, start `agent-bus wait` outside it (with full permissions); otherwise check that Cursor's " +
            "message-bus MCP server is running.\n"
        );
        return 1;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      continue;
    }
    if (answer.text !== undefined) {
      process.stdout.write(
        `${answer.text}\n\n(agent-bus wait: handle these bus messages, then start \`agent-bus wait\` in the background again.)\n`
      );
      return 0;
    }
    if (answer.already) {
      process.stdout.write("agent-bus wait: already running for this chat; nothing to start.\n");
      return 0;
    }
    // absent (the chat is not on the bus yet) or cut off: keep waiting.
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}
