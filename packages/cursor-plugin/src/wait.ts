// `agent-bus wait`: the waiter a Cursor chat leaves running in the background so that a bus message can wake it.
// Cursor cannot start a turn in an idle chat from outside, but it starts one when a background command the chat ran
// finishes. This command finishes when the next bus message for the chat's folder arrives, and prints it.
// It asks the Cursor plugin's daemon (the hook socket) and keeps asking while the daemon is down or the folder's chat
// is not on the bus yet: exiting then would wake the chat for nothing.
import { request } from "node:http";
import { daemonSocketPath } from "./socket";

const RETRY_MS = 5000;

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

/** Blocks until a bus message for this folder's chat arrives; prints it and returns 0. */
export async function runWait(cwd: string): Promise<number> {
  const socketPath = daemonSocketPath();
  for (;;) {
    let answer: ListenAnswer;
    try {
      answer = await listen(socketPath, cwd);
    } catch {
      // The daemon is not running (Cursor restarts its MCP servers now and then): ask again shortly.
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
