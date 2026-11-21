// Phones: one screen at a time (the conversation list, or one conversation), sized above the keyboard.
import { autosize } from "./composer";
import { dom, nearBottom, PHONE, scrollToBottom } from "./dom";
import { isCurrent, state } from "./state";

// The iOS keyboard covers the page instead of shrinking it: pin the page to the visible area above it
// (CSS vars --vvh and --vvt), so the message box sits on the keyboard and the newest messages right above.
// Without the keyboard the page sits at the top (Ümit #11234: after a tap the whole page was left halfway down, an
// offset from the keyboard's way out that no later event corrected): the offset is used only while the keyboard is up,
// the document is scrolled back to 0, and the fit is redone when focus leaves a field, after the keyboard has gone.
const viewport = window.visualViewport;
/** A text field has the focus: only then can the on-screen keyboard be up. */
function typing(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range", "file"].includes(el.type));
}

function fitViewport(): void {
  if (!viewport || !PHONE.matches) return;
  const stick = nearBottom();
  const root = document.documentElement.style;
  // The layout viewport keeps its height when the keyboard comes up; the visual one shrinks by the keyboard's height.
  // Zooming in shrinks it too (Ümit #11400 enlarges the page; codex-ui #11401): zoomed, the page keeps its own size
  // and position and the zoomed view moves over it, as on any page; only at scale 1 does a short view mean a keyboard.
  // And only while a field has the focus (Ümit #11832, iPhone, keyboard gone: the page kept the keyboard-up height,
  // the message box floating mid-screen; the visual viewport had not grown back when the last event came).
  const zoomed = (viewport.scale ?? 1) > 1.05;
  const layout = document.documentElement.clientHeight;
  const keyboard = !zoomed && typing() && viewport.height < layout - 80;
  // While the keyboard is up the tab row and the header's second row step aside (styles.css .keyboard-up), so the
  // messages keep more than a strip (Ümit #13794: about five lines were left between header and message box).
  document.documentElement.classList.toggle("keyboard-up", keyboard);
  if (keyboard) {
    root.setProperty("--vvh", `${Math.round(viewport.height)}px`);
    root.setProperty("--vvt", `${Math.max(0, Math.round(viewport.offsetTop))}px`);
  } else {
    // No keyboard: the whole screen (100dvh in styles.css), from the top.
    root.removeProperty("--vvh");
    root.removeProperty("--vvt");
    if (!zoomed && window.scrollY !== 0) window.scrollTo(0, 0);
  }
  // A message box dragged tall keeps within the space there is now (codex-ui #11237).
  autosize();
  if (stick) scrollToBottom();
}
viewport?.addEventListener("resize", fitViewport);
viewport?.addEventListener("scroll", fitViewport);
window.addEventListener("resize", fitViewport);
window.addEventListener("scroll", fitViewport, { passive: true });
window.addEventListener("pageshow", fitViewport);
document.addEventListener("focusin", () => {
  // The keyboard animates in: fit as it comes.
  for (const ms of [100, 400, 800]) setTimeout(fitViewport, ms);
});
document.addEventListener("focusout", () => {
  // Leaving a field takes the keyboard away: the full screen at once, then again once iOS has finished.
  setTimeout(fitViewport, 0);
  for (const ms of [100, 400, 800]) setTimeout(fitViewport, ms);
});
// While a field has the focus the keyboard can also go without a blur (a hardware keyboard, iOS's own dismiss): check
// the viewport twice a second and refit when its height changed, in case no event came (codex-ui #11836).
let fittedHeight = 0;
setInterval(() => {
  if (!viewport || !PHONE.matches || !typing() || Math.round(viewport.height) === fittedHeight) return;
  fittedHeight = Math.round(viewport.height);
  fitViewport();
}, 500);

const LIST_KEY = "agent-bus.phoneList";

/**
 * Phones: show the conversation list (← in the conversation bar) instead of the open conversation. Remembered for this
 * tab, so a reload shows the list again (Ümit #11664: a reload opened the conversation she had left).
 */
export function setPhoneList(on: boolean): void {
  dom.app.classList.toggle("phone-list", on);
  sessionStorage.setItem(LIST_KEY, on ? "1" : "0");
}

/** The list was showing when this tab was last reloaded. */
export function wasOnPhoneList(): boolean {
  return sessionStorage.getItem(LIST_KEY) === "1";
}
dom.backBtn.addEventListener("click", () => {
  dom.input.blur();
  setPhoneList(true);
});

/** Phones: members, subtitle and the agent panel stay folded behind ⓘ so the messages get the screen. */
export function setDetails(on: boolean): void {
  dom.main.classList.toggle("show-details", on);
  dom.detailsBtn.setAttribute("aria-pressed", String(on));
}
dom.detailsBtn.addEventListener("click", () => setDetails(!dom.main.classList.contains("show-details")));

/** Unread messages in the other conversations, on the ← button. */
export function renderBackBadge(): void {
  let n = 0;
  let forMe = false;
  for (const [id, count] of state.unread) {
    if (isCurrent(id)) continue;
    n += count;
    if ((state.attention.get(id) ?? 0) > 0) forMe = true;
  }
  dom.backBadge.hidden = n === 0;
  dom.backBadge.textContent = n > 99 ? "99+" : String(n);
  dom.backBadge.classList.toggle("badge-for-me", forMe);
}

// The title of a conversation with many names does not fit a phone's header: a tap unfolds it (and folds it again).
// Where the name opens the room's menu, the menu's heading shows it whole instead.
dom.convTitle.addEventListener("click", () => {
  if (PHONE.matches && dom.convMenuBtn.classList.contains("no-menu")) dom.convTitle.classList.toggle("expanded");
});
