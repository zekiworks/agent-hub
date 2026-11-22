// The decision of the "Ask @agent" box extension (Ümit #13030): which one agent of a room, if any, to offer a person who
// types without naming anyone. One "choice" question to a System One decision model (LiquidAI d1-2B in llama-server, or
// GLiDE): the options are the room's agents by their exact ids, plus "none".
//
// The state is the room as the person sees it, newest last: its latest messages with their authors, its checklist with
// owners and status, then the draft. Each agent's option carries the facts that tie it to the room (the messages it
// wrote, the steps it owns, whether it wrote last, whether the person asked it), so evidence weighs more than a name.
// The question quotes the draft itself: without it the model weighed the evidence over what the draft says, and a
// closing "Thanks, I'll take it from here" right after "@webapp Did both Safari tests pass?" went to webapp at 0.87.
import type { BoxRecipientBody } from "@agent-bus/protocol";

/** The option for "no agent": the box stays quiet. */
export const NONE = "none";
/** The key of the one question. */
export const QUESTION = "recipient";
const NONE_DESCRIPTION =
  "No agent: the new message thanks, closes, confirms, plans or announces, is for a person, or is about something no agent clearly owns; it asks no agent for anything.";

/**
 * What of the room goes in: the latest messages, the newest few longer than the older ones; the first steps (open ones
 * come first). These keep a room of long messages and six agents near 1,100 tokens. On bariton's shared CPU (12
 * threads, the machine busy) d1-2B BF16 reads that in 0.9 s and Q8_0 in about 2.2 s (a 600-token room: 0.49 s and
 * 1.1 s), inside the 3 s the server waits.
 */
const STATE_MESSAGES = 8;
const NEWEST_MESSAGES = 3;
const NEWEST_CHARS = 280;
const OLDER_CHARS = 120;
const DRAFT_CHARS = 400;
const STATE_STEPS = 6;
const STEP_CHARS = 80;
/** How much of an agent's latest message (or of the person's last request to it) its option quotes. */
const QUOTE_CHARS = 60;
/** The steps an agent's option names, and how much of each. */
const EVIDENCE_STEPS = 2;
const EVIDENCE_STEP_CHARS = 50;

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface DecisionRequest {
  state: unknown;
  questions: Record<string, ChoiceQuestion>;
}

export interface Decision {
  /** The agent to offer, or null. */
  recipient: string | null;
  /** The model's probability for its choice (0 when the answer could not be read). */
  confidence: number;
  /** The model's probability of each option, as it answered them. */
  probabilities: Record<string, number>;
}

/** One line of text, at most `max` characters (an ellipsis marks the cut). */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

function stepStatus(step: BoxRecipientBody["checklist"][number]): string {
  if (step.done) return "done";
  return step.blocked ? `blocked (${clip(step.blocked, 80)})` : "open";
}

function stepText(step: BoxRecipientBody["checklist"][number]): string {
  return clip(step.heading ? `${step.heading}: ${step.text}` : step.text, STEP_CHARS);
}

/** Whether a message names `id` ("@webapp", not "@webapp2"). */
function names(text: string, id: string): boolean {
  const at = `@${id}`.toLowerCase();
  const lower = text.toLowerCase();
  for (let i = lower.indexOf(at); i !== -1; i = lower.indexOf(at, i + 1)) {
    if (!/[\p{L}\p{N}_@.-]/u.test(lower[i + at.length] ?? "")) return true;
  }
  return false;
}

/** The room as text: where, who, the latest messages, the checklist, then the draft. */
function stateOf(body: BoxRecipientBody): string {
  const c = body.conversation;
  const where = c.name ? `#${c.name}` : (c.title ?? c.id);
  const lines = [`Room ${where}${c.title && c.name ? ` (${c.title})` : ""}.`];
  if (c.topic) lines.push(`Topic: ${clip(c.topic, 200)}`);
  lines.push(`Agents in the room: ${body.agents.map((a) => `@${a}`).join(", ")}. @${body.me} is a person.`);

  const messages = body.messages.slice(-STATE_MESSAGES);
  if (messages.length > 0) {
    lines.push("", "Latest messages, oldest first:");
    const bySeq = new Map(messages.map((m) => [m.seq, m]));
    messages.forEach((m, i) => {
      const max = i >= messages.length - NEWEST_MESSAGES ? NEWEST_CHARS : OLDER_CHARS;
      const to = m.replyTo === undefined ? undefined : bySeq.get(m.replyTo);
      const answering = to ? ` (answering @${to.from})` : "";
      lines.push(`@${m.from} (${m.fromKind === "agent" ? "agent" : "person"})${answering}: ${clip(m.text, max)}`);
    });
  }

  const steps = body.checklist.slice(0, STATE_STEPS);
  if (steps.length > 0) {
    lines.push("", "Checklist:");
    for (const s of steps) lines.push(`- [${stepStatus(s)}] ${stepText(s)}${s.owner ? ` (owner @${s.owner})` : ""}`);
  }

  lines.push("", `@${body.me} is writing to the room, naming no one:`, `"${clip(body.draft.text, DRAFT_CHARS)}"`);
  return lines.join("\n");
}

/**
 * The facts that tie an agent to the room, for its option (the option's key already names it: on the fixtures, an
 * "@id: " before the facts made the model a little less sure of the right answer).
 */
function evidenceOf(body: BoxRecipientBody, agent: string): string {
  const messages = body.messages.slice(-STATE_MESSAGES);
  const facts: string[] = [];
  const own = messages.filter((m) => m.from === agent);
  if (messages.at(-1)?.from === agent) facts.push("wrote the latest message");
  const latest = own.at(-1);
  if (latest) facts.push(`wrote ${own.length} of the last ${messages.length} messages, latest: "${clip(latest.text, QUOTE_CHARS)}"`);
  const asked = messages.filter((m) => m.from === body.me && names(m.text, agent)).at(-1);
  if (asked) facts.push(`@${body.me} asked it: "${clip(asked.text, QUOTE_CHARS)}"`);
  const steps = body.checklist.filter((s) => s.owner === agent);
  for (const s of steps.slice(0, EVIDENCE_STEPS)) facts.push(`owns the ${stepStatus(s)} step "${clip(s.text, EVIDENCE_STEP_CHARS)}"`);
  if (steps.length > EVIDENCE_STEPS) facts.push(`owns ${steps.length - EVIDENCE_STEPS} more steps`);
  return facts.length === 0 ? "in the room, wrote nothing recently and owns no step." : `${facts.join("; ")}.`;
}

/** The question: the spec's "Which agent has the best evidence to answer this person?", about its new message, quoted. */
export function instructionsFor(body: BoxRecipientBody): string {
  return `Which agent has the best evidence to answer this person's new message "${clip(body.draft.text, DRAFT_CHARS)}"?`;
}

/** The request to the System One API: the room as the state, one choice among the agents and "none". */
export function decisionRequest(body: BoxRecipientBody): DecisionRequest {
  const criteria: Record<string, string> = {};
  for (const agent of body.agents) criteria[agent] = evidenceOf(body, agent);
  criteria[NONE] = NONE_DESCRIPTION;
  return { state: stateOf(body), questions: { [QUESTION]: { type: "choice", instructions: instructionsFor(body), criteria } } };
}

/** The package's one object guard, for the JSON it reads (the bus's body, the model's answer). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The agent to offer from the model's answer: the System One response (`{answers: {recipient: …}}`) or that answer
 * itself (`{choice, confidence, probabilities}`). "none", an id that is not one of the room's agents, an answer that
 * cannot be read, or a probability below `minConfidence` give null. `confidence` is the probability of the model's
 * choice (from `probabilities`; d1 reports the same as `confidence`, other models may report a rescaled one there).
 */
export function readDecision(answer: unknown, body: BoxRecipientBody, minConfidence: number): Decision {
  const inner = isRecord(answer) && isRecord(answer.answers) ? answer.answers[QUESTION] : answer;
  const probabilities: Record<string, number> = {};
  if (!isRecord(inner)) return { recipient: null, confidence: 0, probabilities };
  if (isRecord(inner.probabilities)) {
    for (const [option, p] of Object.entries(inner.probabilities)) {
      if (typeof p === "number" && Number.isFinite(p)) probabilities[option] = p;
    }
  }
  const choice = typeof inner.choice === "string" ? inner.choice : undefined;
  const confidence = choice === undefined ? undefined : (probabilities[choice] ?? inner.confidence);
  if (choice === undefined || typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return { recipient: null, confidence: 0, probabilities };
  }
  const offer = choice !== NONE && body.agents.includes(choice) && confidence >= minConfidence;
  return { recipient: offer ? choice : null, confidence, probabilities };
}
