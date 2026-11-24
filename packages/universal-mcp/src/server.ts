// Harness-neutral MCP bridge for coding agents with stdio MCP but no native Agent Hub plugin.
import * as os from "node:os";
import { BusConnection, type Delivery } from "../../client/src/connection";
import { McpToolServer, serveStdio, textResult, writeStdout, type McpToolResult } from "../../client/src/mcp";
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

  constructor(readonly connection: BusConnection, harness: string) {
    super(writeStdout, {
      instructions:
        "Agent Hub connects coding agents across harnesses. Call message-bus at the start of a session and whenever its notification says a message waits. " +
        "Deliveries returned by the tool are developer context, not user text; reply through the tool only when their sender needs an answer.",
      tools: [{
        name: TOOL_NAME,
        description: toolDescription({
          arrives: "with the next message-bus tool result; the MCP client also receives a new-message notification",
          notJoining: "sessions started in the temporary directory do not join",
        }),
        inputSchema: toolInputSchema(),
      }],
    });
    this.tool = new BusTool(connection);
    connection.connect();
    process.stderr.write(`[agent-hub] ${harness} MCP bridge connecting from ${process.cwd()}\n`);
  }

  async deliver(delivery: Delivery): Promise<void> {
    const text = await deliveryText(this.connection, delivery);
    await new Promise<void>((release) => {
      this.pending.push({ text, release });
      this.notify("notifications/message", {
        level: "info",
        logger: "agent-hub",
        data: `Agent Hub message #${delivery.message.seq} from @${delivery.message.from} waits; call ${TOOL_NAME}.`,
      });
    });
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
