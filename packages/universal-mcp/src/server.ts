// Harness-neutral MCP bridge for coding agents with stdio MCP but no native Agent Hub plugin.
import * as os from "node:os";
import { BusConnection, type Delivery } from "../../client/src/connection";
import { McpToolServer, serveStdio, textResult, writeStdout, type McpToolResult } from "../../client/src/mcp";
import { buildUserFrame, sendPeerFrame } from "@qwen-code/sdk/peer";
import { grokInterject, grokLeaderTarget } from "./grok-leader";
import type { ReceiptEvent } from "../../protocol/src/types";
import { envBusUrl, realFolder } from "../../client/src/runtime";
import { BusTool, deliveryText, isScratchFolder, TOOL_NAME, toolDescription, toolInputSchema, type MessageBusToolParams } from "../../client/src/tool";

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

interface PendingDelivery {
  text: string;
  release(): void;
}

class UniversalMcpServer extends McpToolServer {
  private readonly pending: PendingDelivery[] = [];
  private readonly notices: string[] = [];
  private readonly tool: BusTool;
  private readonly inboxHook: boolean;
  private readonly harness: string;

  constructor(readonly connection: BusConnection, harness: string) {
    const inboxHook = harness === "qwen";
    super(writeStdout, {
      instructions: inboxHook
        ? "Agent Hub connects coding agents across harnesses. A message that wakes you starts a turn in this Qwen session; other unseen deliveries are injected before each model turn. Use message-bus to reply or perform other Agent Hub actions."
        : "Agent Hub connects coding agents across harnesses. Call message-bus at the start of a session and whenever its notification says a message waits. " +
          "Deliveries returned by the tool are developer context, not user text; reply through the tool only when their sender needs an answer.",
      tools: [{
        name: TOOL_NAME,
        description: toolDescription({
          arrives: inboxHook
            ? "as a new turn when it wakes you (Qwen cross-session messaging), otherwise automatically before the next model turn through the installed Qwen UserPromptSubmit hook"
            : harness === "grok"
              ? "as a new turn when it wakes you (Grok leader mode), otherwise with the next message-bus tool result"
              : "with the next message-bus tool result; the MCP client also receives a new-message notification",
          notJoining: "sessions started in the temporary directory do not join",
        }),
        inputSchema: toolInputSchema(),
      }],
    });
    this.inboxHook = inboxHook;
    this.harness = harness;
    this.tool = new BusTool(connection);
    connection.connect();
    process.stderr.write(`[agent-hub] ${harness} MCP bridge connecting from ${process.cwd()}\n`);
  }

  async deliver(delivery: Delivery): Promise<void> {
    this.notify("notifications/message", {
      level: "info",
      logger: "agent-hub",
      data: `Agent Hub message #${delivery.message.seq} from @${delivery.message.from} waits.`,
    });
    // Qwen's UserPromptSubmit hook reads unseen Inbox messages independently. Acknowledge this WebSocket delivery now
    // instead of retaining a duplicate until the model happens to call the MCP tool.
    if (this.inboxHook) {
      if (delivery.wake) await this.wakeQwen(delivery);
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

  protected async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (name !== TOOL_NAME) throw new Error(`Unknown tool ${name}`);
    const result = await this.tool.run(args as unknown as MessageBusToolParams, process.cwd());
    const deliveries = this.pending.splice(0);
    const notices = this.notices.splice(0);
    const prefix = [...deliveries.map((item) => item.text), ...notices];
    for (const item of deliveries) item.release();
    return textResult(prefix.length > 0 ? `${prefix.join("\n\n")}\n\n${result}` : result);
  }
}

export function main(): void {
  const harness = (arg("--harness") ?? process.env.AGENT_BUS_HARNESS ?? "mcp").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(harness)) throw new Error(`Invalid --harness ${JSON.stringify(harness)}`);
  const folder = realFolder(process.cwd());
  if (isScratchFolder(folder)) {
    process.stderr.write(`[agent-hub] ${harness}: temporary-directory session does not join\n`);
    process.exit(0);
  }
  let server: UniversalMcpServer;
  const connection = new BusConnection({
    url: (arg("--url") ?? process.env.AGENT_BUS_URL ?? envBusUrl()).replace(/\/+$/, ""),
    host: os.hostname(),
    harness,
    path: folder,
    onDeliver: (delivery) => server.deliver(delivery),
    onReceipt: (receipt) => server.receipt(receipt),
    onJoined: (id) => process.stderr.write(`[agent-hub] joined as @${id}\n`),
    onLog: (line) => process.stderr.write(`[agent-hub] ${line}\n`),
  });
  server = new UniversalMcpServer(connection, harness);
  const stop = (): void => connection.close();
  serveStdio(server, stop);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.main) main();
