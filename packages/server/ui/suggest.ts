// Typing suggestions (Can #12841–#12853): when the bus has a "complete" box extension and this browser has them on
// (Settings), a pause in typing asks it for the next words. They show in grey after the cursor; Tab takes them, any
// other key lets them go. Phones have no Tab: there a chip under the text takes them on a tap. Not Enter: Enter
// sends, and Safari's grey completion taking Enter is why it was turned off (Ümit #11651).
import type { BoxResponse } from "@agent-bus/protocol";
import { api } from "./api";
import { dom } from "./dom";
import { h } from "./html";
import { state } from "./state";

const SUGGEST_KEY = "agent-bus.suggestions";
/** How long typing must pause before asking. */
const PAUSE_MS = 300;

/** The bus's "complete" extension, if it has one. */
export function suggestionBox(): string | undefined {
  return Object.entries(state.boxes).find(([, role]) => role === "complete")?.[0];
}

export function suggestionsOn(): boolean {
  return localStorage.getItem(SUGGEST_KEY) === "1";
}

export function setSuggestionsOn(on: boolean): void {
  localStorage.setItem(SUGGEST_KEY, on ? "1" : "0");
  if (!on) clear();
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

let shown: { text: string; draft: string } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let asking: AbortController | undefined;

function clear(): void {
  clearTimeout(timer);
  asking?.abort();
  asking = undefined;
  shown = undefined;
  ghost.replaceChildren();
  chip.hidden = true;
}

/** The cursor is at the end of the draft, with nothing selected: the only place a suggestion goes. */
function atEnd(): boolean {
  const { selectionStart, selectionEnd, value } = dom.input;
  return selectionStart === value.length && selectionEnd === value.length;
}

function show(text: string, draft: string): void {
  shown = { text, draft };
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
  ghost.replaceChildren(h("span", "ghost-draft", draft), h("span", "ghost-words", text));
  ghost.scrollTop = dom.input.scrollTop;
  chip.textContent = `+${text}`;
  chip.title = "Add these words (Tab)";
  chip.hidden = !window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

function take(): void {
  if (!shown) return;
  const { text } = shown;
  clear();
  dom.input.focus();
  // As typed, so ⌘Z takes it back and the box's own listeners (size, draft, @names) see it.
  if (!document.execCommand("insertText", false, text)) dom.input.setRangeText(text, dom.input.value.length, dom.input.value.length, "end");
  dom.input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function ask(name: string, conversationId: string, draft: string): Promise<void> {
  asking?.abort();
  const controller = new AbortController();
  asking = controller;
  try {
    const res = await api<BoxResponse>(`/api/box/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, text: draft }),
      signal: controller.signal,
    });
    // Only if nothing changed meanwhile: the same draft, the cursor still at its end.
    if (asking !== controller || !res.text || dom.input.value !== draft || !atEnd() || document.activeElement !== dom.input) return;
    show(res.text, draft);
  } catch {
    // A suggestion that does not come is no loss: the box works as before.
  } finally {
    if (asking === controller) asking = undefined;
  }
}

dom.input.addEventListener("input", () => {
  clear();
  const name = suggestionBox();
  const view = state.view;
  if (!name || !suggestionsOn() || view.kind !== "conversation" || state.mention.open) return;
  const draft = dom.input.value;
  if (!draft.trim() || !atEnd()) return;
  timer = setTimeout(() => void ask(name, view.id, draft), PAUSE_MS);
});

// Tab takes the words; any other key (Escape included) lets them go. In the capture phase, before the box's own keys.
dom.input.addEventListener(
  "keydown",
  (event) => {
    if (!shown) return;
    if (event.key === "Tab" && !event.shiftKey && !state.mention.open) {
      event.preventDefault();
      event.stopImmediatePropagation();
      take();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    clear();
  },
  { capture: true }
);
dom.input.addEventListener("scroll", () => (ghost.scrollTop = dom.input.scrollTop));
dom.input.addEventListener("blur", () => setTimeout(() => document.activeElement !== chip && clear(), 0));
dom.input.addEventListener("click", () => clear());
// A tap on the chip must not take the focus (the keyboard would drop): pointerdown keeps it in the box.
chip.addEventListener("pointerdown", (event) => event.preventDefault());
chip.addEventListener("click", take);
window.addEventListener("hashchange", clear);
