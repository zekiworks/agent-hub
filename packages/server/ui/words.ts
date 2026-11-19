// Completing the word being typed from word lists (Can #12953, #12955): English and Turkish, built from Tatoeba's
// sentences by scripts/build-words.ts. A word is ranked by how often it follows the word before it, smoothed
// (interpolated Kneser-Ney) with how many different words it follows, so "…into a t" prefers "tab" to "the". The
// conversation's own messages count too, so its names and words ("checklist", "webapp") come first.
//
// Turkish typed without its letters ("gorusuruz") finds its words: matching ignores ç ğ ı ö ş ü, and the rest of
// the word comes in the same style (without them) unless the draft already has them. Everything runs in the page:
// nothing typed leaves it.

type Lang = "en" | "tr";

interface List {
  lang: Lang;
  words: string[];
  /** How often each word occurs (the first, "", is the start of a sentence: the number of sentences). */
  count: Uint32Array;
  /** After how many different words it was seen, and before how many (Kneser-Ney's continuation count). */
  followers: Uint32Array;
  preceders: Uint32Array;
  /** All preceders added up: the number of different pairs. */
  pairTypes: number;
  /** For each word, the words most often after it: index → count. */
  next: Map<number, Map<number, number>>;
  /** Folded word → index (the most frequent word of that spelling), and the folded words sorted, for prefixes. */
  index: Map<string, number>;
  sorted: Array<[string, number]>;
}

/** Kneser-Ney's discount. */
const DISCOUNT = 0.75;
/**
 * The letters offered carry at least this share of the weight of all words that fit what is typed. Tuned on Can's
 * and Ümit's last 364 typed messages, cut at every letter of every longer word: at 0.7, 86% of what shows is right
 * and it types 28,000 of their letters (0.5: 79%, 32,000).
 */
const MIN_SHARE = 0.7;
/** Letters typed before a completion is offered. */
const MIN_TYPED = 2;
/** How much the conversation's own messages count, once it has this many words. */
const LOCAL_WEIGHT = 0.35;
const LOCAL_FULL = 200;

const TURKISH = /[çğıöşüÇĞİÖŞÜ]/;
const FOLD: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" };

function lower(text: string, lang: Lang): string {
  return text.toLocaleLowerCase(lang);
}

/** Without Turkish letters and accents: what someone typing without them would write. */
export function fold(text: string): string {
  return text.replace(/[çğıöşüâîû]/g, (c) => FOLD[c] ?? c);
}

/** The words of a text: letters, with an apostrophe inside ("don't", "Ankara'ya"); as typed (case kept). */
function wordsOf(text: string): string[] {
  return (text.match(/\p{L}+(?:['’]\p{L}+)*/gu) ?? []).map((w) => w.replace(/’/g, "'"));
}

export function parseList(lang: Lang, text: string): List {
  const lines = text.split("\n").filter((line) => !line.startsWith("#"));
  const blank = lines.indexOf("");
  const rows = lines.slice(0, blank);
  const n = rows.length;
  const list: List = {
    lang,
    words: new Array<string>(n),
    count: new Uint32Array(n),
    followers: new Uint32Array(n),
    preceders: new Uint32Array(n),
    pairTypes: 0,
    next: new Map(),
    index: new Map(),
    sorted: [],
  };
  rows.forEach((row, i) => {
    const [word = "", count, followers, preceders] = row.split(" ");
    list.words[i] = i === 0 ? "" : word;
    list.count[i] = Number(count);
    list.followers[i] = Number(followers);
    list.preceders[i] = Number(preceders);
    list.pairTypes += Number(preceders);
    if (i > 0) {
      const key = fold(word);
      if (!list.index.has(key)) list.index.set(key, i);
      list.sorted.push([key, i]);
    }
  });
  list.sorted.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  for (const line of lines.slice(blank + 1)) {
    if (!line) continue;
    const [from = "", ...pairs] = line.split(" ");
    const after = new Map<number, number>();
    for (const pair of pairs) {
      const [w = "", c = ""] = pair.split(":");
      after.set(parseInt(w, 36), parseInt(c, 36));
    }
    list.next.set(parseInt(from, 36), after);
  }
  return list;
}

/** How likely `w` is after `prev` (undefined: a word the list does not know): interpolated Kneser-Ney. */
function probability(list: List, prev: number | undefined, w: number): number {
  const continuation = (list.preceders[w]! + 0.5) / list.pairTypes;
  if (prev === undefined || list.count[prev] === 0) return continuation;
  const total = list.count[prev]!;
  const seen = list.next.get(prev)?.get(w) ?? 0;
  return Math.max(seen - DISCOUNT, 0) / total + ((DISCOUNT * list.followers[prev]!) / total) * continuation;
}

/** The list's words whose folded spelling starts with `prefix` (folded). */
function startingWith(list: List, prefix: string): Array<[string, number]> {
  let lo = 0;
  let hi = list.sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list.sorted[mid]![0] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out: Array<[string, number]> = [];
  for (let i = lo; i < list.sorted.length && list.sorted[i]![0].startsWith(prefix); i++) out.push(list.sorted[i]!);
  return out;
}

/** The conversation's own words: how often each (folded) occurs, the pairs, and each word's usual spelling. */
interface Local {
  key: string;
  total: number;
  count: Map<string, number>;
  pairs: Map<string, Map<string, number>>;
  spelling: Map<string, string>;
  hits: Record<Lang, number>;
}

let lists: List[] = [];
let loading: Promise<void> | undefined;
let local: Local | undefined;

/** Loads the lists once; `then` runs when they are there. A list that cannot be loaded is simply not used. */
export function loadWords(): Promise<void> {
  loading ??= Promise.all(
    (["en", "tr"] as const).map(async (lang) => {
      const res = await fetch(`/words-${lang}.txt`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseList(lang, await res.text());
    })
  )
    .then((loaded) => void (lists = loaded))
    .catch(() => undefined);
  return loading;
}

/** Only for tests: lists given directly. */
export function useLists(given: List[]): void {
  lists = given;
  local = undefined;
}

function localOf(key: string, texts: readonly string[]): Local {
  if (local?.key === key) return local;
  const built: Local = { key, total: 0, count: new Map(), pairs: new Map(), spelling: new Map(), hits: { en: 0, tr: 0 } };
  for (const text of texts) {
    for (const sentence of text.split(/[.!?;:\n]+/)) {
      let prev = "";
      for (const word of wordsOf(sentence)) {
        const key = fold(lower(word, "tr"));
        built.total += 1;
        built.count.set(key, (built.count.get(key) ?? 0) + 1);
        if (!built.spelling.has(key) || word === word.toLowerCase()) built.spelling.set(key, word);
        let after = built.pairs.get(prev);
        if (!after) built.pairs.set(prev, (after = new Map()));
        after.set(key, (after.get(key) ?? 0) + 1);
        prev = key;
      }
    }
  }
  for (const list of lists) for (const [key, n] of built.count) if (list.index.has(key)) built.hits[list.lang] += n;
  local = built;
  return built;
}

/**
 * How much each language counts for this draft: the words already typed (and, when the draft is short, the
 * conversation's), found in each list; a Turkish letter anywhere makes it Turkish.
 */
function languageWeights(earlier: string[], draft: string, conversation: Local | undefined): Record<Lang, number> {
  const hits: Record<Lang, number> = { en: 0, tr: TURKISH.test(draft) ? 5 : 0 };
  for (const word of earlier.slice(-8)) {
    for (const list of lists) {
      const i = list.index.get(fold(lower(word, list.lang)));
      if (i !== undefined) hits[list.lang] += 1;
    }
  }
  if (conversation && earlier.length < 3) {
    const sum = conversation.hits.en + conversation.hits.tr || 1;
    hits.en += (2 * conversation.hits.en) / sum;
    hits.tr += (2 * conversation.hits.tr) / sum;
  }
  const total = hits.en + hits.tr + 2;
  return { en: (hits.en + 1) / total, tr: (hits.tr + 1) / total };
}

/** The draft reads as Turkish: its words are mostly in the Turkish list, or it has Turkish letters. */
export function looksTurkish(draft: string): boolean {
  if (lists.length === 0) return TURKISH.test(draft);
  return languageWeights(wordsOf(draft), draft, undefined).tr > 0.65;
}

/**
 * The rest of the word being typed at the end of `draft` ("" when nothing is sure enough): `texts` are the
 * conversation's messages (counted once per `key`).
 */
export function completeWord(draft: string, key: string, texts: readonly string[]): string {
  if (lists.length === 0) return "";
  const typed = /(?:^|[^\p{L}'’])(\p{L}+(?:['’]\p{L}*)*)$/u.exec(draft)?.[1];
  if (!typed || [...typed.replace(/['’]/g, "")].length < MIN_TYPED) return "";
  const before = draft.slice(0, draft.length - typed.length);
  // The word before it, unless a sentence ended between them: then what starts a sentence.
  const earlier = wordsOf(before);
  const prevWord = /[.!?\n]\s*$/.test(before) || earlier.length === 0 ? undefined : earlier[earlier.length - 1];
  const conversation = texts.length > 0 ? localOf(key, texts) : undefined;
  const weights = languageWeights(earlier, draft, conversation);
  const localWeight = conversation ? LOCAL_WEIGHT * Math.min(1, conversation.total / LOCAL_FULL) : 0;
  const withTurkish = TURKISH.test(draft);

  // Each word that fits, by its spelling as it would be added, with its score summed over lists and the conversation.
  const scores = new Map<string, number>();
  const add = (word: string, score: number): void => void scores.set(word, (scores.get(word) ?? 0) + score);

  for (const list of lists) {
    const typedLower = lower(typed, list.lang);
    const prefix = fold(typedLower);
    const prev = prevWord === undefined ? 0 : list.index.get(fold(lower(prevWord, list.lang)));
    const weight = weights[list.lang] * (1 - localWeight);
    for (const [, i] of startingWith(list, prefix)) {
      const word = list.words[i]!;
      // Typed with Turkish letters: only words with those letters there.
      if (TURKISH.test(typedLower) && !word.startsWith(typedLower)) continue;
      add(word, weight * probability(list, prev, i));
    }
  }
  if (conversation && localWeight > 0) {
    const prefix = fold(lower(typed, "tr"));
    const prevKey = prevWord === undefined ? "" : fold(lower(prevWord, "tr"));
    const after = conversation.pairs.get(prevKey);
    const afterTotal = after ? [...after.values()].reduce((a, b) => a + b, 0) : 0;
    for (const [key, n] of conversation.count) {
      if (!key.startsWith(prefix)) continue;
      if (TURKISH.test(typed) && !lower(conversation.spelling.get(key)!, "tr").startsWith(lower(typed, "tr"))) continue;
      const unigram = n / conversation.total;
      const p = after ? ((after.get(key) ?? 0) + unigram) / (afterTotal + 1) : unigram;
      add(conversation.spelling.get(key)!, localWeight * p);
    }
  }

  // The same word from a list (lower case) and the conversation (its own spelling) count together.
  const merged = new Map<string, { spelling: string; score: number }>();
  for (const [word, score] of scores) {
    const key = fold(lower(word, "tr"));
    const seen = merged.get(key);
    if (!seen) merged.set(key, { spelling: word, score });
    else {
      seen.score += score;
      if (word !== lower(word, "tr")) seen.spelling = word;
    }
  }
  // How far the word is sure: letter by letter, while most of the weight goes the same way. "Th" goes on to "the"
  // and stops there (more weight ends there than goes on to "they"); "toplant" goes on to "toplantı" though no one
  // form of it ("toplantıya", "toplantıda") is sure, which suits a language that builds words by adding endings.
  const entries = [...merged].map(([key, entry]) => ({ key, ...entry }));
  const total = entries.reduce((sum, e) => sum + e.score, 0);
  if (total === 0) return "";
  let prefix = fold(lower(typed, "tr"));
  let fitting = entries;
  for (;;) {
    const ending = fitting.filter((e) => e.key === prefix).reduce((sum, e) => sum + e.score, 0);
    const byLetter = new Map<string, number>();
    for (const e of fitting) {
      const letter = e.key[prefix.length];
      if (letter !== undefined) byLetter.set(letter, (byLetter.get(letter) ?? 0) + e.score);
    }
    const [letter, weight] = [...byLetter].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    if (!letter || weight <= ending || weight / total < MIN_SHARE) break;
    prefix += letter;
    fitting = fitting.filter((e) => e.key.startsWith(prefix));
  }
  const added = prefix.length - typed.length;
  const wholeWord = fitting.some((e) => e.key === prefix);
  // One letter is worth offering only when it ends a word ("th" → "the").
  if (added < 1 || (added < 2 && !wholeWord)) return "";
  const word = fitting.reduce((a, b) => (b.score > a.score ? b : a)).spelling.slice(0, prefix.length);

  // The rest, in the style typed: without Turkish letters unless the draft has them and the word matches as typed.
  const asTyped = lower(word, withTurkish ? "tr" : "en").startsWith(lower(typed, withTurkish ? "tr" : "en"));
  let rest = word.slice(typed.length);
  if (!withTurkish || !asTyped) rest = fold(rest);
  if (typed.length >= 2 && typed === typed.toLocaleUpperCase("tr") && /\p{L}/u.test(typed)) rest = rest.toLocaleUpperCase("tr");
  return rest;
}
