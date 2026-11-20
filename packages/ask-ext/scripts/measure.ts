// Runs the fixtures through a System One model and prints, per fixture, the model's choice, its probability, the
// recipient after the cut-off, and the median latency of RUNS calls after one warm-up call (Ümit #13030).
//
//   ASK_DECIDE_URL=http://127.0.0.1:9963 ASK_MIN_CONFIDENCE=0.5 bun run packages/ask-ext/scripts/measure.ts [RUNS]
import { decisionRequest, isRecord, readDecision } from "../src/decide";
import { fixtures } from "../src/fixtures";

const decideUrl = (process.env.ASK_DECIDE_URL ?? "http://127.0.0.1:9963").replace(/\/+$/, "");
const minConfidence = Number(process.env.ASK_MIN_CONFIDENCE ?? 0.5);
const runs = Number(process.argv[2] ?? 5);

async function ask(request: unknown): Promise<{ answer: unknown; ms: number }> {
  const start = performance.now();
  const res = await fetch(`${decideUrl}/v1/systemone`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const answer: unknown = await res.json();
  return { answer, ms: performance.now() - start };
}

let right = 0;
for (const f of fixtures) {
  const request = decisionRequest(f.body);
  const { answer } = await ask(request); // warm-up
  const times: number[] = [];
  for (let i = 0; i < runs; i++) times.push((await ask(request)).ms);
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)] ?? 0;
  const decision = readDecision(answer, f.body, minConfidence);
  const raw = readDecision(answer, f.body, 0);
  const tokens = isRecord(answer) && isRecord(answer.usage) ? answer.usage.input_tokens : undefined;
  const ok = decision.recipient === f.expect;
  if (ok) right++;
  const probs = Object.entries(decision.probabilities)
    .map(([k, p]) => `${k} ${p.toFixed(2)}`)
    .join(", ");
  console.log(
    `${ok ? "ok  " : "FAIL"} ${f.name.padEnd(16)} expect ${String(f.expect).padEnd(18)} got ${String(decision.recipient).padEnd(18)} ` +
      `(choice ${String(raw.recipient ?? "none")} p=${decision.confidence.toFixed(2)}) ${median.toFixed(0)} ms, ${tokens} tokens [${probs}]`,
  );
}
console.log(`${right}/${fixtures.length} right at cut-off ${minConfidence}`);
