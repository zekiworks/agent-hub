// Completing the word being typed from word lists (Can #12953, #12955): the word before counts, Turkish typed
// without its letters finds its words and goes on in the same style, a sure start of several forms is offered, and
// the conversation's own words count.
import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { Website } from "../packages/server/src/website";
import { completeWord, looksTurkish, parseList, useLists } from "../packages/server/ui/words";

/** A list in build-words.ts's format: words with count, followers, preceders; then followers by index. */
function list(rows: Array<[string, number, number, number]>, next: Record<number, Array<[number, number]>>): string {
  return [
    "# test list",
    ...rows.map((r) => r.join(" ")),
    "",
    ...Object.entries(next).map(([i, pairs]) => `${Number(i).toString(36)} ${pairs.map(([w, c]) => `${w.toString(36)}:${c.toString(36)}`).join(" ")}`),
  ].join("\n");
}

const EN = list(
  [
    ["^", 1000, 50, 0],
    ["the", 900, 300, 200],
    ["table", 300, 40, 60],
    ["tab", 40, 20, 30],
    ["a", 800, 300, 200],
    ["into", 100, 30, 40],
    ["cheese", 50, 10, 20],
    ["think", 200, 50, 30],
  ],
  { 0: [[1, 300]], 1: [[2, 120]], 4: [[3, 30]], 5: [[4, 60]] }
);
const TR = list(
  [
    ["^", 1000, 50, 0],
    ["görüşürüz", 300, 20, 40],
    ["görüşmek", 30, 10, 10],
    ["toplantı", 100, 20, 30],
    ["toplantıya", 90, 20, 30],
    ["toplantıda", 60, 20, 30],
    ["bugün", 200, 60, 40],
    ["akşam", 150, 50, 40],
  ],
  { 0: [[6, 100]], 6: [[7, 40]] }
);

describe("word completion", () => {
  test("the word before decides: 'a ta' is 'tab', 'the ta' is 'table'", () => {
    useLists([parseList("en", EN), parseList("tr", TR)]);
    expect(completeWord("turn it into a ta", "k", [])).toBe("b");
    expect(completeWord("put it on the ta", "k", [])).toBe("ble");
  });

  test("Turkish without its letters finds its words and goes on without them; with them, with them", () => {
    useLists([parseList("en", EN), parseList("tr", TR)]);
    expect(completeWord("tamam, gorus", "k", [])).toBe("uruz");
    expect(completeWord("tamam, görüş", "k", [])).toBe("ürüz");
    expect(looksTurkish("bugun aksam")).toBe(true);
    expect(looksTurkish("put it on the table")).toBe(false);
  });

  test("a sure start of several forms is offered, in the draft's style", () => {
    useLists([parseList("en", EN), parseList("tr", TR)]);
    expect(completeWord("bugun aksam toplant", "k", [])).toBe("i");
    expect(completeWord("bugün akşam toplant", "k", [])).toBe("ı");
  });

  test("the conversation's own words count; nothing for a single letter or an unsure start", () => {
    useLists([parseList("en", EN), parseList("tr", TR)]);
    const texts = Array.from({ length: 40 }, () => "The checklist is pinned. Open the checklist in the Workspace.");
    expect(completeWord("open the che", "c1", texts)).toBe("cklist");
    expect(completeWord("open the Wor", "c1", texts)).toBe("kspace");
    expect(completeWord("t", "c1", texts)).toBe("");
    expect(completeWord("I think", "c1", texts)).toBe("");
  });
});

describe("word lists on the website", () => {
  test("served gzipped when the browser takes it, and 'not modified' the second time", async () => {
    const website = new Website();
    const first = await website.serve("/words-en.txt", new Headers({ "Accept-Encoding": "gzip, deflate" }));
    expect(first?.status).toBe(200);
    expect(first?.headers.get("content-encoding")).toBe("gzip");
    const text = new TextDecoder().decode(gunzipSync(new Uint8Array(await first!.arrayBuffer())));
    expect(text.startsWith("# Agent Hub word list (en)")).toBe(true);
    const again = await website.serve("/words-en.txt", new Headers({ "If-None-Match": first!.headers.get("etag")! }));
    expect(again?.status).toBe(304);
  });
});
