// The main pane: header and messages (with quotes, receipts, attachments), and renderAll.
import { senderLabel, type Conversation, type Message, type Quote, type ReceiptEvent } from "@agent-bus/protocol";
import { renderFile } from "./attachments";
import { BRAND } from "./brand";
import { setReplyTo, updateComposerState } from "./composer";
import { dom, PHONE } from "./dom";
import { dayFormat, dayKey, errorText, fullFormat, nameList, timeFormat } from "./format";
import { changeButtons, deleteQuestion, editBox } from "./edit";
import { h } from "./html";
import { icon, setIcon, type IconName } from "./icons";
import { renderMarkdown } from "./markdown";
import { setTitleBase } from "./notify";
import { navigate } from "./routing";
import { renderSidebar } from "./sidebar";
import { renderTaskBadge } from "./inbox";
import { updateJump } from "./jump";
import { renderPane } from "./pane";
import { isPinned, setMessagePinned } from "./pins";
import { bookmarkButton, isBookmarked } from "./bookmarks";
import { renderSpeaking, speakButton } from "./speak";
import { conversationAddress, conversationTitle, projectColor, state } from "./state";
import { conversationLink, flashMessage, markSelected, mentionNodes, mentionsMe, selectMessage, shownMessage, textBlocks } from "./text";

export function renderAll(): void {
  renderSidebar();
  renderHeader();
  renderMessages();
  updateComposerState();
  renderPane();
}

/**
 * Sets the header's title and the full name list shown on hover; on phones a tap unfolds a title too long for one
 * line (Ümit, 15 Nov), and a new title starts folded again.
 */
function setConvTitle(title: string, names: string): void {
  if (dom.convTitle.textContent !== title) dom.convTitle.classList.remove("expanded");
  dom.convTitle.textContent = title;
  dom.convTitle.title = names;
}

export function renderHeader(): void {
  const view = state.view;
  setNameMenu(undefined);
  dom.subgroupsPanel.hidden = true;
  dom.convParent.hidden = true;
  if (view.kind === "draft") {
    const title = view.project !== undefined ? `@@${view.project}` : nameList(view.to);
    setConvTitle(title, view.project !== undefined ? title : `You and ${nameList(view.to)}`);
    dom.convSubtitle.textContent =
      view.project !== undefined
        ? `New project "${view.project}", open: anyone can find and join it — created when you send the first message.`
        : `New conversation between you and ${nameList(view.to)} — created when you send the first message.`;
    setTitleBase(`${title} · ${BRAND}`);
    return;
  }
  const conv = state.conversations.get(view.id);
  if (!conv) {
    setConvTitle(view.id, view.id);
    dom.convSubtitle.textContent = "Unknown conversation.";
    setTitleBase(BRAND);
    return;
  }
  const title = conversationTitle(conv);
  setConvTitle(title, conv.kind === "all" ? "Everyone" : `Members: ${nameList(conv.members)}`);
  // The title in the text colour (#10099): a project's colour is its band in the list and the Workspace's shared tint.
  setTitleBase(`${title} · ${BRAND}`);
  setNameMenu(conv.kind === "group" || conv.kind === "project" ? "settings and tab" : "tab");
  // "Parent: @@reading" beside the name, a link to it (Can #11791), where the conversation is under a project I can see.
  const parent = conv.parentId ? state.conversations.get(conv.parentId) : undefined;
  if (parent) {
    dom.convParent.replaceChildren("Parent: ", conversationLink(parent));
    dom.convParent.hidden = false;
  }
  if (conv.kind === "all") {
    dom.convSubtitle.textContent = "Everyone. Every agent receives what is written here.";
  } else {
    const member = conv.members.includes(state.me);
    const membership = member
      ? ""
      : conv.kind === "dm"
        ? " You are viewing agents' DM."
        : conv.kind === "project" && conv.visibility !== "open"
          ? " Ask a member to add you."
          : " You are viewing; you join when you send a message.";
    // A named room or project also shows its address, the way links and agents reach it (#10623).
    const address = conv.kind === "project" && conv.title ? `${conversationAddress(conv)} · ` : "";
    const project = conv.kind === "project" ? `${address}${conv.topic ? `${conv.topic} · ` : ""}${conv.visibility ?? "open"} ${conv.room ? "room" : "project"} · ` : "";
    const level = conv.notify?.[state.me];
    const notify = level ? ` Your notifications: ${level === "mentions" ? "mentions only" : "none"}.` : "";
    const archived = conv.archived ? " Archived: writing in it brings it back." : "";
    dom.convSubtitle.textContent = `${project}Members: ${nameList(conv.members)}.${membership}${notify}${archived}`;
  }
  renderSubgroups(conv);
}

/**
 * The name is the button to the conversation's menu (Can #11463: no ⋯ of its own): its tab for every conversation
 * (Can #11480), and more for rooms, projects and groups (`what` says what). Only a draft's name is plain text, and on
 * a phone a tap unfolds a long one (phones.ts).
 */
function setNameMenu(what: string | undefined): void {
  dom.convMenuBtn.classList.toggle("no-menu", !what);
  if (what) {
    dom.convMenuBtn.setAttribute("aria-haspopup", "menu");
    dom.convMenuBtn.setAttribute("aria-label", `${dom.convTitle.textContent}: ${what}`);
  } else {
    dom.convMenuBtn.removeAttribute("aria-haspopup");
    dom.convMenuBtn.removeAttribute("aria-label");
  }
}

/**
 * A root project's "Sub-groups": the projects and group DMs under it, each a link with its description (a project's
 * topic, a group's members), open or folded as the reader left it. Only those the reader can see are listed.
 */
function renderSubgroups(conv: Conversation): void {
  const children = conv.kind === "project"
    ? Array.from(state.conversations.values())
        .filter((c) => c.parentId === conv.id)
        .sort((a, b) => Number(a.kind !== "project") - Number(b.kind !== "project") || b.lastMessageAt - a.lastMessageAt)
    : [];
  dom.subgroupsPanel.hidden = children.length === 0;
  if (children.length === 0) return;
  dom.subgroupsPanel.style.setProperty("--project-color", projectColor(conv));
  dom.subgroupsSummary.textContent = `Sub-groups (${children.length})`;
  dom.subgroupsList.replaceChildren(
    ...children.map((child) => {
      const li = h("li");
      const link = h("button", "link-btn subgroup-link", conversationTitle(child));
      link.type = "button";
      link.addEventListener("click", () => navigate({ kind: "conversation", id: child.id }));
      // A group DM's title already names its members.
      const description =
        child.kind === "project" ? (child.topic ?? `${child.visibility ?? "open"} ${child.room ? "room" : "project"}`) : `group DM · ${child.members.length} members`;
      const unread = state.unread.get(child.id) ?? 0;
      li.append(link, h("span", "subgroup-desc", ` — ${description}${unread > 0 ? ` · ${unread} unread` : ""}`));
      if (!child.members.includes(state.me)) li.append(h("span", "subgroup-desc", " · you're not in it"));
      return li;
    })
  );
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
  renderSpeaking();
  updateJump();
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
  // Changed by its writer (Ümit #10890): said quietly, the time in the tooltip.
  if (message.editedAt && !message.deletedAt) {
    const edited = h("span", "msg-edited", "edited");
    edited.title = `Edited ${fullFormat.format(message.editedAt)}`;
    head.append(edited);
  }
  li.append(head);
  // Outside the head so grouped messages (whose head is hidden) can be replied to too. Shown on hover, or on phones
  // (no hover) after tapping the message. Clicking Reply again cancels.
  const actions = h("div", "msg-actions");
  const deleted = !!message.deletedAt;
  if (message.text && !deleted) actions.append(speakButton(message), copyButton(message));
  actions.append(copyIdButton(message));
  // ☆ saves it in my own bookmarks, ★ drops it (Can #11065); a deleted one keeps its ★ so it can still be dropped here.
  if (!deleted || isBookmarked(message.seq)) actions.append(bookmarkButton(message));
  // 📌 for members: pins the message in its conversation, or unpins it (#10757).
  if (!deleted && state.conversations.get(message.conversationId)?.members.includes(state.me)) actions.append(pinButton(message));
  // ✎ 🗑 on my own messages (Ümit #10890).
  actions.append(...changeButtons(message));
  const replyBtn = h("button", "msg-action-btn msg-reply-btn");
  setIcon(replyBtn, "reply");
  replyBtn.append(h("span", "msg-reply-label", "Reply"));
  replyBtn.type = "button";
  replyBtn.title = "Reply to this message (quotes it); click again to cancel";
  replyBtn.addEventListener("click", () =>
    setReplyTo(state.replyTo?.conversationId === message.conversationId && state.replyTo.seq === message.seq ? undefined : message)
  );
  if (!deleted) actions.append(replyBtn);
  li.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a, button, audio, img, input, textarea, summary, .msg-edit, .msg-delete-ask")) return;
    // Selecting text inside it is not a click on it.
    if (String(getSelection() ?? "").trim()) return;
    // A click on a message puts me "in" it, on the paragraph clicked: lit until I click another, press Esc or leave
    // (Ümit #11622, #11855).
    const at = textBlocks(li).findIndex((block) => block.contains(event.target as Node));
    selectMessage(message.seq, at >= 0 ? at : undefined);
    if (!PHONE.matches) return;
    const open = state.tappedSeq !== message.seq;
    for (const other of dom.messageList.querySelectorAll(".msg-tapped")) other.classList.remove("msg-tapped");
    state.tappedSeq = open ? message.seq : undefined;
    if (!open) return;
    li.classList.add("msg-tapped");
    requestAnimationFrame(() => revealActions(actions));
  });

  if (message.quote) li.append(renderQuote(message.quote));
  if (deleted) {
    li.classList.add("msg-deleted");
    const gone = h("div", "msg-text msg-deleted-text", "Message deleted");
    if (message.deletedAt) gone.title = `Deleted by ${message.from} ${fullFormat.format(message.deletedAt)}`;
    li.append(gone);
  } else {
    const box = editBox(message);
    if (box) li.append(box);
    else if (message.text) li.append(renderText(message.text));
  }
  if (message.files.length > 0) {
    const files = h("ul", "msg-files");
    for (const file of message.files) files.append(renderFile(file));
    li.append(files);
  }
  const badge = renderTaskBadge(message);
  if (badge) li.append(badge);
  const receipts = renderReceipts(message);
  if (receipts) li.append(receipts);
  const ask = deleteQuestion(message);
  if (ask) li.append(ask);
  // Last: on phones it is a row under the message (on wider screens it floats top right).
  li.append(actions);
  if (state.selectedSeq === message.seq) markSelected(li);
  if (state.tappedSeq === message.seq) li.classList.add("msg-tapped");
  return li;
}

/**
 * Phones: a tapped message's buttons open as a row under it; at the lower edge that row was below the visible
 * messages (Ümit #11869). Scroll the messages just enough to show it, nothing else moves.
 */
function revealActions(actions: HTMLElement): void {
  const below = actions.getBoundingClientRect().bottom - dom.messageScroll.getBoundingClientRect().bottom + 8;
  if (below > 0) dom.messageScroll.scrollBy({ top: below, behavior: "smooth" });
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
  // Whom it started a turn for (Can, 15 Nov: wake lists); the other agents take it in at their next turn.
  if (message.wake) el.textContent += message.wake.length > 0 ? ` · woke ${message.wake.join(", ")}` : " · woke nobody";
  el.title = receipts
    .map((r) =>
      r.deliveredAt !== null
        ? `${label(r)}: delivered ${fullFormat.format(r.deliveredAt)}`
        : r.expired
          ? `${label(r)}: expired ${fullFormat.format(message.expiresAt)} (it stayed offline)`
          : `${label(r)}: not delivered yet; held until ${fullFormat.format(message.expiresAt)}`
    )
    .join("\n");
  if (message.wake) el.title += "\nWoken (a turn now): " + (message.wake.join(", ") || "nobody; the agents read it at their next turn");
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
  // No text and no files: the quoted message was deleted (Ümit #10890); every other message has one or the other.
  const quoted = quote.text || (quote.files > 0 ? "(no text)" : "(message deleted)");
  el.append(h("span", "msg-quote-from", quote.from), h("span", "msg-quote-text", `${quoted}${files}`));
  el.addEventListener("click", () => {
    const target = shownMessage(quote.seq);
    if (target) flashMessage(target);
  });
  return el;
}

/** Message text as markdown (see markdown.ts), with @mentions highlighted outside code. */
/**
 * ⧉: the whole message's text to the clipboard, as shown (without markdown signs); single sentences people select
 * themselves.
 */
function copyButton(message: Message): HTMLButtonElement {
  return copier("copy", "Copy the whole message", () => {
    const shown = actionsOwner(message)?.querySelector<HTMLElement>(".msg-text");
    return shown?.innerText.trim() || message.text;
  });
}

/** "#10228" to the clipboard (Can, #10228): the number stays easy to share while it is drawn quietly. */
function copyIdButton(message: Message): HTMLButtonElement {
  return copier("hash", `Copy the message's number (#${message.seq})`, () => `#${message.seq}`);
}

/** 📌 on a message: pinned (filled, "Unpin") or not; the header's pin and the Pinned list follow (#10757). */
function pinButton(message: Message): HTMLButtonElement {
  const pinned = isPinned(message);
  const button = h("button", `msg-action-btn msg-pin-btn${pinned ? " pinned" : ""}`);
  button.append(icon("pin", pinned));
  button.type = "button";
  button.title = pinned ? "Unpin it from this conversation (the message stays)" : "Pin it to this conversation (the pin at the top right)";
  button.setAttribute("aria-label", pinned ? `Unpin message #${message.seq}` : `Pin message #${message.seq}`);
  button.setAttribute("aria-pressed", pinned ? "true" : "false");
  button.addEventListener("click", () => {
    button.disabled = true;
    setMessagePinned(message, !pinned).catch((error) => {
      button.disabled = false;
      button.title = `Not ${pinned ? "unpinned" : "pinned"}: ${errorText(error)}`;
    });
  });
  return button;
}

function actionsOwner(message: Message): Element | null {
  return dom.messageList.querySelector(`[data-seq="${message.seq}"]`);
}

/** One polite live region for copy results, so screen readers hear "Copied #12" or why not (#10401). */
let announcer: HTMLElement | undefined;
function announce(text: string): void {
  if (!announcer) {
    announcer = h("div", "visually-hidden");
    announcer.setAttribute("aria-live", "polite");
    document.body.append(announcer);
  }
  announcer.textContent = "";
  setTimeout(() => (announcer ? (announcer.textContent = text) : undefined), 30);
}

/** Copies `value`: the Clipboard API, else a selected hidden text box (plain http, older browsers). Whether it worked. */
async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const box = h("textarea");
    box.value = value;
    box.style.position = "fixed";
    box.style.opacity = "0";
    document.body.append(box);
    box.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    box.remove();
    return copied;
  }
}

/** Copying was blocked: the text in a selected box under the message, to copy by hand; ✕ or Esc closes it. */
function manualCopy(near: Element | null, value: string): void {
  if (!near) return;
  near.querySelector(".copy-manual")?.remove();
  const row = h("div", "copy-manual");
  const field = h("input");
  field.readOnly = true;
  field.value = value;
  field.setAttribute("aria-label", "Text to copy");
  const close = h("button", "link-btn", "✕");
  close.type = "button";
  close.title = "Close";
  close.addEventListener("click", () => row.remove());
  field.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    row.remove();
  });
  row.append(h("span", "copy-manual-hint", "Not copied automatically; copy it from here:"), field, close);
  near.append(row);
  field.focus();
  field.select();
}

/** A message action that copies `text()`: ✓ "Copied" only when it was (#10401), else the text to copy by hand. */
function copier(name: IconName, title: string, text: () => string): HTMLButtonElement {
  const button = h("button", "msg-action-btn msg-copy-btn");
  setIcon(button, name);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", async () => {
    const value = text();
    const copied = await copyText(value);
    const short = value.length > 40 ? `${value.slice(0, 39)}…` : value;
    setIcon(button, copied ? "check" : "x");
    button.title = copied ? "Copied" : "Not copied";
    announce(copied ? `Copied ${short}` : "Not copied automatically: the text is selected below the message, copy it from there");
    if (!copied) manualCopy(button.closest(".msg"), value);
    setTimeout(() => {
      setIcon(button, name);
      button.title = title;
    }, 1500);
  });
  return button;
}

function renderText(text: string): HTMLDivElement {
  const body = h("div", "msg-text");
  body.append(...renderMarkdown(text, mentionNodes));
  return body;
}
