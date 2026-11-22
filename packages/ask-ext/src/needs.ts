// The "needs you" question to a System One decision model (d1-2B's or GLiDE's /v1/systemone): one choice, "needs_you"
// or "update", about one agent message for one person. The state is the room, its last few messages, then the message,
// whose start and end both go in (the ask is often in the last lines). The study (needs-you/*.ts, Ümit #13719) asks it
// of its dataset; the bus asks it live through POST /needs (Ümit #14881: the Inbox's "Waiting for your answer"), in
// phrasing "b", of every model at once, so their verdicts can be compared later.
import type { BoxNeedsBody, BoxNeedsResponse, NeedsVerdict } from "@agent-bus/protocol";
import { clip, isRecord, type DecisionRequest } from "./decide";

export const QUESTION = "needs";
export const NEEDS = "needs_you";
export const UPDATE = "update";
/** The phrasing the live box asks: it scored best on the dev set. */
export const LIVE_PHRASING = "b";
/** At or above this probability of "needs_you", a model's verdict is "needs". */
export const NEEDS_CUT = 0.5;
/** The messages before the one judged that go in (as in the dataset, needs-you/build.ts). */
export const CONTEXT_MESSAGES = 4;

/** What the question reads of an item: the dataset's items (needs-you/build.ts) and the live body's both have it. */
export interface NeedsItem {
  /** The person asked about. */
  person: string;
  /** The room's people (the person among them). */
  people: string[];
  /** "#name", "#all", a title, "a direct conversation" or "a group". */
  room: string;
  /** The messages before, oldest first. */
  context: Array<{ from: string; person: boolean; text: string }>;
  /** The agent who wrote the message. */
  author: string;
  /** "task" or "approval" when the message is one for the person. */
  task: string | null;
  text: string;
}

/** The message's first `head` and last `tail` characters, one line. */
function headTail(text: string, head: number, tail: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= head + tail ? line : `${line.slice(0, head).trimEnd()} … ${line.slice(-tail).trimStart()}`;
}

export function stateOf(it: NeedsItem): string {
  const others = it.people.filter((p) => p !== it.person);
  const lines = [`Room ${it.room}. @${it.person} is a person reading their unread messages${others.length ? `; @${others.join(", @")} is another person` : ""}.`];
  if (it.context.length > 0) {
    lines.push("", "Messages before, oldest first:");
    it.context.forEach((m, i) => lines.push(`@${m.from} (${m.person ? "person" : "agent"}): ${clip(m.text, i === it.context.length - 1 ? 280 : 160)}`));
  }
  lines.push("", `New message from @${it.author} (agent)${it.task ? `, a ${it.task} request for @${it.person}` : ""}:`, `"${headTail(it.text, 500, 300)}"`);
  return lines.join("\n");
}

export type Phrasing = (it: NeedsItem) => { instructions: string; criteria: Record<string, string> };
export const PHRASINGS: Record<string, Phrasing> = {
  a: (it) => ({
    instructions: `Does this new message from @${it.author} need @${it.person}, or is it just an update?`,
    criteria: {
      [NEEDS]: `It needs @${it.person}: it asks @${it.person} a question, asks for @${it.person}'s decision or OK, or reports a problem @${it.person} must act on.`,
      [UPDATE]: `Just an update: it reports progress or results, confirms or thanks, or talks to other agents; @${it.person} need not do anything.`,
    },
  }),
  b: (it) => ({
    instructions: `@${it.person} has 99+ unread messages. Should this one from @${it.author} be shown first, as needing @${it.person}?`,
    criteria: {
      [NEEDS]: `Show first: @${it.person} must answer, decide, approve or fix something here.`,
      [UPDATE]: `Leave among the rest: @${it.person} can read it later or skip it; nothing waits on @${it.person}.`,
    },
  }),
  c: (it) => ({
    instructions: `Is @${it.author} waiting for @${it.person} after this message?`,
    criteria: {
      [NEEDS]: `@${it.author} waits for @${it.person}: a question, a choice, an approval, or something only @${it.person} can do.`,
      [UPDATE]: `@${it.author} goes on without @${it.person}: a report, a "done", a plan already agreed, or a message to other agents.`,
    },
  }),
};

export function requestFor(it: NeedsItem, phrasing: string): DecisionRequest {
  const p = PHRASINGS[phrasing];
  if (!p) throw new Error(`unknown phrasing ${phrasing}`);
  return { state: stateOf(it), questions: { [QUESTION]: { type: "choice", ...p(it) } } };
}

// ---- The live box: POST /needs ----

/** The body's shape as far as this extension reads it. */
export function isNeedsBody(value: unknown): value is BoxNeedsBody {
  const c = isRecord(value) ? value.conversation : undefined;
  const m = isRecord(value) ? value.message : undefined;
  return (
    isRecord(value) &&
    value.v === 1 &&
    value.kind === "needs" &&
    typeof value.person === "string" &&
    isRecord(c) &&
    typeof c.id === "string" &&
    Array.isArray(c.people) &&
    Array.isArray(value.messages) &&
    value.messages.every((x) => isRecord(x) && typeof x.from === "string" && typeof x.text === "string") &&
    isRecord(m) &&
    typeof m.from === "string" &&
    typeof m.text === "string"
  );
}

/** The bus's body as the dataset's item: the same room names and context as needs-you/build.ts. */
export function itemOf(body: BoxNeedsBody): NeedsItem {
  const c = body.conversation;
  const room = c.kind === "all" ? "#all" : c.name ? `#${c.name}` : (c.title ?? (c.kind === "dm" ? "a direct conversation" : "a group"));
  return {
    person: body.person,
    people: c.people,
    room,
    context: body.messages.slice(-CONTEXT_MESSAGES).map((m) => ({ from: m.from, person: m.fromKind === "human", text: m.text })),
    author: body.message.from,
    task: body.message.task ?? null,
    text: body.message.text,
  };
}

/** The probability of "needs_you" in a System One answer, or undefined when it has none. */
export function needsProbability(answer: unknown): number | undefined {
  const inner = isRecord(answer) && isRecord(answer.answers) ? answer.answers[QUESTION] : undefined;
  const p = isRecord(inner) && isRecord(inner.probabilities) ? inner.probabilities[NEEDS] : undefined;
  return typeof p === "number" && Number.isFinite(p) ? p : undefined;
}

/** A model the box asks: its short name in the answer and its System One server. */
export interface NeedsModel {
  name: string;
  url: string;
}

/** How long one model may take; past it its verdict is an error (GLiDE on the CPU takes about 0.5 s a message). */
const MODEL_TIMEOUT_MS = 60_000;

async function verdictOf(model: NeedsModel, request: DecisionRequest, signal: AbortSignal): Promise<NeedsVerdict | { error: string }> {
  try {
    const res = await fetch(`${model.url.replace(/\/+$/, "")}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.any([signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const p = needsProbability(await res.json());
    return p === undefined ? { error: "no needs_you probability in the answer" } : { needs: p >= NEEDS_CUT, p };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Every model's verdict on the message, asked at once; one model failing leaves the others' verdicts. */
export async function needsVerdicts(body: BoxNeedsBody, models: NeedsModel[], signal: AbortSignal): Promise<BoxNeedsResponse> {
  const request = requestFor(itemOf(body), LIVE_PHRASING);
  const verdicts = await Promise.all(models.map((m) => verdictOf(m, request, signal)));
  return { verdicts: Object.fromEntries(models.map((m, i) => [m.name, verdicts[i]!])) };
}
