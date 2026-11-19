// Typing suggestions (Can #12841–#12871): when the bus has a "complete" box extension and this browser has them on
// (Settings), every change of the draft asks it for the next words, one request at a time (the newest draft goes
// next). An answer shows as long as it still fits what is typed: typing the suggested letters keeps showing the rest,
// typing something else hides it. The words show in grey after the cursor; Tab takes them, Escape drops them. Phones
// have no Tab: there a chip under the text takes them on a tap. Not Enter: Enter sends, and Safari's grey completion
// taking Enter is why it was turned off (Ümit #11651).
import type { BoxResponse } from "@agent-bus/protocol";
import { api } from "./api";
import { dom } from "./dom";
import { h } from "./html";
import { state } from "./state";

const SUGGEST_KEY = "agent-bus.suggestions";

/** The bus's "complete" extension, if it has one. */
export function suggestionBox(): string | undefined {
  return Object.entries(state.boxes).find(([, role]) => role === "complete")?.[0];
}

export function suggestionsOn(): boolean {
  return localStorage.getItem(SUGGEST_KEY) === "1";
}

export function setSuggestionsOn(on: boolean): void {
  localStorage.setItem(SUGGEST_KEY, on ? "1" : "0");
  if (!on) reset();
}

/** The grey words, laid over the box: the draft in transparent text (to take its place), then the words. */
const ghost = h("div", "composer-ghost");
ghost.setAttribute("aria-hidden", "true");
dom.input.before(ghost);
/** The phones' way to take them. */
const chip = h("button", "suggest-chip");
chip.type = "button";
chip.hidden = true;
dom.input.after(chip);

/** The latest answer: the draft it was for, and that draft followed by its words. Shown while the box's text runs
 * from the draft into the words (so an answer for an earlier, shorter text never shows after a send or a deletion). */
let answer: { conversationId: string; draft: string; full: string } | undefined;
/** The words on screen now. */
let shown: string | undefined;
/** The request on its way, and whether the draft changed since (then the newest draft is asked next). */
let asking: { controller: AbortController; draft: string } | undefined;
let changed = false;
/** An input method (Japanese, Chinese, accents held on a Mac) is composing: nothing is asked, shown or taken. */
let composing = false;

function hide(): void {
  shown = undefined;
  ghost.replaceChildren();
  chip.hidden = true;
}

/** Forgets everything: what is shown, the answer kept, the request on its way. */
function reset(): void {
  asking?.controller.abort();
  asking = undefined;
  changed = false;
  answer = undefined;
  hide();
}

/** The cursor is at the end of the draft, with nothing selected: the only place a suggestion goes. */
function atEnd(): boolean {
  const { selectionStart, selectionEnd, value } = dom.input;
  return selectionStart === value.length && selectionEnd === value.length;
}

/** Where suggestions are asked for now: a conversation (not a new draft), turned on, nothing in the way. */
function conversationNow(): string | undefined {
  const view = state.view;
  if (!suggestionBox() || !suggestionsOn() || composing || view.kind !== "conversation" || state.mention.open) return undefined;
  return view.id;
}

function show(text: string): void {
  shown = text;
  // Laid exactly over the box's text: its place, size, font and padding (they change with the screen and the grip).
  const box = getComputedStyle(dom.input);
  Object.assign(ghost.style, {
    top: `${dom.input.offsetTop}px`,
    left: `${dom.input.offsetLeft}px`,
    width: `${dom.input.clientWidth}px`,
    height: `${dom.input.clientHeight}px`,
    font: box.font,
    letterSpacing: box.letterSpacing,
    padding: box.padding,
  });
  ghost.replaceChildren(h("span", "ghost-draft", dom.input.value), h("span", "ghost-words", text));
  ghost.scrollTop = dom.input.scrollTop;
  chip.textContent = `+${text}`;
  chip.title = "Add these words (Tab)";
  chip.hidden = !window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

/** Shows what of the latest answer is still ahead of the typed text, if the text is a start of it; else nothing. */
function showFitting(): void {
  const id = conversationNow();
  const text = dom.input.value;
  const fits = answer && id === answer.conversationId && atEnd() && text.startsWith(answer.draft) && answer.full.startsWith(text);
  const rest = fits && answer ? answer.full.slice(text.length) : "";
  if (rest.trim() && document.activeElement === dom.input) show(rest);
  else hide();
}

/** Asks about the draft as it is now, unless a request is on its way: then it goes when that one is back. */
function askNow(): void {
  const id = conversationNow();
  const name = suggestionBox();
  const draft = dom.input.value;
  if (!id || !name || !draft.trim() || !atEnd()) return;
  if (asking) {
    changed = asking.draft !== draft;
    return;
  }
  changed = false;
  const controller = new AbortController();
  asking = { controller, draft };
  void api<BoxResponse>(`/api/box/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: id, text: draft }),
    signal: controller.signal,
  })
    .then((res) => {
      if (asking?.controller !== controller) return;
      // An answer with nothing to add replaces nothing: the earlier one may still fit.
      if (res.text) answer = { conversationId: id, draft, full: draft + res.text };
      showFitting();
    })
    .catch(() => {
      // A suggestion that does not come is no loss: the box works as before.
    })
    .finally(() => {
      if (asking?.controller !== controller) return;
      asking = undefined;
      if (changed) askNow();
    });
}

/**
 * The box's text was replaced without typing (a message was sent; what stays is anything typed after Send): what was
 * asked or answered for the old text goes, and the new text is asked about afresh (codex-ui #12875).
 */
export function draftReplaced(): void {
  reset();
  askNow();
}

function take(): void {
  if (!shown) return;
  const text = shown;
  hide();
  dom.input.focus();
  // As typed, so ⌘Z takes it back and the box's own listeners (size, draft, @names, the next suggestion) see it.
  if (!document.execCommand("insertText", false, text)) {
    dom.input.setRangeText(text, dom.input.value.length, dom.input.value.length, "end");
    dom.input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

dom.input.addEventListener("input", (event) => {
  if ((event as InputEvent).isComposing) return hide();
  showFitting();
  askNow();
});
// Unfinished input from an input method is not asked about; the committed text is (codex-ui #12868).
dom.input.addEventListener("compositionstart", () => {
  composing = true;
  hide();
});
dom.input.addEventListener("compositionend", () => {
  composing = false;
  showFitting();
  askNow();
});

// Tab takes the words; Escape drops them and what was on its way, so nothing shows later (codex-ui #12868). In the
// capture phase, before the box's own keys.
dom.input.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Tab" && shown && !event.shiftKey && !event.isComposing && !composing && !state.mention.open) {
      event.preventDefault();
      event.stopImmediatePropagation();
      take();
    } else if (event.key === "Escape" && (shown || asking || answer)) {
      if (shown) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      reset();
    }
  },
  { capture: true }
);
// The cursor moved away from the end (arrows, a click), or the box lost the focus: nothing shows.
document.addEventListener("selectionchange", () => {
  if (document.activeElement === dom.input && shown && !atEnd()) hide();
});
dom.input.addEventListener("scroll", () => (ghost.scrollTop = dom.input.scrollTop));
dom.input.addEventListener("blur", () => setTimeout(() => document.activeElement !== chip && hide(), 0));
// A tap on the chip must not take the focus (the keyboard would drop): pointerdown keeps it in the box.
chip.addEventListener("pointerdown", (event) => event.preventDefault());
chip.addEventListener("click", take);
window.addEventListener("hashchange", reset);
