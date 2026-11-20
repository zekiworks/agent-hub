// The first box extension (Can #12841–#12853): typing suggestions from a small model run by llama-server. The bus
// (`serve --ext complete=http://127.0.0.1:7830,box=complete`) posts a BoxCompleteBody to /complete; this answers
// {text}: the next few words of the draft, or "" when it has nothing good to offer.
//
//   COMPLETE_PORT=7830 COMPLETE_LLAMA_URL=http://127.0.0.1:9962 bun run packages/complete-ext/src/server.ts
//
// The model: any llama-server model. On bariton LFM3 1.7B (BF16) again, on trial (Ümit #13060), with COMPLETE_HEAL=0;
// SmolLM2 1.7B base (Q8_0) ran before it (Can #12912): on 12 of Can's lines it was right as often, in half the time.
//
// Two things from "Subword token healing & autocomplete" (Can #12915):
// - Token healing: a draft that ends mid-word ("Let's configur") is not sent as it is, since the model never saw
//   " config" + "ur" and goes on with "ate". The half-typed word goes back out of the prompt and a grammar makes the
//   model's answer begin with it, so it picks the whole token " configure" and the words after it fit.
// - Confidence stopping: the words are kept only while the model is sure of each one (log-probability per word, and
//   for the whole), so a doubtful suggestion ends early or is not shown at all.
// Then the cut-offs for what small models do wrong: the first punctuation ends it, nothing past a speaker label, and
// nothing copied whole from an earlier message.
import type { BoxCompleteBody, BoxResponse } from "@agent-bus/protocol";

/** Messages of the conversation in the prompt: the latest, each cut short. */
const PROMPT_MESSAGES = 12;
const PROMPT_MESSAGE_CHARS = 300;
/** Words a suggestion holds at most (confidence usually ends it sooner). */
const MAX_WORDS = 8;
const PREDICT_TOKENS = 12;
/**
 * A word less likely than this ends the suggestion before it; so does a whole below the second. The article's -1.8
 * and -4.0 cut words SmolLM2 had right on Can's lines ("logo" at -2.1); these were tuned on them (Can #12915).
 */
const MIN_STEP_LOGPROB = -2.5;
const MIN_TOTAL_LOGPROB = -5.0;
/** The forced tokens may be unlikely ("context" after "con" at -5.2), but not absurd: "an" spelled "ne" (-13) is. */
const MIN_FORCED_LOGPROB = -8;

/** The prompt: the conversation as lines "@who: text", then the person's draft (or the part before a half word). */
export function promptOf(body: BoxCompleteBody, draft = body.draft.text): string {
  const where = body.conversation.title ?? (body.conversation.name ? `#${body.conversation.name}` : `a conversation of ${body.conversation.members.join(", ")}`);
  const lines = body.messages
    .slice(-PROMPT_MESSAGES)
    .map((m) => `@${m.from}: ${m.text.replace(/\s+/g, " ").slice(0, PROMPT_MESSAGE_CHARS)}`);
  return `Conversation in ${where}.\n${lines.join("\n")}\n@${body.me}: ${draft}`;
}

/**
 * Token healing's split: a draft ending mid-word gives back the half word with the space before it (`stub`, " configur")
 * and what comes before it (`prefix`, "Let's"). A draft ending in a space or a sign, or of one word only, is not split.
 */
export function healSplit(draft: string): { prefix: string; stub: string } {
  const m = /(\s+)([\p{L}\p{N}_'’-]+)$/u.exec(draft);
  if (!m || m.index === 0) return { prefix: draft, stub: "" };
  return { prefix: draft.slice(0, m.index), stub: draft.slice(m.index) };
}

/** A GBNF grammar whose text begins with `stub`, then anything up to the end of the line. */
export function grammarFor(stub: string): string {
  return `root ::= "${stub.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" [^\\n]*`;
}

/** One generated token and how likely the model found it (natural log). */
export interface TokenProb {
  token: string;
  logprob: number;
}

/**
 * The text after `stub` that the model was sure of: tokens are taken while each one's log-probability is at least
 * MIN_STEP_LOGPROB and their sum at least MIN_TOTAL_LOGPROB. The tokens that spell the stub are forced by the grammar
 * (their prior can be low only because the person typed something unusual), so they are judged only against
 * MIN_FORCED_LOGPROB: below it the model took an odd way to spell the stub ("ta" + "leb's"), and nothing is offered.
 */
export function confidentText(tokens: readonly TokenProb[], stub: string): string {
  let text = "";
  let total = 0;
  for (const { token, logprob } of tokens) {
    const before = text.length;
    text += token;
    if (before < stub.length) {
      if (logprob < MIN_FORCED_LOGPROB) return "";
      continue;
    }
    if (logprob < MIN_STEP_LOGPROB || total + logprob < MIN_TOTAL_LOGPROB) {
      text = text.slice(0, before);
      break;
    }
    total += logprob;
  }
  return text.startsWith(stub) ? text.slice(stub.length) : "";
}

/**
 * What of the model's sure words to show: up to MAX_WORDS, ending at the first punctuation mark (kept); nothing past a
 * speaker label ("@codex-ui:", the model starting someone else's line; Can #12883); after a finished sentence only a
 * new sentence of the writer's, never one that opens with a name ("@codex-ui."); nothing when the words are copied
 * whole from an earlier message (the model's habit), or when fewer than 3 letters are left.
 */
export function suggestionOf(raw: string, body: BoxCompleteBody): string {
  const line = raw.split("\n")[0] ?? "";
  const label = /@[a-z0-9][a-z0-9@._-]*:/i.exec(line);
  const first = label ? line.slice(0, label.index) : line;
  if (/[.!?]\s*$/.test(body.draft.text) && !/^\s*[A-Z]/.test(first)) return "";
  // A sign that ends a word ("ready?", "it,"), not one inside it ("1.2", "e.g").
  const stop = /[.,;:!?)](?=\s|$)/.exec(first);
  let text = stop ? first.slice(0, stop.index + 1) : first;
  const words = text.match(/\s*\S+/g) ?? [];
  if (words.length > MAX_WORDS) text = words.slice(0, MAX_WORDS).join("");
  if (text.trim().length < 3) return "";
  const said = body.messages.map((m) => m.text.toLowerCase());
  const core = text.trim().toLowerCase().replace(/[.,;:!?)]$/, "");
  if (core.split(/\s+/).length >= 3 && said.some((m) => m.includes(core))) return "";
  return text.replace(/\s+$/, "");
}

/** Whether to ask at all: a draft with something to continue, not Turkish (the model does not write it). */
export function worthAsking(draft: string): boolean {
  return draft.trim().length >= 3 && !/[çğışöüÇĞİŞÖÜ]/.test(draft);
}

/**
 * `heal`: token healing of a half-typed word (SmolLM2). Off for LFM3 1.7B (Ümit #13060): its tokenizer spells the
 * forced half word in odd pieces ("tests" as " " + "te" + "st", log-probability -17), so nothing was ever offered.
 */
async function complete(body: BoxCompleteBody, llamaUrl: string, signal: AbortSignal, heal: boolean): Promise<BoxResponse> {
  if (body.v !== 1 || body.kind !== "complete" || !worthAsking(body.draft.text)) return { text: "" };
  const { prefix, stub } = heal ? healSplit(body.draft.text) : { prefix: body.draft.text, stub: "" };
  const res = await fetch(`${llamaUrl.replace(/\/+$/, "")}/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: promptOf(body, prefix),
      ...(stub ? { grammar: grammarFor(stub) } : {}),
      n_predict: PREDICT_TOKENS,
      n_probs: 1,
      temperature: 0,
      stop: ["\n"],
      cache_prompt: true,
      repeat_penalty: 1.3,
      repeat_last_n: 32,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`llama-server answered HTTP ${res.status}`);
  const answer = (await res.json()) as { completion_probabilities?: Array<{ token: string; logprob?: number; prob?: number }> };
  const tokens = (answer.completion_probabilities ?? []).map((t) => ({ token: t.token, logprob: t.logprob ?? Math.log(t.prob ?? 0) }));
  return { text: suggestionOf(confidentText(tokens, stub), body) };
}

if (import.meta.main) {
  const port = Number(process.env.COMPLETE_PORT ?? 7830);
  const llamaUrl = process.env.COMPLETE_LLAMA_URL ?? "http://127.0.0.1:9962";
  const heal = process.env.COMPLETE_HEAL !== "0";
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/complete") return new Response("POST /complete", { status: 404 });
      try {
        return Response.json(await complete((await req.json()) as BoxCompleteBody, llamaUrl, req.signal, heal));
      } catch (error) {
        if (req.signal.aborted) return Response.json({ text: "" });
        console.error(`complete: ${error instanceof Error ? error.message : String(error)}`);
        return Response.json({ error: "the model is not answering" }, { status: 502 });
      }
    },
  });
  console.log(`complete extension on http://127.0.0.1:${port}, model at ${llamaUrl}`);
}
