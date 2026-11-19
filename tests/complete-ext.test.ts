// The typing-suggestion extension's own rules: a few words up to the first punctuation, nothing copied
// whole from an earlier message, no asking for Turkish.
import { expect, test } from "bun:test";
import type { BoxCompleteBody } from "@agent-bus/protocol";
import { suggestionOf, worthAsking } from "../packages/complete-ext/src/server";

const body = (draft: string): BoxCompleteBody => ({
  v: 1,
  kind: "complete",
  me: "maya",
  conversation: { id: "g_1", kind: "project", name: "launch", members: ["maya", "leo"] },
  messages: [{ seq: 1, from: "leo", text: "Can we keep the old export button until 2.1?", createdAt: 0 }],
  draft: { text: draft },
});

test("the model's words are cut at the first punctuation and to a few words", () => {
  expect(suggestionOf(" are still passing? The upgrade needs Bun", body("Can you check whether the tests"))).toBe(" are still passing?");
  expect(suggestionOf(" notes draft and upgrade to Bun 1.2", body("Thanks, I'll review the release"))).toBe(" notes draft and upgrade to");
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
