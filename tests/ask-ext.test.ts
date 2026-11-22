// The "Ask @agent" extension's own logic (Ümit #13030), without the model: one choice question over the room's agents
// and "none", with each agent's evidence from the room; the model's answer read back with the cut-off.
import { expect, test } from "bun:test";
import type { BoxNeedsBody } from "@agent-bus/protocol";
import { decisionRequest, readDecision } from "../packages/ask-ext/src/decide";
import { hubRoom, launchRoom } from "../packages/ask-ext/src/fixtures";
import { isNeedsBody, itemOf, LIVE_PHRASING, requestFor } from "../packages/ask-ext/src/needs";
import { handleNeeds, isRecipientBody } from "../packages/ask-ext/src/server";

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

// ---- POST /needs (Ümit #14881): the "needs you" question, phrasing b, to d1-2B and GLiDE at once ----

const needsBody: BoxNeedsBody = {
  v: 1,
  kind: "needs",
  person: "umit",
  conversation: { id: "c1", kind: "project", name: "launch", members: ["umit", "can", "webapp"], people: ["umit", "can"] },
  messages: [
    { seq: 1, from: "umit", fromKind: "human", text: "Fix the Safari tests please.", createdAt: 1 },
    { seq: 2, from: "can", fromKind: "human", text: "Thanks.", createdAt: 2 },
  ],
  message: { seq: 3, from: "webapp", fromKind: "agent", text: "Fixed two; the third needs a new date library. Shall I add it?", createdAt: 3 },
};

test("the live body reads as the study's item: same room name, context and phrasing b", () => {
  const item = itemOf(needsBody);
  expect(item).toEqual({
    person: "umit",
    people: ["umit", "can"],
    room: "#launch",
    context: [
      { from: "umit", person: true, text: "Fix the Safari tests please." },
      { from: "can", person: true, text: "Thanks." },
    ],
    author: "webapp",
    task: null,
    text: "Fixed two; the third needs a new date library. Shall I add it?",
  });
  const request = requestFor(item, LIVE_PHRASING);
  expect(request.state).toContain("Room #launch. @umit is a person reading their unread messages; @can is another person.");
  expect(request.questions.needs!.instructions).toBe("@umit has 99+ unread messages. Should this one from @webapp be shown first, as needing @umit?");
  expect(Object.keys(request.questions.needs!.criteria)).toEqual(["needs_you", "update"]);
  expect(itemOf({ ...needsBody, conversation: { ...needsBody.conversation, kind: "dm", name: undefined } }).room).toBe("a direct conversation");
  expect(isNeedsBody(needsBody)).toBe(true);
  expect(isNeedsBody({ ...needsBody, kind: "recipient" })).toBe(false);
  expect(isNeedsBody({ ...needsBody, message: {} })).toBe(false);
});

test("POST /needs asks every model the same question; each verdict uses the 0.5 cut, a failing model gives its error", async () => {
  const seen: unknown[] = [];
  const model = (p: number) =>
    Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen.push(await req.json());
        return Response.json({ answers: { needs: { choice: p >= 0.5 ? "needs_you" : "update", probabilities: { needs_you: p, update: 1 - p } } } });
      },
    });
  const d1 = model(0.72);
  const glide = model(0.31);
  const broken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no", { status: 500 }) });
  try {
    const ask = (models: Array<{ name: string; port: number | undefined }>) =>
      handleNeeds(
        new Request("http://x/needs", { method: "POST", body: JSON.stringify(needsBody) }),
        models.map((m) => ({ name: m.name, url: `http://127.0.0.1:${m.port}` }))
      );
    const res = await ask([{ name: "d1", port: d1.port }, { name: "glide", port: glide.port }]);
    expect(await res.json()).toEqual({ verdicts: { d1: { needs: true, p: 0.72 }, glide: { needs: false, p: 0.31 } } });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    const failing = await (await ask([{ name: "d1", port: d1.port }, { name: "glide", port: broken.port }])).json();
    expect(failing).toEqual({ verdicts: { d1: { needs: true, p: 0.72 }, glide: { error: "HTTP 500" } } });
    const bad = await handleNeeds(new Request("http://x/needs", { method: "POST", body: "{}" }), []);
    expect(bad.status).toBe(400);
  } finally {
    for (const s of [d1, glide, broken]) s.stop(true);
  }
});
