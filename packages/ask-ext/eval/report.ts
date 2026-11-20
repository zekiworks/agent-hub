// The "Ask @agent" report (Ümit #13030): the models against the current rule, on the senders' labels.
//
//   bun packages/ask-ext/eval/report.ts --results ~/.agent-bus/ask-eval/results-d1-cpu.jsonl,~/.agent-bus/ask-eval/results-glide-gpu.jsonl
//     [--labels ~/.agent-bus/ask-eval/labels.jsonl] [--min-precision 0.8] [--out ~/.agent-bus/ask-eval/report.md]
//
// Only labelled items count; items labelled "can't judge" are left out of every number and counted on their own line.
// Definitions (per item; `labels` = the agents the sender accepts, [] = none):
// - shown: the box offers an agent (model: its top choice is an agent with probability ≥ the cut-off; rule: below);
// - correct: the shown agent is among the labels (on a none-labelled item any shown agent is wrong);
// - wrong: shown and not correct; missed: silent where an agent was acceptable; quiet-right: silent on a none item;
// - corrected: an agent was acceptable, the rule was wrong or silent, the model shows an acceptable agent;
// - disrupted (wrong agent): the rule was correct, the model shows an agent that is not acceptable;
// - disrupted (silent): the rule was correct, the model shows nothing.
// The current rule (wakeList, packages/server/src/messages.ts): the author of the latest earlier message by someone
// else than the sender, as an offer only when that author is one of the room's agents.
//
// Cut-offs, chosen on DEV only: for each common suggestion rate R (shown / labelled items, from the highest down), each
// model takes the lowest cut-off whose DEV rate is at most R (so the models are compared at the same rate); the chosen
// R is the highest at which every model shows at least 5 DEV suggestions with DEV precision (correct / shown) at least
// --min-precision. That maximises the correct suggestions (they grow with the rate) while the box stays right often
// enough to be trusted, at a matched rate. When no rate reaches that for every model, each model takes the cut-off with
// the most correct − wrong on DEV instead (said in the report). The report shows the DEV sweep it chose from.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_DIR, ITEMS_FILE, LABELS_FILE, flag, latestLabels, readJsonl, type Item, type Lang, type LabelLine, type ResultLine } from "./common";

/** One model's results with how and where it ran. */
export interface Run {
  model: string;
  hardware: string;
  results: Map<string, ResultLine>;
}

interface Counts {
  n: number;
  shown: number;
  correct: number;
  wrong: number;
  missed: number;
  quietRight: number;
}

/** The agent the model offers at `cutoff`, or null. */
function offer(result: ResultLine | undefined, cutoff: number): string | null {
  if (!result || result.error !== undefined || result.recipient === null) return null;
  return result.confidence >= cutoff ? result.recipient : null;
}

/** The acceptable agents of a labelled item ([] = none); undefined when unlabelled or labelled "can't judge". */
function judged(labels: ReadonlyMap<string, LabelLine>, id: string): string[] | undefined {
  const line = labels.get(id);
  return line && !line.cannotJudge ? line.labels : undefined;
}

function count(items: readonly Item[], labels: ReadonlyMap<string, LabelLine>, shownFor: (item: Item) => string | null): Counts {
  const c: Counts = { n: 0, shown: 0, correct: 0, wrong: 0, missed: 0, quietRight: 0 };
  for (const item of items) {
    const ok = judged(labels, item.id);
    if (!ok) continue;
    c.n++;
    const shown = shownFor(item);
    if (shown === null) {
      if (ok.length > 0) c.missed++;
      else c.quietRight++;
    } else {
      c.shown++;
      if (ok.includes(shown)) c.correct++;
      else c.wrong++;
    }
  }
  return c;
}

/** The candidate cut-offs of a run: 0 and just above each top-choice probability (each drops one more offer). */
function cutoffs(run: Run, items: readonly Item[]): number[] {
  const set = new Set([0]);
  for (const item of items) {
    const r = run.results.get(item.id);
    if (r && r.recipient !== null && r.error === undefined) set.add(r.confidence + 1e-9);
  }
  return [...set].sort((a, b) => a - b);
}

export interface Choice {
  cutoffs: Map<string, number>;
  how: string;
  /** Markdown table: per DEV suggestion rate, each model's cut-off, correct and precision there. */
  sweep: string;
}

/** DEV suggestions a precision needs before it counts (fewer: too noisy to pick a cut-off on). */
const MIN_SHOWN = 5;

/** The cut-offs per model, from DEV (see the header). */
export function chooseCutoffs(runs: readonly Run[], dev: readonly Item[], labels: ReadonlyMap<string, LabelLine>, minPrecision: number): Choice {
  const sweeps = runs.map((run) =>
    cutoffs(run, dev).map((cut) => ({ cut, ...count(dev, labels, (item) => offer(run.results.get(item.id), cut)) }))
  );
  const n = count(dev, labels, () => null).n;
  if (n === 0) {
    return { cutoffs: new Map(runs.map((r) => [r.model, 0])), how: "no labelled DEV items, so no cut-off could be chosen: 0 for every model (every top-choice agent shown)", sweep: "" };
  }
  // Each model's lowest cut-off whose DEV suggestions are at most `shownMax`: the models at a matched rate.
  const at = (shownMax: number) => sweeps.map((sweep) => sweep.find((s) => s.shown <= shownMax));
  const rows = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((tenth) => {
    const shownMax = Math.floor((tenth * n) / 10);
    const cells = at(shownMax).map((p) => (p ? `${p.cut.toFixed(3)}: ${p.shown} shown, ${p.correct} correct (${pct(p.correct, p.shown)})` : "–"));
    return `| ≤ ${tenth * 10}% | ${cells.join(" | ")} |`;
  });
  const sweep = [`| DEV rate | ${runs.map((r) => r.model).join(" | ")} |`, `|---|${runs.map(() => "---|").join("")}`, ...rows].join("\n");
  for (let shownMax = n; shownMax >= MIN_SHOWN; shownMax--) {
    const picks = at(shownMax);
    if (picks.every((p) => p !== undefined && p.shown >= MIN_SHOWN && p.correct / p.shown >= minPrecision)) {
      return {
        cutoffs: new Map(runs.map((run, i) => [run.model, picks[i]?.cut ?? 0])),
        how: `matched DEV suggestion rate ≤ ${pct(shownMax, n)} (${shownMax}/${n} labelled DEV items), the highest at which every model shows at least ${MIN_SHOWN} and its DEV precision is ≥ ${pct(minPrecision, 1)}`,
        sweep,
      };
    }
  }
  const best = sweeps.map((sweep) => sweep.reduce((a, b) => (b.correct - b.wrong > a.correct - a.wrong ? b : a)));
  return {
    cutoffs: new Map(runs.map((run, i) => [run.model, best[i]?.cut ?? 0])),
    how: `no common DEV suggestion rate gives every model at least ${MIN_SHOWN} suggestions at precision ≥ ${pct(minPrecision, 1)}: each model's cut-off maximises correct − wrong on DEV instead (rates not matched)`,
    sweep,
  };
}

function pct(a: number, b: number): string {
  return b === 0 ? "–" : `${Math.round((100 * a) / b)}%`;
}

function quantile(sorted: readonly number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

const ms = (v: number | undefined) => (v === undefined ? "–" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);

type System = { name: string; cut?: number; shownFor: (item: Item) => string | null; run?: Run };

/** Cells of a system on `items`: labelled, shown, correct, wrong, precision, missed, quiet on none, then (models only) corrected and both disruptions. */
function metricCells(items: readonly Item[], labels: ReadonlyMap<string, LabelLine>, s: System): string[] {
  const c = count(items, labels, s.shownFor);
  let corrected = 0;
  let disruptedWrong = 0;
  let disruptedSilent = 0;
  for (const item of items) {
    const ok = judged(labels, item.id);
    if (!ok || !s.run) continue;
    const ruleRight = item.rule !== null && ok.includes(item.rule);
    const shown = s.shownFor(item);
    if (ok.length > 0 && !ruleRight && shown !== null && ok.includes(shown)) corrected++;
    if (ruleRight && shown !== null && !ok.includes(shown)) disruptedWrong++;
    if (ruleRight && shown === null) disruptedSilent++;
  }
  const versusRule = s.run ? [String(corrected), String(disruptedWrong), String(disruptedSilent)] : ["–", "–", "–"];
  return [
    String(c.n),
    `${c.shown} (${pct(c.shown, c.n)})`,
    `${c.correct} (${pct(c.correct, c.n)})`,
    String(c.wrong),
    pct(c.correct, c.shown),
    String(c.missed),
    String(c.quietRight),
    ...versusRule,
  ];
}

const METRIC_HEADS = "labelled | shown | correct | wrong | precision | missed | quiet on none | corrected vs rule | disrupted: wrong agent | disrupted: silent";

/** The report as markdown. */
export function buildReport(items: readonly Item[], labels: ReadonlyMap<string, LabelLine>, runs: readonly Run[], minPrecision: number): string {
  const test = items.filter((i) => i.split === "test");
  const dev = items.filter((i) => i.split === "dev");
  const labelled = (list: readonly Item[]) => list.filter((i) => judged(labels, i.id)).length;
  const cannotJudge = (list: readonly Item[]) => list.filter((i) => labels.get(i.id)?.cannotJudge === true).length;
  const choice = chooseCutoffs(runs, dev, labels, minPrecision);
  const systems: System[] = [
    { name: "current rule (last other author)", shownFor: (item: Item) => item.rule },
    ...runs.map((run) => {
      const cut = choice.cutoffs.get(run.model) ?? 0;
      return { name: run.model, cut, run, shownFor: (item: Item) => offer(run.results.get(item.id), cut) };
    }),
  ];
  const out: string[] = [];
  out.push(`# Ask @agent: models against the current rule`, "");
  out.push(`Items: TEST ${test.length} (${labelled(test)} labelled), DEV ${dev.length} (${labelled(dev)} labelled). Only labelled items count.`, "");
  out.push(`can't judge: ${cannotJudge(test)} TEST, ${cannotJudge(dev)} DEV (the sender could not tell from what the room showed; left out of every number below).`, "");
  out.push(
    `This historical comparison is messages-only: the database keeps only today's checklist, so no checklist context goes into these items (it would show later evidence; codex-ui #13109). Checklist evidence is tested separately, on the made-up rooms of packages/ask-ext/src/fixtures.ts.`,
    ""
  );
  out.push(`Cut-offs (on DEV): ${choice.how}. ${runs.map((r) => `${r.model} ${(choice.cutoffs.get(r.model) ?? 0).toFixed(3)}`).join(", ") || "no models"}.`, "");

  if (choice.sweep) out.push(`DEV sweep (each model's lowest cut-off at most at that suggestion rate):`, "", choice.sweep, "");
  out.push(`## TEST`, "");
  out.push(`| system | cut-off | ${METRIC_HEADS} | latency median | latency p90 | hardware |`);
  out.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const s of systems) {
    const times = s.run ? [...s.run.results.values()].filter((r) => r.error === undefined).map((r) => r.ms).sort((a, b) => a - b) : [];
    const latency = s.run ? [ms(quantile(times, 0.5)), ms(quantile(times, 0.9)), s.run.hardware] : ["0 (no call)", "–", "the bus"];
    out.push(`| ${s.name} | ${s.cut === undefined ? "–" : s.cut.toFixed(3)} | ${[...metricCells(test, labels, s), ...latency].join(" | ")} |`);
  }
  out.push("");
  out.push(`Latency: client wall time per call (one call at a time, after warm-up), over all items the model answered (TEST and DEV).`, "");

  const splits: Array<[title: string, column: string, parts: Array<[string, Item[]]>]> = [
    ["TEST by language", "language", (["en", "tr"] as Lang[]).map((lang) => [lang, test.filter((i) => i.lang === lang)])],
  ];
  for (const [title, column, parts] of splits) {
    out.push(`## ${title}`, "");
    out.push(`| system | ${column} | ${METRIC_HEADS} |`);
    out.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const s of systems) for (const [part, list] of parts) out.push(`| ${s.name} | ${part} | ${metricCells(list, labels, s).join(" | ")} |`);
    out.push("");
  }
  const noneItems = test.filter((i) => judged(labels, i.id)?.length === 0).length;
  out.push(`Labels on TEST: ${noneItems} none, ${labelled(test) - noneItems} with an acceptable agent, ${cannotJudge(test)} can't judge. Failed calls count as silent: ${runs.map((r) => `${r.model} ${[...r.results.values()].filter((x) => x.error !== undefined).length}`).join(", ") || "–"}.`, "");
  out.push(`Definitions: shown = an agent offered; correct = offered agent among the sender's labels (any offer on a none-labelled item is wrong); missed = silent where an agent was acceptable; quiet on none = silent on a none-labelled item; corrected = an agent was acceptable, the rule was wrong or silent and the model offered an acceptable agent; disrupted: wrong agent = the rule was right and the model offered an unacceptable agent; disrupted: silent = the rule was right and the model stayed silent.`);
  return out.join("\n") + "\n";
}

function loadRun(path: string): Run {
  const results = new Map(readJsonl<ResultLine>(path).map((r) => [r.item, r]));
  const metaPath = `${path}.meta.json`;
  const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as { model?: string; hardware?: string }) : {};
  const model = meta.model ?? [...results.values()][0]?.model ?? path;
  return { model, hardware: meta.hardware ?? "unknown", results };
}

if (import.meta.main) {
  const paths = (flag("results") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const labelsPath = flag("labels", LABELS_FILE) as string;
  const labels = latestLabels(labelsPath);
  if (labels.size === 0) {
    console.error(`No labels in ${labelsPath}: no accuracy to report yet.`);
    process.exit(1);
  }
  const items = readJsonl<Item>(flag("items", ITEMS_FILE) as string);
  const runs = paths.map(loadRun);
  const names = runs.map((r) => r.model);
  // Two runs of one model (CPU and GPU): told apart by their hardware.
  for (const run of runs) if (names.filter((n) => n === run.model).length > 1) run.model = `${run.model} (${run.hardware})`;
  const report = buildReport(items, labels, runs, Number(flag("min-precision", "0.8")));
  const out = flag("out", join(EVAL_DIR, "report.md")) as string;
  writeFileSync(out, report);
  console.log(report);
  console.log(`(written to ${out})`);
}
