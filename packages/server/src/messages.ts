// Writing messages (recipients, holding for offline agents, replies that quote, the @resources notices) and the
// website's message reads: conversation pages and a message with its receipts.
import {
  ALL_CONVERSATION_ID,
  mentionedIds,
  mentions,
  RESOURCES_AGENT_ID,
  type Conversation,
  type FileRef,
  type Message,
  type MessagesResponse,
  type SharedFilesResponse,
  type PostMessageResponse,
  type Receipt,
} from "@agent-bus/protocol";
import type { BusContext } from "./context";
import { addMembers, canRead, canSee, checkedProjectName, leave, mayRead, type Reader } from "./conversations";
import { DEFAULT_HOLD_MS, type ParticipantRecord } from "./db";
import { newTask } from "./tasks";
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

/** Agents a new message goes to: every agent for `all`, else the conversation's agents; never the writer. */
export function recipientsFor(ctx: BusContext, conversation: Conversation, writerId: string): ParticipantRecord[] {
  return (
    conversation.kind === "all"
      ? ctx.db.listAgents()
      : conversation.members
          .map((id) => ctx.db.getParticipant(id))
          .filter((p): p is ParticipantRecord => p !== null && p.kind === "agent")
  ).filter((p) => p.id !== writerId);
}

/**
 * The conversation `to` names for `writer`: "@all"; "@x" the writer's DM with x; "@{a,b}" with the writer, two
 * members a DM, more a group DM (the one with exactly these members, else a new one); "@@name" a project, created
 * (open) if there is none, joined if open.
 */
/**
 * The root project `name` of "@{@@name,a,b}", which `writer` must be able to see. Groups go under root projects only
 * (one level), so a sub-project's name is refused with the reason.
 */
export function rootProjectFor(ctx: BusContext, writer: ParticipantRecord, name: string): Conversation {
  const project = ctx.db.projectByName(name);
  if (!project || !canSee(ctx, project, { id: writer.id, kind: writer.kind === "human" ? "human" : "agent" })) {
    throw new HttpError(404, `No project "@@${name}"`);
  }
  if (project.parentId) throw new HttpError(409, `@@${name} is itself under a project; groups go under root projects`);
  return project;
}

function conversationFor(ctx: BusContext, writer: ParticipantRecord, parsed: ReturnType<BusContext["knownAddress"]>, now: number): Conversation {
  const { db } = ctx;
  if (parsed.kind === "all") {
    const all = db.getConversation(ALL_CONVERSATION_ID);
    if (!all) throw new Error("The all conversation is missing");
    return all;
  }
  if (parsed.kind === "project") {
    const existing = db.projectByName(parsed.name);
    // Checked only when creating: anyone may write to (and join) an existing open project, e.g. @@compactor.
    const name = existing ? parsed.name : checkedProjectName(ctx, parsed.name, writer.id);
    const project = existing ?? null;
    if (!project) return db.createProject(name, writer.id, now);
    if (!project.members.includes(writer.id)) {
      if (project.visibility !== "open") throw new HttpError(403, `Project "${name}" is not open: ask a member to add @${writer.id}`);
      return addMembers(ctx, project, [writer.id]);
    }
    return project;
  }
  const ids = Array.from(new Set([writer.id, ...parsed.ids]));
  if (ids.length < 2) throw new HttpError(400, "Cannot write only to yourself");
  if (parsed.project) return db.groupUnder(rootProjectFor(ctx, writer, parsed.project).id, ids, now);
  const [a, b] = ids;
  return ids.length === 2 && a && b ? db.dmOf(a, b, now) : db.groupDmOf(ids, now);
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
    conversation = conversationFor(ctx, writer, parsed, now);
  } else {
    if (typeof body.conversationId !== "string") throw new HttpError(400, "conversationId must be a string");
    const existing = db.getConversation(body.conversationId);
    if (!existing) throw new HttpError(404, `Unknown conversation "${body.conversationId}"`);
    conversation = existing;
    // A person answering a DM between others (people may read agents' DMs; its members are fixed) writes in the group
    // DM of its members and them, made if new; a reply keeps its quote (Can, 15 Nov).
    if (conversation.kind === "dm" && writer.kind === "human" && !conversation.members.includes(writer.id)) {
      if (!canRead(ctx, conversation, writer)) throw new HttpError(404, `Unknown conversation "${conversation.id}"`);
      conversation = db.groupDmOf([writer.id, ...conversation.members], now);
    }
    if (conversation.kind !== "all" && !conversation.members.includes(writer.id)) {
      // A person may join a group DM or project they can read; an agent only an open project.
      const joinable =
        (conversation.kind === "project" && conversation.visibility === "open") ||
        (writer.kind === "human" && conversation.kind !== "dm" && canRead(ctx, conversation, writer));
      if (!joinable) {
        throw new HttpError(
          403,
          conversation.kind === "dm"
            ? `@${writer.id} is not in this DM: start a group DM or a project with its members`
            : `@${writer.id} is not in ${conversation.id}: ask a member to add you`
        );
      }
      conversation = addMembers(ctx, conversation, [writer.id]);
    }
  }
  if (conversation.kind !== "all") {
    // Agents forgotten after a long time offline cannot be held for: they have no record to come back to.
    const gone = conversation.members.filter((id) => !hub.knownParticipant(id));
    if (gone.length > 0 && conversation.kind === "dm") {
      throw new HttpError(409, `@${gone[0]} is no longer on the bus (forgotten after a long time offline). Nothing was sent.`);
    }
  }
  if (conversation.archived) {
    // Archived for being quiet: any member's message brings it back. Archived by a person: agents wait for a person.
    if (writer.kind !== "human" && !conversation.archivedIdle) {
      throw new HttpError(409, `${conversation.name ? `Project "${conversation.name}"` : `Conversation ${conversation.id}`} is archived; a person can bring it back by writing in it`);
    }
    db.setArchived(conversation.id, false);
    hub.conversationsChanged();
  }
  // "exit" alone, from an agent in a group DM or project: it leaves (people have the website's Leave button).
  const leavable = conversation.kind === "group" || conversation.kind === "project";
  if (leavable && writer.kind === "agent" && text.trim().toLowerCase() === "exit" && files.length === 0) {
    const left = leave(ctx, conversation, writer.id);
    const message = db.insertMessage({
      conversationId: left.id,
      from: writer.id,
      fromKind: writer.kind,
      text: "(left the conversation)",
      files: [],
      createdAt: now,
      recipients: [],
      expiresAt: now,
    });
    hub.publishMessage(message, left);
    return { message, conversation: left };
  }
  // A person can add whoever they @mention (the website asks first: "Add and send" or "Send only").
  let newcomers: string[] = [];
  if (body.addMentioned === true && writer.kind === "human") {
    newcomers = mentionedParticipants(ctx, text).filter((id) => !conversation.members.includes(id));
    if (newcomers.length > 0) conversation = addMembers(ctx, conversation, newcomers);
  }
  // A reply to a message one session of an agent wrote goes back to that session.
  if (replyToSeq !== undefined) {
    const original = db.getMessage(replyToSeq);
    if (original?.fromSession !== undefined && original.from !== writer.id && !sessions.has(original.from)) {
      sessions.set(original.from, original.fromSession);
    }
  }
  if (body.toSession !== undefined && body.toSession !== null) {
    const agents = conversation.members.filter((id) => id !== writer.id && !hub.isHuman(id));
    if (typeof body.toSession !== "number" || !Number.isSafeInteger(body.toSession) || body.toSession < 1) {
      throw new HttpError(400, "toSession must be a session number");
    }
    if (conversation.kind === "all" || agents.length !== 1 || !agents[0]) {
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

  // Every agent of the conversation (for @all, every agent): the online ones get it now, the offline ones when they are
  // back, until it expires. Only those on the wake list get a turn for it.
  const recipients = recipientsFor(ctx, conversation, writer.id).map((p) => p.id);
  const task = newTask(ctx, body.task, writer, conversation, mentionedIds(text));
  const listed = wakeList(ctx, writer, body.wake, conversation, recipients, text, replyToSeq, newcomers);
  // A task wakes the agents it is assigned to.
  const assigned = task ? task.assignees.map((a) => a.id).filter((id) => recipients.includes(id)) : [];
  const wake = listed && assigned.length > 0 ? [...new Set([...listed, ...assigned])] : listed;
  const message = db.insertMessage({
    conversationId: conversation.id,
    from: writer.id,
    fromKind: writer.kind,
    text,
    files,
    createdAt: now,
    recipients,
    expiresAt: now + holdMs,
    replyToSeq,
    ...(sessions.size > 0 ? { sessions } : {}),
    ...(fromSession === undefined ? {} : { fromSession }),
    ...(verified === undefined ? {} : { verified }),
    ...(wake ? { wake } : {}),
    ...(task ? { task } : {}),
  });
  if (writer.kind === "human") db.touchParticipant(writer.id, now);
  const updated = db.getConversation(conversation.id);
  if (!updated) throw new Error(`Conversation ${conversation.id} vanished`);
  hub.publishMessage(message, updated);
  const warnings = writer.kind === "agent" ? [...unreadableRefs(ctx, text, updated), ...unwokenMentions(text, recipients, wake)] : [];
  return { message, conversation: updated, ...(warnings.length > 0 ? { warnings } : {}) };
}

/**
 * The agents a message wakes (Can, 15 Nov): one agent, the best placed, decides who acts next. A person's: in a DM, its
 * agent. Elsewhere the agents it @mentions, plus the agent it answers (the author of the message replied to, else of the
 * previous message by someone else) when it mentions none or calls in an agent new to the conversation (who lacks the
 * context the answered one has); where nobody else has written yet, all its agents. An agent's: the agent it replies
 * to (replyToSeq) and its list, members only; list left out (an older tool): undefined, the old rule.
 */
function wakeList(
  ctx: BusContext,
  writer: ParticipantRecord,
  given: unknown,
  conversation: Conversation,
  recipients: string[],
  text: string,
  replyToSeq: number | undefined,
  newcomers: readonly string[]
): string[] | undefined {
  if (writer.kind === "human") {
    if (conversation.kind === "dm") return recipients;
    const answered = replyToSeq !== undefined ? ctx.db.getMessage(replyToSeq)?.from : ctx.db.lastAuthorBesides(conversation.id, writer.id);
    if (answered === undefined) return recipients; // a conversation started with them: they are meant
    // "@all" in a person's text wakes every agent of the conversation (Can, 15 Nov).
    if (mentionedIds(text).includes(ALL_CONVERSATION_ID)) return recipients;
    const mentioned = recipients.filter((id) => mentions(text, id));
    const withAnswered = mentioned.length === 0 || mentioned.some((id) => newcomers.includes(id));
    return recipients.filter((id) => mentioned.includes(id) || (withAnswered && id === answered));
  }
  if (given === undefined || given === null) return undefined;
  if (!Array.isArray(given) || !given.every((id) => typeof id === "string")) throw new HttpError(400, "wake must be a list of agent ids");
  const wake = [...new Set(given.map((id: string) => id.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))];
  const outside = wake.filter((id) => !recipients.includes(id));
  if (outside.length > 0) {
    throw new HttpError(
      400,
      `wake names agents of this conversation; ${outside.map((id) => `@${id}`).join(", ")} ${outside.length > 1 ? "are" : "is"} not one (or a person, or you). Nothing was sent.`
    );
  }
  const repliedTo = replyToSeq !== undefined ? ctx.db.getMessage(replyToSeq)?.from : undefined;
  return repliedTo && recipients.includes(repliedTo) && !wake.includes(repliedTo) ? [repliedTo, ...wake] : wake;
}

/** An agent @mentions an agent its wake list leaves out: said, since the mention alone wakes nobody. */
function unwokenMentions(text: string, recipients: string[], wake: string[] | undefined): string[] {
  if (!wake) return [];
  return recipients
    .filter((id) => !wake.includes(id) && mentions(text, id))
    .map((id) => `@${id} is mentioned but not in wake: it reads this at its next turn, no turn now`);
}

/** "#n" message references, as the website links them (ui/text.ts REF_RE). */
const REF_RE = /(^|[^\w#&])#(\d{1,7})(?!\w)/g;

/**
 * The `#n` in `text` that a person of `conversation` cannot open, as warnings for the agent that wrote them: the
 * website answers such a link with an error, and the person would have to chase it (Can, 15 Nov).
 */
function unreadableRefs(ctx: BusContext, text: string, conversation: Conversation): string[] {
  const people = conversation.kind === "all" ? ctx.humans : conversation.members.filter((id) => ctx.hub.isHuman(id));
  if (people.length === 0) return [];
  const warnings: string[] = [];
  for (const seq of new Set([...text.matchAll(REF_RE)].map((m) => Number(m[2])))) {
    const ref = ctx.db.getMessage(seq);
    const where = ref ? ctx.db.getConversation(ref.conversationId) : null;
    if (!where) continue;
    const blind = people.filter((id) => !mayRead(ctx, where, { id, kind: "human" }));
    if (blind.length > 0) {
      warnings.push(`${blind.map((id) => `@${id}`).join(", ")} cannot open #${seq} (it is in a conversation they are not in): quote what it says instead`);
    }
  }
  return warnings;
}

/** A notice from @resources to one holder, in their own conversation with it (an agent's turn starts, as for a DM). */
export function postResourcesNotice(ctx: BusContext, holder: string, text: string): void {
  const { db } = ctx;
  const recipient = db.getParticipant(holder);
  if (!recipient) return;
  const writer = db.ensureBuiltInAgent(RESOURCES_AGENT_ID, "bus");
  const now = Date.now();
  const conversation = db.dmOf(writer.id, holder, now);
  const recipients = recipientsFor(ctx, conversation, writer.id).map((p) => p.id);
  const message = db.insertMessage({
    conversationId: conversation.id,
    from: writer.id,
    fromKind: "agent",
    text,
    files: [],
    createdAt: now,
    recipients,
    expiresAt: now + NOTICE_HOLD_MS,
    wake: recipients, // the holder must act on it (wake lists, Can 15 Nov)
  });
  ctx.hub.publishMessage(message, db.getConversation(conversation.id) ?? conversation);
}

/** GET /api/conversations/:id/messages?beforeSeq=&limit= (the website's pages). */
/** Most files listed per conversation. */
const MAX_SHARED_FILES = 500;

/** GET /api/conversations/:id/files, for whoever may read the conversation. */
export function getSharedFiles(ctx: BusContext, conversationId: string, reader: Reader): SharedFilesResponse {
  const conversation = ctx.db.getConversation(conversationId);
  if (!conversation || !mayRead(ctx, conversation, reader)) {
    throw new HttpError(404, `Unknown conversation "${conversationId}"`);
  }
  return { files: ctx.db.sharedFiles(conversation.id, MAX_SHARED_FILES) };
}

export function getMessages(
  ctx: BusContext,
  conversationId: string,
  url: URL,
  reader: Reader
): MessagesResponse {
  const conversation = ctx.db.getConversation(conversationId);
  if (!conversation || !mayRead(ctx, conversation, reader)) {
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
  url: URL,
  reader: Reader
): Promise<{ message: Message; conversation: Conversation }> {
  const current = ctx.db.getMessage(seq);
  const own = current ? ctx.db.getConversation(current.conversationId) : null;
  if (!current || !own) throw new HttpError(404, `Unknown message ${seq}`);
  // Numbers are sequential, so saying it exists gives nothing away; saying why spares people a dead end (Can, 15 Nov).
  if (!mayRead(ctx, own, { ...reader, all: reader.all || url.searchParams.get("scope") === "all" })) {
    throw new HttpError(403, `#${seq} is in a conversation you are not in`);
  }
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
