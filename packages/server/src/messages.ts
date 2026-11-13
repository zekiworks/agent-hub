// Writing messages (recipients, holding for offline agents, replies that quote, the @resources notices) and the
// website's message reads: conversation pages and a message with its receipts.
import {
  ALL_CONVERSATION_ID,
  mentionedIds,
  RESOURCES_AGENT_ID,
  type Conversation,
  type FileRef,
  type Message,
  type MessagesResponse,
  type PostMessageResponse,
  type Receipt,
} from "@agent-bus/protocol";
import type { BusContext } from "./context";
import { DEFAULT_HOLD_MS, type ParticipantRecord } from "./db";
import { HttpError, readJsonObject } from "./http";

const MAX_TEXT_LENGTH = 100_000;
/** The longest a writer may have a message held for offline recipients. */
const MAX_HOLD_HOURS = 168;
/** @resources notices wait longer: a holder offline for an hour still needs to hear that its hold expired. */
const NOTICE_HOLD_MS = 24 * 3600_000;

/** `text` without a leading "<id>:" / "@<id> –" naming the writer itself (any case, `:`, `-` or `–`). */
export function withoutOwnName(text: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^\\s*@?${escaped}\\s*[:\\-–—]\\s+`, "i"), "");
}

export const MAX_RECEIPT_WAIT_MS = 30_000;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

/** Earlier messages a newly invited agent gets before the message that mentions it. */
const INVITE_CONTEXT_MESSAGES = 5;

/** Participants @mentioned in `text` (`@id-n` counts as agent `id`); unknown names and "@all" are left out. */
function mentionedParticipants(ctx: BusContext, text: string): string[] {
  const ids: string[] = [];
  for (const mention of mentionedIds(text)) {
    const session = /^(.+)-(\d+)$/.exec(mention)?.[1];
    const id = ctx.hub.knownParticipant(mention) ? mention : session && ctx.hub.knownParticipant(session)?.kind === "agent" ? session : undefined;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Agents a new message goes to: every agent for `all`, the addressed agents of a group; never the writer. */
function recipientsFor(ctx: BusContext, conversation: Conversation, writerId: string): ParticipantRecord[] {
  return (
    conversation.kind === "all"
      ? ctx.db.listAgents()
      : conversation.addressed
          .map((id) => ctx.db.getParticipant(id))
          .filter((p): p is ParticipantRecord => p !== null && p.kind === "agent")
  ).filter((p) => p.id !== writerId);
}

/**
 * POST /api/messages {from, to | conversationId | replyToSeq, text, fileIds?, toSession?, holdHours?}. Agents that
 * are offline get it when they come back, within `holdHours` (default 1); after that it expires for them.
 */
export async function postMessage(ctx: BusContext, req: Request): Promise<PostMessageResponse> {
  const { db, hub } = ctx;
  const body = await readJsonObject(req);
  if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
  const writer = hub.knownParticipant(body.from.trim().toLowerCase());
  if (!writer) {
    throw new HttpError(400, `Unknown participant "${body.from}". Known ids: ${hub.knownIds().join(", ")}`);
  }
  const verified = ctx.checkWriter(req, writer);
  // A reply goes to the conversation of the message it answers (then it is a conversationId post) and quotes it.
  let replyToSeq: number | undefined;
  if (body.replyToSeq !== undefined && body.replyToSeq !== null) {
    if (typeof body.replyToSeq !== "number" || !Number.isSafeInteger(body.replyToSeq)) {
      throw new HttpError(400, "replyToSeq must be a message number");
    }
    if (body.to != null || body.conversationId != null) {
      throw new HttpError(400, "Give exactly one of to, conversationId or replyToSeq");
    }
    const original = db.getMessage(body.replyToSeq);
    if (!original) throw new HttpError(404, `Unknown message #${body.replyToSeq}`);
    body.conversationId = original.conversationId;
    replyToSeq = original.seq;
  }
  const hasTo = body.to !== undefined && body.to !== null;
  const hasConversation = body.conversationId !== undefined && body.conversationId !== null;
  if (hasTo === hasConversation) throw new HttpError(400, "Give exactly one of to, conversationId or replyToSeq");

  if (body.text !== undefined && typeof body.text !== "string") throw new HttpError(400, "text must be a string");
  // The bus shows every message's sender; agents that start with their own name ("logic: …") only repeat it.
  const text = writer.kind === "agent" ? withoutOwnName(body.text ?? "", writer.id) : (body.text ?? "");
  if (text.length > MAX_TEXT_LENGTH) {
    throw new HttpError(400, `text is longer than ${MAX_TEXT_LENGTH} characters`);
  }
  const fileIds = body.fileIds ?? [];
  if (!Array.isArray(fileIds) || !fileIds.every((id): id is string => typeof id === "string")) {
    throw new HttpError(400, "fileIds must be an array of file ids");
  }
  const files: FileRef[] = [];
  for (const fileId of fileIds) {
    const file = db.getFile(fileId);
    if (!file) throw new HttpError(400, `Unknown file "${fileId}"`);
    files.push(file);
  }
  if (text.trim() === "" && files.length === 0) throw new HttpError(400, "text is required");

  const now = Date.now();
  /** Sessions the writer chose: `@id-n` in `to`, or `toSession` (the website's picker) in a one-agent conversation. */
  let sessions = new Map<string, number>();
  let conversation: Conversation;
  if (hasTo) {
    if (typeof body.to !== "string") throw new HttpError(400, "to must be an address string");
    const parsed = ctx.knownAddress(body.to);
    sessions = parsed.sessions;
    if (parsed.kind === "all") {
      const all = db.getConversation(ALL_CONVERSATION_ID);
      if (!all) throw new Error("The all conversation is missing");
      conversation = all;
    } else {
      const addressed = Array.from(new Set([writer.id, ...parsed.ids])).sort();
      if (addressed.length < 2) throw new HttpError(400, "Cannot write only to yourself");
      conversation = db.getOrCreateGroup(addressed, now);
    }
  } else {
    if (typeof body.conversationId !== "string") throw new HttpError(400, "conversationId must be a string");
    const existing = db.getConversation(body.conversationId);
    if (!existing) throw new HttpError(404, `Unknown conversation "${body.conversationId}"`);
    conversation = existing;
    if (conversation.kind === "group") {
      // Agents forgotten after a long time offline cannot be held for: they have no record to come back to.
      const gone = conversation.addressed.filter((id) => !hub.knownParticipant(id));
      if (gone.length > 0) {
        throw new HttpError(409, `${gone.map((id) => `@${id}`).join(", ")} ${gone.length > 1 ? "are" : "is"} no longer on the bus (forgotten after a long time offline). Nothing was sent.`);
      }
      if (writer.kind === "agent" && !conversation.members.includes(writer.id)) {
        throw new HttpError(403, `${writer.id} is not in conversation ${conversation.id}`);
      }
      if (writer.kind === "human" && !conversation.members.includes(writer.id)) {
        db.addMember(conversation.id, writer.id);
      }
    }
  }
  // Mentioning someone who is not in a group invites them: they join it (agents change its thread; a group that
  // already had the new set is merged into this one) and new agents first get the last messages as context.
  let merged: string | undefined;
  if (conversation.kind === "group") {
    const newcomers = mentionedParticipants(ctx, text).filter((id) => id !== writer.id && !conversation.addressed.includes(id));
    if (newcomers.length > 0) {
      const invited = db.inviteToGroup(conversation.id, newcomers);
      conversation = invited.conversation;
      merged = invited.merged;
      for (const id of newcomers) {
        const agent = db.getParticipant(id);
        if (agent?.kind !== "agent") continue;
        for (const earlier of db.addContextReceipts(conversation.id, id, INVITE_CONTEXT_MESSAGES)) {
          hub.deliver(hub.deliveryTargets(id), earlier, conversation, agent);
        }
      }
    }
  }
  // A reply to a message one session of an agent wrote goes back to that session.
  if (replyToSeq !== undefined) {
    const original = db.getMessage(replyToSeq);
    if (original?.fromSession !== undefined && original.from !== writer.id && !sessions.has(original.from)) {
      sessions.set(original.from, original.fromSession);
    }
  }
  if (body.toSession !== undefined && body.toSession !== null) {
    const agents = conversation.addressed.filter((id) => id !== writer.id && !hub.isHuman(id));
    if (typeof body.toSession !== "number" || !Number.isSafeInteger(body.toSession) || body.toSession < 1) {
      throw new HttpError(400, "toSession must be a session number");
    }
    if (conversation.kind !== "group" || agents.length !== 1 || !agents[0]) {
      throw new HttpError(400, "toSession is for a conversation with one agent");
    }
    sessions.set(agents[0], body.toSession);
  }
  // The writing agent's session (its harness sends X-Agent-Session): it is now the active one, and is named on the
  // message while the agent has several.
  let fromSession: number | undefined;
  const writerSession = writer.kind === "agent" ? req.headers.get("x-agent-session") : null;
  if (writerSession) {
    hub.touchSession(writer.id, writerSession);
    if (hub.sessionsOf(writer.id).length > 1) fromSession = hub.liveSessionNumber(writer.id, writerSession);
  }
  let holdMs = DEFAULT_HOLD_MS;
  if (body.holdHours !== undefined && body.holdHours !== null) {
    if (typeof body.holdHours !== "number" || !(body.holdHours > 0) || body.holdHours > MAX_HOLD_HOURS) {
      throw new HttpError(400, `holdHours must be a number of hours above 0 and at most ${MAX_HOLD_HOURS}`);
    }
    holdMs = body.holdHours * 3600_000;
  }

  const message = db.insertMessage({
    conversationId: conversation.id,
    from: writer.id,
    fromKind: writer.kind,
    text,
    files,
    createdAt: now,
    // Every agent of the conversation (for @all, every agent): the online ones get it now, the offline ones when they
    // are back, until it expires.
    recipients: recipientsFor(ctx, conversation, writer.id).map((p) => p.id),
    expiresAt: now + holdMs,
    replyToSeq,
    ...(sessions.size > 0 ? { sessions } : {}),
    ...(fromSession === undefined ? {} : { fromSession }),
    ...(verified === undefined ? {} : { verified }),
  });
  if (writer.kind === "human") db.touchParticipant(writer.id, now);
  const updated = db.getConversation(conversation.id);
  if (!updated) throw new Error(`Conversation ${conversation.id} vanished`);
  hub.publishMessage(message, updated, merged);
  return { message, conversation: updated };
}

/** A notice from @resources to one holder, in their own conversation with it (an agent's turn starts, as for a DM). */
export function postResourcesNotice(ctx: BusContext, holder: string, text: string): void {
  const { db } = ctx;
  const recipient = db.getParticipant(holder);
  if (!recipient) return;
  const writer = db.ensureBuiltInAgent(RESOURCES_AGENT_ID, "bus");
  const now = Date.now();
  const conversation = db.getOrCreateGroup([writer.id, holder], now);
  const message = db.insertMessage({
    conversationId: conversation.id,
    from: writer.id,
    fromKind: "agent",
    text,
    files: [],
    createdAt: now,
    recipients: recipientsFor(ctx, conversation, writer.id).map((p) => p.id),
    expiresAt: now + NOTICE_HOLD_MS,
  });
  ctx.hub.publishMessage(message, db.getConversation(conversation.id) ?? conversation);
}

/** GET /api/conversations/:id/messages?beforeSeq=&limit= (the website's pages). */
export function getMessages(ctx: BusContext, conversationId: string, url: URL): MessagesResponse {
  const conversation = ctx.db.getConversation(conversationId);
  if (!conversation) {
    throw new HttpError(404, `Unknown conversation "${conversationId}"`);
  }
  const parseIntParam = (key: string): number | null => {
    const raw = url.searchParams.get(key);
    if (raw === null || raw === "") return null;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new HttpError(400, `${key} must be a positive integer`);
    }
    return value;
  };
  const beforeSeq = parseIntParam("beforeSeq");
  const limit = Math.min(parseIntParam("limit") ?? DEFAULT_PAGE, MAX_PAGE);
  return { messages: ctx.db.listMessages(conversation.id, beforeSeq, limit) };
}

/**
 * GET /api/messages/:seq: the message with its receipts and its conversation; with `waitMs`, first waits (≤ 30 s)
 * until every recipient has it (`until=delivered`, default) or has seen it (`until=seen`).
 */
export async function getMessageReceipts(
  ctx: BusContext,
  seq: number,
  url: URL
): Promise<{ message: Message; conversation: Conversation }> {
  const current = ctx.db.getMessage(seq);
  if (!current) throw new HttpError(404, `Unknown message ${seq}`);
  const withConversation = (message: Message): { message: Message; conversation: Conversation } => {
    const conversation = ctx.db.getConversation(message.conversationId);
    if (!conversation) throw new Error(`Conversation ${message.conversationId} of message ${seq} is missing`);
    return { message, conversation };
  };
  const until = url.searchParams.get("until") ?? "delivered";
  if (until !== "delivered" && until !== "seen") throw new HttpError(400, 'until must be "delivered" or "seen"');
  const done = until === "seen" ? (r: Receipt) => r.seenAt !== null : (r: Receipt) => r.deliveredAt !== null;
  const waitMs = Math.min(Math.max(Number(url.searchParams.get("waitMs") ?? 0) || 0, 0), MAX_RECEIPT_WAIT_MS);
  if (waitMs === 0 || current.receipts.every(done)) return withConversation(current);
  await ctx.hub.waitForReceipts(seq, done, waitMs);
  const latest = ctx.db.getMessage(seq);
  if (!latest) throw new HttpError(404, `Unknown message ${seq}`);
  return withConversation(latest);
}
