// The typing-suggestion extension's own rules (Can #12847): a few words up to the first punctuation, nothing copied
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

test("Can's case (#12883): after a finished sentence, no line of someone else's; @mentions in a draft stay", () => {
  const draft = "What are we sending with the new prefix-matching behavior? I'm currently using it in #12868, but also want to complete your answer.";
  const cans: BoxCompleteBody = { ...body(draft), conversation: { id: "g_1", kind: "project", name: "hilde-hub", members: ["can", "codex-ui"] },
    messages: [{ seq: 1, from: "codex-ui", text: "Reviewed 9f5485d: the Escape, composition and microphone findings in #12868 are addressed.", createdAt: 0 }] };
  expect(suggestionOf(" @codex-ui:", cans)).toBe("");
  expect(suggestionOf(" @codex-ui.", cans)).toBe("");
  expect(suggestionOf(" @codex-ui: I'm reviewing #12868", cans)).toBe("");
  expect(suggestionOf(" what do you think", cans)).toBe("");
  expect(suggestionOf(" Thanks!", cans)).toBe(" Thanks!");
  // Mid-sentence: a label still ends it, a mention is part of it.
  expect(suggestionOf(" your answer. @codex-ui: I'm", body("but also want to complete"))).toBe(" your answer.");
  expect(suggestionOf(" @webapp about the tests", body("Can you ask"))).toBe(" @webapp about the tests");
});

test("nothing is asked for a near-empty or Turkish draft", () => {
  expect(worthAsking("Hi")).toBe(false);
  expect(worthAsking("Bugün akşam toplantıda")).toBe(false);
  expect(worthAsking("Can you check")).toBe(true);
});
