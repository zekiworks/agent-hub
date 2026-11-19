// Builds the word lists the message box completes the current word from (ui/words.ts; Can #12953, #12955):
// ui/words-en.txt and ui/words-tr.txt, from Tatoeba's sentences (https://tatoeba.org, CC BY 2.0 FR).
//
//   curl -LO https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2
//   curl -LO https://downloads.tatoeba.org/exports/per_language/tur/tur_sentences.tsv.bz2
//   bunzip2 eng_sentences.tsv.bz2 tur_sentences.tsv.bz2
//   bun run packages/server/scripts/build-words.ts eng_sentences.tsv tur_sentences.tsv
//
// A list holds each word with what Kneser-Ney smoothing needs (ui/words.ts reads it): how often it occurs, after how
// many different words, and before how many; then, for each word, the words that follow it most often, with counts.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const uiDir = path.resolve(import.meta.dir, "..", "ui");

/** Words kept per language: Turkish needs more, a word having many forms ("ev", "evde", "evden", "evimiz"). */
const VOCABULARY = { en: 30_000, tr: 40_000 } as const;
/** A word is kept when seen this often; a pair when seen this often. */
const MIN_WORD = 3;
const MIN_PAIR = 3;
/** The followers kept per word, most frequent first: enough to rank what is typed after it, small enough to load. */
const FOLLOWERS = 24;

/** The words of a text as ui/words.ts splits them: letters, with an apostrophe inside ("don't", "Ankara'ya"). */
function words(text: string, lang: string): string[] {
  return (text.toLocaleLowerCase(lang).match(/\p{L}+(?:['’]\p{L}+)*/gu) ?? []).map((w) => w.replace(/’/g, "'"));
}

/** Tatoeba's stock characters: every tenth sentence is about Tom or Mary ("Tom'un", "Mary'ye" too), which would make
 * "tom" the second word of Turkish. They are left out, and no pair is counted across them. */
const STOCK_NAMES = /^(tom|mary|john|alice)(?:'|$)/;

function build(lang: "en" | "tr", file: string): void {
  const count = new Map<string, number>();
  const pairs = new Map<string, Map<string, number>>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.split("\t")[2];
    if (!text) continue;
    for (const sentence of text.split(/[.!?;:]+/)) {
      // "" stands for the start of a sentence: what is typed first.
      let prev: string | undefined = "";
      for (const word of words(sentence, lang)) {
        if (STOCK_NAMES.test(word)) {
          prev = undefined;
          continue;
        }
        count.set(word, (count.get(word) ?? 0) + 1);
        if (prev !== undefined) {
          let after = pairs.get(prev);
          if (!after) pairs.set(prev, (after = new Map()));
          after.set(word, (after.get(word) ?? 0) + 1);
        }
        prev = word;
      }
    }
  }
  const kept = [...count].filter(([, c]) => c >= MIN_WORD).sort((a, b) => b[1] - a[1]).slice(0, VOCABULARY[lang]);
  const index = new Map<string, number>([["", 0]]);
  for (const [word] of kept) index.set(word, index.size);
  // Before how many different words each word comes, over all pairs (not only those kept): its continuation count.
  const preceders = new Map<string, number>();
  for (const after of pairs.values()) for (const word of after.keys()) preceders.set(word, (preceders.get(word) ?? 0) + 1);
  const row = (word: string, total: number): string => `${word} ${total} ${pairs.get(word)?.size ?? 0} ${preceders.get(word) ?? 0}`;
  const sentences = [...(pairs.get("")?.values() ?? [])].reduce((a, b) => a + b, 0);
  const lines = [
    `# Agent Hub word list (${lang}), from Tatoeba's sentences (https://tatoeba.org), CC BY 2.0 FR; built by packages/server/scripts/build-words.ts.`,
    `# word count followers preceders; the first line is the start of a sentence. Then: word followers as index:count (base 36).`,
    `^ ${sentences} ${pairs.get("")?.size ?? 0} 0`,
    ...kept.map(([word, c]) => row(word, c)),
    "",
  ];
  for (const [word, i] of index) {
    const top = [...(pairs.get(word) ?? [])]
      .filter(([next, c]) => c >= MIN_PAIR && index.has(next))
      .sort((a, b) => b[1] - a[1])
      .slice(0, FOLLOWERS);
    if (top.length > 0) lines.push(`${i.toString(36)} ${top.map(([next, c]) => `${index.get(next)!.toString(36)}:${c.toString(36)}`).join(" ")}`);
  }
  const out = path.join(uiDir, `words-${lang}.txt`);
  writeFileSync(out, `${lines.join("\n")}\n`);
  console.log(`${out}: ${kept.length} words, ${lines.length - kept.length - 4} with followers`);
}

const [en, tr] = process.argv.slice(2);
if (!en || !tr) throw new Error("Give eng_sentences.tsv and tur_sentences.tsv (see the top of this file)");
build("en", en);
build("tr", tr);
