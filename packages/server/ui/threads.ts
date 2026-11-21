// Threads (Can #14203, codex-ui #14204): with threads on, a chain of messages joined by replies is a child conversation
// of the room. The room shows the chain's first message (its root) with a bar "↳ 3 replies · 1 new"; a click (or Enter)
// opens the chain in the main pane, under a breadcrumb back to the room (#/c/<room>/t/<root>). Off by default, per
// browser. Built from the messages the page has loaded: a reply whose message is older than those is its own root.
import type { Message } from "@agent-bus/protocol";
import { state } from "./state";

const THREADS_KEY = "agent-bus.threads";
/** The newest reply I saw in each thread, by conversation and root: the replies after it are new. */
const READ_KEY = "agent-bus.threadRead";
const SINCE_KEY = "agent-bus.threadsSince";

export function threadsOn(): boolean {
  return localStorage.getItem(THREADS_KEY) === "1";
}

export function setThreadsOn(on: boolean): void {
  localStorage.setItem(THREADS_KEY, on ? "1" : "0");
  if (on) localStorage.setItem(SINCE_KEY, String(Date.now()));
}

/** When threads were turned on here: replies older than that, in a thread never opened, count as read. */
function threadsSince(): number {
  const since = Number(localStorage.getItem(SINCE_KEY));
  if (since > 0) return since;
  const now = Date.now();
  localStorage.setItem(SINCE_KEY, String(now));
  return now;
}

/** The thread open in the main pane (its root's number), or undefined for the room. */
export function openThread(): number | undefined {
  return threadsOn() ? state.thread : undefined;
}

export interface Threads {
  /** Each message's root (itself when it answers nothing loaded). */
  rootOf: Map<number, number>;
  /** Each root's replies, oldest first. */
  replies: Map<number, Message[]>;
}

export function threadsOf(messages: readonly Message[]): Threads {
  const loaded = new Set(messages.map((m) => m.seq));
  const parent = new Map<number, number>();
  for (const m of messages) if (m.quote && loaded.has(m.quote.seq) && m.quote.seq < m.seq) parent.set(m.seq, m.quote.seq);
  const rootOf = new Map<number, number>();
  const replies = new Map<number, Message[]>();
  for (const m of messages) {
    let root = m.seq;
    for (let p = parent.get(root); p !== undefined; p = parent.get(root)) root = rootOf.get(p) ?? p;
    rootOf.set(m.seq, root);
    if (root !== m.seq) (replies.get(root) ?? replies.set(root, []).get(root)!).push(m);
  }
  return { rootOf, replies };
}

/** What the main pane lists: the room's messages (threads folded into their roots), or one thread. */
export function displayed(messages: readonly Message[]): { shown: readonly Message[]; threads?: Threads } {
  if (!threadsOn()) return { shown: messages };
  const threads = threadsOf(messages);
  const open = state.thread;
  if (open !== undefined && threads.rootOf.get(open) === open) {
    return { shown: messages.filter((m) => threads.rootOf.get(m.seq) === open), threads };
  }
  return { shown: messages.filter((m) => threads.rootOf.get(m.seq) === m.seq), threads };
}

function readMarks(): Record<string, Record<string, number>> {
  try {
    return JSON.parse(localStorage.getItem(READ_KEY) ?? "{}") as Record<string, Record<string, number>>;
  } catch {
    return {};
  }
}

/**
 * Replies in thread `root` I have not seen (not mine): those after the last one I saw in it, or, in a thread never
 * opened, those that came after threads were turned on. Drawing its bar marks nothing read (codex-ui #14246: the first
 * reply that made a thread showed "0 new").
 */
export function newReplies(conversationId: string, root: number, replies: readonly Message[]): number {
  const seen = readMarks()[conversationId]?.[root];
  const since = seen === undefined ? threadsSince() : 0;
  return replies.filter((m) => m.from !== state.me && (seen === undefined ? m.createdAt > since : m.seq > seen)).length;
}

export function markThreadRead(conversationId: string, root: number, seq: number): void {
  const marks = readMarks();
  const conv = (marks[conversationId] ??= {});
  if ((conv[root] ?? 0) >= seq) return;
  conv[root] = seq;
  localStorage.setItem(READ_KEY, JSON.stringify(marks));
}

/** The message a new one in the open thread answers: the thread's newest (so the chain goes on). */
export function threadTail(conversationId: string): Message | undefined {
  const root = openThread();
  const messages = state.caches.get(conversationId)?.messages;
  if (root === undefined || !messages) return undefined;
  const threads = threadsOf(messages);
  if (threads.rootOf.get(root) !== root) return undefined;
  return threads.replies.get(root)?.at(-1) ?? messages.find((m) => m.seq === root);
}

// Esc in an open thread goes back to the room, unless it is closing something else first (a reply, a recording, a menu,
// a dialog): capture, so it sees the state before those handlers change it.
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || openThread() === undefined) return;
    if (state.replyTo || state.itemReply || state.voiceLatched || state.mention.open || document.querySelector("dialog[open]")) return;
    if (state.view.kind !== "conversation") return;
    event.preventDefault();
    location.hash = `#/c/${encodeURIComponent(state.view.id)}`;
  },
  { capture: true }
);
