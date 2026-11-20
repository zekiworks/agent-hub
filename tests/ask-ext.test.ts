// The "Ask @agent" extension's own logic (Ümit #13030), without the model: one choice question over the room's agents
// and "none", with each agent's evidence from the room; the model's answer read back with the cut-off.
import { expect, test } from "bun:test";
import { decisionRequest, readDecision } from "../packages/ask-ext/src/decide";
import { hubRoom, launchRoom } from "../packages/ask-ext/src/fixtures";
import { isRecipientBody } from "../packages/ask-ext/src/server";

test("one choice question whose options are exactly the room's agents and none", () => {
  const request = decisionRequest(launchRoom("Did both Safari tests pass after the fix?"));
  expect(Object.keys(request.questions)).toEqual(["recipient"]);
  const question = request.questions.recipient!;
  expect(question.type).toBe("choice");
  // The spec's question, about the draft itself, quoted.
  expect(question.instructions).toBe('Which agent has the best evidence to answer this person\'s new message "Did both Safari tests pass after the fix?"?');
  expect(Object.keys(question.criteria)).toEqual(["webapp", "docs", "release-bot", "none"]);
  // Ids with a host and a dash stay the keys as they are.
  const hub = decisionRequest(hubRoom("Is the ETag done?")).questions.recipient!;
  expect(Object.keys(hub.criteria)).toEqual(["agent-hub@bariton", "codex-ui@mac", "none"]);
});

test("each agent's option carries its evidence; the state holds the messages, the checklist and the draft", () => {
  const request = decisionRequest(launchRoom("Did both Safari tests pass after the fix?"));
  const { criteria } = request.questions.recipient!;
  expect(criteria.webapp).toContain("wrote the latest message");
  expect(criteria.webapp).toContain("wrote 2 of the last 6 messages");
  expect(criteria.webapp).toContain('owns the open step "Fix the two Safari date-picker tests"');
  expect(criteria.webapp).toContain("@umit asked it");
  expect(criteria.docs).toContain('owns the done step "Write the 2.3 release notes"');
  expect(criteria.docs).not.toContain("wrote the latest message");
  expect(criteria["release-bot"]).toContain("owns the blocked (waits for the Safari fix) step");
  expect(criteria["release-bot"]).not.toContain("asked it");
  expect(criteria.none).toContain("thanks");

  const state = String(request.state);
  expect(state).toContain("Room #launch (Launch 2.3).");
  expect(state).toContain("@webapp (agent) (answering @umit): Browser suite done");
  expect(state).toContain("@can (person): Nice, thanks both.");
  expect(state).toContain("- [open] Fix the two Safari date-picker tests (owner @webapp)");
  expect(state.endsWith('@umit is writing to the room, naming no one:\n"Did both Safari tests pass after the fix?"')).toBe(true);
});

test("an agent with nothing in the room says so; a long message is clipped", () => {
  const body = launchRoom("Anyone?");
  body.agents = [...body.agents, "qa-runner"];
  body.messages.push({ seq: 107, from: "docs", fromKind: "agent", text: "x".repeat(2000), createdAt: 0 });
  const request = decisionRequest(body);
  expect(request.questions.recipient!.criteria["qa-runner"]).toBe("in the room, wrote nothing recently and owns no step.");
  expect(String(request.state)).toContain(`@docs (agent): ${"x".repeat(279)}…`);
  expect(String(request.state)).not.toContain("x".repeat(281));
});

test("the answer gives the agent at or above the cut-off; none, unknown ids, malformed answers and low ones give null", () => {
  const body = launchRoom("Did both Safari tests pass after the fix?");
  const answer = (choice: unknown, p: number) => ({
    answers: { recipient: { type: "choice", choice, confidence: p, probabilities: { webapp: p, docs: 0.07, none: 0.05 } } },
    usage: { input_tokens: 600, output_tokens: 0 },
  });
  expect(readDecision(answer("webapp", 0.88), body, 0.5)).toEqual({
    recipient: "webapp",
    confidence: 0.88,
    probabilities: { webapp: 0.88, docs: 0.07, none: 0.05 },
  });
  // The bare answer of the question reads the same.
  expect(readDecision(answer("webapp", 0.5).answers.recipient, body, 0.5).recipient).toBe("webapp");
  expect(readDecision(answer("webapp", 0.49), body, 0.5)).toMatchObject({ recipient: null, confidence: 0.49 });
  expect(readDecision(answer("none", 0.9), body, 0.5).recipient).toBeNull();
  expect(readDecision(answer("someone-else", 0.9), body, 0.5).recipient).toBeNull();
  expect(readDecision(answer(42, 0.9), body, 0.5).recipient).toBeNull();
  for (const malformed of [null, "webapp", [], {}, { answers: {} }, { answers: { recipient: { choice: "webapp" } } }]) {
    expect(readDecision(malformed, body, 0.5)).toEqual({ recipient: null, confidence: 0, probabilities: {} });
  }
  // The probability of the choice counts, not a rescaled confidence another model may report.
  const glide = { answers: { recipient: { choice: "docs", confidence: 0.2, probabilities: { webapp: 0.3, docs: 0.6, none: 0.1 } } } };
  expect(readDecision(glide, body, 0.5)).toMatchObject({ recipient: "docs", confidence: 0.6 });
});

test("only a version 1 recipient body is taken", () => {
  const body = launchRoom("Did both Safari tests pass?");
  expect(isRecipientBody(body)).toBe(true);
  expect(isRecipientBody({ ...body, v: 2 })).toBe(false);
  expect(isRecipientBody({ ...body, kind: "complete" })).toBe(false);
  expect(isRecipientBody({ ...body, agents: [1, 2] })).toBe(false);
  expect(isRecipientBody({ ...body, draft: {} })).toBe(false);
});
