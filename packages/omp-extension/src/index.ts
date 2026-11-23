// omp extension: joins the message bus as the session's project folder and exposes the `message-bus` tool
// (ops and texts in packages/client/src/tool.ts). Messages for this agent arrive like composer input:
// idle → a turn starts; busy → `aside`: at the next step of the running turn, without cutting a tool
// batch short, and ending a running `wait` (an agent waiting inside its turn for a bus reply would
// otherwise never see it); quiet (@all from other agents, unless `set all wake`) → added to the
// conversation at the next turn without starting one.
// Only the main session joins; subagents share the folder but are not bus participants.
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLog, contentText, contentThinking } from "../../client/src/activity";
import { BusConnection, type Delivery } from "../../client/src/connection";
import { UnseenSeqs } from "../../client/src/held";
import { envBusUrl } from "../../client/src/runtime";
import { StatusTracker } from "../../client/src/status";
import {
  BusTool,
  deliveryText,
  isScratchFolder,
  TOOL_NAME,
  TOOL_PARAMS,
  toolDescription,
  type MessageBusToolParams,
  type ToolField,
  type ToolParam,
} from "../../client/src/tool";
import { runTaskTool, TASK_TOOL_DESCRIPTION, TASK_TOOL_NAME, type TaskToolParams } from "../../client/src/task-tool";
import type { ReceiptEvent } from "../../protocol/src/types";

export { TOOL_NAME, type MessageBusToolParams };

interface ZodSchemaLike {
  optional(): ZodSchemaLike;
  describe(text: string): ZodSchemaLike;
}

/** The slice of omp's injected Zod-compatible builder (`pi.zod`) this extension uses. */
interface ZodLike {
  object(shape: Record<string, ZodSchemaLike>): ZodSchemaLike;
  string(): ZodSchemaLike;
  number(): ZodSchemaLike;
  enum(values: [string, ...string[]]): ZodSchemaLike;
  array(item: ZodSchemaLike): ZodSchemaLike;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}

/** The slice of omp's `ExtensionContext` used here (omp ships as a binary; no type package to import). */
export interface MessageBusContext {
  cwd: string;
  agent?: { kind: "main" | "sub" };
  isIdle(): boolean;
  /** Absent in some harness modes (and in tests): notices are best effort. */
  ui?: { notify(message: string, level: "info" | "warning" | "error"): void };
  /** Managed timer: a throw in the callback does not tear the session down. Absent in tests. */
  setTimeout?(fn: () => void, ms: number): unknown;
}

/** How long a new session may take to join before the user is told it is not on the bus. */
const JOIN_NOTICE_MS = 8000;

/** The slice of omp's `ExtensionAPI` used here. */
export interface MessageBusApi {
  zod: ZodLike;
  on(event: "session_start", handler: (event: unknown, ctx: MessageBusContext) => void): void;
  on(event: "session_shutdown", handler: () => void): void;
  /** Runs before every model request with the messages the model will get. */
  on(event: "context", handler: (event: { messages: unknown[] }) => void): void;
  on(event: "agent_start", handler: () => void): void;
  on(event: "agent_end", handler: (event: { willContinue?: boolean; awaitingAsyncWork?: boolean }) => void): void;
  on(
    event: "tool_execution_start",
    handler: (event: { toolCallId: string; toolName: string; args?: unknown; intent?: string }) => void
  ): void;
  on(event: "tool_execution_update", handler: (event: { toolCallId: string; partialResult?: { content?: unknown } }) => void): void;
  on(
    event: "tool_execution_end",
    handler: (event: { toolCallId: string; result?: { content?: unknown }; isError?: boolean }) => void
  ): void;
  on(
    event: "message_start" | "message_update" | "message_end",
    handler: (event: { message?: { role?: string; content?: unknown; timestamp?: number } }) => void
  ): void;
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: ZodSchemaLike;
    execute(
      toolCallId: string,
      params: MessageBusToolParams,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: MessageBusContext
    ): Promise<ToolResult>;
  }): void;
  sendUserMessage(content: string, options: { deliverAs?: "aside"; attribution: "agent" }): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; attribution: "agent" },
    options: { deliverAs: "nextTurn" }
  ): void;
}

/** The tool's parameters as an omp (zod) schema. */
function zodParameters(z: ZodLike): ZodSchemaLike {
  const scalar = (field: ToolParam | ToolField): ZodSchemaLike =>
    field.enum !== undefined ? z.enum(field.enum as unknown as [string, ...string[]]) : field.type === "number" ? z.number() : z.string();
  const one = (param: ToolParam): ZodSchemaLike => {
    const base =
      param.type === "string[]"
        ? z.array(z.string())
        : param.type === "object[]"
          ? z.array(z.object(Object.fromEntries((param.fields ?? []).map((f) => [f.name, (f.required ? scalar(f) : scalar(f).optional()).describe(f.description)]))))
          : scalar(param);
    return (param.name === "op" ? base : base.optional()).describe(param.description);
  };
  return z.object(Object.fromEntries(TOOL_PARAMS.map((param) => [param.name, one(param)])));
}

export default function messageBus(pi: MessageBusApi): void {
  let connection: BusConnection | undefined;
  let tool: BusTool | undefined;
  let sessionCtx: MessageBusContext | undefined;
  const log = (line: string): void => console.error(`[message-bus] ${line}`);

  const quietly = (content: string): void =>
    pi.sendMessage({ customType: TOOL_NAME, content, display: true, attribution: "agent" }, { deliverAs: "nextTurn" });

  const onReceipt = (receipt: ReceiptEvent): void => {
    const notice = tool?.receiptNotice(receipt);
    if (notice) quietly(notice);
  };

  /** Delivered seqs the model has not been given yet. */
  const unseen = new UnseenSeqs((seq) => connection?.markSeen(seq));

  const deliver = async (delivery: Delivery): Promise<void> => {
    const conn = connection;
    if (!conn?.id) throw new Error("delivery before join");
    const text = await deliveryText(conn, delivery);
    unseen.add(delivery.message.seq);
    if (!delivery.wake) quietly(text);
    else if (sessionCtx?.isIdle() ?? true) pi.sendUserMessage(text, { attribution: "agent" });
    else pi.sendUserMessage(text, { deliverAs: "aside", attribution: "agent" });
  };

  // A delivery is "seen" once its header is in what goes to the model (idle start, dequeued follow-up, or
  // a quiet message joining the next turn alike).
  pi.on("context", (event) => {
    if (connection && unseen.size > 0) unseen.seenIn(JSON.stringify(event.messages));
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.agent?.kind === "sub" || connection) return;
    const projectPath = path.resolve(ctx.cwd);
    if (isScratchFolder(projectPath)) {
      ctx.ui?.notify("message-bus: not joining (session started in the temp directory)", "info");
      return;
    }
    sessionCtx = ctx;
    const url = envBusUrl();
    let announced = false;
    let waitingForApproval = false;
    const conn = new BusConnection({
      url,
      host: os.hostname(),
      harness: "omp",
      path: projectPath,
      onDeliver: deliver,
      onReceipt,
      onWatch: (on) => activityLog.setWatching(on),
      onJoined: (id) => {
        if (announced) return;
        announced = true;
        ctx.ui?.notify(`message-bus: on the bus as @${id}`, "info");
      },
      onLog: log,
      onPending: (code) => {
        waitingForApproval = true;
        ctx.ui?.notify(`message-bus: waiting for a person to allow this machine (code ${code}, on the bus website)`, "warning");
      },
    });
    connection = conn;
    tool = new BusTool(conn);
    conn.connect();
    status.attach(conn);
    ctx.setTimeout?.(() => {
      if (connection !== conn || conn.connected || waitingForApproval) return;
      ctx.ui?.notify(
        `message-bus: cannot reach the bus at ${url} (still retrying). Check AGENT_BUS_URL and the network.`,
        "warning"
      );
    }, JOIN_NOTICE_MS);
  });

  // ---- Status for the bus (website, GET /api/state): idle/busy, running tool, latest intent. No model turns. ----
  const status = new StatusTracker(log);
  pi.on("agent_start", () => status.setBusy());
  pi.on("agent_end", (event) => {
    // A turn that ends with background work still running (a job, a watcher) comes as willContinue + awaitingAsyncWork:
    // the agent waits, it is idle for the bus, and a message starts a new turn. Kept busy, an agent with a long-lived
    // background job showed "busy" for a day (personal-assistant #12571: @turkce).
    if (!event.willContinue || event.awaitingAsyncWork) status.setIdle();
  });
  pi.on("tool_execution_start", (event) => {
    status.toolStarted(event.toolCallId, event.toolName, event.intent);
    if (connection) activityLog.toolStart(event.toolCallId, event.toolName, event.args, event.intent);
  });
  pi.on("tool_execution_end", (event) => {
    status.toolEnded(event.toolCallId);
    if (connection) activityLog.toolOutput(event.toolCallId, contentText(event.result?.content), event.isError ? "error" : "done");
  });

  // ---- Live output for whoever watches this agent's page on the website (sent only while watched). ----
  const activityLog = new ActivityLog((events, replay) => connection?.sendActivity(events, replay));
  pi.on("tool_execution_update", (event) => {
    if (connection) activityLog.toolOutput(event.toolCallId, contentText(event.partialResult?.content), "running");
  });
  const onMessage = (done: boolean) => (event: { message?: { role?: string; content?: unknown; timestamp?: number } }) => {
    const message = event.message;
    if (!connection || !message) return;
    const at = typeof message.timestamp === "number" ? message.timestamp : Date.now();
    if (message.role === "assistant") {
      activityLog.assistant(at, contentText(message.content), contentThinking(message.content), done);
    }
    else if (message.role === "user" && !done) activityLog.user(at, contentText(message.content));
  };
  pi.on("message_start", onMessage(false));
  pi.on("message_update", onMessage(false));
  pi.on("message_end", onMessage(true));

  pi.on("session_shutdown", () => {
    status.detach();
    activityLog.dispose();
    connection?.close();
    connection = undefined;
    tool = undefined;
    sessionCtx = undefined;
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Message bus",
    description: toolDescription({
      arrives: "after your current tool call finishes, and they end a running `wait`",
      notJoining: "sessions started in the temp directory do not join",
    }),
    parameters: zodParameters(pi.zod),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!tool) {
        throw new Error("This session is not on the message bus: subagents and sessions started in the temp directory do not join.");
      }
      return { content: [{ type: "text", text: await tool.run(params, ctx.cwd) }] };
    },
  });

  pi.registerTool({
    name: TASK_TOOL_NAME,
    label: "Tasks",
    description: TASK_TOOL_DESCRIPTION,
    parameters: pi.zod.object({
      op: pi.zod.enum(["create", "list", "mutate"]),
      conversation: pi.zod.string().optional().describe("create: @agent, #room or @@project"),
      to: pi.zod.array(pi.zod.string()).optional().describe("create: assignee ids"),
      text: pi.zod.string().optional().describe("create: what to do"),
      box: pi.zod.enum(["mine", "assigned"]).optional(),
      state: pi.zod.enum(["open", "all"]).optional(),
      message_id: pi.zod.number().optional(),
      action: pi.zod.enum(["accept", "progress", "done", "reject", "cancel"]).optional(),
      reason: pi.zod.string().optional(),
      note: pi.zod.string().optional(),
      eta: pi.zod.string().optional(),
    }),
    async execute(_toolCallId, params) {
      if (!connection) throw new Error("This session is not on the message bus.");
      return { content: [{ type: "text", text: await runTaskTool(connection, params as unknown as TaskToolParams) }] };
    },
  });
}
