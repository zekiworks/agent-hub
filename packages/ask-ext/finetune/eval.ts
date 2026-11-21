// Asks a llama-server's /v1/systemone about each TEST item (build.ts), as ask-ext asks it: decisionRequest() with "none"
// (as stored) and forced (criteria.none deleted, as rule-vs-d1/roles.ts), read back with readDecision(). One request at
// a time. Writes OUT.json: per item, both answers.
//
//   bun eval.ts PORT DATA_DIR/test.jsonl OUT.json
import type { BoxRecipientBody } from "../../protocol/src/index.ts";
import { readDecision, type DecisionRequest } from "../src/decide.ts";

const [port, testPath, outPath] = process.argv.slice(2);
if (!port || !testPath || !outPath) throw new Error("usage: bun eval.ts PORT TEST_JSONL OUT_JSON");
type Item = { seq: number; who: string; agents: string[]; right: string[]; rule?: string; request: DecisionRequest };
const items: Item[] = (await Bun.file(testPath).text()).trim().split("\n").map((l) => JSON.parse(l));

async function ask(request: unknown, agents: string[]) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/systemone`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  // readDecision reads only body.agents.
  const d = readDecision(await res.json(), { agents } as BoxRecipientBody, 0);
  return { pick: d.recipient, confidence: d.confidence, probabilities: d.probabilities };
}

const rows = [];
for (const it of items) {
  const forced = structuredClone(it.request);
  delete forced.questions.recipient.criteria.none;
  rows.push({ seq: it.seq, who: it.who, right: it.right, rule: it.rule ?? null, withNone: await ask(it.request, it.agents), forced: await ask(forced, it.agents) });
}
await Bun.write(outPath, JSON.stringify(rows, null, 1));
console.log(`${rows.length} items → ${outPath}`);
