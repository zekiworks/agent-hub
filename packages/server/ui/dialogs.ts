// "Close window" at the bottom of every dialog (Can, 15 Nov), besides ✕ and Esc. Dialogs drawn once get it here;
// those drawn afresh each time they open (settings.ts, convmenu.ts) add it in their render.
import { dom } from "./dom";
import { h } from "./html";

/** A "Close window" row for the bottom of `dialog`. */
export function closeWindowButton(dialog: HTMLDialogElement): HTMLDivElement {
  const row = h("div", "dialog-actions close-window-row");
  const button = h("button", "btn close-window", "Close window");
  button.type = "button";
  button.addEventListener("click", () => dialog.close());
  row.append(button);
  return row;
}

for (const dialog of [dom.statsDialog, dom.gpuDialog, dom.profileDialog]) dialog.append(closeWindowButton(dialog));

// The image viewer closes on any click already; the button says so where people look for it.
const lightboxClose = h("button", "link-btn", "Close window");
lightboxClose.type = "button";
dom.lightboxDownload.after(lightboxClose);

// New group's Cancel already closes it: it gets the same name.
dom.groupCancel.textContent = "Close window";
