// Box extensions (Can #12841–#12853): services the website's message box asks while a person types, set with
// `serve --ext NAME=URL,box=complete`. POST /api/box/:name {conversationId, text} → {text}: the bus checks the person
// may read the conversation, sends the extension a versioned body (BoxCompleteBody: the draft and the conversation's
// latest messages) at `POST <URL>/complete`, and passes back its words. Nothing is stored.
import type { BoxCompleteBody, BoxResponse, BoxRole } from "@agent-bus/protocol";
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
/** A suggestion that comes later than this is no use: the person has typed on. */
const TIMEOUT_MS = 3000;

/** Each person's request in flight, per extension: a new one cancels it (they typed on). */
const inFlight = new Map<string, AbortController>();

export async function postBox(
  ctx: BusContext,
  req: Request,
  name: string,
  boxes: Record<string, BoxExtension>,
  person: string | undefined
): Promise<BoxResponse> {
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
  const key = `${person}\n${name}`;
  inFlight.get(key)?.abort();
  const controller = new AbortController();
  inFlight.set(key, controller);
  const cancel = () => controller.abort();
  req.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, TIMEOUT_MS);
  const payload: BoxCompleteBody = {
    v: 1,
    kind: "complete",
    me: person,
    conversation: {
      id: conversation.id,
      kind: conversation.kind,
      ...(conversation.name ? { name: conversation.name } : {}),
      ...(conversation.title ? { title: conversation.title } : {}),
      members: conversation.members,
    },
    messages: ctx.db
      .listMessages(conversation.id, null, CONTEXT_MESSAGES)
      .filter((m) => m.deletedAt === undefined)
      .map((m) => ({ seq: m.seq, from: m.from, text: m.text, createdAt: m.createdAt })),
    draft: { text: body.text.slice(-MAX_DRAFT_CHARS) },
  };
  try {
    const res = await fetch(`${box.url.replace(/\/+$/, "")}/${box.role}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new HttpError(502, `${name} answered HTTP ${res.status}`);
    const answer = (await res.json()) as { text?: unknown };
    const text = typeof answer.text === "string" && answer.text.length <= MAX_ANSWER_CHARS ? answer.text : "";
    return { text };
  } catch (error) {
    if (controller.signal.aborted) return { text: "" };
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, `${name} is not answering: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", cancel);
    if (inFlight.get(key) === controller) inFlight.delete(key);
  }
}
