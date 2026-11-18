// Inline nodes of message text: @mentions highlighted, #n message references linked.
import { ALL_CONVERSATION_ID, mentionedIds, mentionSpans, type Conversation, type Message } from "@agent-bus/protocol";
import { api } from "./api";
import { dom, holdInView, showInView } from "./dom";
import { errorText } from "./format";
import { hooks } from "./hooks";
import { h } from "./html";
import { conversationTitle, state } from "./state";

/** `text` mentions me as `@me` or inside `@{…}`. */
export function mentionsMe(text: string): boolean {
  return mentionedIds(text).includes(state.me);
}

/** Plain text with @mentions highlighted and #n message references linked. */
export function mentionNodes(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const { start, end } of mentionSpans(text)) {
    const mention = text.slice(start, end);
    if (start > last) out.push(...refNodes(text.slice(last, start)));
    const span = h("span", "mention", mention);
    const id = mention.slice(1).toLowerCase();
    if (id === state.me || id === "all") span.classList.add("mention-me");
    out.push(span);
    last = end;
  }
  if (last < text.length) out.push(...refNodes(text.slice(last)));
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
 * "#n" as a link: click shows message n (in its conversation); hovering highlights it when it is on screen,
 * otherwise its text shows as a tooltip.
 */
function refLink(seq: number): HTMLAnchorElement {
  const a = h("a", "msg-ref", `#${seq}`);
  a.href = "#";
  a.addEventListener("click", (event) => {
    event.preventDefault();
    void hooks.showMessage(seq);
  });
  a.addEventListener("mouseenter", () => {
    const target = shownMessage(seq);
    if (target && onScreen(target)) {
      a.removeAttribute("title");
      target.classList.add("msg-ref-target");
      return;
    }
    void refSummary(seq).then((text) => (a.title = text));
  });
  a.addEventListener("mouseleave", () => shownMessage(seq)?.classList.remove("msg-ref-target"));
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
 * Lights message `seq` as the one I am in (Ümit #11622), or none; it stays lit through redraws (render.ts). `part`: the
 * paragraph clicked in a message of several, lit alone (Ümit #11855: a frame round the whole message was too big).
 */
export function selectMessage(seq: number | undefined, part?: number): void {
  state.selectedSeq = seq;
  state.selectedPart = seq === undefined ? undefined : part;
  for (const li of dom.messageList.querySelectorAll<HTMLElement>(".msg-selected")) {
    li.classList.remove("msg-selected", "msg-selected-part");
    for (const block of li.querySelectorAll(".md-selected")) block.classList.remove("md-selected");
  }
  const li = seq === undefined ? null : dom.messageList.querySelector<HTMLElement>(`.msg[data-seq="${seq}"]`);
  if (li) markSelected(li);
}

/** The blocks of a message's text: its paragraphs, lists, code and quotes. */
export function textBlocks(li: HTMLElement): HTMLElement[] {
  return [...(li.querySelector(":scope > .msg-text")?.children ?? [])] as HTMLElement[];
}

/** Draws the selection on `li`, the selected message: the clicked paragraph, or the whole message. */
export function markSelected(li: HTMLElement): void {
  li.classList.add("msg-selected");
  const blocks = textBlocks(li);
  const part = state.selectedPart !== undefined && blocks.length > 1 ? blocks[state.selectedPart] : undefined;
  li.classList.toggle("msg-selected-part", !!part);
  part?.classList.add("md-selected");
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

/** Tooltip for "#n": sender, conversation and the start of the text. */
async function refSummary(seq: number): Promise<string> {
  try {
    const { message, conversation } = await fetchMessage(seq);
    const text = message.text.replace(/\s+/g, " ").trim();
    const files = message.files.length > 0 ? ` [${message.files.map((f) => f.name).join(", ")}]` : "";
    return `#${seq} · ${message.from} in ${conversationTitle(conversation)}\n${text.length > 400 ? `${text.slice(0, 399)}…` : text}${files}`;
  } catch (err) {
    return `#${seq}: ${errorText(err)}`;
  }
}
