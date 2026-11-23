// Inline nodes of message text: @mentions highlighted, #n message references linked.
import { ALL_CONVERSATION_ID, mentionedIds, mentionSpans, type Conversation, type Message } from "@agent-bus/protocol";
import { api } from "./api";
import { dom, holdInView, showInView } from "./dom";
import { errorText } from "./format";
import { hooks } from "./hooks";
import { h } from "./html";
import { icon, setIcon } from "./icons";
import { conversationTitle, state } from "./state";
import { noteAttention } from "./attention";

/** `text` mentions me as `@me` or inside `@{…}`. */
export function mentionsMe(text: string): boolean {
  return mentionedIds(text).includes(state.me);
}

/**
 * Plain text with @mentions highlighted and #n message references linked; `refs` false leaves the references as text
 * (a forwarded copy for someone who cannot read its conversation; Can #12470).
 */
export function mentionNodes(text: string, refs = true): Node[] {
  const out: Node[] = [];
  let last = 0;
  const plain = (part: string): Node[] => (refs ? refNodes(part) : [document.createTextNode(part)]);
  for (const { start, end } of mentionSpans(text)) {
    const mention = text.slice(start, end);
    if (start > last) out.push(...plain(text.slice(last, start)));
    const span = h("span", "mention", mention);
    const id = mention.slice(1).toLowerCase();
    if (id === state.me || id === "all") span.classList.add("mention-me");
    out.push(span);
    last = end;
  }
  if (last < text.length) out.push(...plain(text.slice(last)));
  return out;
}

// ---- Message references (#n), rooms (#name) and projects (@@name) ----

/**
 * "#1234" (a message), "#name" (a room) or "@@name" (a project): rooms and projects are linked only when they exist
 * and I can see them (Can 15 Nov, #11791); other #words and @@words stay text.
 */
const REF_RE = /(^|[^\w#&@])(#|@@)(\d{1,7}|[a-z0-9][a-z0-9_-]*)(?![\w-])/g;

function refNodes(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(REF_RE)) {
    const sign = match[2] ?? "#";
    const ref = match[3] ?? "";
    const named = /[a-z]/.test(ref);
    if (sign === "@@" && !named) continue;
    const target =
      sign === "@@" ? namedConversation(ref, false) : ref === "all" ? state.conversations.get(ALL_CONVERSATION_ID) : named ? namedConversation(ref, true) : undefined;
    if (named && !target) continue;
    const start = (match.index ?? 0) + (match[1] ?? "").length;
    if (start > last) out.push(document.createTextNode(text.slice(last, start)));
    out.push(target ? conversationLink(target) : refLink(Number(ref)));
    last = start + sign.length + ref.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/** The room (`room`) or project (not a room) with address `name`, if I can see it. */
function namedConversation(name: string, room: boolean): Conversation | undefined {
  for (const c of state.conversations.values()) if (c.kind === "project" && !!c.room === room && c.name === name) return c;
  return undefined;
}

/** "#name" or "@@name" as a link to that room or project (the header's "Parent:" uses it too). */
export function conversationLink(conv: Conversation): HTMLAnchorElement {
  const label = conv.kind === "all" ? "#all" : conv.room ? `#${conv.name}` : `@@${conv.name}`;
  const a = h("a", "msg-ref", label);
  a.href = `#/c/${encodeURIComponent(conv.id)}`;
  a.title =
    conv.kind === "all"
      ? "Everyone's room"
      : [conv.title ?? `${conv.room ? "Room" : "Project"} ${label}`, conv.topic, conv.archived ? "archived" : undefined].filter(Boolean).join(" — ");
  return a;
}

/**
 * "#n" as a link: click shows message n (in its conversation); hovering highlights it when it is on screen and shows
 * its message in the same floating-card language as a new-message banner (Can #15519).
 */
export function refLink(seq: number): HTMLAnchorElement {
  const a = h("a", "msg-ref", `#${seq}`);
  a.href = "#";
  a.addEventListener("click", (event) => {
    event.preventDefault();
    void hooks.showMessage(seq);
  });
  a.addEventListener("mouseenter", () => {
    const target = shownMessage(seq);
    if (target && onScreen(target)) target.classList.add("msg-ref-target");
    void showRefPreview(a, seq);
  });
  a.addEventListener("mouseleave", () => {
    shownMessage(seq)?.classList.remove("msg-ref-target");
    hideRefPreview(a);
  });
  return a;
}

export function shownMessage(seq: number): HTMLElement | null {
  return dom.messageList.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
}

function onScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const view = dom.messageScroll.getBoundingClientRect();
  return r.bottom > view.top && r.top < view.bottom;
}

/**
 * Lights message `seq` as the one I am in, always with one frame around the whole message (Ümit #15125).
 * Paragraph Seen controls are independent and always visible; `part` remembers which paragraph was tapped.
 */
export function selectMessage(seq: number | undefined, part?: number): void {
  state.selectedSeq = seq;
  state.selectedPart = seq === undefined ? undefined : part;
  for (const li of dom.messageList.querySelectorAll<HTMLElement>(".msg-selected")) li.classList.remove("msg-selected");
  const li = seq === undefined ? null : dom.messageList.querySelector<HTMLElement>(`.msg[data-seq="${seq}"]`);
  if (li) markSelected(li);
}

/** The blocks of a message's text: its paragraphs, lists, code and quotes. */
export function textBlocks(li: HTMLElement): HTMLElement[] {
  return [...(li.querySelector(":scope > .msg-text")?.children ?? [])] as HTMLElement[];
}

/** Draws the whole-message selection frame. */
export function markSelected(li: HTMLElement): void {
  li.classList.add("msg-selected");
}

// ---- Messages I marked as seen (Can #15838): green rules plus an open-envelope action button ----

const READ_PARTS_KEY = "agent-bus.readParts";
/** "me:seq:paragraph"; the newest kept last, at most READ_PARTS_MAX. This browser only. */
const READ_PARTS_MAX = 5000;
let readParts: string[] = (() => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(READ_PARTS_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
})();
let readSet = new Set(readParts);

const partKey = (seq: number, index: number): string => `${state.me}:${seq}:${index}`;

function setMessageRead(seq: number, count: number, read: boolean): void {
  const prefix = `${state.me}:${seq}:`;
  readParts = readParts.filter((key) => !key.startsWith(prefix));
  if (read) {
    for (let index = 0; index < count; index += 1) readParts.push(partKey(seq, index));
  }
  readParts = readParts.slice(-READ_PARTS_MAX);
  readSet = new Set(readParts);
  localStorage.setItem(READ_PARTS_KEY, JSON.stringify(readParts));
}

function drawSeenButton(li: HTMLElement, seq: number): void {
  const button = li.querySelector<HTMLButtonElement>(".msg-seen-btn");
  if (!button) return;
  const blocks = textBlocks(li);
  const seen = blocks.length > 0 && blocks.every((_, index) => readSet.has(partKey(seq, index)));
  const iconName = seen ? "mail" : "mail-open";
  const oldIcon = button.querySelector<SVGSVGElement>(".icon");
  if (oldIcon && !oldIcon.classList.contains(`icon-${iconName}`)) oldIcon.replaceWith(icon(iconName));
  button.querySelector<HTMLElement>(".msg-extra-label")?.replaceChildren(seen ? "Unseen" : "Seen");
  button.classList.toggle("marked-seen", seen);
  button.title = seen ? "Mark this message as unseen" : "Mark this message as seen";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", String(seen));
}

/** Restores this browser's green rules and the action button's state. */
export function markReadParts(li: HTMLElement, seq: number): void {
  textBlocks(li).forEach((block, index) => block.classList.toggle("md-read", readSet.has(partKey(seq, index))));
  drawSeenButton(li, seq);
}

/** Open-envelope action: mark every text block in a message as seen, or undo them together. */
export function seenButton(seq: number): HTMLButtonElement {
  const button = h("button", "msg-action-btn msg-seen-btn");
  button.type = "button";
  setIcon(button, "mail-open");
  button.title = "Mark this message as seen";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => {
    const li = button.closest<HTMLElement>(".msg");
    if (!li) return;
    const blocks = textBlocks(li);
    const seen = blocks.length > 0 && blocks.every((_, index) => readSet.has(partKey(seq, index)));
    setMessageRead(seq, blocks.length, !seen);
    if (!seen) noteAttention(seq, "marked-read");
    markReadParts(li, seq);
  });
  return button;
}

/**
 * Takes me to a message (a banner, a #number, a bookmark, search): scrolled to the middle and lit until I move on, so
 * it is found among the others (Ümit #11622: the short flash was over before the scroll ended).
 */
export function flashMessage(el: HTMLElement): void {
  const seq = Number(el.dataset.seq);
  selectMessage(seq);
  holdInView(seq);
  showInView(el, "smooth");
  el.classList.remove("msg-flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("msg-flash");
}

type MessageWithConversation = { message: Message; conversation: Conversation };

const refFetches = new Map<number, Promise<MessageWithConversation>>();

export function fetchMessage(seq: number): Promise<MessageWithConversation> {
  let pending = refFetches.get(seq);
  if (!pending) {
    pending = api<MessageWithConversation>(`/api/messages/${seq}`);
    pending.catch(() => refFetches.delete(seq));
    refFetches.set(seq, pending);
  }
  return pending;
}

/** Message `seq` changed (edited or deleted, Ümit #10890): the next fetch asks the bus again. */
export function forgetFetched(seq: number): void {
  refFetches.delete(seq);
}

let refPreview: HTMLElement | undefined;
let refPreviewOwner: HTMLAnchorElement | undefined;
let refPreviewRequest = 0;

/** Removes only `owner`'s preview: a late mouseleave from an older reference must not close the current one. */
function hideRefPreview(owner?: HTMLAnchorElement): void {
  if (owner && refPreviewOwner !== owner) return;
  refPreviewRequest += 1;
  refPreview?.remove();
  refPreviewOwner?.removeAttribute("aria-describedby");
  refPreview = refPreviewOwner = undefined;
}

/** Keeps the hover card beside its reference and inside the visual viewport. */
function placeRefPreview(anchor: HTMLAnchorElement, preview: HTMLElement): void {
  const link = anchor.getBoundingClientRect();
  const card = preview.getBoundingClientRect();
  const vv = window.visualViewport;
  const leftEdge = (vv?.offsetLeft ?? 0) + 8;
  const rightEdge = (vv ? vv.offsetLeft + vv.width : innerWidth) - 8;
  const topEdge = (vv?.offsetTop ?? 0) + 8;
  const bottomEdge = (vv ? vv.offsetTop + vv.height : innerHeight) - 8;
  const left = Math.min(Math.max(link.left, leftEdge), Math.max(leftEdge, rightEdge - card.width));
  const below = link.bottom + 8;
  const above = link.top - card.height - 8;
  const top = below + card.height <= bottomEdge ? below : Math.max(topEdge, above);
  preview.style.left = `${Math.round(left)}px`;
  preview.style.top = `${Math.round(top)}px`;
}

/** A transient, non-interactive message card for a hovered "#n"; leaving the reference removes it. */
async function showRefPreview(owner: HTMLAnchorElement, seq: number): Promise<void> {
  hideRefPreview();
  const request = refPreviewRequest;
  refPreviewOwner = owner;
  let result: MessageWithConversation | undefined;
  let failure: string | undefined;
  try {
    result = await fetchMessage(seq);
  } catch (error) {
    failure = errorText(error);
  }
  if (request !== refPreviewRequest || refPreviewOwner !== owner || !owner.matches(":hover")) return;

  const preview = h("div", "answer-toast message-ref-preview");
  preview.id = `message-ref-preview-${seq}`;
  preview.setAttribute("role", "tooltip");
  preview.dataset.seq = String(seq);
  const where = result ? `#${seq} · @${result.message.from} in ${conversationTitle(result.conversation)}` : `#${seq}`;
  const head = h("div", "answer-toast-head");
  head.append(h("span", "answer-toast-where", where));
  const body = h("div", "answer-toast-open");
  const text = result?.message.text.replace(/\s+/g, " ").trim() ?? `Could not show this message: ${failure ?? "unknown error"}`;
  const files = result && result.message.files.length > 0 ? `\nFiles: ${result.message.files.map((file) => file.name).join(", ")}` : "";
  body.append(h("span", "answer-toast-text", `${text || "(file)"}${files}`));
  preview.append(head, body);
  document.body.append(preview);
  refPreview = preview;
  owner.setAttribute("aria-describedby", preview.id);
  placeRefPreview(owner, preview);
}
