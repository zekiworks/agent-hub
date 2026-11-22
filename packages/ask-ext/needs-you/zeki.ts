// How the shipped d1-2B agrees with @zeki's ratings of 300 agent messages for Ümit (Ümit #14116, Can OK #14119):
// "needs Ümit" judged from the message and what came before. Asks the live /v1/systemone one item at a time.
//
//   bun zeki.ts PORT DIR   (DIR holds items.jsonl and ratings.jsonl; writes DIR/d1-PHRASING.json and prints a table)
import { NEEDS, PHRASINGS, QUESTION, requestFor } from "../src/needs.ts";
import type { Item } from "./build.ts";

const [port, dir] = process.argv.slice(2);
if (!port || !dir) throw new Error("usage: bun zeki.ts PORT DIR");
type Raw = { id: number; room: string; before: { from: string; text: string }[]; message: { seq: number; from: string; text: string } };
const read = async <T>(f: string): Promise<T[]> => (await Bun.file(`${dir}/${f}`).text()).trim().split("\n").map((l) => JSON.parse(l) as T);
const raws = await read<Raw>("items.jsonl");
const ratings = new Map((await read<{ id: number; needs: string; outdated: string }>("ratings.jsonl")).map((r) => [r.id, r]));
const people = new Set(["can", "umit"]);

const asItem = (r: Raw): Item => ({
  person: "umit", seq: r.message.seq, at: 0, conversation: "", kind: "project", room: r.room, author: r.message.from,
  text: r.message.text, context: r.before.map((b) => ({ from: b.from, person: people.has(b.from), text: b.text })),
  people: ["umit", "can"], mentions: false, question: false, task: null, label: false, why: [], split: "test",
});

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const lines = ["| asked as | needs (zeki) | d1 says needs, cut 0.5 | agree | precision | recall |", "|---|---|---|---|---|---|"];
for (const phrasing of Object.keys(PHRASINGS)) {
  const rows: { id: number; zeki: boolean; p: number }[] = [];
  for (const r of raws) {
    const res = await fetch(`http://127.0.0.1:${port}/v1/systemone`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestFor(asItem(r), phrasing)) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const answer = (await res.json()) as { answers: Record<string, { probabilities: Record<string, number> }> };
    rows.push({ id: r.id, zeki: ratings.get(r.id)?.needs === "yes", p: answer.answers[QUESTION]?.probabilities[NEEDS] ?? NaN });
  }
  await Bun.write(`${dir}/d1-${phrasing}.json`, JSON.stringify(rows));
  const yes = rows.filter((r) => r.zeki).length;
  const said = rows.filter((r) => r.p >= 0.5);
  const both = said.filter((r) => r.zeki).length;
  const agree = rows.filter((r) => (r.p >= 0.5) === r.zeki).length;
  lines.push(`| ${phrasing} | ${yes}/${rows.length} | ${said.length} | ${pct(agree, rows.length)} | ${pct(both, said.length)} | ${pct(both, yes)} |`);
}
console.log(lines.join("\n"));
