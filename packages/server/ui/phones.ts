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
function fitViewport(): void {
  if (!viewport || !PHONE.matches) return;
  const stick = nearBottom();
  const root = document.documentElement.style;
  // The layout viewport keeps its height when the keyboard comes up; the visual one shrinks by the keyboard's height.
  // Zooming in shrinks it too (Ümit #11400 enlarges the page; codex-ui #11401): zoomed, the page keeps its own size
  // and position and the zoomed view moves over it, as on any page; only at scale 1 does a short view mean a keyboard.
  const zoomed = (viewport.scale ?? 1) > 1.05;
  const layout = document.documentElement.clientHeight;
  const keyboard = !zoomed && viewport.height < layout - 80;
  root.setProperty("--vvh", `${Math.round(zoomed ? layout : viewport.height)}px`);
  root.setProperty("--vvt", `${keyboard ? Math.max(0, Math.round(viewport.offsetTop)) : 0}px`);
  if (!keyboard && !zoomed && window.scrollY !== 0) window.scrollTo(0, 0);
  // A message box dragged tall keeps within the space there is now (codex-ui #11237).
  autosize();
  if (stick) scrollToBottom();
}
viewport?.addEventListener("resize", fitViewport);
viewport?.addEventListener("scroll", fitViewport);
window.addEventListener("scroll", fitViewport, { passive: true });
document.addEventListener("focusout", () => {
  // iOS animates the keyboard away; fit again once it is gone.
  for (const ms of [100, 400, 800]) setTimeout(fitViewport, ms);
});

/** Phones: show the conversation list (← in the conversation bar) instead of the open conversation. */
export function setPhoneList(on: boolean): void {
  dom.app.classList.toggle("phone-list", on);
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
dom.convTitle.addEventListener("click", () => {
  if (PHONE.matches) dom.convTitle.classList.toggle("expanded");
});
