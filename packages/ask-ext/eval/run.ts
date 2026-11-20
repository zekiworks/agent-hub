// The "Ask @agent" harness (Ümit #13030): every sampled item through decide.ts and a System One server, one call at a
// time, timed. Cut-off 0: the full probabilities are kept, report.ts chooses the cut-offs on DEV.
//
//   bun packages/ask-ext/eval/run.ts --url http://127.0.0.1:9963 --model d1-2B-Q8_0 --hardware "bariton CPU, 12 threads"
//     [--split all|test|dev] [--limit N] [--warmup 3] [--out ~/.agent-bus/ask-eval/results-<model>.jsonl] [--fresh]
//
// Resumes: items already answered in --out are skipped (failed ones are tried again) unless --fresh.
// Writes <out> (one ResultLine per item) and <out>.meta.json (url, model, hardware, times).
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decisionRequest, isRecord, readDecision } from "../src/decide";
import { EVAL_DIR, ITEMS_FILE, appendJsonl, ensureEvalDir, flag, readJsonl, writeJsonl, type Item, type ResultLine } from "./common";

const URL_BASE = (flag("url") ?? "").replace(/\/+$/, "");
const MODEL = flag("model") ?? "";
const HARDWARE = flag("hardware") ?? "unspecified";
const SPLIT = flag("split", "all");
const LIMIT = Number(flag("limit", "0"));
const WARMUP = Number(flag("warmup", "3"));
const TIMEOUT_MS = Number(flag("timeout-ms", "120000"));
const OUT = flag("out") ?? join(EVAL_DIR, `results-${MODEL.replace(/[^\w.-]+/g, "_")}.jsonl`);

if (!URL_BASE || !MODEL) {
  console.error("usage: bun packages/ask-ext/eval/run.ts --url http://127.0.0.1:9963 --model NAME [--hardware TEXT] [--split all|test|dev] [--limit N]");
  process.exit(2);
}

async function ask(item: Item): Promise<{ answer: unknown; ms: number; tokens?: number; serverMs?: number }> {
  const start = performance.now();
  const res = await fetch(`${URL_BASE}/v1/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, ...decisionRequest(item.body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  const ms = performance.now() - start;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const answer: unknown = JSON.parse(text);
  const tokens = isRecord(answer) && isRecord(answer.usage) && typeof answer.usage.input_tokens === "number" ? answer.usage.input_tokens : undefined;
  const serverMs = isRecord(answer) && typeof answer.latency_ms === "number" ? answer.latency_ms : undefined;
  return { answer, ms, ...(tokens !== undefined ? { tokens } : {}), ...(serverMs !== undefined ? { serverMs } : {}) };
}

async function main(): Promise<void> {
  ensureEvalDir();
  let items = readJsonl<Item>(ITEMS_FILE).filter((i) => SPLIT === "all" || i.split === SPLIT);
  if (LIMIT > 0) items = items.slice(0, LIMIT);
  const fresh = process.argv.includes("--fresh");
  const kept = fresh ? [] : readJsonl<ResultLine>(OUT).filter((r) => r.error === undefined);
  const done = new Set(kept.map((r) => r.item));
  writeJsonl(OUT, kept); // drop the failed lines: they are tried again
  const todo = items.filter((i) => !done.has(i.id));
  const meta = { url: URL_BASE, model: MODEL, hardware: HARDWARE, split: SPLIT, startedAt: new Date().toISOString(), items: items.length, warmup: WARMUP };
  const metaFile = `${OUT}.meta.json`;
  const before = existsSync(metaFile) && !fresh ? (JSON.parse(await Bun.file(metaFile).text()) as { runs?: unknown[] }) : {};
  writeFileSync(metaFile, JSON.stringify({ ...meta, runs: [...(before.runs ?? []), meta] }, null, 2) + "\n");

  // Warm-up calls (kernels compiled, caches filled), not timed: on the first items of the run.
  for (const item of todo.slice(0, WARMUP)) await ask(item).catch(() => undefined);

  let failed = 0;
  for (const [n, item] of todo.entries()) {
    let line: ResultLine;
    try {
      const { answer, ms, tokens, serverMs } = await ask(item);
      const decision = readDecision(answer, item.body, 0);
      line = { item: item.id, model: MODEL, ...decision, ms: Math.round(ms * 10) / 10, ...(tokens !== undefined ? { tokens } : {}), ...(serverMs !== undefined ? { serverMs } : {}) };
    } catch (error) {
      failed++;
      line = { item: item.id, model: MODEL, recipient: null, confidence: 0, probabilities: {}, ms: 0, error: error instanceof Error ? error.message : String(error) };
    }
    appendJsonl(OUT, line);
    if ((n + 1) % 10 === 0 || n + 1 === todo.length) {
      console.log(`${n + 1}/${todo.length} (${line.item}: ${line.recipient ?? "none"} p=${line.confidence.toFixed(2)}, ${line.ms} ms${line.error ? `, ${line.error}` : ""})`);
    }
  }
  writeFileSync(metaFile, JSON.stringify({ ...meta, finishedAt: new Date().toISOString(), failed, runs: [...(before.runs ?? []), meta] }, null, 2) + "\n");
  console.log(`${todo.length - failed} answered, ${failed} failed, ${done.size} from before → ${OUT}`);
}

await main();
