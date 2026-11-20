// "Ask @agent" (Ümit #13030): while a person writes in a room without naming anyone, the bus's "recipient" box
// extension may name the one agent of the room with the best evidence to answer; the box then offers "Ask @webapp".
// A tap puts the mention at the front of the draft, to edit and send as usual. Asked after a short pause in typing,
// one request at a time; an answer counts only for the exact draft it was asked about, in the same conversation, so
// an edit or another room drops it. Never in the way: no answer, a slow model or one that is down only means no
// button, and sending never waits for it. Quiet when the person chose: a member named, @all, or Reply. An add-on: off
// until turned on in Settings, per browser (Ümit #13222).
import { ALL_CONVERSATION_ID, mentionedIds, type BoxRecipientResponse } from "@agent-bus/protocol";
import { api } from "./api";
import { dom } from "./dom";
import { h } from "./html";
import { state } from "./state";

/** The pause in typing before the box asks: long enough that a question is written, short enough to be there in time. */
const PAUSE_MS = 700;
/** Shorter drafts are not asked about ("ok", "thx"). */
const MIN_DRAFT_CHARS = 8;

const chip = h("button", "ask-chip");
chip.type = "button";
chip.hidden = true;
(dom.composer.querySelector(".composer-tools .tools-spacer") ?? dom.input).before(chip);

let timer: ReturnType<typeof setTimeout> | undefined;
/** The request on its way, for which conversation and draft. */
let asking: { controller: AbortController; conversationId: string; draft: string } | undefined;
/** The suggestion shown: who, for which conversation and draft. */
let shown: { recipient: string; conversationId: string; draft: string } | undefined;

const ASK_KEY = "agent-bus.askAgent";

/** The bus's "recipient" box extension, if it has one. */
export function recipientBox(): string | undefined {
  return Object.entries(state.boxes).find(([, role]) => role === "recipient")?.[0];
}

export function askAgentOn(): boolean {
  return localStorage.getItem(ASK_KEY) === "1";
}

export function setAskAgentOn(on: boolean): void {
  localStorage.setItem(ASK_KEY, on ? "1" : "0");
  if (!on) reset();
}

/** A room of at least two agents besides me, with the add-on on: where an agent could be suggested. */
function askingRoom(conversationId: string): boolean {
  if (!recipientBox() || !askAgentOn()) return false;
  const conversation = state.conversations.get(conversationId);
  if (!conversation?.room) return false;
  const agents = conversation.members.filter((id) => id !== state.me && state.participants.find((p) => p.id === id)?.kind === "agent");
  return agents.length >= 2;
}

/** The room the draft is in, when it is one where an agent could be suggested: else undefined. */
function askableRoom(): string | undefined {
  const view = state.view;
  if (view.kind !== "conversation" || !askingRoom(view.id)) return undefined;
  const conversation = state.conversations.get(view.id)!;
  // The person chose: a reply, a checklist item answered, a member named, @all.
  if (state.replyTo || state.itemReply || state.voiceLatched) return undefined;
  const named = mentionedIds(dom.input.value);
  if (named.includes(ALL_CONVERSATION_ID) || conversation.members.some((id) => named.includes(id))) return undefined;
  return view.id;
}

/**
 * What the model said while this draft was written (Ümit #13224), reported when it is sent: the last offer stands
 * (an empty answer after it does not take it back), the time of the last answer, whether asking failed.
 */
let seen: { conversationId: string; recipient?: string; confidence?: number; ms?: number; failed?: boolean; taken: boolean } | undefined;

function note(conversationId: string, what: { recipient?: string; confidence?: number; ms?: number; failed?: boolean }): void {
  if (seen?.conversationId !== conversationId) seen = { conversationId, taken: false };
  if (what.recipient) Object.assign(seen, { recipient: what.recipient, confidence: what.confidence, taken: false });
  if (what.ms !== undefined) seen.ms = what.ms;
  seen.failed = what.failed === true ? true : undefined;
}

/**
 * After a message went in `conversationId` (send.ts): one line for the bus's record of the add-on's use (Ümit #13224):
 * taken (sent with the offered agent), named-other (someone else or @all named), ignored (offered, nobody named),
 * named (named someone, nothing was offered), quiet (nothing offered, nobody named), reply. Never the text.
 */
export function askSent(conversationId: string, text: string, replied: boolean): void {
  const name = recipientBox();
  const was = seen?.conversationId === conversationId ? seen : undefined;
  seen = undefined;
  if (!name || !askingRoom(conversationId)) return;
  const members = state.conversations.get(conversationId)?.members ?? [];
  const named = mentionedIds(text).filter((id) => id === ALL_CONVERSATION_ID || members.includes(id));
  const outcome = replied
    ? "reply"
    : was?.recipient
      ? named.includes(was.recipient) && was.taken
        ? "taken"
        : named.length > 0
          ? "named-other"
          : "ignored"
      : named.length > 0
        ? "named"
        : "quiet";
  void api(`/api/box/${encodeURIComponent(name)}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, outcome, recipient: was?.recipient, confidence: was?.confidence, ms: was?.ms, failed: was?.failed }),
  }).catch(() => {
    // A report that does not arrive costs nothing but a line.
  });
}

function hide(): void {
  shown = undefined;
  chip.hidden = true;
}

/** Drops what is shown, what is on its way and what was waiting to be asked. */
function reset(): void {
  clearTimeout(timer);
  asking?.controller.abort();
  asking = undefined;
  hide();
}

function ask(conversationId: string, draft: string): void {
  const name = recipientBox();
  if (!name) return;
  asking?.controller.abort();
  const controller = new AbortController();
  asking = { controller, conversationId, draft };
  const started = performance.now();
  void api<BoxRecipientResponse>(`/api/box/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, text: draft }),
    signal: controller.signal,
  })
    .then((res) => {
      if (asking?.controller !== controller) return;
      // Only for the draft and room it was asked about, and only while nothing was chosen meanwhile.
      if (askableRoom() !== conversationId || dom.input.value.trim() !== draft) return;
      note(conversationId, { recipient: res.recipient ?? undefined, confidence: res.confidence, ms: performance.now() - started });
      if (!res.recipient) return;
      shown = { recipient: res.recipient, conversationId, draft };
      chip.textContent = `Ask @${res.recipient}`;
      chip.title = `Ask @${res.recipient}: puts @${res.recipient} at the front of your message (you still send it)`;
      chip.hidden = false;
    })
    .catch(() => {
      // No suggestion is no loss: the box works as always.
      if (asking?.controller === controller && !controller.signal.aborted) note(conversationId, { failed: true });
    })
    .finally(() => {
      if (asking?.controller === controller) asking = undefined;
    });
}

/** After every change of the draft: what was shown or asked goes, and the new draft is asked about after a pause. */
function schedule(): void {
  reset();
  const conversationId = askableRoom();
  const draft = dom.input.value.trim();
  if (!conversationId || draft.length < MIN_DRAFT_CHARS) return;
  timer = setTimeout(() => {
    if (askableRoom() === conversationId && dom.input.value.trim() === draft) ask(conversationId, draft);
  }, PAUSE_MS);
}

function take(): void {
  if (!shown) return;
  const mention = `@${shown.recipient} `;
  if (seen?.conversationId === shown.conversationId) seen.taken = true;
  reset();
  dom.input.focus();
  // At the front, as typed (so ⌘Z takes it back and the box's own listeners see it); the cursor goes back to the end.
  dom.input.setSelectionRange(0, 0);
  if (!document.execCommand("insertText", false, mention)) {
    dom.input.setRangeText(mention, 0, 0, "start");
    dom.input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  dom.input.setSelectionRange(dom.input.value.length, dom.input.value.length);
}

dom.input.addEventListener("input", schedule);
// A tap on the chip must not take the focus from the box (on a phone the keyboard would drop). Safari sends no click
// after a pointerdown kept from the focus, so a tap takes on pointerup; a click after it is not a second take
// (Ümit #13338: tapping the word chip did nothing).
let pressed = false;
let tookOnPointerUp = false;
chip.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  pressed = true;
  tookOnPointerUp = false;
});
chip.addEventListener("pointercancel", () => (pressed = false));
chip.addEventListener("pointerup", () => {
  if (!pressed) return;
  pressed = false;
  tookOnPointerUp = true;
  take();
});
chip.addEventListener("click", () => {
  if (tookOnPointerUp) tookOnPointerUp = false;
  else take();
});
// Another room, a reply or a checklist item chosen, a message sent: what was asked about no longer applies.
window.addEventListener("hashchange", () => {
  reset();
  seen = undefined;
});
new MutationObserver(() => (dom.replyBar.hidden ? schedule() : reset())).observe(dom.replyBar, { attributes: true, attributeFilter: ["hidden"] });
dom.composer.addEventListener("submit", reset, { capture: true });
