// "↓": back to the newest message, shown while the list is scrolled up (Ümit, 15 Nov: like ChatGPT).
import { dom, scrollToBottom } from "./dom";

/** Shown once the newest message is this far below the visible part (px): a little scrolling keeps it away. */
const SHOW_BELOW_PX = 300;

/** Shows or hides ↓ for the list's scroll position; called on scrolling and after the list is drawn. */
export function updateJump(): void {
  const s = dom.messageScroll;
  dom.jumpBtn.hidden = s.scrollHeight - s.scrollTop - s.clientHeight < SHOW_BELOW_PX;
}

dom.messageScroll.addEventListener("scroll", updateJump, { passive: true });
dom.jumpBtn.addEventListener("click", () => {
  scrollToBottom();
  updateJump();
});
