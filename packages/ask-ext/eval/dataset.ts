// The "Ask @agent" dataset (Ümit #13030): people's messages in rooms that named nobody, each with the body the bus
// would have sent the recipient extension just before it was written, sampled into TEST and DEV with a fixed seed.
//
//   bun packages/ask-ext/eval/dataset.ts [--db PATH] [--days 21] [--test 100] [--dev 60] [--seed 13030]
//
// Reads the live bus database read-only. Writes ~/.agent-bus/ask-eval/items.jsonl and items-summary.json.
//
// What cannot be reconstructed (the database keeps only the present):
// - membership: the room's current members stand for its members then (an agent added later can be among `agents`);
// - edited messages: their current text (edited_at set) stands for the text then;
// - checklist: none. The database keeps only today's checklist (text, heading, owner, blocked as they are now, and no
//   date for when a step was added), so any reconstruction would show later evidence (codex-ui #13109). Historical
//   items are messages-only; checklist evidence is tested on the made-up rooms of packages/ask-ext/src/fixtures.ts.
// Messages deleted after the message are put back (they were on screen then); earlier deletions stay out.
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mentionedIds, type BoxRecipientBody, type ParticipantKind } from "@agent-bus/protocol";
import { EVAL_DIR, ITEMS_FILE, ensureEvalDir, flag, writeJsonl, type Item, type Lang, type Split } from "./common";

const DB_PATH = flag("db", join(homedir(), ".agent-bus", "message-bus.sqlite")) as string;
const DAYS = Number(flag("days", "21"));
const N_TEST = Number(flag("test", "100"));
const N_DEV = Number(flag("dev", "60"));
const SEED = Number(flag("seed", "13030"));
/** Messages the body carries (the bus's recipient body: the latest 20). */
const CONTEXT = 20;

interface Row {
  seq: number;
  conversation_id: string;
  from_id: string;
  from_kind: ParticipantKind;
  text: string;
  created_at: number;
  reply_to_seq: number | null;
  deleted_at: number | null;
}

interface Room {
  id: string;
  name: string;
  title: string | null;
  topic: string | null;
  members: string[];
}

/** mulberry32: a small seeded generator, so the sample is the same on every run over the same data. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const TR_LETTERS = /[çğışöüÇĞİŞÖÜ]/;
// Common Turkish words as typed without Turkish letters too ("icin", "degil"), and common English ones.
const TR_WORDS = new Set(
  "ve bir bu şu su ne mi mı mu mü için icin ama çok cok daha gibi var yok ile olarak sonra şimdi simdi nasıl nasil neden niye hangi bunu şunu sunu onu bana sana bize biz siz ben sen evet hayır hayir tamam değil degil lazım lazim olsun oldu olur olmaz yap yapın yapin yapalım yapalim bak bakın bakin misin musun mısın de da ki hem kadar kim nerede neler artık artik hala sadece hepsi tüm tum her şey sey işte iste bence yine yeni önce once gerek gerekiyor istiyorum diye mı? mi? onayı onayi veriyorum bitti başladı basladi niçin nicin yazın yazin söyle soyle burada orada şu an simdilik tamamdır tamamdir lütfen lutfen".split(
    " "
  )
);
const EN_WORDS = new Set(
  "the is are and to of a an it you we i this that not what do does can in on for with have be please should will was were how why which there they my our your if so but or no yes".split(" ")
);

/** Turkish verb and plural endings, as typed with or without Turkish letters ("veriyor", "demistim", "yapilmiycak"). */
const TR_SUFFIX = /(?:[iıuü]yor|yorum|yoruz|m[iı][sş]|d[iı]m|t[iı]m|d[iı]k|cak|cek|l[ae]r[iı]|[iı]n[iı]z|[iı]m[iı]z|s[iı]n[iı]z|ma[ld][iı]|me[ld]i)$/;

/** "tr" when Turkish letters and Turkish words lead, or Turkish words alone outnumber English ones; else "en". */
export function guessLang(text: string): Lang {
  const words = text.toLowerCase().split(/[^\p{L}?]+/u).filter(Boolean);
  const en = words.filter((w) => EN_WORDS.has(w)).length;
  const tr = words.filter((w) => TR_WORDS.has(w) || (w.length >= 5 && !EN_WORDS.has(w) && TR_SUFFIX.test(w))).length;
  if (TR_LETTERS.test(text)) return tr >= en ? "tr" : "en";
  return tr > en ? "tr" : "en";
}

/**
 * The text names someone: a participant (a room member or not: naming an outsider calls them in, so the person chose),
 * also as "@id-n", everyone ("@all") or a group ("@{…}"). The box would offer nothing then.
 */
function namesSomeone(text: string, known: ReadonlySet<string>): boolean {
  if (/(^|[\s({,])@\{/.test(text)) return true;
  return mentionedIds(text).some((id) => id === "all" || known.has(id) || known.has(id.replace(/-\d+$/, "")));
}

function main(): void {
  const db = new Database(DB_PATH, { readonly: true });
  const kinds = new Map(db.query<{ id: string; kind: ParticipantKind }, []>("SELECT id, kind FROM participants").all().map((p) => [p.id, p.kind]));
  const known = new Set(kinds.keys());
  const rooms = db
    .query<Omit<Room, "members">, []>("SELECT id, name, title, topic FROM conversations WHERE kind = 'project' AND room = 1")
    .all()
    .map((room) => ({
      ...room,
      members: db
        .query<{ p: string }, [string]>("SELECT participant_id p FROM conversation_members WHERE conversation_id = ?1 ORDER BY participant_id")
        .all(room.id)
        .map((r) => r.p),
    }));
  const since = Date.now() - DAYS * 86_400_000;
  const roomMessages = db.query<Row, [string]>(
    "SELECT seq, conversation_id, from_id, from_kind, text, created_at, reply_to_seq, deleted_at FROM messages WHERE conversation_id = ?1 ORDER BY seq"
  );
  const forwarded = db.query<{ seq: number }, []>("SELECT seq FROM messages WHERE forwarded_json IS NOT NULL").all();
  const isForwarded = new Set(forwarded.map((r) => r.seq));

  const candidates: Item[] = [];
  const dropped = { voice: 0, outsideWindow: 0, fewAgents: 0 };
  for (const room of rooms) {
    const all = roomMessages.all(room.id);
    for (const [index, m] of all.entries()) {
      if (m.from_kind !== "human" || kinds.get(m.from_id) !== "human") continue;
      if (m.deleted_at !== null || isForwarded.has(m.seq) || m.reply_to_seq !== null) continue;
      if (namesSomeone(m.text, known)) continue;
      // Voice messages are sent from the recording panel, not typed in the box: the box never sees them.
      if (m.text.startsWith("🎤")) {
        dropped.voice++;
        continue;
      }
      if (m.created_at < since) {
        dropped.outsideWindow++;
        continue;
      }
      const agents = room.members.filter((id) => id !== m.from_id && kinds.get(id) === "agent");
      if (agents.length < 2) {
        dropped.fewAgents++;
        continue;
      }
      const before = all.slice(0, index);
      const shown = before.filter((b) => b.deleted_at === null || b.deleted_at > m.created_at).slice(-CONTEXT);
      // wakeList's `answered` (db.lastAuthorBesides): deleted messages count there, as they do in the bus.
      const answered = before.findLast((b) => b.from_id !== m.from_id)?.from_id;
      const body: BoxRecipientBody = {
        v: 1,
        kind: "recipient",
        me: m.from_id,
        conversation: {
          id: room.id,
          kind: "project",
          name: room.name,
          ...(room.title ? { title: room.title } : {}),
          ...(room.topic ? { topic: room.topic } : {}),
          members: room.members,
        },
        messages: shown.map((b) => ({
          seq: b.seq,
          from: b.from_id,
          fromKind: b.from_kind,
          text: b.text,
          createdAt: b.created_at,
          ...(b.reply_to_seq !== null ? { replyTo: b.reply_to_seq } : {}),
        })),
        checklist: [],
        agents,
        draft: { text: m.text },
      };
      candidates.push({
        id: `m${m.seq}`,
        split: "test",
        seq: m.seq,
        sender: m.from_id,
        room: room.name,
        createdAt: m.created_at,
        lang: guessLang(m.text),
        body,
        rule: answered !== undefined && agents.includes(answered) ? answered : null,
      });
    }
  }

  const picked = sample(candidates);
  ensureEvalDir();
  writeJsonl(ITEMS_FILE, picked);
  const summary = {
    builtAt: new Date().toISOString(),
    db: DB_PATH,
    params: { days: DAYS, test: N_TEST, dev: N_DEV, seed: SEED, context: CONTEXT },
    candidates: tally(candidates),
    dropped,
    test: tally(picked.filter((i) => i.split === "test")),
    dev: tally(picked.filter((i) => i.split === "dev")),
  };
  writeFileSync(join(EVAL_DIR, "items-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  printSummary(summary);
}

/**
 * Half the items per sender (can, umit) when both have enough, the rest from the other; within a sender, rooms take
 * turns (round-robin, so a busy room cannot crowd out the others) and each room's picks are spread over its time
 * span. Turkish is kept at least at its share among the sender's candidates. Then TEST/DEV alternate in a fixed 5:3
 * pattern over the picks ordered by room and time, so both splits cover every room and the whole period.
 */
function sample(candidates: Item[]): Item[] {
  const rand = random(SEED);
  const total = N_TEST + N_DEV;
  const perSender = new Map<string, number>();
  for (const c of candidates) perSender.set(c.sender, (perSender.get(c.sender) ?? 0) + 1);
  const senders = [...perSender.keys()].sort();
  // The smaller sender first: it gets an equal share or all it has; the other takes the rest.
  const quota = new Map<string, number>();
  let left = total;
  const bySize = [...senders].sort((a, b) => (perSender.get(a) ?? 0) - (perSender.get(b) ?? 0));
  bySize.forEach((s, i) => {
    const share = Math.min(perSender.get(s) ?? 0, Math.floor(left / (bySize.length - i)));
    quota.set(s, share);
    left -= share;
  });

  const picked: Item[] = [];
  for (const sender of senders) {
    const mine = candidates.filter((c) => c.sender === sender);
    const want = quota.get(sender) ?? 0;
    const trShare = mine.filter((c) => c.lang === "tr").length / Math.max(1, mine.length);
    const wantTr = Math.round(want * trShare);
    const chosen = [
      ...roundRobin(mine.filter((c) => c.lang === "tr"), wantTr, rand),
      ...roundRobin(mine.filter((c) => c.lang === "en"), want - wantTr, rand),
    ];
    picked.push(...chosen);
  }
  picked.sort((a, b) => a.room.localeCompare(b.room) || a.createdAt - b.createdAt);
  const pattern: Split[] = ["test", "dev", "test", "test", "dev", "test", "dev", "test"]; // 5 test : 3 dev
  const split = picked.map((item, i) => ({ ...item, split: pattern[i % pattern.length] as Split }));
  // Fix the counts exactly when the totals are not a multiple of 8 (or the ratio is not 5:3).
  const tests = split.filter((i) => i.split === "test");
  const devs = split.filter((i) => i.split === "dev");
  const move = (from: Item[], to: Split, n: number) => shuffle(from, rand).slice(0, n).forEach((i) => (i.split = to));
  if (tests.length > N_TEST) move(tests, "dev", tests.length - N_TEST);
  if (devs.length > N_DEV) move(devs, "test", devs.length - N_DEV);
  return split.sort((a, b) => a.seq - b.seq);
}

/** `n` items, rooms in turn (in a shuffled order), each room's items taken spread across its time span. */
function roundRobin(items: Item[], n: number, rand: () => number): Item[] {
  const byRoom = new Map<string, Item[]>();
  for (const item of items) byRoom.set(item.room, [...(byRoom.get(item.room) ?? []), item]);
  const rooms = shuffle([...byRoom.keys()].sort(), rand);
  const takes = new Map(rooms.map((r) => [r, 0]));
  let taken = 0;
  while (taken < n && taken < items.length) {
    for (const room of rooms) {
      if (taken >= n) break;
      const have = takes.get(room) ?? 0;
      if (have < (byRoom.get(room)?.length ?? 0)) {
        takes.set(room, have + 1);
        taken++;
      }
    }
  }
  const out: Item[] = [];
  for (const room of rooms) {
    const list = (byRoom.get(room) ?? []).sort((a, b) => a.createdAt - b.createdAt);
    const k = takes.get(room) ?? 0;
    // One random message out of each of k equal stretches of the room's messages: spread over time.
    for (let i = 0; i < k; i++) {
      const lo = Math.floor((i * list.length) / k);
      const hi = Math.floor(((i + 1) * list.length) / k);
      out.push(list[lo + Math.floor(rand() * (hi - lo))] as Item);
    }
  }
  return out;
}

interface Tally {
  n: number;
  bySender: Record<string, number>;
  byLang: Record<string, number>;
  byRoom: Record<string, number>;
  ruleSilent: number;
  withChecklist: number;
  days: { from: string; to: string } | null;
}

function tally(items: Item[]): Tally {
  const by = (key: (i: Item) => string) => {
    const out: Record<string, number> = {};
    for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
  };
  const times = items.map((i) => i.createdAt);
  return {
    n: items.length,
    bySender: by((i) => i.sender),
    byLang: by((i) => i.lang),
    byRoom: by((i) => i.room),
    ruleSilent: items.filter((i) => i.rule === null).length,
    withChecklist: items.filter((i) => i.body.checklist.length > 0).length,
    days: times.length > 0 ? { from: new Date(Math.min(...times)).toISOString().slice(0, 10), to: new Date(Math.max(...times)).toISOString().slice(0, 10) } : null,
  };
}

function printSummary(summary: { candidates: Tally; dropped: object; test: Tally; dev: Tally }): void {
  for (const [name, t] of [["candidates", summary.candidates], ["TEST", summary.test], ["DEV", summary.dev]] as const) {
    console.log(`${name}: ${t.n} (${t.days?.from} … ${t.days?.to}); sender ${JSON.stringify(t.bySender)}; lang ${JSON.stringify(t.byLang)}; rule silent ${t.ruleSilent}; with checklist ${t.withChecklist}`);
    console.log(`  rooms: ${Object.entries(t.byRoom).map(([r, n]) => `${r} ${n}`).join(", ")}`);
  }
  console.log(`dropped: ${JSON.stringify(summary.dropped)}`);
  console.log(`wrote ${ITEMS_FILE}`);
}

if (import.meta.main) main();
