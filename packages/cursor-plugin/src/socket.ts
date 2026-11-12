// The local socket between Cursor's hook processes and the one daemon that owns the bus agents. A second MCP server
// (Cursor starts one per window) forwards tool calls here instead of joining the bus itself.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

export function daemonSocketPath(): string {
  return process.env.AGENT_BUS_CURSOR_SOCKET || path.join(os.homedir(), ".agent-bus", "cursor", "daemon.sock");
}

/** Folders to put back on the bus after Cursor restarts. The conversation id is learned again from a hook. */
export function stateFilePath(): string {
  return process.env.AGENT_BUS_CURSOR_STATE || path.join(os.homedir(), ".agent-bus", "cursor", "agents.json");
}

export function postDaemon(socketPath: string, body: unknown, timeoutMs = 3000): Promise<unknown> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path: "/hook", method: "POST", headers: { "Content-Type": "application/json" }, timeout: timeoutMs },
      (res) => {
        let out = "";
        res.on("data", (chunk: Buffer | string) => (out += chunk));
        res.on("end", () => {
          try {
            resolve(out ? JSON.parse(out) : {});
          } catch {
            reject(new Error("daemon answer was not JSON"));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

export async function daemonAlive(socketPath: string): Promise<boolean> {
  try {
    const answer = (await postDaemon(socketPath, { event: "ping" }, 300)) as { ok?: boolean };
    return answer?.ok === true;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * One daemon per machine account. The lock holds its pid; a dead pid is taken over. False means another live daemon
 * already owns the bus agents and this process should only forward tool calls.
 */
export function claimDaemon(lockFile: string): boolean {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  const create = (): boolean => {
    try {
      writeFileSync(lockFile, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  if (create()) return true;
  let owner = 0;
  try {
    owner = Number(readFileSync(lockFile, "utf8"));
  } catch {
    owner = 0;
  }
  if (pidAlive(owner)) return false;
  try {
    unlinkSync(lockFile);
  } catch {
    // The other process replaced it.
  }
  return create();
}

export function releaseDaemon(lockFile: string): void {
  try {
    if (!existsSync(lockFile) || readFileSync(lockFile, "utf8").trim() !== String(process.pid)) return;
    unlinkSync(lockFile);
  } catch {
    // Already gone.
  }
}
