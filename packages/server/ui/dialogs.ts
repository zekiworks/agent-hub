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

/**
 * Asks for one line of text in the page's own dialog, not the browser's prompt() (which some phones' Home Screen apps
 * lack, and which looks like the browser rather than Agent Hub): the text, or null when cancelled.
 */
export function askText(heading: string, hint: string, initial = "", action = "Save"): Promise<string | null> {
  const dialog = h("dialog", "dialog ask-dialog");
  const form = h("form");
  form.method = "dialog";
  const input = h("input");
  input.type = "text";
  input.value = initial;
  input.autocomplete = "off";
  input.maxLength = 80;
  const label = h("label", "", hint);
  label.append(input);
  const cancel = h("button", "btn", "Cancel");
  cancel.type = "button";
  const ok = h("button", "btn btn-primary", action);
  ok.type = "submit";
  const actions = h("div", "dialog-actions");
  actions.append(cancel, ok);
  form.append(h("h2", "", heading), label, actions);
  dialog.append(form);
  document.body.append(dialog);
  return new Promise((resolve) => {
    let answer: string | null = null;
    form.addEventListener("submit", () => (answer = input.value));
    cancel.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(answer);
    });
    dialog.showModal();
    input.focus();
    input.select();
  });
}

for (const dialog of [dom.statsDialog, dom.gpuDialog, dom.profileDialog]) dialog.append(closeWindowButton(dialog));

// The image viewer closes on any click already; the button says so where people look for it.
const lightboxClose = h("button", "link-btn", "Close window");
lightboxClose.type = "button";
dom.lightboxDownload.after(lightboxClose);

// New group's Cancel already closes it: it gets the same name.
dom.groupCancel.textContent = "Close window";
