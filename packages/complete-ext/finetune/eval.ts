// Next-word test of the fine-tuned LFM3 1.7B against the base (Ümit #13289), through the production code: promptOf,
// confidentText (stub "", as with COMPLETE_HEAL=0), suggestionOf and worthAsking from ../src/server.ts.
//
// TEST: can's and umit's messages from the cutoff (--cutoff, default 2026-11-18 00:00 Europe/Berlin) on, not deleted, that worthAsking
// accepts (no Turkish letters). Each is cut after a word (the draft holds at least its first word; the real next word
// is what the model should say), up to SAMPLES cut points spread over the messages (fixed seed). The context is the
// conversation's messages before it as the bus sends them (latest 20, deleted ones left out, oldest first; promptOf
// keeps the last 12), with a leading "🎤 " dropped as in the training data.
//
//   bun run eval.ts http://127.0.0.1:9971 http://127.0.0.1:9972 [--cutoff ISO] [--out DIR] [--samples N] [--labels base,tuned]
//
// --cutoff: the TEST's start, an ISO time with its offset (default 2026-11-18T00:00+01:00); --out: the results
// directory (default ~/.agent-bus/finetune/results/); --samples: cut points (default 3000); --labels: the two models'
// names in the table. Reads the bus database read-only; writes table.md, results.jsonl and summary.json (what weekly.sh
// decides on) to the results directory.
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import type { BoxCompleteBody } from "@agent-bus/protocol";
import { confidentText, promptOf, suggestionOf, worthAsking } from "../src/server.ts";

const { values: opts, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    cutoff: { type: "string", default: "2026-11-18T00:00+01:00" },
    out: { type: "string", default: `${homedir()}/.agent-bus/finetune/results` },
    samples: { type: "string", default: "3000" },
    labels: { type: "string", default: "base,tuned" },
  },
});
const DB = `${homedir()}/.agent-bus/message-bus.sqlite`;
const CUTOFF_MS = Date.parse(opts.cutoff);
if (!Number.isFinite(CUTOFF_MS)) throw new Error(`--cutoff ${opts.cutoff} is not an ISO time`);
const OUT = opts.out;
const CONTEXT_MESSAGES = 20; // what the bus reads before dropping deleted ones (boxes.ts)
const SAMPLES = Number(opts.samples);
const CONCURRENCY = 8;
const [baseUrl = "http://127.0.0.1:9971", tunedUrl = "http://127.0.0.1:9972"] = positionals;
const MODELS = { base: baseUrl, tuned: tunedUrl } as const;
type ModelName = keyof typeof MODELS;
const [baseLabel = "base", tunedLabel = "tuned"] = opts.labels.split(",");
const LABELS: Record<ModelName, string> = { base: baseLabel, tuned: tunedLabel };

const TR = new Set(
  "ve bir bu da de ne mi mu ama icin gibi var yok cok simdi tamam evet hayir olsun ben sen biz siz onu bunu sey iyi daha kadar sonra once nasil neden niye hep hic bence galiba artik zaten bak yani olur olmaz misin musun lazim abi hocam burada orada degil oldu mesela ile hem bile bunlar sunu boyle oyle hemen biraz bana sana bizim senin benim istiyorum yapalim yap bakalim olarak diye".split(" "),
);
const EN = new Set(
  "the a an is to and of it in that you this for on with be are not what can we i do have should why how but or if so there was will would just at as they them my me your our it's let's don't".split(" "),
);

/** "en" or "tr" (Turkish typed without its letters), by common words; the client's own looksTurkish needs its lists. */
function languageOf(text: string): "en" | "tr" {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const tr = words.filter((w) => TR.has(w)).length;
  const en = words.filter((w) => EN.has(w)).length;
  return tr >= 2 && tr > en ? "tr" : "en";
}

/** A word for comparison: lower case, signs at either end dropped. */
function norm(word: string): string {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** The words a continuation adds after the draft: none when it goes on inside the draft's last word. */
function wordsAfter(continuation: string): string[] {
  if (!/^\s/.test(continuation)) return [];
  return (continuation.match(/\S+/g) ?? []).map(norm);
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clean = (text: string) => text.replace(/^🎤 /u, "");

interface Row {
  seq: number;
  conversation_id: string;
  from_id: string;
  text: string;
  created_at: number;
  deleted_at: number | null;
}

const db = new Database(DB, { readonly: true });
const conversations = new Map<string, BoxCompleteBody["conversation"]>();
for (const c of db.query<{ id: string; kind: string; name: string | null; title: string | null }, []>("SELECT id, kind, name, title FROM conversations").all()) {
  const members = db
    .query<{ participant_id: string }, [string]>("SELECT participant_id FROM conversation_members WHERE conversation_id = ?1 ORDER BY participant_id")
    .all(c.id)
    .map((m) => m.participant_id);
  conversations.set(c.id, {
    id: c.id,
    kind: c.kind as BoxCompleteBody["conversation"]["kind"],
    ...(c.name ? { name: c.name } : {}),
    ...(c.title ? { title: c.title } : {}),
    members,
  });
}
const tests = db
  .query<Row, [number]>(
    "SELECT seq, conversation_id, from_id, text, created_at, deleted_at FROM messages WHERE from_id IN ('can','umit') AND deleted_at IS NULL AND created_at >= ?1 AND trim(text) <> '' ORDER BY seq",
  )
  .all(CUTOFF_MS)
  .map((m) => ({ ...m, text: clean(m.text) }))
  .filter((m) => worthAsking(m.text));
const before = db.query<Row, [string, number, number]>(
  "SELECT seq, conversation_id, from_id, text, created_at, deleted_at FROM messages WHERE conversation_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3",
);

interface Cut {
  message: Row;
  lang: "en" | "tr";
  draft: string;
  /** The real words after the draft, normalized. */
  next: string[];
}

// Every cut point per message, shuffled; then taken round-robin over the messages (spread), up to SAMPLES.
const random = rng(13289);
const perMessage: Cut[][] = [];
for (const message of tests) {
  const lang = languageOf(message.text);
  const words = [...message.text.matchAll(/\S+/g)];
  const cuts: Cut[] = [];
  for (let j = 0; j + 1 < words.length; j++) {
    const draft = message.text.slice(0, words[j]!.index! + words[j]![0].length);
    const next = words.slice(j + 1).map((w) => norm(w[0]));
    if (!next[0] || !worthAsking(draft)) continue;
    cuts.push({ message, lang, draft, next });
  }
  for (let i = cuts.length - 1; i > 0; i--) {
    const k = Math.floor(random() * (i + 1));
    [cuts[i], cuts[k]] = [cuts[k]!, cuts[i]!];
  }
  if (cuts.length) perMessage.push(cuts);
}
const sample: Cut[] = [];
for (let round = 0; sample.length < SAMPLES; round++) {
  let added = false;
  for (const cuts of perMessage) {
    if (round < cuts.length && sample.length < SAMPLES) {
      sample.push(cuts[round]!);
      added = true;
    }
  }
  if (!added) break;
}
const totalCuts = perMessage.reduce((n, c) => n + c.length, 0);
console.log(`${tests.length} test messages (worthAsking), ${perMessage.length} with cut points, ${totalCuts} cut points, ${sample.length} sampled`);

function bodyOf(cut: Cut): BoxCompleteBody {
  const messages = before
    .all(cut.message.conversation_id, cut.message.seq, CONTEXT_MESSAGES)
    .filter((m) => m.deleted_at === null)
    .reverse()
    .map((m) => ({ seq: m.seq, from: m.from_id, text: clean(m.text), createdAt: m.created_at }));
  return { v: 1, kind: "complete", me: cut.message.from_id, conversation: conversations.get(cut.message.conversation_id)!, messages, draft: { text: cut.draft } };
}

interface Answer {
  raw: string;
  suggestion: string;
  top1: boolean;
  shown: boolean;
  right: boolean;
  saved: number;
  ms: number;
}

async function ask(url: string, body: BoxCompleteBody, cut: Cut): Promise<Answer> {
  const started = performance.now();
  const res = await fetch(`${url}/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // As complete() in server.ts sends it (no healing).
    body: JSON.stringify({
      prompt: promptOf(body, body.draft.text),
      n_predict: 12,
      n_probs: 1,
      temperature: 0,
      stop: ["\n"],
      cache_prompt: true,
      repeat_penalty: 1.3,
      repeat_last_n: 32,
    }),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
  const answer = (await res.json()) as { content: string; completion_probabilities?: Array<{ token: string; logprob?: number; prob?: number }> };
  const ms = performance.now() - started;
  const tokens = (answer.completion_probabilities ?? []).map((t) => ({ token: t.token, logprob: t.logprob ?? Math.log(t.prob ?? 0) }));
  const suggestion = suggestionOf(confidentText(tokens, ""), body);
  const rawWords = wordsAfter(answer.content);
  const shownWords = wordsAfter(suggestion);
  let saved = 0;
  while (saved < shownWords.length && saved < cut.next.length && shownWords[saved] === cut.next[saved]) saved++;
  return {
    raw: answer.content,
    suggestion,
    top1: rawWords[0] === cut.next[0],
    shown: suggestion !== "",
    right: suggestion !== "" && shownWords[0] === cut.next[0],
    saved: suggestion !== "" ? saved : 0,
    ms,
  };
}

interface Result {
  cut: Cut;
  answers: Record<ModelName, Answer>;
}
const results: Result[] = [];
const started = performance.now();
let index = 0;
async function worker(): Promise<void> {
  while (index < sample.length) {
    const cut = sample[index++]!;
    const body = bodyOf(cut);
    const [base, tuned] = await Promise.all([ask(MODELS.base, body, cut), ask(MODELS.tuned, body, cut)]);
    results.push({ cut, answers: { base, tuned } });
    if (results.length % 250 === 0) console.log(`${results.length}/${sample.length} in ${((performance.now() - started) / 1000).toFixed(0)} s`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const seconds = (performance.now() - started) / 1000;

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");
function rowOf(label: string, rs: Result[], model: ModelName): string {
  const a = rs.map((r) => r.answers[model]);
  const shown = a.filter((x) => x.shown);
  const right = shown.filter((x) => x.right);
  const saved = shown.reduce((n, x) => n + x.saved, 0);
  const ms = a.map((x) => x.ms).sort((p, q) => p - q);
  return `| ${label} | ${LABELS[model]} | ${rs.length} | ${pct(a.filter((x) => x.top1).length, a.length)} | ${pct(shown.length, a.length)} | ${pct(right.length, shown.length)} | ${pct(right.length, a.length)} | ${shown.length ? (saved / shown.length).toFixed(2) : "–"} | ${(saved / Math.max(1, a.length)).toFixed(3)} | ${ms[Math.floor(ms.length / 2)]?.toFixed(0) ?? "–"} |`;
}
const groups: Array<[string, Result[]]> = [
  ["all", results],
  ["can", results.filter((r) => r.cut.message.from_id === "can")],
  ["umit", results.filter((r) => r.cut.message.from_id === "umit")],
  ["English", results.filter((r) => r.cut.lang === "en")],
  ["Turkish w/o letters", results.filter((r) => r.cut.lang === "tr")],
  ["can, English", results.filter((r) => r.cut.message.from_id === "can" && r.cut.lang === "en")],
  ["umit, English", results.filter((r) => r.cut.message.from_id === "umit" && r.cut.lang === "en")],
];
const header = [
  "| Cut points | Model | n | next-word top-1 | shown | right of shown | shown & right (of all) | words saved per shown | words saved per cut | median ms |",
  "|---|---|---|---|---|---|---|---|---|---|",
];
const rowsOf = (gs: Array<[string, Result[]]>) => gs.flatMap(([label, rs]) => (rs.length ? (["base", "tuned"] as const).map((m) => rowOf(label, rs, m)) : []));
const table = [...header, ...rowsOf(groups)].join("\n");
const messagesBy = (who: string) => new Set(results.filter((r) => r.cut.message.from_id === who).map((r) => r.cut.message.seq)).size;
const summary = `${tests.length} test messages pass worthAsking; ${totalCuts} cut points, ${sample.length} sampled from ${new Set(sample.map((c) => c.message.seq)).size} messages (can ${messagesBy("can")}, umit ${messagesBy("umit")}); ${seconds.toFixed(0)} s for both models, ${CONCURRENCY} at a time.`;
console.log(`\n${summary}\n\n${table}`);

mkdirSync(OUT, { recursive: true, mode: 0o700 });
writeFileSync(`${OUT}/table.md`, `${summary}\n\n${table}\n`, { mode: 0o600 });
writeFileSync(
  `${OUT}/results.jsonl`,
  results
    .map((r) => JSON.stringify({ seq: r.cut.message.seq, from: r.cut.message.from_id, lang: r.cut.lang, draft: r.cut.draft, next: r.cut.next.slice(0, 8), ...r.answers }))
    .join("\n") + "\n",
  { mode: 0o600 },
);
// What weekly.sh decides on: shown & right per model, and the paired cut points one has right and the other not.
const count = (model: ModelName, key: "top1" | "right") => results.filter((r) => r.answers[model][key]).length;
const only = (a: ModelName, b: ModelName, key: "top1" | "right") => results.filter((r) => r.answers[a][key] && !r.answers[b][key]).length;
writeFileSync(
  `${OUT}/summary.json`,
  JSON.stringify(
    {
      cuts: results.length,
      cutoff: new Date(CUTOFF_MS).toISOString(),
      labels: LABELS,
      shownRight: { base: count("base", "right"), tuned: count("tuned", "right") },
      top1: { base: count("base", "top1"), tuned: count("tuned", "top1") },
      rightWins: only("tuned", "base", "right"),
      rightLosses: only("base", "tuned", "right"),
      top1Wins: only("tuned", "base", "top1"),
      top1Losses: only("base", "tuned", "top1"),
      seconds: Math.round(seconds),
      table: [...header, ...rowsOf(groups.slice(0, 3))].join("\n"),
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
