// One bus session per harness window. A harness can spawn the same stdio MCP bridge several times for one window
// (kimi-code 2.7.3 starts it two to three times), and every process used to join the bus as the same agent, each
// join becoming the session that messages route to. The first bridge of a window — same bus URL, harness, folder
// and parent pid — listens on a local socket and keeps the bus connection; a later twin serves its MCP client
// through that socket and takes the bus session over when the primary exits.
import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

/** A twin's MCP traffic as seen by the primary: lines from its client, and its socket closing. */
export interface TwinGate {
  line(line: string): void;
  close(): void;
}

export interface PrimaryBridge {
  role: "primary";
  /** Serves every connecting twin: `attach` gets the twin's write and returns its gate. */
  onTwin(attach: (write: (line: string) => void) => TwinGate): void;
  /** Stops listening, drops the twins (they re-elect) and removes the socket file. */
  close(): void;
}

export interface SecondaryBridge {
  role: "secondary";
  /** The primary's end: the client's lines go in, the primary's answers come out. */
  socket: net.Socket;
}

export type BridgeElection = PrimaryBridge | SecondaryBridge;

export interface WindowKey {
  url: string;
  harness: string;
  folder: string;
  /** The harness process that spawned the bridges: twins of one window share it, another window has its own. */
  ppid: number;
}

const CONNECT_TIMEOUT_MS = 2_000;

function socketPath(key: WindowKey): string {
  const hash = createHash("sha256").update(`${key.url}|${key.harness}|${key.folder}|${key.ppid}`).digest("hex").slice(0, 24);
  if (process.platform === "win32") return `\\\\.\\pipe\\agent-bus-join-${hash}`;
  return path.join(os.homedir(), ".agent-bus", "run", `join-${hash}.sock`);
}

function removeSocketFile(file: string): void {
  if (process.platform === "win32") return;
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

function tryListen(file: string): Promise<{ server?: net.Server; error?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => resolve({ error }));
    server.listen(file, () => resolve({ server }));
  });
}

function tryConnect(file: string): Promise<net.Socket | undefined> {
  return new Promise((resolve) => {
    const socket = net.createConnection(file);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(undefined);
    }, CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

/**
 * Decides whether this process keeps the window's bus connection (primary) or serves its MCP client through the
 * twin that does (secondary). Never throws: when the socket cannot be used at all, this process runs as a primary
 * without twin serving — the behavior from before election existed.
 */
export async function electBridge(key: WindowKey): Promise<BridgeElection> {
  const file = socketPath(key);
  if (process.platform !== "win32") {
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    } catch {
      // Fall through: the listen reports what is wrong.
    }
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { server, error } = await tryListen(file);
    if (server) return primaryBridge(server, file);
    if (error?.code !== "EADDRINUSE") break;
    const socket = await tryConnect(file);
    if (socket) return { role: "secondary", socket };
    // A bridge that died without cleanup left the file behind: remove it and try the listen once more.
    removeSocketFile(file);
  }
  return { role: "primary", onTwin: () => {}, close: () => {} };
}

function primaryBridge(server: net.Server, file: string): PrimaryBridge {
  const twins = new Set<net.Socket>();
  const early: net.Socket[] = [];
  let attach: ((write: (line: string) => void) => TwinGate) | undefined;
  const serve = (socket: net.Socket): void => {
    if (!attach) {
      // Connected between the listen and onTwin; served as soon as the gate exists.
      early.push(socket);
      return;
    }
    twins.add(socket);
    const gate = attach((line) => {
      try {
        socket.write(`${line}\n`);
      } catch {
        // The twin is gone; the socket's close cleans up.
      }
    });
    const lines = createInterface({ input: socket, terminal: false });
    lines.on("line", (line) => gate.line(line));
    lines.on("close", () => {
      twins.delete(socket);
      gate.close();
      socket.end();
    });
  };
  server.on("connection", serve);
  return {
    role: "primary",
    onTwin(attachFn) {
      attach = attachFn;
      for (const socket of early.splice(0)) serve(socket);
    },
    close() {
      server.close();
      for (const socket of twins.splice(0)) socket.destroy();
      removeSocketFile(file);
    },
  };
}
