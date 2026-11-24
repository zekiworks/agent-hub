// Tools (#10101): occasional utilities (Go to message, Stats, GPU booking) in one top-bar menu instead of a row of
// controls. Items keep their own handlers (app.ts, stats.ts, gpus.ts); this only opens and closes the menu.
import { dom } from "./dom";

function setOpen(on: boolean): void {
  dom.toolsMenu.hidden = !on;
  dom.toolsBtn.setAttribute("aria-expanded", on ? "true" : "false");
}

dom.toolsBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  setOpen(dom.toolsMenu.hidden);
});

// Choosing an item, clicking elsewhere or Esc closes it.
dom.toolsMenu.addEventListener("click", () => setOpen(false));
document.addEventListener("click", () => setOpen(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !dom.toolsMenu.hidden) setOpen(false);
});
