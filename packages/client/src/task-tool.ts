import { titledLabel } from "../../protocol/src/address";
import type { Conversation, Message } from "../../protocol/src/types";
import type { BusConnection } from "./connection";

export const TASK_TOOL_NAME = "task";

export interface TaskToolParams {
  op: "create" | "list" | "mutate";
  conversation?: string;
  to?: string[];
  text?: string;
  box?: "mine" | "assigned";
  state?: "open" | "all";
  message_id?: number;
  action?: "accept" | "progress" | "done" | "reject" | "cancel";
  reason?: string;
  note?: string;
  eta?: string;
}

export const TASK_TOOL_DESCRIPTION =
  "Tasks on Agent Hub. create posts a task in a conversation; list shows tasks for you or assigned by you; mutate accepts, reports progress, finishes, rejects, or cancels a task message.";

export function taskToolInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      op: { type: "string", enum: ["create", "list", "mutate"] },
      conversation: { type: "string", description: 'create: where to post, e.g. "@agent", "#room" or "@@project"' },
      to: { type: "array", items: { type: "string" }, description: "create: assignee ids without @" },
      text: { type: "string", description: "create: what to do" },
      box: { type: "string", enum: ["mine", "assigned"], description: "list: tasks for you or assigned by you" },
      state: { type: "string", enum: ["open", "all"], description: "list: open only (default) or all" },
      message_id: { type: "integer", description: "mutate: task message number" },
      action: { type: "string", enum: ["accept", "progress", "done", "reject", "cancel"] },
      reason: { type: "string", description: "reject/cancel/done: optional reason or result" },
      note: { type: "string", description: "progress: required progress note" },
      eta: { type: "string", description: "progress: optional ETA" },
    },
    required: ["op"],
    additionalProperties: false,
  };
}

function states(message: Message): string {
  return message.task?.assignees.map((assignee) => `@${assignee.id}: ${assignee.state}${assignee.reason ? ` (${assignee.reason})` : ""}`).join("; ") ?? "";
}

function line(message: Message, conversation: Conversation | undefined): string {
  const text = message.text.replace(/\s+/g, " ").trim();
  return `#${message.seq} from @${message.from} in ${conversation ? titledLabel(conversation) : message.conversationId}: ${text.length > 160 ? `${text.slice(0, 159)}…` : text} — ${states(message)}`;
}

export async function runTaskTool(conn: BusConnection, params: TaskToolParams): Promise<string> {
  if (params.op === "create") {
    if (!params.conversation || !params.to?.length || !params.text?.trim()) throw new Error("task create needs conversation, to, and text");
    const result = await conn.write({ to: params.conversation }, params.text, {
      wake: [],
      task: { type: "task", assignees: params.to },
    });
    return `Created task #${result.message.seq} for ${params.to.map((id) => `@${id}`).join(", ")} in ${titledLabel(result.conversation)}.`;
  }
  if (params.op === "list") {
    const result = await conn.tasks(params.box ?? "mine", params.state ?? "open");
    const heading = params.box === "assigned" ? `${result.messages.length} task(s) you assigned` : `${result.open} open task(s) for you`;
    if (result.messages.length === 0) return `${heading}.`;
    const conversations = new Map(result.conversations.map((conversation) => [conversation.id, conversation]));
    return `${heading}:\n\n${result.messages.map((message) => line(message, conversations.get(message.conversationId))).join("\n")}`;
  }
  if (params.op === "mutate") {
    if (!params.message_id || !params.action) throw new Error("task mutate needs message_id and action");
    const result = await conn.extensionAction("task", params.message_id, params.action, {
      reason: params.reason,
      note: params.note,
      eta: params.eta,
    });
    return `#${params.message_id} ${params.action}: ${states(result.message)}.`;
  }
  throw new Error(`Unknown task op "${String((params as { op?: unknown }).op)}"`);
}
