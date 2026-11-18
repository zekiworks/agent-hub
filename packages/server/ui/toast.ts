// An answer elsewhere (Ümit, 16 Nov: "I write in one room and go to another; how do I know an answer came?"): a banner
// at the top, "↩ @logic in #toolbench-models: …", that opens the message when tapped. Phones show no browser
// notifications in a Safari tab, and the conversation list is hidden while a conversation is open. A banner stays
// until tapped, closed with ✕, or its conversation is opened (Ümit #10168: 12 s was too short to catch). One banner per
// conversation, with how many answers it holds; no limit on how many conversations (Can #11976: dropping the oldest
// silently was worse than a timer).
import type { Conversation, Message } from "@agent-bus/protocol";
import { dom } from "./dom";
import { hooks } from "./hooks";
import { h } from "./html";
import { conversationTitle, state } from "./state";

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
  box.classList.toggle("moved", !!position);
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

/** A drag that just ended: the click it ends with must not open the message. */
let dragged = false;

/** Dragging a banner by its header row moves all of them (mouse and touch: pointer events); a tap on it, `tap`. The
 * handle is not inside the banner's button: Firefox gives a button's children no mouse events (Ümit #10864). */
function makeHandle(handle: HTMLElement, tap: () => void): void {
  handle.addEventListener("pointerdown", (down) => {
    if (!box || down.button !== 0 || (down.target as Element).closest("button")) return;
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
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      if (!moving) return tap();
      if (!box) return;
      // The click that may follow this drag must not open the message; a later tap must.
      dragged = true;
      setTimeout(() => (dragged = false), 0);
      const r = box.getBoundingClientRect();
      localStorage.setItem(POSITION_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
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
  previous?.remove();
  const toast = h("div", "answer-toast");
  toast.dataset.conversation = conversation.id;
  toast.dataset.count = String(count);
  const activate = () => {
    toast.remove();
    void hooks.showMessage(message.seq);
  };
  // The header row: a visible grip and who/where, the handle that moves the banners (codex-ui #10866: it looked like
  // ordinary text), and ✕.
  const head = h("div", "answer-toast-head");
  head.title = "Drag to move these notifications; click to open the message";
  const where = `↩ @${message.from} in ${conversationTitle(conversation)}${count > 1 ? ` · ${count} new` : ""}`;
  head.append(h("span", "answer-toast-grip", "⠿"), h("span", "answer-toast-where", where));
  makeHandle(head, activate);
  const dismiss = h("button", "answer-toast-close", "✕");
  dismiss.type = "button";
  dismiss.title = "Close (the message stays in its conversation)";
  dismiss.setAttribute("aria-label", "Close this notification");
  head.append(dismiss);
  const open = h("button", "answer-toast-open");
  open.type = "button";
  // The whole text, a few lines of it shown; "More" lets the rest out (Ümit #10782: she could not read them).
  const body = h("span", "answer-toast-text", text || "(file)");
  open.append(body);
  // A tap or click on the text opens the message: a press and release in place. Pressing and moving selects text,
  // not an open. Not relying on the browser's click: after a touch drag Chrome sometimes sends none for the next tap.
  // The keyboard (Enter/Space) still opens it through click.
  let pressed: { x: number; y: number } | undefined;
  open.addEventListener("pointerdown", (event) => {
    pressed = event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
  });
  open.addEventListener("pointerup", (event) => {
    const still = pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < 6;
    pressed = undefined;
    if (still && !dragged) activate();
  });
  open.addEventListener("click", (event) => {
    if (event.detail === 0) activate();
  });
  dismiss.addEventListener("click", () => toast.remove());
  const reset = h("button", "link-btn answer-toast-reset", "Reset position");
  reset.type = "button";
  reset.addEventListener("click", () => {
    localStorage.removeItem(POSITION_KEY);
    place(undefined);
  });
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
  row.append(reset);
  toast.append(row);
  place(savedPosition());
}

/**
 * Opening a conversation clears its banners: they fade out while its unread messages pulse back (render.ts pulseUnread;
 * Can #11972, #11976). Others stay.
 */
export function clearAnswersFor(conversationId: string): void {
  for (const toast of box?.querySelectorAll<HTMLElement>(".answer-toast") ?? []) {
    if (toast.dataset.conversation !== conversationId || toast.classList.contains("answer-toast-leaving")) continue;
    toast.classList.add("answer-toast-leaving");
    // A timer, not animationend: with reduced motion there is no animation to end.
    setTimeout(() => toast.remove(), PULSE_MS);
  }
}
