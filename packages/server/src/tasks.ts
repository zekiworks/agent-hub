// Tasks (Can, 15 Nov): a message marked as a task, for assignees who accept, finish or reject it; approvals are
// decided by people signed in with a passkey. The message is the task (its seq the id, its text what is asked, never
// edited); its state lives in Message.task. Each step is posted in the conversation as a reply to the task, so the other
// side learns it, and is woken for it when it is an agent.
import {
  type Conversation,
  type Message,
  type Task,
  type TaskActionRequest,
  type TaskState,
  type TaskType,
  type TasksResponse,
} from "@agent-bus/protocol";
import type { BusContext } from "./context";
import type { ParticipantRecord } from "./db";
import { mayRead } from "./conversations";
import { recipientsFor } from "./messages";
import { HttpError, readJsonObject } from "./http";

const TYPES: readonly TaskType[] = ["task", "approval", "chore"];
const MAX_REASON = 2000;
/** The outcome messages hold for offline agents as long as ordinary ones. */
const HOLD_MS = 3600_000;

/**
 * The task a new message carries, from the request's `task`: its assignees (given, else those the text @mentions,
 * else the other member of a DM) must be other members; approvals go to people only.
 */
export function newTask(
  ctx: BusContext,
  given: unknown,
  writer: ParticipantRecord,
  conversation: Conversation,
  mentioned: readonly string[]
): Task | undefined {
  if (given === undefined || given === null) return undefined;
  if (typeof given !== "object" || Array.isArray(given)) throw new HttpError(400, "task must be {type?, assignees?}");
  const { type = "task", assignees } = given as { type?: unknown; assignees?: unknown };
  if (typeof type !== "string" || !TYPES.includes(type as TaskType)) throw new HttpError(400, `task type must be one of ${TYPES.join(", ")}`);
  if (conversation.kind === "all") throw new HttpError(400, "Tasks go to a DM, group DM or project, not @all");
  let ids: string[];
  if (assignees !== undefined) {
    if (!Array.isArray(assignees) || !assignees.every((a) => typeof a === "string")) throw new HttpError(400, "task assignees must be participant ids");
    ids = assignees.map((a: string) => a.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
  } else {
    ids = mentioned.filter((id) => conversation.members.includes(id));
    if (ids.length === 0 && conversation.kind === "dm") ids = conversation.members.filter((id) => id !== writer.id);
  }
  ids = [...new Set(ids)];
  if (ids.length === 0) throw new HttpError(400, "Whose task is it? @mention them in the text or give task.assignees. Nothing was sent.");
  const outside = ids.filter((id) => id === writer.id || !conversation.members.includes(id));
  if (outside.length > 0) {
    throw new HttpError(400, `Task assignees are other members of the conversation; ${outside.map((id) => `@${id}`).join(", ")} ${outside.length > 1 ? "are" : "is"} not. Nothing was sent.`);
  }
  if (type === "approval") {
    const agents = ids.filter((id) => !ctx.hub.isHuman(id));
    if (agents.length > 0) throw new HttpError(400, `Approvals are decided by people; ${agents.map((id) => `@${id}`).join(", ")} ${agents.length > 1 ? "are agents" : "is an agent"}. Nothing was sent.`);
  }
  return { type: type as TaskType, assignees: ids.map((id) => ({ id, state: "open" as const })) };
}

function writerOf(ctx: BusContext, req: Request, body: Record<string, unknown>): { who: ParticipantRecord; verified: boolean | undefined } {
  if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
  const who = ctx.hub.knownParticipant(body.from.trim().toLowerCase());
  if (!who) throw new HttpError(400, `Unknown participant "${body.from}"`);
  return { who, verified: ctx.checkWriter(req, who) };
}

function taskMessage(ctx: BusContext, seq: number, reader: ParticipantRecord): { message: Message; conversation: Conversation; task: Task } {
  const message = ctx.db.getMessage(seq);
  const conversation = message ? ctx.db.getConversation(message.conversationId) : null;
  if (!message || !conversation || !mayRead(ctx, conversation, { id: reader.id, kind: reader.kind === "human" ? "human" : "agent" })) {
    throw new HttpError(404, `Unknown task #${seq}`);
  }
  if (!message.task) throw new HttpError(400, `#${seq} is not a task`);
  return { message, conversation, task: message.task };
}

/** The text of the step's message in the conversation (a reply to the task). */
function stepText(action: string, type: TaskType, reason: string | undefined): string {
  const word =
    action === "accept" ? "Accepted: on it." :
    action === "done" ? (type === "approval" ? "✓ Approved." : "✓ Done.") :
    action === "reject" ? (type === "approval" ? "✕ Denied." : "✕ Rejected.") :
    "Withdrawn.";
  return reason ? `${word} ${reason}` : word;
}

/** POST /api/tasks/:seq/:action with {from, reason?}: accept, done, reject (assignees), withdraw (its writer), read. */
export async function taskAction(ctx: BusContext, req: Request, seq: number, action: string): Promise<{ message: Message }> {
  const body = await readJsonObject(req);
  const { who, verified } = writerOf(ctx, req, body);
  const { message, conversation, task } = taskMessage(ctx, seq, who);
  const reason = (body as Partial<TaskActionRequest>).reason;
  if (reason !== undefined && (typeof reason !== "string" || reason.length > MAX_REASON)) {
    throw new HttpError(400, `reason must be text up to ${MAX_REASON} characters`);
  }
  const now = Date.now();
  const mine = task.assignees.find((a) => a.id === who.id);
  if (action === "read") {
    if (mine && mine.readAt === undefined) {
      mine.readAt = now;
      ctx.db.setTask(seq, task);
      publish(ctx, seq, conversation);
    }
    return { message: ctx.db.getMessage(seq) ?? message };
  }
  const live = (state: TaskState) => state === "open" || state === "accepted";
  let wake: string[] = [];
  if (action === "withdraw") {
    if (who.id !== message.from) throw new HttpError(403, `Only @${message.from}, who assigned it, withdraws #${seq}`);
    const open = task.assignees.filter((a) => live(a.state));
    if (open.length === 0) throw new HttpError(409, `#${seq} is not open for anyone`);
    for (const a of open) Object.assign(a, { state: "withdrawn", at: now, ...(reason ? { reason } : {}) });
    wake = open.map((a) => a.id);
  } else if (action === "accept" || action === "done" || action === "reject") {
    if (!mine) throw new HttpError(403, `#${seq} is not assigned to @${who.id}`);
    if (!live(mine.state)) throw new HttpError(409, `#${seq} is already ${mine.state} for @${who.id}`);
    if (action === "accept" && mine.state === "accepted") throw new HttpError(409, `#${seq} is already accepted`);
    // Approvals bind: only a person, from a signed-in session, decides one (Can, 15 Nov).
    if (task.type === "approval" && action !== "accept" && (who.kind !== "human" || verified !== true)) {
      throw new HttpError(403, "Approvals are decided by people signed in with a passkey");
    }
    const state: TaskState = action === "accept" ? "accepted" : action === "done" ? "done" : "rejected";
    mine.state = state;
    mine.at = now;
    mine.readAt ??= now;
    if (reason) mine.reason = reason;
    else delete mine.reason;
    if (verified !== undefined) mine.verified = verified;
    // Accepting only informs; a decision wakes the one who assigned it.
    if (action !== "accept") wake = [message.from];
  } else {
    throw new HttpError(404, `Unknown task action "${action}"`);
  }
  ctx.db.setTask(seq, task);
  // The step, as a reply to the task in its conversation: the other side reads it there and is woken by it.
  const recipients = recipientsFor(ctx, conversation, who.id).map((p) => p.id);
  const step = ctx.db.insertMessage({
    conversationId: conversation.id,
    from: who.id,
    fromKind: who.kind,
    text: stepText(action, task.type, reason),
    files: [],
    createdAt: now,
    recipients,
    expiresAt: now + HOLD_MS,
    replyToSeq: seq,
    wake: recipients.filter((id) => wake.includes(id)),
    ...(verified === undefined ? {} : { verified }),
  });
  const updated = ctx.db.getConversation(conversation.id) ?? conversation;
  ctx.hub.publishMessage(step, updated);
  publish(ctx, seq, updated);
  return { message: ctx.db.getMessage(seq) ?? message };
}

function publish(ctx: BusContext, seq: number, conversation: Conversation): void {
  const message = ctx.db.getMessage(seq);
  if (message) ctx.hub.taskChanged(message, conversation);
}

/**
 * GET /api/tasks?for=<id>&box=mine|assigned&state=open|all&limit=N. A person reads their own tasks (their session
 * decides, `for` is ignored); an agent token reads only those of its own agents, checked as writing as them is: `for`
 * picked whose tasks, and they were filtered by that participant's read rights, so any agent token could read the
 * tasks in a person's private conversations (Ümit #12750).
 */
export function getTasks(ctx: BusContext, req: Request, url: URL, viewer: string | undefined): TasksResponse {
  const id = (viewer ?? url.searchParams.get("for") ?? "").trim().toLowerCase();
  const who = ctx.hub.knownParticipant(id);
  if (!who) throw new HttpError(400, `Unknown participant "${id}" in for`);
  if (viewer === undefined) {
    if (who.kind === "human") throw new HttpError(403, `An agent token does not read @${who.id}'s tasks`);
    ctx.checkWriter(req, who);
  }
  const box = url.searchParams.get("box") ?? "mine";
  if (box !== "mine" && box !== "assigned") throw new HttpError(400, 'box must be "mine" or "assigned"');
  const state = url.searchParams.get("state") ?? "open";
  if (state !== "open" && state !== "all") throw new HttpError(400, 'state must be "open" or "all"');
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
  const reader = { id: who.id, kind: who.kind === "human" ? ("human" as const) : ("agent" as const) };
  const messages = ctx.db.tasksOf(who.id, box, state === "open", limit).filter((m) => {
    const conversation = ctx.db.getConversation(m.conversationId);
    return conversation !== null && mayRead(ctx, conversation, reader);
  });
  const ids = [...new Set(messages.map((m) => m.conversationId))];
  return {
    messages,
    conversations: ids.map((c) => ctx.db.getConversation(c)).filter((c): c is Conversation => c !== null),
    ...ctx.db.openTaskCounts(who.id),
  };
}
