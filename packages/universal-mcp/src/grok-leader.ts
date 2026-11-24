// Grok Build leader-mode client: starts a turn in the live session that launched this MCP bridge (Can #16677).
//
// In leader mode one process per machine owns every Grok session; TUIs are clients on its Unix socket. Any client may
// send ACP traffic for a session, and `x.ai/interject` starts a turn at once when that session is idle (queued into
// the running turn otherwise). The leader also spawns MCP servers, so this bridge's parent is the leader, and Grok gives
// it `GROK_SESSION_ID`. Wire format (grok-build xai-grok-shell/src/leader/protocol.rs, protocol v1): frames are a
// 4-byte big-endian length followed by JSON.
import { readFileSync } from "node:fs";
import net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const TIMEOUT_MS = 10_000;

/** The live leader session this bridge belongs to, or undefined when Grok runs standalone (no external wake there). */
export function grokLeaderTarget(): { socket: string; sessionId: string } | undefined {
  const sessionId = process.env.GROK_SESSION_ID;
  if (!sessionId) return undefined;
  const home = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
  try {
    // Only a bridge the leader itself spawned may interject; a standalone TUI's bridge has the TUI as parent.
    if (Number(readFileSync(path.join(home, "leader.lock"), "utf8").trim()) !== process.ppid) return undefined;
  } catch {
    return undefined;
  }
  return { socket: process.env.GROK_LEADER_SOCKET || path.join(home, "leader.sock"), sessionId };
}

/** Sends `text` into the session as an interjection; resolves once the leader accepted it. */
export function grokInterject(target: { socket: string; sessionId: string }, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target.socket);
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("Grok leader did not answer")), TIMEOUT_MS);
    const send = (value: unknown): void => {
      const body = Buffer.from(JSON.stringify(value));
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length);
      socket.write(Buffer.concat([head, body]));
    };
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      if (!socket.destroyed) {
        // Disconnect at once: the leader fans every session broadcast out to each attached client.
        if (!error) send({ type: "disconnect" });
        socket.end();
      }
      if (error) reject(error);
      else resolve();
    };
    socket.on("connect", () => send({ type: "register", client_type: "agent-hub", mode: "stdio", capabilities: {} }));
    socket.on("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
        const length = buffer.readUInt32BE(0);
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString()) as { type: string; ready?: boolean; payload?: string; message?: string };
        buffer = buffer.subarray(4 + length);
        if ((message.type === "registered" && message.ready !== false) || message.type === "leader_ready") {
          const request = { jsonrpc: "2.0", id: 1, method: "_x.ai/interject", params: { sessionId: target.sessionId, text } };
          send({ type: "acp", payload: JSON.stringify(request) });
        } else if (message.type === "error") {
          finish(new Error(`Grok leader: ${message.message}`));
        } else if (message.type === "acp" && message.payload) {
          const reply = JSON.parse(message.payload) as { id?: number; error?: { message?: string } };
          if (reply.id === 1) finish(reply.error ? new Error(`Grok interject: ${reply.error.message}`) : undefined);
        }
      }
    });
  });
}
