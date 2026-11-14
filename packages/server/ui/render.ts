// The main pane: header and messages (with quotes, receipts, attachments), and renderAll.
import { senderLabel, type Message, type Quote, type ReceiptEvent } from "@agent-bus/protocol";
import { renderFile } from "./attachments";
import { setReplyTo, updateComposerState } from "./composer";
import { dom, PHONE } from "./dom";
import { dayFormat, dayKey, fullFormat, nameList, timeFormat } from "./format";
import { h } from "./html";
import { renderMarkdown } from "./markdown";
import { setTitleBase } from "./notify";
import { navigate } from "./routing";
import { renderSidebar } from "./sidebar";
import { CAN_SPEAK, speakButton } from "./speak";
import { conversationTitle, state } from "./state";
import { flashMessage, mentionNodes, mentionsMe, shownMessage } from "./text";

export function renderAll(): void {
  renderProfileSelect();
  renderSidebar();
  renderHeader();
  renderMessages();
  updateComposerState();
}

function renderProfileSelect(): void {
  dom.profileSelect.replaceChildren(
    ...state.humans.map((id) => {
      const option = h("option", undefined, id);
      option.value = id;
      return option;
    })
  );
  dom.profileSelect.value = state.me;
}

export function renderHeader(): void {
  const view = state.view;
  if (view.kind === "draft") {
    dom.convTitle.textContent = nameList(view.to);
    dom.convSubtitle.textContent = `New conversation between you and ${nameList(view.to)} — created when you send the first message.`;
    setTitleBase(`${nameList(view.to)} · Agent Bus`);
    return;
  }
  const conv = state.conversations.get(view.id);
  if (!conv) {
    dom.convTitle.textContent = view.id;
    dom.convSubtitle.textContent = "Unknown conversation.";
    setTitleBase("Agent Bus");
    return;
  }
  const title = conversationTitle(conv);
  dom.convTitle.textContent = title;
  setTitleBase(`${title} · Agent Bus`);
  if (conv.kind === "all") {
    dom.convSubtitle.textContent = "Everyone. Every agent receives what is written here.";
  } else {
    const membership = conv.members.includes(state.me)
      ? ""
      : " You are viewing; you join when you send a message.";
    dom.convSubtitle.textContent = `Members: ${nameList(conv.members)}.${membership}`;
  }
}

export function showEmpty(text: string): void {
  dom.messageList.replaceChildren();
  dom.loadEarlier.hidden = true;
  dom.messageEmpty.hidden = false;
  dom.messageEmpty.textContent = text;
}

export function renderMessages(): void {
  const view = state.view;
  if (view.kind === "draft") {
    showEmpty(`No messages yet. Write below to start the conversation with ${nameList(view.to)}.`);
    return;
  }
  const cache = state.caches.get(view.id);
  if (!cache) {
    showEmpty("Loading…");
    return;
  }
  if (cache.messages.length === 0) {
    showEmpty("No messages yet.");
    return;
  }
  dom.messageEmpty.hidden = true;
  dom.loadEarlier.hidden = !cache.hasEarlier;

  const nodes: HTMLElement[] = [];
  let lastDay = "";
  let previous: Message | undefined;
  for (const message of cache.messages) {
    const day = dayKey(message.createdAt);
    if (day !== lastDay) {
      nodes.push(h("li", "day-divider", dayFormat.format(message.createdAt)));
      lastDay = day;
      previous = undefined;
    }
    const continued =
      previous !== undefined && previous.from === message.from && message.createdAt - previous.createdAt < 5 * 60_000;
    nodes.push(renderMessage(message, continued));
    previous = message;
  }
  dom.messageList.replaceChildren(...nodes);
}

function renderMessage(message: Message, continued: boolean): HTMLLIElement {
  const human = message.fromKind === "human";
  const li = h("li", `msg ${human ? "msg-human" : "msg-agent"}`);
  if (message.from === state.me) li.classList.add("msg-mine");
  else if (message.text && mentionsMe(message.text)) li.classList.add("msg-mentions-me");
  if (continued) li.classList.add("msg-continued");
  li.dataset.seq = String(message.seq);
  if (state.replyTo?.conversationId === message.conversationId && state.replyTo.seq === message.seq) li.classList.add("msg-replying");

  const head = h("div", "msg-head");
  const sender = h("button", "msg-sender", senderLabel(message));
  sender.type = "button";
  sender.title = human ? "Human" : "Agent — click to open a direct conversation";
  if (!human) sender.addEventListener("click", () => navigate({ kind: "draft", to: [message.from] }));
  head.append(sender, h("span", `kind-tag ${human ? "kind-human" : "kind-agent"}`, human ? "human" : "agent"));
  // Human messages written while the bus checks who humans are: signed in with a passkey, or not.
  if (message.verified === true) {
    const badge = h("span", "verified-tag", "✓");
    badge.title = "Signed in with a passkey: really them";
    head.append(badge);
  } else if (message.verified === false) {
    const badge = h("span", "unverified-tag", "not verified");
    badge.title = "Written without signing in: anyone on the LAN could have written this";
    head.append(badge);
  }
  const time = h("time", "msg-time", timeFormat.format(message.createdAt));
  time.dateTime = new Date(message.createdAt).toISOString();
  time.title = fullFormat.format(message.createdAt);
  head.append(h("span", "msg-seq", `#${message.seq}`), time);
  li.append(head);
  // Outside the head so grouped messages (whose head is hidden) can be replied to too. Shown on hover, or on phones
  // (no hover) after tapping the message. Clicking Reply again cancels.
  const actions = h("div", "msg-actions");
  if (message.text && CAN_SPEAK) actions.append(speakButton(message.text));
  const replyBtn = h("button", "msg-action-btn msg-reply-btn", "↩ ");
  replyBtn.append(h("span", "msg-reply-label", "Reply"));
  replyBtn.type = "button";
  replyBtn.title = "Reply to this message (quotes it); click again to cancel";
  replyBtn.addEventListener("click", () =>
    setReplyTo(state.replyTo?.conversationId === message.conversationId && state.replyTo.seq === message.seq ? undefined : message)
  );
  actions.append(replyBtn);
  li.addEventListener("click", (event) => {
    if (!PHONE.matches || (event.target as Element).closest("a, button, audio, img, input, summary")) return;
    const tapped = li.classList.contains("msg-tapped");
    for (const other of dom.messageList.querySelectorAll(".msg-tapped")) other.classList.remove("msg-tapped");
    if (!tapped) li.classList.add("msg-tapped");
  });

  if (message.quote) li.append(renderQuote(message.quote));
  if (message.text) li.append(renderText(message.text));
  if (message.files.length > 0) {
    const files = h("ul", "msg-files");
    for (const file of message.files) files.append(renderFile(file));
    li.append(files);
  }
  const receipts = renderReceipts(message);
  if (receipts) li.append(receipts);
  // Last: on phones it is a row under the message (on wider screens it floats top right).
  li.append(actions);
  return li;
}

/**
 * "✓" once every agent recipient has it (seen or not: seen is not shown, it took too much room in groups). Otherwise
 * what is still open: "✓ 3 · ○ waiting: @a · ○ held: @b (offline) · ✕ expired: @c". Names and times are in the
 * tooltip. Null when there are no agent recipients. A receipt not delivered yet is "held" while its agent is offline,
 * "waiting" while it is online.
 */
function renderReceipts(message: Message): HTMLDivElement | null {
  const { receipts } = message;
  if (receipts.length === 0) return null;
  const offline = (to: string) => state.participants.find((p) => p.id === to)?.online !== true;
  const delivered = receipts.filter((r) => r.deliveredAt !== null);
  const expired = receipts.filter((r) => r.deliveredAt === null && r.expired === true);
  const held = receipts.filter((r) => r.deliveredAt === null && r.expired !== true && offline(r.to));
  const waiting = receipts.filter((r) => r.deliveredAt === null && r.expired !== true && !offline(r.to));
  const status = waiting.length + held.length > 0 ? "receipts-pending" : expired.length > 0 ? "receipts-expired" : "receipts-delivered";
  const el = h("div", `msg-receipts ${status}`);
  el.dataset.receipts = String(message.seq);
  // A message sent to one session of an agent names it (`alpha-2`).
  const label = (r: (typeof receipts)[number]) => (r.session === undefined ? r.to : `${r.to}-${r.session}`);
  const names = (list: typeof receipts) => list.map(label).join(", ");
  el.textContent =
    delivered.length === receipts.length
      ? "✓"
      : [
          delivered.length ? `✓ ${delivered.length}` : "",
          waiting.length ? `○ waiting: ${names(waiting)}` : "",
          held.length ? `○ held: ${names(held)} (offline)` : "",
          expired.length ? `✕ expired: ${names(expired)}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
  el.title = receipts
    .map((r) =>
      r.deliveredAt !== null
        ? `${label(r)}: delivered ${fullFormat.format(r.deliveredAt)}`
        : r.expired
          ? `${label(r)}: expired ${fullFormat.format(message.expiresAt)} (it stayed offline)`
          : `${label(r)}: not delivered yet; held until ${fullFormat.format(message.expiresAt)}`
    )
    .join("\n");
  return el;
}

/**
 * Receipts for messages this page does not hold yet: an agent can ack a first message before the page has the new
 * conversation (the POST answer, the socket's message frame and the ack race). `receive` applies them.
 */
const earlyReceipts = new Map<number, ReceiptEvent[]>();

/** Copies a receipt (or an expiry) into the message's entry for its recipient. */
function applyTo(entry: Message["receipts"][number], receipt: ReceiptEvent): void {
  if (receipt.type === "expired") {
    entry.expired = true;
    return;
  }
  entry.deliveredAt = receipt.deliveredAt;
  entry.seenAt = receipt.seenAt;
}

/** Applies receipts that arrived before `message` did. */
export function applyEarlyReceipts(message: Message): void {
  for (const receipt of earlyReceipts.get(message.seq) ?? []) {
    const entry = message.receipts.find((r) => r.to === receipt.to);
    if (entry) applyTo(entry, receipt);
  }
  earlyReceipts.delete(message.seq);
}

/** Updates the cached message and, if it is on screen, its receipt line. */
export function applyReceipt(receipt: ReceiptEvent): void {
  const message =
    state.caches.get(receipt.conversationId)?.messages.find((m) => m.seq === receipt.seq) ??
    state.loading.get(receipt.conversationId)?.find((m) => m.seq === receipt.seq);
  const entry = message?.receipts.find((r) => r.to === receipt.to);
  if (!message || !entry) {
    const list = earlyReceipts.get(receipt.seq) ?? [];
    list.push(receipt);
    earlyReceipts.set(receipt.seq, list);
    // Only the last few matter (first messages of new conversations); never let this grow.
    if (earlyReceipts.size > 50) earlyReceipts.delete(earlyReceipts.keys().next().value ?? 0);
    return;
  }
  applyTo(entry, receipt);
  const shown = dom.messageList.querySelector(`[data-receipts="${receipt.seq}"]`);
  const updated = renderReceipts(message);
  if (shown && updated) shown.replaceWith(updated);
}

/** Quote block of a reply; clicking jumps to the original when it is loaded. */
function renderQuote(quote: Quote): HTMLButtonElement {
  const el = h("button", "msg-quote");
  el.type = "button";
  el.title = `Reply to #${quote.seq} — click to show it`;
  const files = quote.files > 0 ? ` · ${quote.files} file${quote.files === 1 ? "" : "s"}` : "";
  el.append(h("span", "msg-quote-from", quote.from), h("span", "msg-quote-text", `${quote.text || "(no text)"}${files}`));
  el.addEventListener("click", () => {
    const target = shownMessage(quote.seq);
    if (target) flashMessage(target);
  });
  return el;
}

/** Message text as markdown (see markdown.ts), with @mentions highlighted outside code. */
function renderText(text: string): HTMLDivElement {
  const body = h("div", "msg-text");
  body.append(...renderMarkdown(text, mentionNodes));
  return body;
}
