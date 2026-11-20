// Example rooms and drafts for the "Ask @agent" extension (Ümit #13030): the demo, the tests and the measurements of
// scripts/measure.ts. Each has the answer a person would expect: the agent to offer, or null.
import type { BoxRecipientBody } from "@agent-bus/protocol";

export interface Fixture {
  name: string;
  body: BoxRecipientBody;
  expect: string | null;
}

const T0 = Date.UTC(2026, 10, 20, 9, 0);
const minute = 60_000;

/** Ümit's scenario: room #launch, @webapp reported the failing Safari tests and owns their fix, @docs posted the notes. */
export function launchRoom(draft: string): BoxRecipientBody {
  return {
    v: 1,
    kind: "recipient",
    me: "umit",
    conversation: {
      id: "c-launch",
      kind: "group",
      name: "launch",
      title: "Launch 2.3",
      members: ["umit", "can", "webapp", "docs", "release-bot"],
    },
    messages: [
      { seq: 101, from: "umit", fromKind: "human", text: "Starting the 2.3 launch. @webapp please run the browser tests, @docs the release notes.", createdAt: T0 },
      {
        seq: 102,
        from: "webapp",
        fromKind: "agent",
        text: "Browser suite done: Chrome and Firefox green. Two Safari tests fail in the date picker: date-range-select and keyboard-nav (the end date is off by one day). Looking into it.",
        createdAt: T0 + 6 * minute,
        replyTo: 101,
      },
      { seq: 103, from: "release-bot", fromKind: "agent", text: "Release candidate 2.3.0-rc1 is built. Publishing is scheduled for Friday 16:00 UTC once the checklist is done.", createdAt: T0 + 9 * minute },
      {
        seq: 104,
        from: "docs",
        fromKind: "agent",
        text: "Release notes for 2.3 are posted in docs/releases/2.3.md: the new date picker, faster search, and IE11 support dropped.",
        createdAt: T0 + 14 * minute,
        replyTo: 101,
      },
      { seq: 105, from: "can", fromKind: "human", text: "Nice, thanks both.", createdAt: T0 + 15 * minute },
      {
        seq: 106,
        from: "webapp",
        fromKind: "agent",
        text: "Pushed a fix for the Safari date picker: parseDate ignored the timezone offset. Re-running the Safari tests now.",
        createdAt: T0 + 31 * minute,
      },
    ],
    checklist: [
      { id: "s1", text: "Fix the two Safari date-picker tests", owner: "webapp", done: false },
      { id: "s3", text: "Tag and publish 2.3.0", owner: "release-bot", done: false, blocked: "waits for the Safari fix" },
      { id: "s2", text: "Write the 2.3 release notes", owner: "docs", done: true },
    ],
    agents: ["webapp", "docs", "release-bot"],
    draft: { text: draft },
  };
}

/** A room whose agent ids carry a host: the hub's own developers. */
export function hubRoom(draft: string): BoxRecipientBody {
  return {
    v: 1,
    kind: "recipient",
    me: "can",
    conversation: { id: "c-hub", kind: "project", name: "agent-hub", members: ["can", "agent-hub@bariton", "codex-ui@mac"] },
    messages: [
      { seq: 501, from: "agent-hub@bariton", fromKind: "agent", text: "Server side of word completion is in: /api/box/complete answers in 0.2 s, 312 server tests pass.", createdAt: T0 },
      {
        seq: 502,
        from: "codex-ui@mac",
        fromKind: "agent",
        text: "On phones the suggestion chip now sits in the row of buttons, so the message box no longer jumps when it appears. Checked on iOS Safari and Android Chrome.",
        createdAt: T0 + 20 * minute,
      },
    ],
    checklist: [
      { id: "h1", heading: "Phones", text: "Keep the box still when a suggestion shows", owner: "codex-ui@mac", done: true },
      { id: "h2", heading: "Server", text: "Serve the word lists gzipped with an ETag", owner: "agent-hub@bariton", done: false },
    ],
    agents: ["agent-hub@bariton", "codex-ui@mac"],
    draft: { text: draft },
  };
}

type Message = BoxRecipientBody["messages"][number];
type Said = Pick<Message, "from" | "text" | "replyTo">;

/**
 * The live demo's room (Main, #13030): #launch where @maya asked for 2.0 to be made ready; @webapp is fixing two failing
 * Safari tests, @docs posted the release notes, @release-bot added the checklist. `after` are the messages since.
 */
export function demoRoom(draft: string, after: Said[] = []): BoxRecipientBody {
  const said: Said[] = [
    { from: "maya", text: "Kicking off the 2.0 launch here." },
    { from: "maya", text: "Please get 2.0 ready to tag: tests green, notes reviewed, then the tag." },
    { from: "webapp", text: "Two Safari tests fail, both in the date picker. I'm fixing them now." },
    { from: "docs", text: "Release notes are posted: what's new, upgrade steps (Bun 1.2 or newer), known limits." },
    { from: "webapp", text: "Pushed a fix for the date picker; CI is running." },
  ];
  const messages: Message[] = [...said, ...after].map((m, i) => ({
    seq: 300 + i,
    from: m.from,
    fromKind: m.from === "maya" || m.from === "leo" ? "human" : "agent",
    text: m.text,
    createdAt: T0 + i * 5 * minute,
    ...(m.replyTo === undefined ? {} : { replyTo: m.replyTo }),
  }));
  const heading = "#2 Get 2.0 ready to tag";
  return {
    v: 1,
    kind: "recipient",
    me: "maya",
    conversation: { id: "c-demo", kind: "project", name: "launch", members: ["maya", "leo", "webapp", "docs", "release-bot"] },
    messages,
    checklist: [
      { id: "d1", heading, text: "Fix the two Safari date-picker tests", owner: "release-bot", done: false },
      { id: "d2", heading, text: "Review the upgrade steps in the release notes", owner: "release-bot", done: false },
      { id: "d3", heading, text: "Tag v2.0.0", owner: "release-bot", done: false },
    ],
    agents: ["webapp", "docs", "release-bot"],
    draft: { text: draft },
  };
}

const askedWebapp = { from: "maya", text: "@webapp Did both Safari tests pass after the fix?" };
const askedDocs = { from: "maya", text: "@docs Do the upgrade steps cover projects still on Bun 1.1?" };

export const fixtures: Fixture[] = [
  { name: "safari-passed", body: launchRoom("Did both Safari tests pass after the fix?"), expect: "webapp" },
  { name: "thanks", body: launchRoom("Thanks, I'll take it from here"), expect: null },
  { name: "notes-ie11", body: launchRoom("Do the release notes say that IE11 is no longer supported?"), expect: "docs" },
  { name: "announcement", body: launchRoom("Heads up: I'm off tomorrow, Can runs the launch from here."), expect: null },
  { name: "ship-when", body: launchRoom("When exactly does 2.3 get published?"), expect: "release-bot" },
  { name: "question-for-can", body: launchRoom("Can, are you fine with shipping on Friday?"), expect: null },
  { name: "tr-safari", body: launchRoom("Safari testleri düzeldi mi?"), expect: "webapp" },
  { name: "tr-ascii-notes", body: launchRoom("Surum notlarina arama hizlanmasini da ekledin mi?"), expect: "docs" },
  { name: "hub-chip-phones", body: hubRoom("Does the chip still make the box jump on iPhone?"), expect: "codex-ui@mac" },
  { name: "hub-etag", body: hubRoom("Is the ETag for the word lists done yet?"), expect: "agent-hub@bariton" },
  // The demo: a closing remark right after the person asked an agent is not for that agent (Ümit's spec).
  { name: "demo-safari", body: demoRoom("Did both Safari tests pass after the fix?"), expect: "webapp" },
  { name: "demo-notes-bun", body: demoRoom("Do the release notes say which Bun version 2.0 needs?"), expect: "docs" },
  { name: "demo-thanks-after-ask", body: demoRoom("Thanks, I'll take it from here", [askedWebapp]), expect: null },
  { name: "demo-follow-up", body: demoRoom("And is CI green on the other browsers too?", [askedWebapp]), expect: "webapp" },
  {
    name: "demo-great-thanks",
    body: demoRoom("Great, thanks everyone", [askedWebapp, { from: "webapp", text: "Yes, both Safari tests pass now and CI is green.", replyTo: 305 }]),
    expect: null,
  },
  { name: "demo-check-tomorrow", body: demoRoom("ok, will check tomorrow", [askedWebapp]), expect: null },
  {
    name: "demo-thanks-docs",
    body: demoRoom("Thanks", [askedDocs, { from: "docs", text: "Yes: the upgrade steps start from Bun 1.1 and say to update Bun first.", replyTo: 305 }]),
    expect: null,
  },
];
