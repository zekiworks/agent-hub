// The "needs you" question to a System One decision model (d1-2B's /v1/systemone): one choice, "needs_you" or
// "update", about one agent message for one person. The state is the room, its last few messages, then the message,
// whose start and end both go in (the ask is often in the last lines).
import type { DecisionRequest } from "../src/decide.ts";
import type { Item } from "./build.ts";

export const QUESTION = "needs";
export const NEEDS = "needs_you";
export const UPDATE = "update";

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** The message's first `head` and last `tail` characters, one line. */
function headTail(text: string, head: number, tail: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= head + tail ? line : `${line.slice(0, head).trimEnd()} … ${line.slice(-tail).trimStart()}`;
}

export function stateOf(it: Item): string {
  const others = it.people.filter((p) => p !== it.person);
  const lines = [`Room ${it.room}. @${it.person} is a person reading their unread messages${others.length ? `; @${others.join(", @")} is another person` : ""}.`];
  if (it.context.length > 0) {
    lines.push("", "Messages before, oldest first:");
    it.context.forEach((m, i) => lines.push(`@${m.from} (${m.person ? "person" : "agent"}): ${clip(m.text, i === it.context.length - 1 ? 280 : 160)}`));
  }
  lines.push("", `New message from @${it.author} (agent)${it.task ? `, a ${it.task} request for @${it.person}` : ""}:`, `"${headTail(it.text, 500, 300)}"`);
  return lines.join("\n");
}

export type Phrasing = (it: Item) => { instructions: string; criteria: Record<string, string> };
export const PHRASINGS: Record<string, Phrasing> = {
  a: (it) => ({
    instructions: `Does this new message from @${it.author} need @${it.person}, or is it just an update?`,
    criteria: {
      [NEEDS]: `It needs @${it.person}: it asks @${it.person} a question, asks for @${it.person}'s decision or OK, or reports a problem @${it.person} must act on.`,
      [UPDATE]: `Just an update: it reports progress or results, confirms or thanks, or talks to other agents; @${it.person} need not do anything.`,
    },
  }),
  b: (it) => ({
    instructions: `@${it.person} has 99+ unread messages. Should this one from @${it.author} be shown first, as needing @${it.person}?`,
    criteria: {
      [NEEDS]: `Show first: @${it.person} must answer, decide, approve or fix something here.`,
      [UPDATE]: `Leave among the rest: @${it.person} can read it later or skip it; nothing waits on @${it.person}.`,
    },
  }),
  c: (it) => ({
    instructions: `Is @${it.author} waiting for @${it.person} after this message?`,
    criteria: {
      [NEEDS]: `@${it.author} waits for @${it.person}: a question, a choice, an approval, or something only @${it.person} can do.`,
      [UPDATE]: `@${it.author} goes on without @${it.person}: a report, a "done", a plan already agreed, or a message to other agents.`,
    },
  }),
};

export function requestFor(it: Item, phrasing: string): DecisionRequest {
  const p = PHRASINGS[phrasing];
  if (!p) throw new Error(`unknown phrasing ${phrasing}`);
  return { state: stateOf(it), questions: { [QUESTION]: { type: "choice", ...p(it) } } };
}
