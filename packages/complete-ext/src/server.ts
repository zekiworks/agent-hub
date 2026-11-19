// The first box extension (Can #12841–#12853): typing suggestions from a small model run by llama-server. The bus
// (`serve --ext complete=http://127.0.0.1:7830,box=complete`) posts a BoxCompleteBody to /complete; this answers
// {text}: the next few words of the draft, or "" when it has nothing good to offer.
//
//   COMPLETE_PORT=7830 COMPLETE_LLAMA_URL=http://127.0.0.1:9962 bun run packages/complete-ext/src/server.ts
//
// The model: SmolLM2 1.7B base (Q8_0) on a CPU (Can #12912), chosen over LFM3 1.7B: on 12 of Can's own lines it was
// right as often or more, in half the time. Small models' first few words are usually right, after which they copy
// earlier messages. So it shows at most a few words, up to the first punctuation, and nothing copied whole.
import type { BoxCompleteBody, BoxResponse } from "@agent-bus/protocol";

/** Messages of the conversation in the prompt: the latest, each cut short. */
const PROMPT_MESSAGES = 12;
const PROMPT_MESSAGE_CHARS = 300;
/** Words a suggestion holds at most. */
const MAX_WORDS = 5;
/** Tokens asked of the model: a little more than MAX_WORDS, so a sentence end inside it is seen. */
const PREDICT_TOKENS = 10;

/** The prompt: the conversation as lines "@who: text", then the person's draft to be continued. */
export function promptOf(body: BoxCompleteBody): string {
  const where = body.conversation.title ?? (body.conversation.name ? `#${body.conversation.name}` : `a conversation of ${body.conversation.members.join(", ")}`);
  const lines = body.messages
    .slice(-PROMPT_MESSAGES)
    .map((m) => `@${m.from}: ${m.text.replace(/\s+/g, " ").slice(0, PROMPT_MESSAGE_CHARS)}`);
  return `Conversation in ${where}.\n${lines.join("\n")}\n@${body.me}: ${body.draft.text}`;
}

/**
 * What of the model's words to show: up to MAX_WORDS, ending at the first punctuation mark (kept); nothing past a
 * speaker label ("@codex-ui:", the model starting someone else's line; Can #12883); after a finished sentence only a
 * new sentence of the writer's, never one that opens with a name ("@codex-ui."); nothing when the words are copied
 * whole from an earlier message (the model's habit), or when nothing is left.
 */
export function suggestionOf(raw: string, body: BoxCompleteBody): string {
  const line = raw.split("\n")[0] ?? "";
  const label = /@[a-z0-9][a-z0-9@._-]*:/i.exec(line);
  const first = label ? line.slice(0, label.index) : line;
  if (/[.!?]\s*$/.test(body.draft.text) && !/^\s*[A-Z]/.test(first)) return "";
  const stop = /[.,;:!?)]/.exec(first);
  let text = stop ? first.slice(0, stop.index + 1) : first;
  const words = text.match(/\s*\S+/g) ?? [];
  if (words.length > MAX_WORDS) text = words.slice(0, MAX_WORDS).join("");
  if (!text.trim()) return "";
  const said = body.messages.map((m) => m.text.toLowerCase());
  const core = text.trim().toLowerCase().replace(/[.,;:!?)]$/, "");
  if (core.split(/\s+/).length >= 3 && said.some((m) => m.includes(core))) return "";
  return text.replace(/\s+$/, "");
}

/** Whether to ask at all: a draft with something to continue, not Turkish (the model does not write it). */
export function worthAsking(draft: string): boolean {
  return draft.trim().length >= 3 && !/[çğışöüÇĞİŞÖÜ]/.test(draft);
}

async function complete(body: BoxCompleteBody, llamaUrl: string, signal: AbortSignal): Promise<BoxResponse> {
  if (body.v !== 1 || body.kind !== "complete" || !worthAsking(body.draft.text)) return { text: "" };
  const res = await fetch(`${llamaUrl.replace(/\/+$/, "")}/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: promptOf(body),
      n_predict: PREDICT_TOKENS,
      temperature: 0,
      stop: ["\n"],
      cache_prompt: true,
      repeat_penalty: 1.3,
      repeat_last_n: 32,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`llama-server answered HTTP ${res.status}`);
  const answer = (await res.json()) as { content?: string };
  return { text: suggestionOf(answer.content ?? "", body) };
}

if (import.meta.main) {
  const port = Number(process.env.COMPLETE_PORT ?? 7830);
  const llamaUrl = process.env.COMPLETE_LLAMA_URL ?? "http://127.0.0.1:9962";
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/complete") return new Response("POST /complete", { status: 404 });
      try {
        return Response.json(await complete((await req.json()) as BoxCompleteBody, llamaUrl, req.signal));
      } catch (error) {
        if (req.signal.aborted) return Response.json({ text: "" });
        console.error(`complete: ${error instanceof Error ? error.message : String(error)}`);
        return Response.json({ error: "the model is not answering" }, { status: 502 });
      }
    },
  });
  console.log(`complete extension on http://127.0.0.1:${port}, model at ${llamaUrl}`);
}
