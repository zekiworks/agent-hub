// The typing-suggestion extension's own rules: token healing of a half-typed word, words kept
// only while the model is sure, a few words up to the first punctuation, nothing copied whole from an earlier message,
// no asking for Turkish.
import { expect, test } from "bun:test";
import type { BoxCompleteBody } from "@agent-bus/protocol";
import { confidentText, grammarFor, healSplit, suggestionOf, worthAsking } from "../packages/complete-ext/src/server";

test("a half-typed last word goes back out of the prompt, with its space; the answer must begin with it", () => {
  expect(healSplit("Let's configur")).toEqual({ prefix: "Let's", stub: " configur" });
  expect(healSplit("Let's configure ")).toEqual({ prefix: "Let's configure ", stub: "" });
  expect(healSplit("Are the tests?")).toEqual({ prefix: "Are the tests?", stub: "" });
  expect(healSplit("configur")).toEqual({ prefix: "configur", stub: "" }); // nothing before it to go on from
  expect(grammarFor(' say "hi')).toBe('root ::= " say \\"hi" [^\\n]*');
});

test("words are kept while the model is sure of each and of the whole; the forced half word only must not be absurd", () => {
  const t = (token: string, logprob: number) => ({ token, logprob });
  // " configure" spells the stub: kept though its prior is low; then sure words, until an unsure one.
  expect(confidentText([t(" configure", -6), t(" the", -0.5), t(" server", -0.9), t(" today", -2.6)], " configur")).toBe("e the server");
  // The sum runs out before any single word is too unsure.
  expect(confidentText([t(" are", -1.2), t(" ready", -2.0), t(" now", -2.0)], "")).toBe(" are ready");
  expect(confidentText([t(" coffee", -3.9), t(" shop", -0.3)], "")).toBe("");
  // "ta" spelled as " tale" + "b's": an absurd way to the stub, nothing offered.
  expect(confidentText([t(" tale", -13.4), t("b", -1.7), t("'s", -1.1)], " ta")).toBe("");
});

const body = (draft: string): BoxCompleteBody => ({
  v: 1,
  kind: "complete",
  me: "maya",
  conversation: { id: "g_1", kind: "project", name: "launch", members: ["maya", "leo"] },
  messages: [{ seq: 1, from: "leo", text: "Can we keep the old export button until 2.1?", createdAt: 0 }],
  draft: { text: draft },
});

test("the model's words are cut at the first punctuation that ends a word, and to a few words", () => {
  expect(suggestionOf(" are still passing? The upgrade needs Bun", body("Can you check whether the tests"))).toBe(" are still passing?");
  expect(suggestionOf(" notes draft and upgrade to Bun 1.2 or newer", body("Thanks, I'll review the release"))).toBe(" notes draft and upgrade to Bun 1.2 or");
  expect(suggestionOf("   ", body("abc"))).toBe("");
});

test("words copied whole from an earlier message are not offered", () => {
  expect(suggestionOf(" the old export button until 2.1?", body("When can we tag"))).toBe("");
  expect(suggestionOf(" the release notes draft?", body("When can we tag"))).toBe(" the release notes draft?");
});

test("Can's case: after a finished sentence, no line of someone else's; @mentions in a draft stay", () => {
  const draft = "What are we sending with the new prefix-matching behavior? I'm currently using it in #42, but also want to complete your answer.";
  const cans: BoxCompleteBody = { ...body(draft), conversation: { id: "g_1", kind: "project", name: "reader-hub", members: ["can", "the reviewer"] },
    messages: [{ seq: 1, from: "the reviewer", text: "Reviewed 9f5485d: the Escape, composition and microphone findings in #42 are addressed.", createdAt: 0 }] };
  expect(suggestionOf(" @webapp:", cans)).toBe("");
  expect(suggestionOf(" @webapp.", cans)).toBe("");
  expect(suggestionOf(" @webapp: I'm reviewing #42", cans)).toBe("");
  expect(suggestionOf(" what do you think", cans)).toBe("");
  expect(suggestionOf(" Thanks!", cans)).toBe(" Thanks!");
  // Mid-sentence: a label still ends it, a mention is part of it.
  expect(suggestionOf(" your answer. @webapp: I'm", body("but also want to complete"))).toBe(" your answer.");
  expect(suggestionOf(" @webapp about the tests", body("Can you ask"))).toBe(" @webapp about the tests");
});

test("nothing is asked for a near-empty or Turkish draft", () => {
  expect(worthAsking("Hi")).toBe(false);
  expect(worthAsking("Bugün akşam toplantıda")).toBe(false);
  expect(worthAsking("Can you check")).toBe(true);
});
