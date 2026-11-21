// The tables from ask.ts's answers and build.ts's items.
//
//   bun report.ts dev NAME=DEV.json …              → per run on the dev sample: P/R/F1/accuracy at 0.5, and the
//                                                    threshold with the best F1 (for the test table's tuned rows)
//   bun report.ts test NAME=TEST.json[@THRESHOLD] … → markdown: baselines and each run per person, calibration,
//                                                    the same on the strict label, disagreements with the best baseline
import type { Item } from "./build.ts";
import { loadItems, shuffled, splits } from "./data.ts";

type Row = { person: string; seq: number; label: boolean; p: number };
const [mode, ...specs] = process.argv.slice(2);
if ((mode !== "dev" && mode !== "test") || specs.length === 0) throw new Error("usage: bun report.ts dev|test NAME=FILE[@THRESHOLD] …");
const key = (person: string, seq: number) => `${person}/${seq}`;
const runs = await Promise.all(specs.map(async (spec) => {
  const [name, rest] = spec.split("=") as [string, string];
  const [file, thr] = rest.split("@") as [string, string | undefined];
  const rows: Row[] = await Bun.file(file).json();
  return { name, threshold: thr === undefined ? 0.5 : Number(thr), p: new Map(rows.map((r) => [key(r.person, r.seq), r.p])) };
}));

type Score = { tp: number; fp: number; fn: number; tn: number };
function score(xs: Item[], predict: (x: Item) => boolean, label: (x: Item) => boolean = (x) => x.label): Score {
  const s = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const x of xs) {
    const p = predict(x), l = label(x);
    if (p && l) s.tp++; else if (p) s.fp++; else if (l) s.fn++; else s.tn++;
  }
  return s;
}
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");
function cells(s: Score): string {
  const prec = s.tp / (s.tp + s.fp), rec = s.tp / (s.tp + s.fn);
  const f1 = s.tp ? (2 * prec * rec) / (prec + rec) : 0;
  return `${pct(s.tp, s.tp + s.fp)} | ${pct(s.tp, s.tp + s.fn)} | ${f1.toFixed(2)} | ${pct(s.tp + s.tn, s.tp + s.fp + s.fn + s.tn)} | ${s.tp + s.fp}`;
}
function f1(s: Score) { return s.tp ? (2 * s.tp) / (2 * s.tp + s.fp + s.fn) : 0; }

const s = splits(await loadItems());
const items = mode === "dev" ? s.devSample : s.test;
const pOf = (run: (typeof runs)[number], x: Item) => {
  const p = run.p.get(key(x.person, x.seq));
  if (p === undefined) throw new Error(`${run.name}: no answer for ${key(x.person, x.seq)}`);
  return p;
};

if (mode === "dev") {
  console.log("| run | precision | recall | F1 | accuracy | flagged | best threshold (F1) |\n|---|---|---|---|---|---|---|");
  for (const run of runs) {
    let best = { t: 0.5, f: -1 };
    for (let t = 0.05; t < 0.96; t += 0.01) {
      const f = f1(score(items, (x) => pOf(run, x) >= t));
      if (f > best.f) best = { t: Math.round(t * 100) / 100, f };
    }
    console.log(`| ${run.name} | ${cells(score(items, (x) => pOf(run, x) >= 0.5))} | ${best.t} (${best.f.toFixed(2)}) |`);
  }
  console.log(`\n${items.length} dev items, ${items.filter((x) => x.label).length} needed (proxy).`);
  process.exit(0);
}

const baselines: [string, (x: Item) => boolean][] = [
  ["1. @mentions P", (x) => x.mentions],
  ["2. @mentions P and has '?'", (x) => x.mentions && x.question],
  ["3. @mentions P, or a task/approval for P", (x) => x.mentions || x.task !== null],
];
// Not asked for: rules from the conversation, found while building the set (the proxy label is mostly turn-taking).
const wroteBefore = (x: Item) => x.context.some((c) => c.from === x.person);
const extras: [string, (x: Item) => boolean][] = [
  ["extra A. P wrote one of the 4 messages before", wroteBefore],
  ["extra B. P wrote the message just before", (x) => x.context.at(-1)?.from === x.person],
];
const models: [string, (x: Item) => boolean][] = runs.flatMap((run) => {
  const out: [string, (x: Item) => boolean][] = [[`${run.name} (p ≥ 0.5)`, (x) => pOf(run, x) >= 0.5]];
  if (run.threshold !== 0.5) out.push([`${run.name} (p ≥ ${run.threshold}, tuned on dev)`, (x) => pOf(run, x) >= run.threshold]);
  return out;
});
const groups: [string, Item[]][] = [["can", items.filter((x) => x.person === "can")], ["umit", items.filter((x) => x.person === "umit")], ["both", items]];
const out: string[] = [];
function table(title: string, label: (x: Item) => boolean) {
  out.push(`### ${title}`, "");
  for (const [g, xs] of groups) {
    out.push(`**${g}** (n=${xs.length}, needed ${xs.filter(label).length})`, "", "| method | precision | recall | F1 | accuracy | flagged |", "|---|---|---|---|---|---|");
    out.push(`| (flag nothing) | ${cells(score(xs, () => false, label))} |`);
    for (const [name, f] of [...baselines, ...extras, ...models]) out.push(`| ${name} | ${cells(score(xs, f, label))} |`);
    out.push("");
  }
}
table("Proxy label (replied, wrote next, @mentioned the author, or acted on the approval, within 12 h)", (x) => x.label);

out.push("### Calibration (both people)", "", "| run | cut | items whose confidence reaches it | right among them | \"needs you\" with p ≥ cut | of which needed |", "|---|---|---|---|---|---|");
for (const run of runs) {
  for (const cut of [0.5, 0.7, 0.9]) {
    const sure = items.filter((x) => Math.max(pOf(run, x), 1 - pOf(run, x)) >= cut);
    const right = sure.filter((x) => (pOf(run, x) >= 0.5) === x.label).length;
    const flagged = items.filter((x) => pOf(run, x) >= cut);
    out.push(`| ${run.name} | ≥ ${cut} | ${sure.length}/${items.length} | ${right} (${pct(right, sure.length)}) | ${flagged.length} | ${flagged.filter((x) => x.label).length} (${pct(flagged.filter((x) => x.label).length, flagged.length)}) |`);
  }
}
out.push("");
table("Strict label (explicit only: replied, @mentioned the author, or acted on the approval; \"wrote next\" alone counts as not needed)", (x) => x.why.some((w) => w !== "next"));

// Disagreements of each run (at its own threshold, the tuned one if given) with the best rule by F1 (both people), of
// baselines 1–3 and of the extras; example rows against the best of 1–3.
const best = (rules: typeof baselines) => rules.map(([n, f]) => ({ n, f, f1: f1(score(items, f)) })).sort((a, b) => b.f1 - a.f1)[0]!;
const bestBase = best(baselines);
const bestExtra = best(extras);
out.push("### Disagreements", "");
for (const run of runs) {
  for (const rule of [bestBase, bestExtra]) {
    const dis = items.filter((x) => (pOf(run, x) >= run.threshold) !== rule.f(x));
    const d1Right = dis.filter((x) => (pOf(run, x) >= run.threshold) === x.label).length;
    out.push(`- ${run.name} (p ≥ ${run.threshold}) vs ${rule.n}: disagree on ${dis.length} items; ${run.name} right on ${d1Right}, the rule on ${dis.length - d1Right}.`);
  }
}
const last = runs.at(-1)!;
const dis = shuffled(items.filter((x) => (pOf(last, x) >= last.threshold) !== bestBase.f(x)), 13719);
const d1Right = dis.filter((x) => (pOf(last, x) >= last.threshold) === x.label);
const ruleRight = dis.filter((x) => (pOf(last, x) >= last.threshold) !== x.label);
out.push("", `Examples, ${last.name} vs ${bestBase.n} (random; text cut to 10 words):`, "",
  "| person | proxy label | d1 p(needs) | rule | P wrote in the 4 before | message start |", "|---|---|---|---|---|---|");
for (const x of [...d1Right.slice(0, 5), ...ruleRight.slice(0, 5)]) {
  const w = x.text.replace(/\s+/g, " ").trim().replace(/\|/g, "/").split(" ");
  out.push(`| ${x.person} | ${x.label ? "needed" : "not"} | ${pOf(last, x).toFixed(2)} | ${bestBase.f(x) ? "needs" : "update"} | ${wroteBefore(x) ? "yes" : "no"} | @${x.author}: ${w.slice(0, 10).join(" ")}${w.length > 10 ? " …" : ""} |`);
}
console.log(out.join("\n"));
