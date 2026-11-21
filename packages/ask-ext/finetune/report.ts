// The table on the TEST set (build.ts) from eval.ts's answers: the rule, untrained and trained d1 with "none" and
// forced, per sender and overall; and the trained model's calibration (forced and with "none").
//
//   bun report.ts BASE.json TRAINED.json > table.md
const [basePath, trainedPath] = process.argv.slice(2);
if (!basePath || !trainedPath) throw new Error("usage: bun report.ts BASE_JSON TRAINED_JSON");
type Answer = { pick: string | null; confidence: number };
type Row = { seq: number; who: string; right: string[]; rule: string | null; withNone: Answer; forced: Answer };
const base: Row[] = await Bun.file(basePath).json();
const trained: Row[] = await Bun.file(trainedPath).json();
const trainedBySeq = new Map(trained.map((r) => [r.seq, r]));
if (base.length !== trained.length || base.some((r) => !trainedBySeq.has(r.seq))) throw new Error("the two runs differ in items");

const hit = (pick: string | null, r: Row) => pick !== null && r.right.includes(pick);
const columns: [string, (r: Row) => boolean][] = [
  ["rule (last agent who wrote)", (r) => hit(r.rule, r)],
  ["untrained d1, with none", (r) => hit(r.withNone.pick, r)],
  ["untrained d1, forced", (r) => hit(r.forced.pick, r)],
  ["trained d1, forced", (r) => hit(trainedBySeq.get(r.seq)!.forced.pick, r)],
  ["trained d1, with none", (r) => hit(trainedBySeq.get(r.seq)!.withNone.pick, r)],
];
const pct = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0}%)`;
const groups: [string, Row[]][] = [["can", base.filter((r) => r.who === "can")], ["umit", base.filter((r) => r.who === "umit")], ["all", base]];
const lines = [`| | ${groups.map(([g, rs]) => `${g} (n=${rs.length})`).join(" | ")} |`, `|---|${groups.map(() => "---").join("|")}|`];
for (const [name, ok] of columns) lines.push(`| ${name} | ${groups.map(([, rs]) => pct(rs.filter(ok).length, rs.length)).join(" | ")} |`);
lines.push("", "Trained d1, calibration (accuracy among the items whose confidence reaches the cut):", "", "| cut | forced | with none (a \"none\" counts as wrong) |", "|---|---|---|");
for (const cut of [0.5, 0.7, 0.9]) {
  const cell = (mode: "forced" | "withNone") => {
    const sure = trained.filter((r) => r[mode].confidence >= cut);
    return `${pct(sure.filter((r) => hit(r[mode].pick, r)).length, sure.length)} right; ${sure.length}/${trained.length} items reach it`;
  };
  lines.push(`| ≥ ${cut} | ${cell("forced")} | ${cell("withNone")} |`);
}
const nonePicks = (rows: Row[]) => rows.filter((r) => r.withNone.pick === null).length;
lines.push("", `"none" (or no agent) picked, with none: untrained ${nonePicks(base)}/${base.length}, trained ${nonePicks(trained)}/${trained.length}.`);
console.log(lines.join("\n"));

// codex-ui #13704: each d1 variant as an override of the rule, only where it picks another agent than the rule.
const variants: [string, Row[], "forced" | "withNone"][] = [
  ["untrained d1, with none", base, "withNone"], ["untrained d1, forced", base, "forced"],
  ["trained d1, forced", trained, "forced"], ["trained d1, with none", trained, "withNone"],
];
const overrides = ["", "d1 as an override of the rule (where it picks another agent than the rule; \"none\" never overrides):", "",
  "| variant | cut | overrides | fix a rule miss | break a rule hit | miss stays a miss | right overall |", "|---|---|---|---|---|---|---|"];
for (const [name, rows, mode] of variants) {
  for (const cut of [0.5, 0.7, 0.9]) {
    const over = rows.filter((r) => r[mode].pick !== null && r[mode].pick !== r.rule && r[mode].confidence >= cut);
    const fixed = over.filter((r) => hit(r[mode].pick, r) && !hit(r.rule, r)).length;
    const broken = over.filter((r) => !hit(r[mode].pick, r) && hit(r.rule, r)).length;
    const stays = over.filter((r) => !hit(r[mode].pick, r) && !hit(r.rule, r)).length;
    const right = rows.filter((r) => hit(r.rule, r)).length + fixed - broken;
    overrides.push(`| ${name} | ≥ ${cut} | ${over.length} | ${fixed} | ${broken} | ${stays} | ${pct(right, rows.length)} |`);
  }
}
console.log(overrides.join("\n"));
