// The training files for train.py, in the chosen phrasing: OUT/train.jsonl = every "needed" item of FIT (data.ts) and
// twice as many of its other items (a seeded sample; the natural mix is 9% needed, which leaves too few positives per
// minute of GPU), OUT/dev.jsonl = the dev sample (the natural mix). Each line: {person, seq, label, request}.
//
//   bun export.ts PHRASING OUT_DIR
import { loadItems, shuffled, splits } from "./data.ts";
import { requestFor } from "../src/needs.ts";
import type { Item } from "./build.ts";

const NEGATIVES_PER_POSITIVE = 2;
const [phrasing, out] = process.argv.slice(2);
if (!phrasing || !out) throw new Error("usage: bun export.ts PHRASING OUT_DIR");
const s = splits(await loadItems());
const positives = s.fit.filter((x) => x.label);
const negatives = shuffled(s.fit.filter((x) => !x.label), 13719).slice(0, positives.length * NEGATIVES_PER_POSITIVE);
const lines = (xs: Item[]) => xs.map((x) => JSON.stringify({ person: x.person, seq: x.seq, label: x.label, request: requestFor(x, phrasing) })).join("\n") + "\n";
await Bun.write(`${out}/train.jsonl`, lines(shuffled([...positives, ...negatives], 1)));
await Bun.write(`${out}/dev.jsonl`, lines(s.devSample));
console.log(`train ${positives.length} needed + ${negatives.length} not; dev ${s.devSample.length} (${s.devSample.filter((x) => x.label).length} needed)`);
