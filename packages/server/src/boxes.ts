// Box extensions (Can #12841–#12853): services the website's message box asks while a person types, set with
// `serve --ext NAME=URL,box=ROLE`. POST /api/box/:name {conversationId, text}: the bus checks the person may read the
// conversation, sends the extension a versioned body at `POST <URL>/<role>`, and passes back its answer. Nothing is
// stored.
// - "complete": BoxCompleteBody (the draft and the conversation's latest messages) → {text}, the words to add.
// - "recipient" (Ümit #13030): BoxRecipientBody (the draft, the room's latest messages with their authors, its
//   checklist with owners, its agents) → {recipient, confidence}: the one agent to offer ("Ask @webapp"), or null.
//   Asked only for a room with at least two agents besides the person, about a draft that names none of its members;
//   the bus passes on only one of those agents.
import {
  ALL_CONVERSATION_ID,
  mentionedIds,
  type BoxCompleteBody,
  type BoxRecipientBody,
  type BoxRecipientResponse,
  type BoxResponse,
  type BoxRole,
  type Conversation,
} from "@agent-bus/protocol";
import { appendFileSync } from "node:fs";
import type { BusContext } from "./context";
import { mayRead } from "./conversations";
import { HttpError, readJsonObject } from "./http";

/** A box extension: where it answers and what it does. */
export interface BoxExtension {
  url: string;
  role: BoxRole;
}

/** How many of the conversation's latest messages go along: enough for its names and what was just said. */
const CONTEXT_MESSAGES = 20;
/** A draft is cut to its last part; a suggestion longer than this is dropped. */
const MAX_DRAFT_CHARS = 4000;
const MAX_ANSWER_CHARS = 200;
/** The checklist steps sent along, open ones first. */
const MAX_CHECKLIST_ITEMS = 40;
/**
 * An answer that comes later than this is no use: the person has typed on. A recipient takes longer (a model on the
 * hub's processor reads the room), and is still useful while the person finishes the sentence.
 */
const TIMEOUT_MS: Record<BoxRole, number> = { complete: 3000, recipient: 8000 };

/** Each person's request in flight, per extension: a new one cancels it (they typed on). */
const inFlight = new Map<string, AbortController>();

const NONE: BoxRecipientResponse = { recipient: null };

/** The agents a recipient box may name in `conversation`: its agent members besides `person`. */
export function eligibleAgents(ctx: BusContext, conversation: Conversation, person: string): string[] {
  return conversation.members.filter((id) => id !== person && ctx.hub.knownParticipant(id)?.kind === "agent");
}

export async function postBox(
  ctx: BusContext,
  req: Request,
  name: string,
  boxes: Record<string, BoxExtension>,
  person: string | undefined
): Promise<BoxResponse | BoxRecipientResponse> {
  const box = boxes[name];
  if (!box) throw new HttpError(404, `No box extension "${name}" on this bus`);
  if (!person) throw new HttpError(403, "Only a signed-in person's message box asks a box extension");
  const body = await readJsonObject(req);
  if (typeof body.conversationId !== "string" || typeof body.text !== "string") {
    throw new HttpError(400, "Give conversationId and text (the draft up to the cursor)");
  }
  const conversation = ctx.db.getConversation(body.conversationId);
  if (!conversation || !mayRead(ctx, conversation, { id: person, kind: "human" })) {
    throw new HttpError(404, `Unknown conversation "${body.conversationId}"`);
  }
  const draft = body.text.slice(-MAX_DRAFT_CHARS);
  let payload: BoxCompleteBody | BoxRecipientBody;
  if (box.role === "recipient") {
    const agents = eligibleAgents(ctx, conversation, person);
    // Only rooms with a choice to make, and only drafts whose writer has not chosen: a named member (or @all) wins.
    const named = mentionedIds(draft);
    const chosen = named.includes(ALL_CONVERSATION_ID) || conversation.members.some((id) => named.includes(id));
    if (!conversation.room || agents.length < 2 || chosen || !draft.trim()) return NONE;
    payload = recipientBody(ctx, conversation, person, agents, draft);
  } else {
    payload = {
      v: 1,
      kind: "complete",
      me: person,
      conversation: conversationPart(conversation),
      messages: latestMessages(ctx, conversation).map((m) => ({ seq: m.seq, from: m.from, text: m.text, createdAt: m.createdAt })),
      draft: { text: draft },
    };
  }
  const key = `${person}\n${name}`;
  inFlight.get(key)?.abort();
  const controller = new AbortController();
  inFlight.set(key, controller);
  const cancel = () => controller.abort();
  req.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, TIMEOUT_MS[box.role]);
  try {
    const res = await fetch(`${box.url.replace(/\/+$/, "")}/${box.role}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new HttpError(502, `${name} answered HTTP ${res.status}`);
    const answer = (await res.json()) as Record<string, unknown>;
    if (payload.kind === "recipient") return checkedRecipient(answer, payload.agents);
    const text = typeof answer.text === "string" && answer.text.length <= MAX_ANSWER_CHARS ? answer.text : "";
    return { text };
  } catch (error) {
    if (controller.signal.aborted) return box.role === "recipient" ? NONE : { text: "" };
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, `${name} is not answering: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", cancel);
    if (inFlight.get(key) === controller) inFlight.delete(key);
  }
}

function conversationPart(conversation: Conversation): BoxCompleteBody["conversation"] {
  return {
    id: conversation.id,
    kind: conversation.kind,
    ...(conversation.name ? { name: conversation.name } : {}),
    ...(conversation.title ? { title: conversation.title } : {}),
    members: conversation.members,
  };
}

/** The conversation's latest messages, oldest first (deleted ones left out). */
function latestMessages(ctx: BusContext, conversation: Conversation) {
  return ctx.db.listMessages(conversation.id, null, CONTEXT_MESSAGES).filter((m) => m.deletedAt === undefined);
}

function recipientBody(ctx: BusContext, conversation: Conversation, person: string, agents: string[], draft: string): BoxRecipientBody {
  const items = ctx.db.getChecklist(conversation.id)?.items ?? [];
  return {
    v: 1,
    kind: "recipient",
    me: person,
    conversation: { ...conversationPart(conversation), ...(conversation.topic ? { topic: conversation.topic } : {}) },
    messages: latestMessages(ctx, conversation).map((m) => ({
      seq: m.seq,
      from: m.from,
      fromKind: ctx.hub.isHuman(m.from) ? "human" : "agent",
      text: m.text,
      createdAt: m.createdAt,
      ...(m.quote ? { replyTo: m.quote.seq } : {}),
    })),
    checklist: [...items]
      .sort((a, b) => Number(!!a.done) - Number(!!b.done))
      .slice(0, MAX_CHECKLIST_ITEMS)
      .map((item) => ({
        id: item.id,
        ...(item.heading ? { heading: item.heading } : {}),
        text: item.text,
        ...(item.owner ? { owner: item.owner } : {}),
        done: !!item.done,
        ...(item.blocked ? { blocked: item.blocked } : {}),
      })),
    agents,
    draft: { text: draft },
  };
}

/** The extension's answer, passed on only when it names one of the agents the bus offered. */
function checkedRecipient(answer: Record<string, unknown>, agents: string[]): BoxRecipientResponse {
  const recipient = typeof answer.recipient === "string" ? answer.recipient.replace(/^@/, "").toLowerCase() : "";
  if (!agents.includes(recipient)) return NONE;
  const confidence = typeof answer.confidence === "number" && answer.confidence >= 0 && answer.confidence <= 1 ? answer.confidence : undefined;
  return { recipient, ...(confidence !== undefined ? { confidence } : {}) };
}

/** What a person did with a recipient box's offer, as the website saw it when the message went (Ümit #13224). */
const OUTCOMES = new Set(["taken", "ignored", "named-other", "named", "quiet", "reply"]);

/**
 * POST /api/box/:name/report {conversationId, outcome, recipient?, confidence?, ms?, failed?}: one line per message a
 * person sent in a room with the recipient box on, appended to `file` (box-reports.jsonl in the data folder) so the
 * add-on's use can be counted (Ümit #13224). Never the text: who was offered, what happened, how long the model took.
 */
export async function postBoxReport(
  ctx: BusContext,
  req: Request,
  name: string,
  boxes: Record<string, BoxExtension>,
  person: string | undefined,
  file: string
): Promise<{ ok: true }> {
  if (boxes[name]?.role !== "recipient") throw new HttpError(404, `No recipient box extension "${name}" on this bus`);
  if (!person) throw new HttpError(403, "Only a signed-in person reports on the message box");
  const body = await readJsonObject(req);
  if (typeof body.conversationId !== "string" || typeof body.outcome !== "string" || !OUTCOMES.has(body.outcome)) {
    throw new HttpError(400, `Give conversationId and outcome (${[...OUTCOMES].join(", ")})`);
  }
  const conversation = ctx.db.getConversation(body.conversationId);
  if (!conversation || !mayRead(ctx, conversation, { id: person, kind: "human" })) {
    throw new HttpError(404, `Unknown conversation "${body.conversationId}"`);
  }
  const line = {
    at: new Date().toISOString(),
    box: name,
    person,
    conversationId: conversation.id,
    outcome: body.outcome,
    ...(typeof body.recipient === "string" && conversation.members.includes(body.recipient) ? { recipient: body.recipient } : {}),
    ...(typeof body.confidence === "number" ? { confidence: body.confidence } : {}),
    ...(typeof body.ms === "number" ? { ms: Math.round(body.ms) } : {}),
    ...(body.failed === true ? { failed: true } : {}),
  };
  appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  return { ok: true };
}
