// The "needs you" dataset for Agent Hub (Ümit #13719): for each agent message a person can read, did it need that
// person? Reads the live database read-only.
//
// Items: (person P, agent message M) for P in can/umit, M from an agent, not deleted, in a conversation P is a member
// of (#all only when M @mentions P).
// Proxy label "needs P": within 12 h of M, P
//   - replied to M (reply_to_seq = M), or
//   - wrote in M's conversation with M among the last 3 messages before it, and P's message @mentions M's author or
//     comes directly after M (a message of P's that replies to another message does not count here), or
//   - acted on M's task/approval for P (state done or rejected).
// TEST = the latest 30% of the items by created_at (one cut-off for both people).
//
//   bun build.ts OUT_DIR    → OUT_DIR/items.jsonl (every item, with its context and split), OUT_DIR/stats.json
import { Database } from "bun:sqlite";
import { mentionedIds } from "../../protocol/src/index.ts";

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: bun build.ts OUT_DIR");
const PEOPLE = ["can", "umit"];
const WINDOW = 12 * 3600_000;
const LAST_N = 3;
const CONTEXT = 4;
const TEST_SHARE = 0.3;

const db = new Database(`${process.env.HOME}/.agent-bus/message-bus.sqlite`, { readonly: true });
type C = { id: string; kind: string; name: string | null; title: string | null };
const convs = new Map(db.query<C, []>("SELECT id, kind, name, title FROM conversations").all().map((c) => [c.id, c]));
const membersOf = new Map<string, string[]>();
for (const r of db.query<{ c: string; p: string }, []>("SELECT conversation_id c, participant_id p FROM conversation_members").all()) {
  (membersOf.get(r.c) ?? membersOf.set(r.c, []).get(r.c)!).push(r.p);
}
type M = {
  seq: number; conversation_id: string; from_id: string; from_kind: string; text: string; created_at: number;
  reply_to_seq: number | null; deleted_at: number | null; task_json: string | null;
};
const all = db.query<M, []>("SELECT seq, conversation_id, from_id, from_kind, text, created_at, reply_to_seq, deleted_at, task_json FROM messages ORDER BY seq").all();
const byConv = new Map<string, M[]>();
for (const m of all) if (m.deleted_at === null) (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m);
const repliesTo = new Map<number, M[]>();
for (const m of all) if (m.reply_to_seq !== null && m.deleted_at === null) (repliesTo.get(m.reply_to_seq) ?? repliesTo.set(m.reply_to_seq, []).get(m.reply_to_seq)!).push(m);

export type Item = {
  person: string; seq: number; at: number; conversation: string; kind: string; room: string; author: string;
  text: string; context: { from: string; person: boolean; text: string }[]; people: string[];
  mentions: boolean; question: boolean; task: string | null; label: boolean; why: string[]; split: "train" | "test";
};
const items: Item[] = [];

for (const [cid, msgs] of byConv) {
  const c = convs.get(cid)!;
  const members = membersOf.get(cid) ?? [];
  for (const person of PEOPLE) {
    const isAll = c.kind === "all";
    if (!isAll && !members.includes(person)) continue;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!;
      if (m.from_kind !== "agent" || !m.text.trim()) continue;
      const mentions = mentionedIds(m.text).includes(person);
      if (isAll && !mentions) continue;
      const why: string[] = [];
      if ((repliesTo.get(m.seq) ?? []).some((r) => r.from_id === person && r.created_at - m.created_at <= WINDOW)) why.push("replied");
      for (let j = i + 1; j < msgs.length && j <= i + LAST_N; j++) {
        const r = msgs[j]!;
        if (r.created_at - m.created_at > WINDOW) break;
        if (r.from_id !== person) continue;
        if (r.reply_to_seq !== null && r.reply_to_seq !== m.seq) continue;
        if (j === i + 1 || mentionedIds(r.text).includes(m.from_id)) why.push(j === i + 1 ? "next" : "mentioned author");
        break;
      }
      let task: string | null = null;
      if (m.task_json) {
        const t = JSON.parse(m.task_json) as { type: string; assignees: { id: string; state: string; at?: number }[] };
        const a = t.assignees.find((x) => x.id === person);
        if (a) {
          task = t.type;
          if ((a.state === "done" || a.state === "rejected") && a.at !== undefined && a.at - m.created_at <= WINDOW) why.push(`${t.type} ${a.state}`);
        }
      }
      items.push({
        person, seq: m.seq, at: m.created_at, conversation: cid, kind: c.kind,
        room: c.kind === "all" ? "#all" : c.name ? `#${c.name}` : (c.title ?? (c.kind === "dm" ? "a direct conversation" : "a group")),
        author: m.from_id, text: m.text,
        context: msgs.slice(Math.max(0, i - CONTEXT), i).map((b) => ({ from: b.from_id, person: b.from_kind === "human", text: b.text })),
        people: isAll ? [...PEOPLE] : members.filter((p) => PEOPLE.includes(p)),
        mentions, question: m.text.includes("?"), task, label: why.length > 0, why: [...new Set(why)], split: "train",
      });
    }
  }
}

items.sort((a, b) => a.at - b.at || a.seq - b.seq || a.person.localeCompare(b.person));
const nTest = Math.round(items.length * TEST_SHARE);
const cutoff = items[items.length - nTest]!.at;
for (const it of items) if (it.at >= cutoff) it.split = "test";
await Bun.write(`${OUT}/items.jsonl`, items.map((x) => JSON.stringify(x)).join("\n") + "\n");

// Stats: label counts per person and split, why, and agent messages per day per person.
const day = (ms: number) => new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Istanbul" });
const stats: Record<string, unknown> = {
  cutoff: new Date(cutoff).toISOString(), first: new Date(items[0]!.at).toISOString(), last: new Date(items.at(-1)!.at).toISOString(),
  items: items.length,
};
for (const person of PEOPLE) {
  const mine = items.filter((x) => x.person === person);
  const counts = (xs: Item[]) => ({ n: xs.length, needed: xs.filter((x) => x.label).length });
  const whyCounts: Record<string, number> = {};
  for (const x of mine) for (const w of x.why) whyCounts[w] = (whyCounts[w] ?? 0) + 1;
  const perDay = new Map<string, { all: number; needed: number }>();
  for (const x of mine) {
    const d = perDay.get(day(x.at)) ?? perDay.set(day(x.at), { all: 0, needed: 0 }).get(day(x.at))!;
    d.all++;
    if (x.label) d.needed++;
  }
  stats[person] = {
    all: counts(mine), train: counts(mine.filter((x) => x.split === "train")), test: counts(mine.filter((x) => x.split === "test")),
    why: whyCounts, mentions: mine.filter((x) => x.mentions).length, tasks: mine.filter((x) => x.task).length,
    per_day: Object.fromEntries([...perDay].sort()),
  };
}
await Bun.write(`${OUT}/stats.json`, JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats, null, 2));
