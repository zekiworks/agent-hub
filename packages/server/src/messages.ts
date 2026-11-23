// Writing messages (recipients, holding for offline agents, replies that quote, the @resources notices) and the
// website's message reads: conversation pages and a message with its receipts.
import {
  ALL_CONVERSATION_ID,
  conversationLabel,
  mentionedIds,
  RESOURCES_AGENT_ID,
  titledLabel,
  type Bookmark,
  type OwnTask,
  type Conversation,
  type FileRef,
  type ForwardedMessage,
  type ForwardResponse,
  type Message,
  type MessagesResponse,
  type SharedFilesResponse,
  type PostMessageResponse,
  type Receipt,
} from "@agent-bus/protocol";
import type { BusContext } from "./context";
import { addMembers, canRead, canSee, checkedProjectName, leave, mayRead, type Reader } from "./conversations";
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

/** Text as words only, lowercased: a link's address and the markdown marks dropped, so the shown text matches its source. */
function plainWords(text: string): string {
  return text
    .replace(/\]\([^)]*\)/g, "]")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@]+/gu, " ")
    .trim();
}

/**
 * Participants @mentioned in `text` (`@id-n` counts as agent `id`; a renamed agent's old id counts as it); unknown
 * names and "@all" are left out.
 */
export function mentionedParticipants(ctx: BusContext, text: string): string[] {
  const ids: string[] = [];
  for (const mention of mentionedIds(text)) {
    const session = /^(.+)-(\d+)$/.exec(mention)?.[1];
    const sessionAgent = session ? ctx.hub.knownParticipant(session) : null;
    const id = ctx.hub.knownParticipant(mention)?.id ?? (sessionAgent?.kind === "agent" ? sessionAgent.id : undefined);
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
    // A room is only "#name", a project only "@@name" (Can, 15 Nov): one name, one place, one way to write it.
    if (existing && !!existing.room !== !!parsed.room) {
      throw new HttpError(409, existing.room ? `"${parsed.name}" is a room: write to #${parsed.name}` : `"${parsed.name}" is a project: write to @@${parsed.name}`);
    }
    // Checked only when creating: anyone may write to (and join) an existing open project, e.g. @@compactor.
    const name = existing ? parsed.name : checkedProjectName(ctx, parsed.name, writer.id);
    const project = existing ?? null;
    if (!project) return db.createProject(name, writer.id, now, parsed.room === true);
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
  return writeMessage(ctx, req, await readJsonObject(req));
}

/** Writes the message `body` asks for (POST /api/messages), carrying `forwarded` when it forwards one (Can #12470). */
async function writeMessage(ctx: BusContext, req: Request, body: Record<string, unknown>, forwarded?: ForwardedMessage): Promise<PostMessageResponse> {
  const { db, hub } = ctx;
  if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
  const writer = hub.knownParticipant(body.from.trim().toLowerCase());
  if (!writer) {
    throw new HttpError(400, `Unknown participant "${body.from}". Known ids: ${hub.knownIds().join(", ")}`);
  }
  const verified = ctx.checkWriter(req, writer);
  // A reply goes to the conversation of the message it answers (then it is a conversationId post) and quotes it.
  let replyToSeq: number | undefined;
  let quoteText: string | undefined;
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
    // A reply to one paragraph quotes that paragraph (Ümit #13981). Only words that are in the message (as the page
    // shows it: without the markdown) count, so nobody is quoted saying what they did not write; anything else quotes
    // the message as usual, and the reply still goes.
    const part = typeof body.quoteText === "string" ? body.quoteText.trim() : "";
    if (part && plainWords(original.text).includes(plainWords(part))) quoteText = part;
  } else if (body.quoteText != null) throw new HttpError(400, "quoteText goes with replyToSeq");
  const hasTo = body.to !== undefined && body.to !== null;
  const hasConversation = body.conversationId !== undefined && body.conversationId !== null;
  if (hasTo === hasConversation) throw new HttpError(400, "Give exactly one of to, conversationId or replyToSeq");

  if (body.text !== undefined && typeof body.text !== "string") throw new HttpError(400, "text must be a string");
  // The bus shows every message's sender; agents that start with their own name ("logic: …") only repeat it.
  let text = writer.kind === "agent" ? withoutOwnName(body.text ?? "", writer.id) : (body.text ?? "");
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
  // A forwarded copy may come without a note (Can #12470).
  if (text.trim() === "" && files.length === 0 && !forwarded) throw new HttpError(400, "text is required");

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
  if (leavable && writer.kind === "agent" && text.trim().toLowerCase() === "exit" && files.length === 0 && !forwarded) {
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

  // Extension proposals are consumed only while their message is written. Agents' legacy task fields run the same
  // extension command and post its answer immediately.
  let extension: { ext: NonNullable<Message["ext"]>; wake: string[] } | undefined;
  if (body.proposal !== undefined) {
    if (!ctx.extensions) throw new HttpError(503, "The task extension is not configured");
    extension = ctx.extensions.consume(body.proposal, writer.id, conversation.id);
  } else if (body.task !== undefined) {
    if (!ctx.extensions) throw new HttpError(503, "The task extension is not configured");
    const prepared = await ctx.extensions.agentTask(writer, conversation, text, body.task);
    extension = { ext: prepared.ext, wake: prepared.wake };
    text = prepared.text;
  }
  // Every agent of the conversation (for @all, every agent): the online ones get it now, the offline ones when they are
  // back, until it expires. Only those on the wake list get a turn for it.
  const recipients = recipientsFor(ctx, conversation, writer.id).map((p) => p.id);
  const listed = wakeList(ctx, writer, body.wake, conversation, recipients, text, replyToSeq, newcomers);
  const assigned = extension?.wake.filter((id) => recipients.includes(id)) ?? [];
  const wake = assigned.length > 0 ? [...new Set([...(listed ?? []), ...assigned])] : listed;
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
    ...(quoteText === undefined ? {} : { quoteText }),
    ...(sessions.size > 0 ? { sessions } : {}),
    ...(fromSession === undefined ? {} : { fromSession }),
    ...(verified === undefined ? {} : { verified }),
    ...(wake ? { wake } : {}),
    ...(extension ? { ext: extension.ext } : {}),
    ...(forwarded ? { forwarded } : {}),
  });
  if (writer.kind === "human") db.touchParticipant(writer.id, now);
  const updated = db.getConversation(conversation.id);
  if (!updated) throw new Error(`Conversation ${conversation.id} vanished`);
  hub.publishMessage(message, updated);
  const response: PostMessageResponse = { message, conversation: updated };
  await ctx.extensions?.posted(response);
  const warnings =
    writer.kind === "agent" ? [...unreadableRefs(ctx, text, updated), ...unwokenMentions(mentionedParticipants(ctx, text), recipients, wake)] : [];
  return { ...response, ...(warnings.length > 0 ? { warnings } : {}) };
}

/**
 * The agents a message wakes (Can, 15 Nov): one agent, the best placed, decides who acts next. A person's: in a DM, its
 * agent. Elsewhere the agents it @mentions, plus the agent it answers (the author of the message replied to, else
 * `answeredBy`) when it mentions none or calls in an agent new to the conversation (who lacks the context the answered
 * one has); where nobody else has written yet, all its agents. An agent's: the agent it replies to (replyToSeq) and its
 * list, members only; list left out (an older tool): undefined, the old rule.
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
    const answered = replyToSeq !== undefined ? answeredInChain(ctx, replyToSeq, writer.id) : answeredBy(ctx, conversation.id, writer.id);
    if (answered === undefined) return recipients; // a conversation started with them: they are meant
    // "@all" in a person's text wakes every agent of the conversation (Can, 15 Nov).
    if (mentionedIds(text).includes(ALL_CONVERSATION_ID)) return recipients;
    const named = mentionedParticipants(ctx, text);
    const mentioned = recipients.filter((id) => named.includes(id));
    const withAnswered = mentioned.length === 0 || mentioned.some((id) => newcomers.includes(id));
    return recipients.filter((id) => mentioned.includes(id) || (withAnswered && id === answered));
  }
  if (given === undefined || given === null) return undefined;
  if (!Array.isArray(given) || !given.every((id) => typeof id === "string")) throw new HttpError(400, "wake must be a list of agent ids");
  const wake = [
    ...new Set(
      given
        .map((id: string) => id.trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean)
        .map((id: string) => ctx.db.renamedTo(id) ?? id)
    ),
  ];
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

/**
 * Whom a person's message naming nobody answers: the last one who wrote besides them, and when that was a person, the
 * last agent who wrote before (Can #13603: "the last agent who wrote is the best"; it was right 73% of the time on
 * Can's and Ümit's messages since 15 Nov, a person writing last woke nobody, and the last agent before them was right
 * 14 of 21 times). Undefined when nobody else has written yet.
 */
export function answeredBy(ctx: BusContext, conversationId: string, person: string): string | undefined {
  const last = ctx.db.lastAuthorBesides(conversationId, person);
  if (last === undefined || !ctx.hub.isHuman(last)) return last;
  return ctx.db.lastAgentAuthorBesides(conversationId, person) ?? last;
}

/**
 * Whom a person's reply answers: the replied-to message's author, and when that is a person (their own message, in a
 * thread most often), the nearest agent up the reply chain (Can #14236: answering one's own message in a thread with
 * an agent woke nobody). The direct author when the chain holds no agent.
 */
function answeredInChain(ctx: BusContext, replyToSeq: number, writer: string): string | undefined {
  const first = ctx.db.getMessage(replyToSeq);
  let m = first;
  for (let steps = 0; m && steps < 50; steps++) {
    if (!ctx.hub.isHuman(m.from) && m.from !== writer) return m.from;
    m = m.quote ? ctx.db.getMessage(m.quote.seq) : null;
  }
  return first?.from;
}

/** An agent @mentions an agent its wake list leaves out: said, since the mention alone wakes nobody. */
function unwokenMentions(mentioned: string[], recipients: string[], wake: string[] | undefined): string[] {
  if (!wake) return [];
  return recipients
    .filter((id) => !wake.includes(id) && mentioned.includes(id))
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

/**
 * POST /api/messages/:seq/edit {from, text} and /delete {from} (Ümit #10890): only its writer, signed in as itself
 * (checkWriter). Tasks are withdrawn, not edited or deleted: their steps and inboxes refer to the text.
 */
export async function changeMessage(ctx: BusContext, req: Request, seq: number, action: "edit" | "delete"): Promise<{ message: Message }> {
  const body = await readJsonObject(req);
  if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
  const writer = ctx.hub.knownParticipant(body.from.trim().toLowerCase());
  if (!writer) throw new HttpError(400, `Unknown participant "${body.from}"`);
  ctx.checkWriter(req, writer);
  const message = ctx.db.getMessage(seq);
  const conversation = message ? ctx.db.getConversation(message.conversationId) : null;
  if (!message || !conversation || !mayRead(ctx, conversation, { id: writer.id, kind: writer.kind === "human" ? "human" : "agent" })) {
    throw new HttpError(404, `Unknown message ${seq}`);
  }
  if (message.from !== writer.id) throw new HttpError(403, `#${seq} is @${message.from}'s; only its writer ${action}s it`);
  if (message.deletedAt) throw new HttpError(409, `#${seq} is deleted already`);
  if (message.task) throw new HttpError(409, `#${seq} is a task: withdraw it instead`);
  if (action === "edit") {
    if (typeof body.text !== "string") throw new HttpError(400, "text must be a string");
    const text = body.text.trim();
    // A forwarded copy's note may be emptied: the copy is still there (Can #12470).
    if (text === "" && message.files.length === 0 && !message.forwarded) throw new HttpError(400, "The text is empty: delete the message instead");
    if (text.length > MAX_TEXT_LENGTH) throw new HttpError(400, `text is longer than ${MAX_TEXT_LENGTH} characters`);
    if (text !== message.text) ctx.db.editMessage(seq, text);
  } else {
    ctx.db.deleteMessage(seq);
  }
  const changed = ctx.db.getMessage(seq) ?? message;
  ctx.hub.messageChanged(changed, conversation);
  return { message: changed };
}

/**
 * POST /api/messages/:seq/forward {from, to, note?} (Can #12470, #12471): `from`, who may read message `seq`, shows it to
 * `to`. A participant in its conversation (or anyone, for @all) gets a reply to it there that @mentions them, which
 * wakes them as a mention does; nothing is copied. Anyone else gets it in their DM with `from`, and a conversation
 * (never its own) gets it posted there, as a copy of the message as it is now (Message.forwarded) under the note. A
 * participant who may read the conversation without being in it gets the copy too: a mention there would not reach
 * them. The message records the forward (Message.forwards), which its readers see.
 */
export async function forwardMessage(ctx: BusContext, req: Request, seq: number): Promise<ForwardResponse> {
  const { db, hub } = ctx;
  const body = await readJsonObject(req);
  if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
  const writer = hub.knownParticipant(body.from.trim().toLowerCase());
  if (!writer) throw new HttpError(400, `Unknown participant "${body.from}"`);
  ctx.checkWriter(req, writer);
  const original = db.getMessage(seq);
  const source = original ? db.getConversation(original.conversationId) : null;
  if (!original || !source || !mayRead(ctx, source, { id: writer.id, kind: writer.kind === "human" ? "human" : "agent" })) {
    throw new HttpError(404, `Unknown message ${seq}`);
  }
  if (original.deletedAt) throw new HttpError(409, `#${seq} is deleted`);
  if (typeof body.to !== "string" || body.to.trim() === "") throw new HttpError(400, "to must be a participant id or a conversation address");
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") throw new HttpError(400, "note must be a string");
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const to = body.to.trim();
  const agentWriter = writer.kind === "agent";
  // A copy of a copy without a note of its own passes the first copy on: the message itself says nothing more.
  const copy: ForwardedMessage =
    original.forwarded && original.text === "" && original.files.length === 0
      ? original.forwarded
      : {
          seq,
          conversationId: source.id,
          conversationTitle: source.kind === "all" ? "#all" : titledLabel(source),
          from: original.from,
          createdAt: original.createdAt,
          text: original.text,
          files: original.files,
        };
  let sent: PostMessageResponse;
  let label: string;
  // "b" or "@b" is a participant; "#room", "@@project", "@{a,b}" and "@all" are conversations.
  const id = /^@?([a-z0-9][a-z0-9_-]*(?:@[a-z0-9][a-z0-9_-]*)?)$/i.exec(to)?.[1]?.toLowerCase();
  if (id && id !== ALL_CONVERSATION_ID) {
    const target = hub.knownParticipant(id);
    if (!target) throw new HttpError(400, `Unknown participant "${id}". Known ids: ${hub.knownIds().join(", ")}`);
    if (target.id === writer.id) throw new HttpError(400, "Cannot forward to yourself");
    label = `@${target.id}`;
    // An agent's wake list names the agent it forwards to; people's lists follow the mention (or the DM).
    const wake = agentWriter ? { wake: target.kind === "agent" ? [target.id] : [] } : {};
    // An agent who can read it already gets a reply there that names it. A person always gets a copy in the DM: in a
    // busy room a mention was missed, and "forward to Can" was taken for not arriving (Ümit #13324).
    if (target.kind === "agent" && (source.kind === "all" || source.members.includes(target.id))) {
      sent = await writeMessage(ctx, req, { from: writer.id, replyToSeq: seq, text: `${label} ${note || "(forwarded to you)"}`, ...wake });
    } else {
      sent = await writeMessage(ctx, req, { from: writer.id, to: label, text: note, ...wake }, copy);
    }
  } else {
    const target = conversationFor(ctx, writer, ctx.knownAddress(to), Date.now());
    if (target.id === source.id) throw new HttpError(400, `#${seq} is in ${to} already`);
    label = target.kind === "all" ? "#all" : conversationLabel(target);
    // An agent forwarding into a DM wakes its other member; elsewhere nobody (it says whom in the note, with wake).
    const wake = agentWriter ? { wake: target.kind === "dm" ? target.members.filter((m) => m !== writer.id && !hub.isHuman(m)) : [] } : {};
    sent = await writeMessage(ctx, req, { from: writer.id, conversationId: target.id, text: note, ...wake }, copy);
  }
  db.addForward(seq, writer.id, label);
  const updated = db.getMessage(seq);
  if (updated) hub.messageChanged(updated, db.getConversation(source.id) ?? source);
  return { ...sent, to: label };
}

/** POST /api/tabs {from, order} (Can #11480): a person puts their tabs in a new order; exactly their pins, each once. */
export async function postTabs(ctx: BusContext, req: Request): Promise<{ tabs: string[] }> {
  const body = await readJsonObject(req);
  if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
  const who = ctx.hub.knownParticipant(body.from.trim().toLowerCase());
  if (!who) throw new HttpError(400, `Unknown participant "${body.from}"`);
  ctx.checkWriter(req, who);
  const order = body.order;
  if (!Array.isArray(order) || !order.every((id): id is string => typeof id === "string")) throw new HttpError(400, "order must be a list of conversation ids");
  const mine = ctx.db.tabsOf(who.id);
  if (order.length !== mine.length || new Set(order).size !== order.length || !order.every((id) => mine.includes(id))) {
    throw new HttpError(409, "order must be exactly your tabs, each once (they changed meanwhile: reload them)");
  }
  ctx.db.setTabOrder(who.id, order);
  const tabs = ctx.db.tabsOf(who.id);
  if (who.kind === "human") ctx.hub.tabsChanged(who.id, tabs);
  return { tabs };
}

/**
 * POST /api/bookmarks {from, seq, bookmarked} (Can #11065): a person saves a message they can read in their own list,
 * or drops it. Only people, signed in as themselves; only they see the list.
 */
export async function postBookmark(ctx: BusContext, req: Request): Promise<{ bookmarks: Bookmark[] }> {
  const body = await readJsonObject(req);
  if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
  const who = ctx.hub.knownParticipant(body.from.trim().toLowerCase());
  if (!who) throw new HttpError(400, `Unknown participant "${body.from}"`);
  if (who.kind !== "human") throw new HttpError(403, "Bookmarks are people's");
  ctx.checkWriter(req, who);
  if (typeof body.seq !== "number" || !Number.isSafeInteger(body.seq)) throw new HttpError(400, "seq must be a message number");
  if (typeof body.bookmarked !== "boolean") throw new HttpError(400, "bookmarked must be true or false");
  if (body.bookmarked) {
    const message = ctx.db.getMessage(body.seq);
    const conversation = message ? ctx.db.getConversation(message.conversationId) : null;
    if (!message || !conversation || !mayRead(ctx, conversation, { id: who.id, kind: "human" })) throw new HttpError(404, `Unknown message ${body.seq}`);
  }
  ctx.db.setBookmark(who.id, body.seq, body.bookmarked);
  const bookmarks = ctx.db.bookmarksOf(who.id);
  ctx.hub.bookmarksChanged(who.id, bookmarks);
  return { bookmarks };
}

/**
 * POST /api/own-tasks {from, seq, state} (Can #12197): a person takes a message they can read as a task for themselves
 * ("open"), marks it "done" (or "open" again), or drops it ("none"). Only people, signed in as themselves; only they
 * see their tasks, the message is not touched and nobody is told.
 */
export async function postOwnTask(ctx: BusContext, req: Request): Promise<{ ownTasks: OwnTask[] }> {
  const body = await readJsonObject(req);
  if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
  const who = ctx.hub.knownParticipant(body.from.trim().toLowerCase());
  if (!who) throw new HttpError(400, `Unknown participant "${body.from}"`);
  if (who.kind !== "human") throw new HttpError(403, "Own tasks are people's");
  ctx.checkWriter(req, who);
  if (typeof body.seq !== "number" || !Number.isSafeInteger(body.seq)) throw new HttpError(400, "seq must be a message number");
  const taskState = body.state;
  if (taskState !== "open" && taskState !== "done" && taskState !== "none") throw new HttpError(400, 'state must be "open", "done" or "none"');
  if (taskState !== "none") {
    const message = ctx.db.getMessage(body.seq);
    const conversation = message ? ctx.db.getConversation(message.conversationId) : null;
    if (!message || !conversation || !mayRead(ctx, conversation, { id: who.id, kind: "human" })) throw new HttpError(404, `Unknown message ${body.seq}`);
  }
  ctx.db.setOwnTask(who.id, body.seq, taskState);
  const ownTasks = ctx.db.ownTasksOf(who.id);
  ctx.hub.ownTasksChanged(who.id, ownTasks);
  return { ownTasks };
}
