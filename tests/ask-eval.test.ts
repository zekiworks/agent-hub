// The "Ask @agent" comparison tools (packages/ask-ext/eval, Ümit #13030) on made-up items: the report's counts and
// cut-off choice, the labelling page's save and export, the language guess. No bus data, no model.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BoxRecipientBody } from "@agent-bus/protocol";
import type { Item, LabelLine, ResultLine } from "../packages/ask-ext/eval/common";

const dir = mkdtempSync(path.join(tmpdir(), "ask-eval-"));
process.env.ASK_EVAL_DIR = dir;
// Imported after ASK_EVAL_DIR is set: the eval modules read it when they load (the private data dir otherwise).
const { buildReport, chooseCutoffs } = await import("../packages/ask-ext/eval/report");
const { handle } = await import("../packages/ask-ext/eval/label-server");
const { guessLang } = await import("../packages/ask-ext/eval/dataset");
const common = await import("../packages/ask-ext/eval/common");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function body(draft: string): BoxRecipientBody {
  return {
    v: 1,
    kind: "recipient",
    me: "umit",
    conversation: { id: "c1", kind: "project", name: "launch", members: ["docs", "umit", "webapp"] },
    messages: [{ seq: 1, from: "webapp", fromKind: "agent", text: "Safari <tests> fail", createdAt: 0 }],
    checklist: [],
    agents: ["docs", "webapp"],
    draft: { text: draft },
  };
}

function item(id: string, split: "test" | "dev", rule: string | null, lang: "en" | "tr" = "en"): Item {
  return { id, split, seq: Number(id.slice(1)), sender: "umit", room: "launch", createdAt: 0, lang, body: body(`draft ${id}`), rule };
}

function result(id: string, recipient: string | null, confidence: number): ResultLine {
  return { item: id, model: "m", recipient, confidence, probabilities: {}, ms: 10 };
}

const label = (labels: string[], cannotJudge?: true): Omit<LabelLine, "item"> => ({ labels, at: 0, ...(cannotJudge ? { cannotJudge } : {}) });

test("report: counts, corrected and disrupted against the rule, cut-off from DEV", () => {
  const items = [
    item("m1", "test", "webapp"), // rule right; model right
    item("m2", "test", "webapp"), // rule wrong (docs wanted); model right → corrected
    item("m3", "test", "webapp"), // rule right; model wrong → disrupted (wrong agent)
    item("m4", "test", "webapp"), // rule right; model low confidence → silent → disrupted (silent)
    item("m5", "test", "webapp", "tr"), // none; rule wrong; model quiet
    item("m8", "test", "webapp"), // can't judge: left out of every number
    item("m6", "dev", "webapp"),
    item("m7", "dev", "docs"),
  ];
  const labels = new Map([
    ["m1", label(["webapp"])],
    ["m2", label(["docs"])],
    ["m3", label(["webapp"])],
    ["m4", label(["webapp", "docs"])],
    ["m5", label([])],
    ["m8", label([], true)],
    ["m6", label(["webapp"])],
    ["m7", label([])],
  ].map(([id, l]) => [id as string, { item: id as string, ...(l as Omit<LabelLine, "item">) }]));
  const results = new Map(
    [result("m1", "webapp", 0.9), result("m2", "docs", 0.8), result("m3", "docs", 0.7), result("m4", "webapp", 0.3), result("m5", null, 0.9), result("m8", "docs", 0.9), result("m6", "webapp", 0.9), result("m7", "docs", 0.4)].map((r) => [r.item, r])
  );
  const run = { model: "m", hardware: "test box", results };
  // DEV: at cut-off 0 the model offers m6 (right) and m7 (wrong): 50%; above 0.4 only m6: 100%.
  const choice = chooseCutoffs([run], items.filter((i) => i.split === "dev"), labels, 0.8);
  expect(choice.cutoffs.get("m")).toBeCloseTo(0.4, 6);
  const report = buildReport(items, labels, [run], 0.8);
  const rows = report.split("\n").filter((l) => l.startsWith("| "));
  const ruleRow = rows.find((r) => r.startsWith("| current rule"))?.split("|").map((c) => c.trim());
  const modelRow = rows.find((r) => r.startsWith("| m |"))?.split("|").map((c) => c.trim());
  // rule: shown 5, correct 3 (m1, m3, m4), wrong 2
  expect(ruleRow?.slice(3, 7)).toEqual(["5", "5 (100%)", "3 (60%)", "2"]);
  // model at 0.4: m1 right, m2 right, m3 wrong, m4 silent (missed), m5 quiet; corrected 1, disrupted 1 + 1
  expect(modelRow?.slice(3, 16)).toEqual(["5", "3 (60%)", "2 (40%)", "1", "67%", "1", "1", "1", "1", "1", "10 ms", "10 ms", "test box"]);
  expect(report).toContain("can't judge: 1 TEST, 0 DEV");
  expect(report).toContain("This historical comparison is messages-only");
  expect(report).toContain("| m | tr | 1 | 0 (0%) | 0 (0%) | 0 | – | 0 | 1 | 0 | 0 | 0 |");
});

test("label page: renders, saves by GET, refuses non-agents, exports", async () => {
  writeFileSync(common.ITEMS_FILE, [item("m1", "test", "webapp"), item("m2", "dev", null)].map((i) => JSON.stringify(i)).join("\n") + "\n");
  const get = (q: string) => handle(new Request(`http://127.0.0.1:7840${q}`));
  const first = await get("/?sender=umit").text();
  expect(first).toContain("draft m1");
  expect(first).toContain("Safari &#60;tests&#62; fail");
  expect(first).toContain('data-id="webapp"');
  expect(first).not.toMatch(/(href|src)="\//); // relative URLs only: the page lives under the bus's /ext/<name>/<key>/
  const saved = await get("/save?item=m1&labels=webapp,docs&sender=umit").text();
  expect(saved).toContain("Saved m1");
  expect(saved).toContain("draft m2");
  expect((await get("/save?item=m2&labels=release-bot")).status).toBe(400);
  expect((await get("/save?item=m2&labels=none,docs")).status).toBe(400);
  await get("/save?item=m2&labels=none");
  await get("/save?item=m1&labels=docs"); // the latest wins
  expect((await get("/save?item=m2&cannotJudge=1&labels=docs")).status).toBe(400);
  const cannot = await get("/save?item=m2&cannotJudge=1&sender=umit");
  expect(await cannot.text()).toContain("Saved m2: can’t judge.");
  expect(await (await get("/?item=m2")).text()).toContain('data-cannot="1" aria-pressed="true"');
  const exported = (await (await get("/labels.json")).json()) as { labels: Record<string, { labels: string[] }> };
  expect(exported.labels).toEqual({ m1: expect.objectContaining({ labels: ["docs"] }), m2: expect.objectContaining({ labels: [], cannotJudge: true }) });
  expect(common.latestLabels().get("m2")).toMatchObject({ labels: [], cannotJudge: true, by: "umit" });
  expect(JSON.parse(readFileSync(common.LABELS_EXPORT, "utf8")).count).toBe(2);
  expect((await get("/?item=nope")).status).toBe(404);
});

test("language guess: Turkish with and without its letters", () => {
  expect(guessLang("Zeki, logo fazla ufak kalmış")).toBe("tr");
  expect(guessLang("toolbench bitti mi?")).toBe("tr");
  expect(guessLang("truce yapilmiycak demistim logicte")).toBe("tr");
  expect(guessLang("do I need to reinstall antigravity?")).toBe("en");
  expect(guessLang("I asked Ümit about the release")).toBe("en");
});
