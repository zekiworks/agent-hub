// Asks a llama-server's /v1/systemone the "needs you" question (prompt.ts) about each item of a set, one request at a
// time. Writes OUT.json: per item, the person, seq, proxy label and the model's probability of "needs_you".
//
//   bun ask.ts PORT PHRASING dev|test OUT.json
import { loadItems, splits } from "./data.ts";
import { NEEDS, QUESTION, requestFor } from "./prompt.ts";

const [port, phrasing, set, outPath] = process.argv.slice(2);
if (!port || !phrasing || (set !== "dev" && set !== "test") || !outPath) throw new Error("usage: bun ask.ts PORT PHRASING dev|test OUT_JSON");
const s = splits(await loadItems());
const items = set === "dev" ? s.devSample : s.test;

const rows = [];
const t0 = performance.now();
for (const it of items) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/systemone`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestFor(it, phrasing)) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const answer = (await res.json()) as { answers: Record<string, { probabilities: Record<string, number> }> };
  const p = answer.answers[QUESTION]?.probabilities[NEEDS];
  if (typeof p !== "number") throw new Error(`no probability for ${it.person}/${it.seq}: ${JSON.stringify(answer)}`);
  rows.push({ person: it.person, seq: it.seq, label: it.label, p });
}
await Bun.write(outPath, JSON.stringify(rows));
console.log(`${rows.length} items, ${((performance.now() - t0) / 1000).toFixed(0)} s → ${outPath}`);
