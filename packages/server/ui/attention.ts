// What I do with agents' messages (Ümit #13977, #14109): the answer key for teaching a small model which messages need
// me. Each agent message on screen long enough counts as seen (with how long); a tap, a reply, a forward, ✓ Mark as
// read, a banner's ✓ Read or open, a notification opened: each is noted. Sent in batches to POST /api/attention; the bus
// keeps them only for people who said yes (attention.ts) and never the text.
import { dom } from "./dom";
import { SESSION_KEY } from "./api";
import { state } from "./state";

export type AttentionAction = "seen" | "tapped" | "replied" | "forwarded" | "marked-read" | "notification" | "banner-opened" | "banner-read";

/** On screen at least this long counts as seen. */
const SEEN_MS = 1500;
const FLUSH_MS = 20_000;

let queue: Array<{ seq: number; action: AttentionAction; ms?: number }> = [];

export function noteAttention(seq: number, action: AttentionAction, ms?: number): void {
  if (!state.me) return;
  queue.push(ms === undefined ? { seq, action } : { seq, action, ms });
}

function flush(): void {
  settleVisible();
  if (queue.length === 0 || !state.me) return;
  const events = queue;
  queue = [];
  // keepalive: also when the page is being closed or hidden.
  void fetch("/api/attention", {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem(SESSION_KEY) ?? ""}` },
    body: JSON.stringify({ events }),
  }).catch(() => undefined);
}
setInterval(flush, FLUSH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});

// Seen: an agent message mostly in view while the page is in front.
const visibleSince = new Map<number, number>();
const looking = (): boolean => document.visibilityState === "visible" && document.hasFocus();

function settleVisible(): void {
  const now = Date.now();
  for (const [seq, since] of visibleSince) {
    if (now - since >= SEEN_MS) noteAttention(seq, "seen", now - since);
    visibleSince.set(seq, now);
  }
}

const observer = new IntersectionObserver(
  (entries) => {
    const now = Date.now();
    for (const entry of entries) {
      const seq = Number((entry.target as HTMLElement).dataset.seq);
      if (!seq) continue;
      if (entry.isIntersecting && looking()) {
        if (!visibleSince.has(seq)) visibleSince.set(seq, now);
      } else {
        const since = visibleSince.get(seq);
        visibleSince.delete(seq);
        if (since !== undefined && now - since >= SEEN_MS) noteAttention(seq, "seen", now - since);
      }
    }
  },
  { threshold: 0.6 }
);
// Looking away (another tab, app or window) ends what is on screen.
for (const type of ["blur", "visibilitychange"] as const) {
  window.addEventListener(type, () => {
    if (looking()) return;
    const now = Date.now();
    for (const [seq, since] of visibleSince) if (now - since >= SEEN_MS) noteAttention(seq, "seen", now - since);
    visibleSince.clear();
  });
}
window.addEventListener("focus", () => {
  // Back in front: what is on screen counts again from now.
  for (const li of dom.messageList.querySelectorAll<HTMLElement>(".msg-agent[data-seq]")) observer.unobserve(li), observer.observe(li);
});

const watch = (node: Node): void => {
  if (!(node instanceof HTMLElement)) return;
  if (node.matches(".msg-agent[data-seq]")) observer.observe(node);
  for (const li of node.querySelectorAll<HTMLElement>(".msg-agent[data-seq]")) observer.observe(li);
};
new MutationObserver((records) => {
  for (const r of records) for (const node of r.addedNodes) watch(node);
}).observe(dom.messageList, { childList: true, subtree: true });
watch(dom.messageList);

// Opened from a notification: sw.js puts the message's number in the address (?n=).
const opened = Number(new URLSearchParams(location.search).get("n"));
if (opened) noteAttention(opened, "notification");
