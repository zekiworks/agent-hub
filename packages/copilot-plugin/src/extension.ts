// GitHub Copilot extension: the Copilot CLI (and the Copilot app, which runs it) starts one extension process per
// foreground session. It joins the session's folder to the LAN message bus, serves the message-bus tool, and starts a
// turn for each message that wakes it (`session.send`; while a turn runs, the message steers it).
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLog, contentText } from "../../client/src/activity";
import { BusConnection, type Delivery } from "../../client/src/connection";
import { HeldQueue, UnseenSeqs } from "../../client/src/held";
import { realFolder } from "../../client/src/runtime";
import { StatusTracker } from "../../client/src/status";
import { BusTool, deliveryText, isScratchFolder, TOOL_NAME, toolDescription, toolInputSchema, type MessageBusToolParams } from "../../client/src/tool";
import { runTaskTool, TASK_TOOL_DESCRIPTION, TASK_TOOL_NAME, taskToolInputSchema, type TaskToolParams } from "../../client/src/task-tool";
import type { ReceiptEvent } from "../../protocol/src/types";
import type { CopilotSession, HookContext, JoinSession, SessionEvent } from "./copilot";

export interface ExtensionOptions {
  busUrl: string;
  folder?: string;
  log?: (line: string) => void;
}

const NOT_JOINING = "sessions in the temp directory and the Copilot app's own folders do not join";

const copilotHome = (): string => realFolder(process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"));
const inside = (folder: string, dir: string): boolean => folder === dir || folder.startsWith(dir + path.sep);

/** The Copilot app's internal sessions (probes, chats) run in its home; its worktrees there are real projects. */
function isCopilotInternal(folder: string): boolean {
  const home = copilotHome();
  return inside(folder, home) && !inside(folder, path.join(home, "copilot-worktrees"));
}

/**
 * The folder a session joins the bus as. The Copilot app puts each session in a worktree with a generated name,
 * `<copilot home>/copilot-worktrees/<repo>/<worktree>`: those join as `<repo>`, its worktrees being sessions of one agent.
 */
export function busFolder(folder: string): string {
  const worktrees = path.join(copilotHome(), "copilot-worktrees");
  if (!inside(folder, worktrees) || folder === worktrees) return folder;
  const repo = path.relative(worktrees, folder).split(path.sep)[0] as string;
  return path.join(worktrees, repo);
}

export class CopilotBinding {
  readonly conn: BusConnection;
  readonly tool: BusTool;
  private readonly unseen = new UnseenSeqs((seq) => this.conn.markSeen(seq));
  /** Quiet deliveries and receipt notices, handed over as added context at the next prompt or tool result. */
  private readonly held = new HeldQueue(this.unseen);
  private readonly status: StatusTracker;
  private readonly activity: ActivityLog;
  private session: CopilotSession | undefined;

  constructor(readonly folder: string, busUrl: string, private readonly log: (line: string) => void) {
    this.status = new StatusTracker(log);
    this.activity = new ActivityLog((events, replay) => this.conn.sendActivity(events, replay));
    this.conn = new BusConnection({
      url: busUrl,
      host: os.hostname(),
      harness: "copilot",
      path: busFolder(folder),
      onDeliver: (delivery) => this.deliver(delivery),
      onReceipt: (receipt) => this.receipt(receipt),
      onWatch: (on) => this.activity.setWatching(on),
      onJoined: (id) => log(`on the Hub as @${id} (${folder})`),
      onLog: log,
    });
    this.tool = new BusTool(this.conn);
  }

  /** Connects once the Copilot session exists, so every delivery can be handed to it. */
  attach(session: CopilotSession): void {
    this.session = session;
    session.on((event) => this.onEvent(event));
    this.status.attach(this.conn);
    this.conn.connect();
  }

  close(): void {
    this.status.detach();
    this.activity.dispose();
    this.conn.close();
  }

  async runTool(params: MessageBusToolParams): Promise<string> {
    if (!this.conn.id) throw new Error("Not connected to Agent Hub yet (still trying).");
    return this.tool.run(params, this.folder);
  }

  /** Held texts for a hook's added context. */
  context(): HookContext | undefined {
    const text = this.held.take();
    return text ? { additionalContext: text } : undefined;
  }

  private async deliver(delivery: Delivery): Promise<void> {
    const session = this.session;
    if (!session) throw new Error("Copilot session not ready");
    const text = await deliveryText(this.conn, delivery);
    const seq = delivery.message.seq;
    this.unseen.add(seq);
    if (!delivery.wake) {
      this.held.push({ text, seq, wake: false });
      return;
    }
    // Idle: starts a turn. Busy: steers the running turn at its next step. Seen once the user.message shows it.
    // Sent as the writer's, not the user's: a bus message never carries the user's authority (as in every other
    // binding; the SDK's `agent-<id>` source).
    await session.send({ prompt: text, mode: "immediate", source: `agent-${delivery.message.from}` });
  }

  private receipt(receipt: ReceiptEvent): void {
    const notice = this.tool.receiptNotice(receipt);
    if (notice) this.held.push({ text: notice, wake: false });
  }

  private onEvent(event: SessionEvent): void {
    if (event.agentId) return;
    const at = Date.parse(event.timestamp) || Date.now();
    const data = event.data;
    switch (event.type) {
      case "user.message": {
        const content = typeof data.content === "string" ? data.content : "";
        this.unseen.seenIn(content);
        this.status.setBusy();
        this.activity.user(at, content, event.id);
        break;
      }
      case "assistant.turn_start":
        this.status.setBusy();
        break;
      case "assistant.message": {
        const text = typeof data.content === "string" ? data.content : "";
        const thinking = typeof data.reasoningText === "string" ? data.reasoningText : "";
        if (text || thinking) this.activity.assistant(at, text, thinking, true, String(data.messageId ?? event.id));
        break;
      }
      case "tool.execution_start": {
        const id = String(data.toolCallId);
        this.status.toolStarted(id, String(data.toolName));
        this.activity.toolStart(id, String(data.toolName), data.arguments, undefined, at);
        break;
      }
      case "tool.execution_complete": {
        const id = String(data.toolCallId);
        this.status.toolEnded(id);
        const result = data.result as { content?: unknown } | undefined;
        const error = data.error as { message?: unknown } | undefined;
        this.activity.toolOutput(id,
          data.success ? contentText(result?.content ?? "") : String(error?.message ?? "failed"),
          data.success ? "done" : "error");
        break;
      }
      case "session.idle":
        this.status.setIdle();
        break;
      case "session.shutdown":
        this.close();
        break;
    }
  }
}

/** Joins the foreground Copilot session; the session's folder joins the bus unless it is a scratch folder. */
export async function start(joinSession: JoinSession, options: ExtensionOptions): Promise<CopilotBinding | undefined> {
  const log = options.log ?? (() => {});
  const folder = realFolder(options.folder ?? process.cwd());
  const skip = isScratchFolder(folder) || isCopilotInternal(folder);
  const binding = skip ? undefined : new CopilotBinding(folder, options.busUrl, log);

  const session = await joinSession({
    tools: [
      {
        name: TOOL_NAME,
        description: toolDescription({
          arrives: "a message for you starts a turn, or reaches the running one at its next step",
          notJoining: NOT_JOINING,
        }),
        parameters: toolInputSchema(),
        skipPermission: true,
        async handler(args) {
          if (!binding) throw new Error(`This session is not on Agent Hub: ${NOT_JOINING}.`);
          return binding.runTool(args as unknown as MessageBusToolParams);
        },
      },
      {
        name: TASK_TOOL_NAME,
        description: TASK_TOOL_DESCRIPTION,
        parameters: taskToolInputSchema(),
        skipPermission: true,
        async handler(args) {
          if (!binding) throw new Error(`This session is not on Agent Hub: ${NOT_JOINING}.`);
          return runTaskTool(binding.conn, args as unknown as TaskToolParams);
        },
      },
    ],
    hooks: {
      // Only the main agent's turns take held messages; a subagent's tool calls run these hooks too.
      onUserPromptSubmitted: async (input) => (input.agentId ? undefined : binding?.context()),
      onPostToolUse: async (input) => (input.agentId ? undefined : binding?.context()),
    },
  });

  if (!binding) {
    log(`not joining: ${folder}`);
    return undefined;
  }
  binding.attach(session);
  log(`Hub ${options.busUrl}, folder ${folder}, session ${session.sessionId}`);
  return binding;
}
