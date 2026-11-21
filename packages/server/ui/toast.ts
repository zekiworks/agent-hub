// An answer elsewhere (Ümit, 16 Nov: "I write in one room and go to another; how do I know an answer came?"): a banner
// at the top, "↩ @logic in #toolbench-models: …", that opens the message when tapped. Phones show no browser
// notifications in a Safari tab, and the conversation list is hidden while a conversation is open. A banner stays
// until tapped, closed with ✕, or its conversation is opened (Ümit #10168: 12 s was too short to catch). One banner per
// conversation, with how many answers it holds; no limit on how many conversations (Can #11976: dropping the oldest
// silently was worse than a timer).
import type { Conversation, Message, PostMessageResponse } from "@agent-bus/protocol";
import { postJson } from "./api";
import { dom } from "./dom";
import { errorText } from "./format";
import { hooks } from "./hooks";
import { h } from "./html";
import { setIcon } from "./icons";
import { setOwnTask } from "./inbox";
import { copyText } from "./render";
import { speakButton } from "./speak";
import { conversationTitle, state } from "./state";
import { markRead } from "./unread";
import { noteAttention } from "./attention";
import { startVoiceReply } from "./voice";

let box: HTMLElement | undefined;

/** How long a pulse of unread messages lasts; banners leave in the same time (styles.css msg-pulse, answer-leave). */
export const PULSE_MS = 1600;

/** `message` answers me: it quotes me, mentions me, follows my own last message there, or is in a DM with me. */
export function answersMe(message: Message, conversation: Conversation, previous: Message | undefined): boolean {
  if (!state.me || message.from === state.me) return false;
  if (conversation.kind !== "all" && !conversation.members.includes(state.me)) return false;
  if (message.quote?.from === state.me) return true;
  if (previous?.from === state.me) return true;
  if (conversation.kind === "dm") return true;
  return new RegExp(`(^|[^\\w@])@${state.me}(?![\\w-])`, "i").test(message.text);
}

/**
 * Where the person moved the banners to (Ümit #10814, codex-ui #10815: she wants to move them to read what is under
 * them), kept per browser; the banners stay on screen and above the message box.
 */
const POSITION_KEY = "agent-bus.bannerPosition";
type Position = { x: number; y: number };

function savedPosition(): Position | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null");
    if (value && typeof value === "object" && typeof (value as Position).x === "number" && typeof (value as Position).y === "number") return value as Position;
  } catch {
    // Not ours, or broken: the default place.
  }
  return undefined;
}

/** Puts the banners at `position`, kept inside the screen and above the message box; undefined: the default place. */
function place(position: Position | undefined): void {
  if (!box) return;
  if (!position) {
    box.style.left = box.style.top = box.style.right = box.style.maxHeight = "";
    return;
  }
  // The visible part of the page: on phones the keyboard shrinks only the visual viewport (codex-ui #10841).
  const vv = window.visualViewport;
  const top = vv?.offsetTop ?? 0;
  const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
  const left = vv?.offsetLeft ?? 0;
  const right = vv ? vv.offsetLeft + vv.width : innerWidth;
  const composerTop = dom.composer.getBoundingClientRect().top || bottom;
  // All the height between the top and the message box, not the default place's cap (codex-ui #10843: in landscape
  // that left 80 px); longer text scrolls inside, so More, Reset position and ✕ stay reachable.
  box.style.maxHeight = `${Math.max(80, Math.min(bottom, composerTop) - top - 16)}px`;
  const r = box.getBoundingClientRect();
  const maxX = Math.max(left + 8, right - r.width - 8);
  const maxY = Math.max(top + 8, Math.min(bottom, composerTop) - r.height - 8);
  box.style.left = `${Math.round(Math.min(Math.max(position.x, left + 8), maxX))}px`;
  box.style.top = `${Math.round(Math.min(Math.max(position.y, top + 8), maxY))}px`;
  box.style.right = "auto";
}

/**
 * Pressing anywhere on a banner and dragging moves all of them (mouse and touch: pointer events); a tap opens its
 * message (Ümit #12199: the hand cursor says it moves, no "Reset position"). Its buttons and reply box keep their own
 * clicks. Not relying on the browser's click: after a touch drag Chrome sometimes sends none for the next tap.
 */
function makeHandle(handle: HTMLElement, tap: () => void): void {
  handle.addEventListener("pointerdown", (down) => {
    if (!box || down.button !== 0 || (down.target as Element).closest("button:not(.answer-toast-open), textarea, input, a, .answer-toast-form")) return;
    const start = box.getBoundingClientRect();
    let moving = false;
    // Captured at once: a quick mouse move leaves the line before the drag is recognised.
    handle.setPointerCapture(down.pointerId);
    const move = (event: PointerEvent) => {
      const dx = event.clientX - down.clientX;
      const dy = event.clientY - down.clientY;
      if (!moving && Math.hypot(dx, dy) < 6) return; // a tap stays a tap
      moving = true;
      event.preventDefault();
      place({ x: start.left + dx, y: start.top + dy });
    };
    const cleanup = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", cleanup);
    };
    // A cancelled gesture (the system took it: a scroll, a call) only cleans up; it opens nothing (codex-ui #12455).
    const end = (up: PointerEvent) => {
      cleanup();
      if (!moving) {
        swallowClickAt(up.clientX, up.clientY);
        return tap();
      }
      if (!box) return;
      const r = box.getBoundingClientRect();
      localStorage.setItem(POSITION_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", cleanup);
  });
}

/**
 * After a tap opens a message its banner is gone, and the browser's own click for that tap lands on whatever was under
 * the finger: on a phone the tab row or the conversation's header, which took Ümit somewhere else (#12447). Only that
 * click is dropped: the first click after the tap, if it comes where the finger lifted and within half a second. Any
 * other click (the browser sent none for the tap, and this is a new one elsewhere) goes through (codex-ui #12455).
 */
function swallowClickAt(x: number, y: number): void {
  const until = performance.now() + 500;
  const first = (event: MouseEvent) => {
    document.removeEventListener("click", first, { capture: true });
    if (performance.now() > until || Math.hypot(event.clientX - x, event.clientY - y) > 12) return;
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener("click", first, { capture: true });
  setTimeout(() => document.removeEventListener("click", first, { capture: true }), 500);
}

// Rotation, a resized window, or the phone keyboard opening: the moved banners are fitted into what is visible again.
window.addEventListener("resize", () => place(savedPosition()));
window.visualViewport?.addEventListener("resize", () => place(savedPosition()));

export function showAnswer(message: Message, conversation: Conversation): void {
  if (!box) {
    box = h("div", "answer-toasts");
    box.setAttribute("aria-live", "polite");
    document.body.append(box);
  }
  const text = message.text.replace(/\s+/g, " ").trim();
  // A newer answer in the same conversation takes the old banner's place and counts it.
  const previous = box.querySelector<HTMLElement>(`.answer-toast[data-conversation="${CSS.escape(conversation.id)}"]:not(.answer-toast-leaving)`);
  const count = Number(previous?.dataset.count ?? 0) + 1;
  // A reply being written there stays as it is; only its count moves.
  if (previous?.querySelector(".answer-toast-form")) {
    previous.dataset.count = String(count);
    const where = previous.querySelector(".answer-toast-where");
    if (where) where.textContent = `${where.textContent?.replace(/ · \d+ new$/, "")} · ${count} new`;
    return;
  }
  previous?.remove();
  const toast = h("div", "answer-toast");
  toast.dataset.conversation = conversation.id;
  toast.dataset.count = String(count);
  const activate = () => {
    // A reply being written in it stays: going to the message must not throw it away (codex-ui #12361).
    if (!holdsReply(toast)) toast.remove();
    void hooks.showMessage(message.seq);
    if (message.fromKind === "agent") noteAttention(message.seq, "banner-opened");
  };
  // The header row: a visible grip, who/where, and ✕ (codex-ui #10866: the grip says it moves).
  const head = h("div", "answer-toast-head");
  toast.title = "Drag to move these notifications; click to open the message";
  const where = `↩ @${message.from} in ${conversationTitle(conversation)}${count > 1 ? ` · ${count} new` : ""}`;
  head.append(h("span", "answer-toast-grip", "⠿"), h("span", "answer-toast-where", where));
  makeHandle(toast, activate);
  const dismiss = h("button", "answer-toast-close", "✕");
  dismiss.type = "button";
  dismiss.title = "Close, leaving it unread (✓ Read marks it read)";
  dismiss.setAttribute("aria-label", "Close this notification");
  head.append(dismiss);
  const open = h("button", "answer-toast-open");
  open.type = "button";
  // The whole text, a few lines of it shown; "More" lets the rest out (Ümit #10782: she could not read them).
  const body = h("span", "answer-toast-text", text || "(file)");
  open.append(body);
  // A tap opens it through the handle above; the keyboard (Enter/Space) through click.
  open.addEventListener("click", (event) => {
    if (event.detail === 0) activate();
  });
  dismiss.addEventListener("click", () => toast.remove());
  toast.append(head, open);
  box.append(toast);
  const row = h("div", "answer-toast-row");
  if (body.scrollHeight > body.clientHeight + 1) {
    const more = h("button", "link-btn answer-toast-more", "More");
    more.type = "button";
    more.addEventListener("click", () => {
      const expanded = body.classList.toggle("expanded");
      more.textContent = expanded ? "Less" : "More";
      place(savedPosition());
    });
    row.append(more);
  }
  // Answer it here, without going to its conversation (Ümit #12130): a box in the banner, sent as a reply to it.
  const reply = h("button", "link-btn answer-toast-reply");
  reply.type = "button";
  setIcon(reply, "reply", "Reply");
  reply.title = `Reply to @${message.from} here, without leaving this conversation`;
  reply.addEventListener("click", () => replyIn(toast, message, conversation));
  // Or keep it as a task for myself, in my inbox (Can #12197).
  const take = h("button", "link-btn answer-toast-reply");
  take.type = "button";
  const drawTake = (taken: boolean) => {
    setIcon(take, "task", taken ? "In your inbox ✓" : "Task for me");
    take.disabled = taken;
    take.title = taken ? "One of your tasks, in your inbox" : "Put it in your inbox as a task for yourself (only you see it)";
  };
  drawTake(state.ownTasks.some((t) => t.seq === message.seq));
  take.addEventListener("click", () => {
    take.disabled = true;
    setOwnTask(message.seq, "open").then(
      () => drawTake(true),
      (error) => {
        take.disabled = false;
        take.title = `Not saved: ${errorText(error)}`;
      }
    );
  });
  // Copy its text (Ümit #12447): dragging leaves no way to select it, so a button does it, and says whether it worked.
  const copy = h("button", "link-btn answer-toast-reply");
  copy.type = "button";
  setIcon(copy, "copy", "Copy");
  copy.title = "Copy the whole message";
  copy.setAttribute("aria-live", "polite");
  copy.addEventListener("click", async () => {
    const copied = await copyText(message.text);
    setIcon(copy, copied ? "check" : "x", copied ? "Copied" : "Not copied: open the message and copy it there");
    setTimeout(() => setIcon(copy, "copy", "Copy"), copied ? 1500 : 4000);
  });
  // Answer it by voice, or hear it (Ümit #12766): the message box's recording panel, sent to this conversation as a
  // reply to this message; and the same ▶ as on messages, read by the bus's speech server.
  const voice = h("button", "link-btn answer-toast-reply");
  voice.type = "button";
  setIcon(voice, "mic", "Voice");
  voice.title = `Reply to @${message.from} with a voice message, without leaving this conversation (Send sends it)`;
  voice.addEventListener("click", () => startVoiceReply({ kind: "conversation", id: conversation.id }, message));
  const listen = speakButton(message);
  listen.classList.add("answer-toast-speak");
  // ✓ Read (Ümit #13983): one tap says "seen it" and the banner goes, its conversation read; not "unimportant", the
  // message stays where it is (and ✕ still only closes, leaving it unread).
  const read = h("button", "link-btn answer-toast-reply answer-toast-read");
  read.type = "button";
  setIcon(read, "check", "Read");
  read.title = "I've read it: close this and mark its conversation read (the message stays where it is)";
  read.addEventListener("click", () => {
    markRead(conversation.id);
    if (message.fromKind === "agent") noteAttention(message.seq, "banner-read");
    if (!holdsReply(toast)) toast.remove();
  });
  row.prepend(read, reply, voice, listen, take, copy);
  for (const button of row.querySelectorAll("button")) tapOnTouchEnd(button);
  toast.append(row);
  place(savedPosition());
}

/**
 * A finger's tap on `button` acts when it lifts, not on the browser's click: on the iPhone a banner button sometimes
 * took several taps (Ümit #13664), the click going astray while the keyboard closed and the banner moved. A tap that
 * moved more than a few pixels is a scroll or a drag and does nothing; touchend is kept from the page, so the browser's
 * own click for it never comes and nothing runs twice. Mouse and keyboard keep the plain click.
 */
function tapOnTouchEnd(button: HTMLButtonElement): void {
  let start: { x: number; y: number } | undefined;
  button.addEventListener("touchstart", (event) => {
    const t = event.touches[0];
    start = event.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : undefined;
  }, { passive: true });
  button.addEventListener("touchend", (event) => {
    const t = event.changedTouches[0];
    const was = start;
    start = undefined;
    if (!was || !t || button.disabled || Math.hypot(t.clientX - was.x, t.clientY - was.y) > 10) return;
    event.preventDefault();
    button.click();
  });
  button.addEventListener("touchcancel", () => (start = undefined));
}

/**
 * Opening a conversation clears its banners: they fade out while its unread messages pulse back (render.ts pulseUnread;
 * Can #11972, #11976). Others stay.
 */
export function clearAnswersFor(conversationId: string): void {
  for (const toast of box?.querySelectorAll<HTMLElement>(".answer-toast") ?? []) {
    if (toast.dataset.conversation !== conversationId || toast.classList.contains("answer-toast-leaving")) continue;
    // One with a reply written in it, or on its way, stays until sent or closed (codex-ui #12361).
    if (holdsReply(toast)) continue;
    toast.classList.add("answer-toast-leaving");
    // A timer, not animationend: with reduced motion there is no animation to end.
    setTimeout(() => toast.remove(), PULSE_MS);
  }
}

/** A banner whose reply box has text in it, or whose reply is being sent. */
function holdsReply(toast: HTMLElement): boolean {
  const input = toast.querySelector<HTMLTextAreaElement>(".answer-toast-input");
  return !!input && (input.readOnly || input.value.trim() !== "");
}

/** The reply box inside a banner: Enter sends it as a reply to `message`, Shift+Enter is a new line, Esc closes it. */
function replyIn(toast: HTMLElement, message: Message, conversation: Conversation): void {
  const existing = toast.querySelector<HTMLTextAreaElement>(".answer-toast-input");
  if (existing) return existing.focus();
  const form = h("form", "answer-toast-form");
  const input = h("textarea", "answer-toast-input");
  input.rows = 2;
  input.placeholder = `Reply to @${message.from} in ${conversationTitle(conversation)}…`;
  input.setAttribute("aria-label", input.placeholder);
  const send = h("button", "answer-toast-send");
  send.type = "submit";
  setIcon(send, "send");
  send.setAttribute("aria-label", "Send the reply");
  const note = h("div", "answer-toast-note");
  note.setAttribute("role", "status");
  form.append(input, send, note);
  toast.append(form);
  place(savedPosition());
  input.focus();
  let sending = false;
  const submit = async () => {
    const text = input.value.trim();
    if (!text || sending) return;
    sending = true;
    send.disabled = true;
    // Read-only while on its way: what is in the box is what was sent, nothing typed after it is lost (codex-ui #12361).
    input.readOnly = true;
    note.textContent = "Sending…";
    try {
      await postJson<PostMessageResponse>("/api/messages", { from: state.me, text, replyToSeq: message.seq });
      // Sent: the banner says so for a moment and goes; the reply is in its conversation.
      toast.classList.add("answer-toast-leaving");
      form.replaceChildren(h("div", "answer-toast-note", `Sent to ${conversationTitle(conversation)} ✓`));
      setTimeout(() => toast.remove(), PULSE_MS);
    } catch (err) {
      note.textContent = `Not sent: ${errorText(err)} Your text is still here.`;
      input.readOnly = false;
      send.disabled = false;
      sending = false;
    }
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      form.remove();
      place(savedPosition());
    }
  });
}
