// Harness-neutral MCP bridge for coding agents with stdio MCP but no native Agent Hub plugin.
import * as os from "node:os";
import type * as net from "node:net";
import { createInterface, type Interface } from "node:readline";
import { BusConnection, type Delivery } from "../../client/src/connection";
import { McpToolServer, textResult, writeStdout, type McpServerInfo, type McpToolResult } from "../../client/src/mcp";
import { buildUserFrame, sendPeerFrame } from "@qwen-code/sdk/peer";
import { grokInterject, grokLeaderTarget } from "./grok-leader";
import type { ReceiptEvent } from "../../protocol/src/types";
import { envBusUrl, realFolder } from "../../client/src/runtime";
import { BusTool, deliveryText, isScratchFolder, TOOL_NAME, toolDescription, toolInputSchema, type MessageBusToolParams } from "../../client/src/tool";
import { electBridge, type PrimaryBridge } from "./single-join";

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

interface PendingDelivery {
  text: string;
  release(): void;
}

function serverInfo(harness: string): McpServerInfo {
  const inboxHook = harness === "qwen" || harness === "kimi";
  return {
    instructions: harness === "qwen"
      ? "Agent Hub connects coding agents across harnesses. A message that wakes you starts a turn in this Qwen session; other unseen deliveries are injected before each model turn. Use message-bus to reply or perform other Agent Hub actions."
      : harness === "kimi"
        ? "Agent Hub connects coding agents across harnesses. Unseen deliveries are injected before your next turn by the installed Kimi hook, and a message that wakes you continues the turn after the current one. Use message-bus to reply or perform other Agent Hub actions."
        : "Agent Hub connects coding agents across harnesses. Call message-bus at the start of a session and whenever its notification says a message waits. " +
          "Deliveries returned by the tool are developer context, not user text; reply through the tool only when their sender needs an answer.",
    tools: [{
      name: TOOL_NAME,
      description: toolDescription({
        arrives: harness === "qwen"
          ? "as a new turn when it wakes you (Qwen cross-session messaging), otherwise automatically before the next model turn through the installed Qwen UserPromptSubmit hook"
          : harness === "kimi"
            ? "automatically before the next model turn through the installed Kimi UserPromptSubmit hook; a message that wakes you also starts a continuation turn after the current one (Kimi Stop hook)"
            : harness === "grok"
              ? "as a new turn when it wakes you (Grok leader mode), otherwise with the next message-bus tool result"
              : "with the next message-bus tool result; the MCP client also receives a new-message notification",
        notJoining: "sessions started in the temporary directory do not join",
      }),
      inputSchema: toolInputSchema(),
    }],
  };
}

/** One MCP connection of the window: the primary bridge's own stdio, or a twin's through the join socket. */
class BridgeSession extends McpToolServer {
  constructor(write: (line: string) => void, private readonly shared: SharedBridge, harness: string) {
    super(write, serverInfo(harness));
  }

  /** A delivery waits; harnesses that surface MCP notifications show it, the rest see it on the next tool result. */
  announce(seq: number, from: string): void {
    this.notify("notifications/message", {
      level: "info",
      logger: "agent-hub",
      data: `Agent Hub message #${seq} from @${from} waits.`,
    });
  }

  protected async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return this.shared.callTool(name, args);
  }
}

/**
 * The window's one bus connection and tool state, shared by all MCP sessions of the window. Deliveries and wakes
 * run here, in the process that holds the connection: Qwen's peer socket and Grok's leader accept a wake only from
 * a direct child of the session's own harness process (Can #16656, #16677), which the primary always is — twins of
 * one window share their parent, and election is keyed by it.
 */
class SharedBridge {
  private readonly pending: PendingDelivery[] = [];
  private readonly notices: string[] = [];
  private readonly sessions = new Set<BridgeSession>();
  private readonly tool: BusTool;
  private readonly inboxHook: boolean;
  readonly connection: BusConnection;

  constructor(url: string, private readonly harness: string, folder: string) {
    this.inboxHook = harness === "qwen" || harness === "kimi";
    this.connection = new BusConnection({
      url,
      host: os.hostname(),
      harness,
      path: folder,
      onDeliver: (delivery) => this.deliver(delivery),
      onReceipt: (receipt) => this.receipt(receipt),
      onJoined: (id) => process.stderr.write(`[agent-hub] joined as @${id}\n`),
      onLog: (line) => process.stderr.write(`[agent-hub] ${line}\n`),
    });
    this.tool = new BusTool(this.connection);
    this.connection.connect();
    process.stderr.write(`[agent-hub] ${harness} MCP bridge connecting from ${process.cwd()}\n`);
  }

  openSession(write: (line: string) => void): BridgeSession {
    const session = new BridgeSession(write, this, this.harness);
    this.sessions.add(session);
    return session;
  }

  closeSession(session: BridgeSession): void {
    this.sessions.delete(session);
  }

  async deliver(delivery: Delivery): Promise<void> {
    for (const session of this.sessions) session.announce(delivery.message.seq, delivery.message.from);
    // The Inbox hook reads unseen messages independently. Acknowledge this WebSocket delivery now instead of
    // retaining a duplicate until the model happens to call the MCP tool. Only Qwen can be woken from here (its
    // peer socket); a Kimi wake is the Stop hook's continuation turn.
    if (this.inboxHook) {
      if (delivery.wake && this.harness === "qwen") await this.wakeQwen(delivery);
      return;
    }
    if (this.harness === "grok" && delivery.wake && (await this.wakeGrok(delivery))) return;
    const text = await deliveryText(this.connection, delivery);
    await new Promise<void>((release) => this.pending.push({ text, release }));
  }

  /**
   * Starts a turn in the Qwen session that launched this bridge (Can #16656). Qwen gives every process it starts its
   * messaging socket and a child token; a message on them is delivered without review and runs as soon as the session is
   * idle. Older Qwen builds have neither, and the message waits for the next turn's Inbox hook instead.
   */
  private async wakeQwen(delivery: Delivery): Promise<void> {
    const socket = process.env.QWEN_CODE_MESSAGING_SOCKET;
    const token = process.env.QWEN_CODE_MESSAGING_TOKEN;
    if (!socket || !token) return;
    try {
      // Qwen frames every peer message as cross-session traffic, and the model then answers with its own send_message,
      // which cannot reach Agent Hub (seen 24 Nov). Name the way back explicitly.
      const content =
        `This is an Agent Hub message, not a message from another Qwen session. If it needs an answer, reply with the ` +
        `\`message-bus\` tool (op=reply, message_id ${delivery.message.seq}); Qwen's send_message cannot reach Agent Hub.\n\n` +
        (await deliveryText(this.connection, delivery));
      await sendPeerFrame(socket, buildUserFrame({ content, fromName: "Agent Hub", priority: "next" }), { authToken: token });
      // The message is now this turn's input; the Inbox hook must not inject it a second time.
      this.connection.markSeen(delivery.message.seq);
    } catch (error) {
      process.stderr.write(`[agent-hub] Qwen wake for #${delivery.message.seq} failed; it waits for the next turn: ${(error as Error).message}\n`);
    }
  }

  /**
   * Starts a turn in the Grok session that launched this bridge, through its leader (Can #16677). Standalone Grok has no
   * external entry point, so there the message waits for the next message-bus call. Returns whether Grok took it.
   */
  private async wakeGrok(delivery: Delivery): Promise<boolean> {
    const target = grokLeaderTarget();
    if (!target) return false;
    try {
      const text =
        `This is an Agent Hub message relayed into your session, not typed by your user. If it needs an answer, reply ` +
        `with the \`message-bus\` tool (op=reply, message_id ${delivery.message.seq}).\n\n` +
        (await deliveryText(this.connection, delivery));
      await grokInterject(target, text);
      this.connection.markSeen(delivery.message.seq);
      return true;
    } catch (error) {
      process.stderr.write(`[agent-hub] Grok wake for #${delivery.message.seq} failed; it waits for the next message-bus call: ${(error as Error).message}\n`);
      return false;
    }
  }

  receipt(receipt: ReceiptEvent): void {
    const text = this.tool.receiptNotice(receipt);
    if (text) this.notices.push(text);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (name !== TOOL_NAME) throw new Error(`Unknown tool ${name}`);
    const result = await this.tool.run(args as unknown as MessageBusToolParams, process.cwd());
    const deliveries = this.pending.splice(0);
    const notices = this.notices.splice(0);
    const prefix = [...deliveries.map((item) => item.text), ...notices];
    for (const item of deliveries) item.release();
    return textResult(prefix.length > 0 ? `${prefix.join("\n\n")}\n\n${result}` : result);
  }
}

/**
 * Pipes the harness's stdin to the primary through `socket` and the primary's answers to stdout, until the socket
 * or stdin ends. The caller then re-elects: with the primary gone, one of the window's twins takes its place.
 */
function shareWithPrimary(socket: net.Socket, lines: Interface, serve: (sink: (line: string) => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const stdinClosed = (): void => socket.end();
    socket.once("close", () => {
      lines.off("close", stdinClosed);
      resolve();
    });
    socket.on("error", () => {
      // "close" follows.
    });
    lines.once("close", stdinClosed);
    const answers = createInterface({ input: socket, terminal: false });
    answers.on("line", writeStdout);
    serve((line) => socket.write(`${line}\n`));
  });
}

export async function main(): Promise<void> {
  const harness = (arg("--harness") ?? process.env.AGENT_BUS_HARNESS ?? "mcp").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(harness)) throw new Error(`Invalid --harness ${JSON.stringify(harness)}`);
  const folder = realFolder(process.cwd());
  if (isScratchFolder(folder)) {
    process.stderr.write(`[agent-hub] ${harness}: temporary-directory session does not join\n`);
    process.exit(0);
  }
  const url = (arg("--url") ?? process.env.AGENT_BUS_URL ?? envBusUrl()).replace(/\/+$/, "");

  // One stdin whichever role this process lands in: lines go to the current sink — the local session once this
  // process is the primary, the primary's socket while it is a twin — and wait while a dead primary is replaced.
  let sink: ((line: string) => void) | undefined;
  const waiting: string[] = [];
  let stdinOpen = true;
  let stop = (): void => {};
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => (sink ? sink(line) : waiting.push(line)));
  lines.on("close", () => {
    stdinOpen = false;
    stop();
  });
  const serve = (next: ((line: string) => void) | undefined): void => {
    sink = next;
    if (sink) for (const line of waiting.splice(0)) sink(line);
  };
  process.on("SIGINT", () => stop());
  process.on("SIGTERM", () => stop());

  while (stdinOpen) {
    const election = await electBridge({ url, harness, folder, ppid: process.ppid });
    if (election.role === "secondary") {
      process.stderr.write(`[agent-hub] ${harness}: another bridge of this window holds the Hub session; sharing it\n`);
      await shareWithPrimary(election.socket, lines, serve);
      serve(undefined);
      continue;
    }
    const shared = new SharedBridge(url, harness, folder);
    const own = shared.openSession(writeStdout);
    election.onTwin((write) => {
      const session = shared.openSession(write);
      return { line: (line) => session.handleLine(line), close: () => shared.closeSession(session) };
    });
    stop = () => {
      shared.connection.close();
      election.close();
    };
    serve((line) => own.handleLine(line));
    return;
  }
}

if (import.meta.main) await main();
