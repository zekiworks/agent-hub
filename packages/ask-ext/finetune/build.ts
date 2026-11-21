// The dataset for fine-tuning d1-2B on the bus's routing labels (Ümit #13659). Reads the live database read-only.
//
// Labelled items: as ~/.agent-bus/ask-eval/rule-vs-d1/active.ts builds them (can/umit in a project or group with 2+
// agents, naming nobody, not a reply, not voice, wake_json recorded; the answer key from what happened, Can #13591).
// TEST = the latest 30% of them by created_at; nothing at or after the first test message goes into training.
// Named items (training only): can/umit messages that start by naming exactly one of the room's agents (and name
// nobody else), before the test window; the draft is the message without that leading @mention, the label that agent.
//
//   bun build.ts OUT_DIR    → OUT_DIR/{train,test}.jsonl, OUT_DIR/stats.json
import { Database } from "bun:sqlite";
import { mentionedIds, mentionSpans, type BoxRecipientBody } from "../../protocol/src/index.ts";
import { decisionRequest } from "../src/decide.ts";

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: bun build.ts OUT_DIR");
const TEST_SHARE = 0.3;
const db = new Database(`${process.env.HOME}/.agent-bus/message-bus.sqlite`, { readonly: true });
const kind = new Map(db.query<{ id: string; kind: string }, []>("SELECT id, kind FROM participants").all().map((r) => [r.id, r.kind]));
const convs = db.query<{ id: string; kind: string; name: string | null; title: string | null; topic: string | null }, []>("SELECT id, kind, name, title, topic FROM conversations WHERE kind IN ('project','group')").all();
const membersOf = new Map<string, string[]>();
for (const r of db.query<{ c: string; p: string }, []>("SELECT conversation_id c, participant_id p FROM conversation_members").all()) {
  (membersOf.get(r.c) ?? membersOf.set(r.c, []).get(r.c)!).push(r.p);
}
type M = { seq: number; conversation_id: string; from_id: string; from_kind: string; text: string; created_at: number; reply_to_seq: number | null; wake_json: string | null; deleted_at: number | null };
const all = db.query<M, []>("SELECT seq, conversation_id, from_id, from_kind, text, created_at, reply_to_seq, wake_json, deleted_at FROM messages ORDER BY seq").all();
const byConv = new Map<string, M[]>();
for (const m of all) (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m);

type Item = {
  source: "labelled" | "named"; seq: number; at: number; who: string; conversation: string; agents: string[];
  right: string[]; rule?: string; request: unknown;
};
const labelled: Item[] = [];
const named: Item[] = [];

function bodyOf(c: (typeof convs)[number], members: string[], agents: string[], msgs: M[], i: number, draft: string): BoxRecipientBody {
  const m = msgs[i]!;
  const before = msgs.slice(0, i).filter((b) => b.deleted_at === null || b.deleted_at > m.created_at);
  return {
    v: 1, kind: "recipient", me: m.from_id,
    conversation: { id: c.id, kind: c.kind as "project" | "group", ...(c.name ? { name: c.name } : {}), ...(c.title ? { title: c.title } : {}), ...(c.topic ? { topic: c.topic } : {}), members },
    messages: before.slice(-20).map((b) => ({ seq: b.seq, from: b.from_id, fromKind: b.from_kind as "agent" | "human", text: b.text, createdAt: b.created_at, ...(b.reply_to_seq !== null ? { replyTo: b.reply_to_seq } : {}) })),
    checklist: [], agents, draft: { text: draft },
  };
}

for (const c of convs) {
  const members = membersOf.get(c.id) ?? [];
  const msgs = byConv.get(c.id) ?? [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if ((m.from_id !== "can" && m.from_id !== "umit") || m.deleted_at || m.reply_to_seq || m.text.startsWith("🎤")) continue;
    const agents = members.filter((a) => a !== m.from_id && kind.get(a) === "agent");
    if (agents.length < 2) continue;
    const mentioned = mentionedIds(m.text);
    if (!mentioned.some((id) => agents.includes(id) || id === "all")) {
      // active.ts, unchanged: the answer key from what happened.
      if (!m.wake_json) continue;
      const rule = (JSON.parse(m.wake_json) as string[])[0];
      const after = msgs.slice(i + 1).filter((x) => x.created_at - m.created_at <= 30 * 60_000);
      const nextOwn = after.find((x) => x.from_id === m.from_id);
      const corrected = nextOwn ? mentionedIds(nextOwn.text).filter((id) => agents.includes(id) && id !== rule) : [];
      let right: string[] | undefined;
      if (corrected.length > 0) right = corrected;
      else if (rule) {
        const reply = after.find((x) => x.from_id === rule);
        if (reply) { const passed: string[] = reply.wake_json ? JSON.parse(reply.wake_json).filter((x: string) => agents.includes(x) && x !== rule) : []; right = passed.length > 0 ? passed : [rule]; }
      } else {
        const first = after.find((x) => agents.includes(x.from_id));
        if (first) right = [first.from_id];
      }
      if (!right) continue;
      const before = msgs.slice(0, i).filter((b) => b.deleted_at === null || b.deleted_at > m.created_at);
      // The rule as active.ts scores it: the woken agent, or (a person wrote last) the last agent who wrote.
      const ruleOrRecent = rule ?? before.findLast((b) => agents.includes(b.from_id))?.from_id;
      const body = bodyOf(c, members, agents, msgs, i, m.text);
      labelled.push({ source: "labelled", seq: m.seq, at: m.created_at, who: m.from_id, conversation: c.id, agents, right, ...(ruleOrRecent ? { rule: ruleOrRecent } : {}), request: decisionRequest(body) });
      continue;
    }
    // Named: exactly one mention, at the start, of one of the room's agents.
    const spans = mentionSpans(m.text);
    if (spans.length !== 1 || mentioned.length !== 1 || !agents.includes(mentioned[0]!)) continue;
    const lead = m.text.length - m.text.trimStart().length;
    if (spans[0]!.start !== lead) continue;
    const draft = m.text.slice(spans[0]!.end).replace(/^[\s,:;.!-]+/, "").trim();
    if (draft.length < 3) continue;
    const body = bodyOf(c, members, agents, msgs, i, draft);
    named.push({ source: "named", seq: m.seq, at: m.created_at, who: m.from_id, conversation: c.id, agents, right: [mentioned[0]!], request: decisionRequest(body) });
  }
}

labelled.sort((a, b) => a.at - b.at || a.seq - b.seq);
const nTest = Math.round(labelled.length * TEST_SHARE);
const test = labelled.slice(labelled.length - nTest);
const cutoff = test[0]!.at;
const train = [...labelled.filter((x) => x.at < cutoff), ...named.filter((x) => x.at < cutoff)];
const lines = (xs: Item[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
await Bun.write(`${OUT}/train.jsonl`, lines(train));
await Bun.write(`${OUT}/test.jsonl`, lines(test));
const count = (xs: Item[], f: (x: Item) => boolean) => xs.filter(f).length;
const stats = {
  cutoff_ms: cutoff, cutoff: new Date(cutoff).toISOString(),
  labelled: labelled.length, test: test.length,
  test_by_sender: { can: count(test, (x) => x.who === "can"), umit: count(test, (x) => x.who === "umit") },
  train: train.length,
  train_labelled: count(train, (x) => x.source === "labelled"),
  train_named: count(train, (x) => x.source === "named"),
  named_total: named.length, named_in_test_window_dropped: count(named, (x) => x.at >= cutoff),
  first_labelled: new Date(labelled[0]!.at).toISOString(), last_labelled: new Date(labelled.at(-1)!.at).toISOString(),
  first_named: new Date(Math.min(...named.map((x) => x.at))).toISOString(),
};
await Bun.write(`${OUT}/stats.json`, JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats, null, 2));
