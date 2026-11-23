// The main pane: header and messages (with quotes, receipts, attachments), and renderAll.
import { senderLabel, type Conversation, type FileRef, type Message, type Quote, type ReceiptEvent } from "@agent-bus/protocol";
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
import { navigate, threadHash, viewHash } from "./routing";
import { renderSidebar } from "./sidebar";
import { ownTaskButton, renderTaskBadge } from "./inbox";
import { forwardButton, renderForwarded, renderForwards } from "./forward";
import { updateJump } from "./jump";
import { renderPane } from "./pane";
import { isPinned, setMessagePinned } from "./pins";
import { bookmarkButton, isBookmarked } from "./bookmarks";
import { renderSpeaking, speakButton } from "./speak";
import { conversationAddress, conversationTitle, projectColor, state } from "./state";
import { conversationLink, flashMessage, markReadParts, markSelected, mentionNodes, mentionsMe, selectMessage, shownMessage, textBlocks } from "./text";
import { PULSE_MS } from "./toast";
import { noteAttention } from "./attention";
import { inlinedFiles, markInlined, placeInlined } from "./inline";
import { displayed, markThreadRead, newReplies, type Threads } from "./threads";
import { startVoiceReply } from "./voice";

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
  dom.convSettingsBtn.hidden = true;
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
  setNameMenu("tab");
  // ⚙ beside the name: a room's, project's or group's settings (Ümit #12288), not behind the name's menu.
  dom.convSettingsBtn.hidden = conv.kind !== "group" && conv.kind !== "project";
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
  const { shown, threads } = displayed(cache.messages);
  const inThread = threads && state.thread !== undefined && shown[0]?.seq === state.thread;
  // An address naming a thread that is not here (not loaded, or not a thread): the room.
  if (threads && state.thread !== undefined && !inThread) {
    history.replaceState(null, "", viewHash(view));
    state.thread = undefined;
  }
  renderCrumb(view.id, inThread ? shown[0] : undefined, threads);
  dom.loadEarlier.hidden = !cache.hasEarlier || !!inThread;

  const nodes: HTMLElement[] = [];
  let lastDay = "";
  let previous: Message | undefined;
  for (const message of shown) {
    const day = dayKey(message.createdAt);
    if (day !== lastDay) {
      nodes.push(h("li", "day-divider", dayFormat.format(message.createdAt)));
      lastDay = day;
    }
    const continued =
      previous !== undefined && dayKey(previous.createdAt) === day && previous.from === message.from && message.createdAt - previous.createdAt < 5 * 60_000;
    const li = renderMessage(message, continued, previous?.seq);
    if (threads && !inThread) threadBar(li, view.id, message, threads);
    nodes.push(li);
    previous = message;
  }
  seenLine(shown.at(-1), nodes.at(-1));
  dom.messageList.replaceChildren(...nodes);
  if (inThread) markThreadRead(view.id, shown[0]!.seq, shown.at(-1)!.seq);
  renderSpeaking();
  updateJump();
}

/**
 * A new newest message of the open conversation, added at the end instead of drawing the whole list again: drawing
 * every message and laying the list out anew for each arrival made a busy room slower by the minute, until typing
 * froze (Ümit #14171; Safari's engine on a copy of #agent hub: 0.2 → 0.6 s stalls in 3 minutes). With threads on, a
 * reply into a thread the room shows folded only redraws that thread's bar. False when it is neither (then the caller
 * draws the list).
 */
export function appendMessage(message: Message): boolean {
  const view = state.view;
  if (view.kind !== "conversation") return false;
  const messages = state.caches.get(view.id)?.messages;
  if (!messages || messages.at(-1)?.seq !== message.seq || !dom.messageEmpty.hidden) return false;
  const { shown, threads } = displayed(messages);
  if (shown.at(-1)?.seq !== message.seq) {
    // Folded into a thread of the room: only its root's bar changes.
    const root = threads?.rootOf.get(message.seq);
    const rootLi = root === undefined ? null : dom.messageList.querySelector<HTMLElement>(`:scope > .msg[data-seq="${root}"]`);
    const rootMessage = messages.find((m) => m.seq === root);
    if (!threads || !rootLi || !rootMessage || state.thread !== undefined) return false;
    // A person's reply just turned a chain into a thread (Can #14532): its earlier replies, in the room until now, go.
    if (threads.replies.get(root!)?.some((m) => dom.messageList.querySelector(`:scope > .msg[data-seq="${m.seq}"]`))) return false;
    threadBar(rootLi, view.id, rootMessage, threads);
    return true;
  }
  const previous = shown.at(-2);
  const lastLi = dom.messageList.querySelector<HTMLElement>(":scope > .msg:last-of-type");
  if (!previous || !lastLi || Number(lastLi.dataset.seq) !== previous.seq) return false;
  const nodes: HTMLElement[] = [];
  const newDay = dayKey(message.createdAt) !== dayKey(previous.createdAt);
  if (newDay) nodes.push(h("li", "day-divider", dayFormat.format(message.createdAt)));
  const continued = !newDay && previous.from === message.from && message.createdAt - previous.createdAt < 5 * 60_000;
  const li = renderMessage(message, continued, previous.seq);
  if (threads && state.thread === undefined) threadBar(li, view.id, message, threads);
  nodes.push(li);
  lastLi.querySelector(":scope > .msg-seen")?.remove();
  seenLine(message, li);
  dom.messageList.append(...nodes);
  if (threads && state.thread !== undefined) {
    markThreadRead(view.id, state.thread, message.seq);
    renderCrumb(view.id, shown[0], threads);
  }
  renderSpeaking();
  updateJump();
  return true;
}

/** A thread root's bar in the room: how many replies, how many new, who wrote last; a click or Enter opens it. */
function threadBar(li: HTMLElement, conversationId: string, root: Message, threads: Threads): void {
  li.querySelector(":scope > .thread-bar")?.remove();
  const replies = threads.replies.get(root.seq);
  if (!replies || replies.length === 0) return;
  const fresh = newReplies(conversationId, root.seq, replies);
  const last = replies.at(-1)!;
  const bar = h("button", fresh > 0 ? "thread-bar thread-bar-new" : "thread-bar");
  bar.type = "button";
  const count = `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`;
  bar.append(
    h("span", "thread-count", `↳ ${count}`),
    ...(fresh > 0 ? [h("span", "thread-new", `${fresh} new`)] : []),
    h("span", "thread-last", `last @${last.from} ${timeFormat.format(last.createdAt)}`)
  );
  bar.title = `Open the thread: ${count}${fresh > 0 ? `, ${fresh} new` : ""}`;
  bar.setAttribute("aria-label", `Open the thread of #${root.seq}: ${count}${fresh > 0 ? `, ${fresh} new` : ""}`);
  bar.addEventListener("click", (event) => {
    event.stopPropagation();
    location.hash = threadHash(conversationId, root.seq);
  });
  const actions = li.querySelector(":scope > .msg-actions");
  if (actions) actions.before(bar);
  else li.append(bar);
}

/** Above an open thread: "‹ #room › thread of @x: …", the room a click (or Enter) away (Can #14203). */
function renderCrumb(conversationId: string, root: Message | undefined, threads: Threads | undefined): void {
  dom.threadCrumb.hidden = !root;
  if (!root) return dom.threadCrumb.replaceChildren();
  const conv = state.conversations.get(conversationId);
  // A button that reads as one: "‹ Back to #room" (Ümit #14688, #14705: the lilac name alone was not found).
  const back = h("button", "thread-back", `‹ Back to ${conv ? conversationTitle(conv) : "the room"}`);
  back.type = "button";
  back.title = "Back to the room (Esc)";
  back.addEventListener("click", () => {
    location.hash = viewHash({ kind: "conversation", id: conversationId });
  });
  const words = root.text.replace(/\s+/g, " ").trim();
  const n = threads?.replies.get(root.seq)?.length ?? 0;
  dom.threadCrumb.replaceChildren(
    back,
    h("span", "thread-sep", "›"),
    h("span", "thread-title", `Thread of @${root.from}: ${words.length > 60 ? `${words.slice(0, 59)}…` : words || "(file)"}`),
    h("span", "thread-meta", `${n} ${n === 1 ? "reply" : "replies"}`)
  );
}

/** Someone saw the conversation (Ümit #12323): only the newest message's "Seen by" line changes. */
export function updateSeenLine(): void {
  const view = state.view;
  const cache = view.kind === "conversation" ? state.caches.get(view.id) : undefined;
  const last = cache ? displayed(cache.messages).shown.at(-1) : undefined;
  const li = last ? dom.messageList.querySelector<HTMLElement>(`:scope > .msg[data-seq="${last.seq}"]`) : null;
  if (!last || !li) return;
  li.querySelector(":scope > .msg-seen")?.remove();
  seenLine(last, li);
}

/**
 * "Seen by can" under my message when it is the newest (Ümit #12323): the people in the conversation who have seen it
 * (agents have their receipts).
 */
function seenLine(last: Message | undefined, li: HTMLElement | undefined): void {
  if (!last || !li || last.from !== state.me) return;
  const conv = state.conversations.get(last.conversationId);
  const by = (conv?.members ?? []).filter((id) => id !== state.me && state.humans.includes(id) && (conv?.seen?.[id] ?? 0) >= last.createdAt);
  if (by.length === 0) return;
  const line = h("div", "msg-seen", `Seen by ${nameList(by)}`);
  const actions = li.querySelector(":scope > .msg-actions");
  if (actions) actions.before(line);
  else li.append(line);
}

/** `previousSeq`: the message shown just above it; a reply to that one needs no quote (Can #14203). */
function renderMessage(message: Message, continued: boolean, previousSeq?: number): HTMLLIElement {
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
  const speak = message.text && !deleted ? speakButton(message) : undefined;
  const copy = message.text && !deleted ? copyButton(message) : undefined;
  // ↪ shows it to someone else (Can #12470).
  const forward = state.me && !deleted ? forwardButton(message) : undefined;
  const copyId = copyIdButton(message);
  // ☆ saves it in my own bookmarks, ★ drops it (Can #11065); a deleted one keeps its ★ so it can still be dropped here.
  const bookmark = !deleted || isBookmarked(message.seq) ? bookmarkButton(message) : undefined;
  // Take it as a task for myself, into my inbox (Can #12197); people only.
  const ownTask = state.me && (!deleted || state.ownTasks.some((t) => t.seq === message.seq)) ? ownTaskButton(message.seq) : undefined;
  // 📌 for members: pins the message in its conversation, or unpins it (#10757).
  const pin = !deleted && state.conversations.get(message.conversationId)?.members.includes(state.me) ? pinButton(message) : undefined;
  // ✎ 🗑 on my own messages (Ümit #10890).
  const changes = changeButtons(message);
  const replyBtn = h("button", "msg-action-btn msg-reply-btn");
  setIcon(replyBtn, "reply");
  replyBtn.append(h("span", "msg-reply-label", "Reply"));
  replyBtn.type = "button";
  replyBtn.title = "Reply to the whole message (quotes it); click again to cancel";
  replyBtn.setAttribute("aria-label", "Reply to whole message");
  replyBtn.addEventListener("click", () => {
    const same = state.replyTo?.conversationId === message.conversationId && state.replyTo.seq === message.seq;
    setReplyTo(same ? undefined : message);
  });
  // On a phone the row shows Copy, ☆, Reply and ⋯; ⋯ opens the rest as a second row, each with its name (Ümit #14570:
  // eight look-alike icons in a row could not be told apart or even counted). A computer shows them all, as before.
  const extra = h("div", "msg-actions-extra");
  // Beside Listen, the other way round: answer it by voice, as a banner's Voice does (Ümit #14600).
  let voiceReply: HTMLButtonElement | undefined;
  if (state.me && !deleted) {
    voiceReply = h("button", "msg-action-btn msg-voice-reply-btn");
    setIcon(voiceReply, "mic");
    voiceReply.type = "button";
    voiceReply.title = "Reply to it by voice: recording starts at once";
    voiceReply.setAttribute("aria-label", `Reply to message #${message.seq} by voice`);
    voiceReply.addEventListener("click", () => startVoiceReply({ kind: "conversation", id: message.conversationId }, message));
  }
  const named: Array<[HTMLElement | undefined, string]> = [
    [speak, "Listen"],
    [voiceReply, "Voice reply"],
    [forward, "Forward"],
    [copyId, `Copy #${message.seq}`],
    [ownTask, "Task for me"],
    [pin, pin?.classList.contains("pinned") ? "Unpin" : "Pin"],
    [changes[0], "Edit"],
    [changes[1], "Delete"],
  ];
  for (const [button, name] of named) {
    if (!button) continue;
    button.append(h("span", "msg-extra-label", name));
    extra.append(button);
  }
  const overflow = h("button", "msg-action-btn msg-overflow-btn", "⋯");
  overflow.type = "button";
  overflow.title = "More: listen, forward, task, pin…";
  overflow.setAttribute("aria-label", `More buttons for message #${message.seq}`);
  overflow.setAttribute("aria-expanded", "false");
  overflow.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = actions.classList.toggle("msg-actions-open");
    overflow.setAttribute("aria-expanded", String(open));
  });
  if (copy) actions.append(copy);
  if (bookmark) actions.append(bookmark);
  if (!deleted) actions.append(replyBtn);
  if (extra.childElementCount > 0) actions.append(overflow, extra);
  li.addEventListener("mouseenter", () => {
    pointedMessage = li;
    keepActionsInView(li);
  });
  li.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a, button, audio, img, input, textarea, summary, .msg-edit, .msg-delete-ask")) return;
    // Selecting text inside it is not a click on it.
    if (String(getSelection() ?? "").trim()) return;
    // A click on a message puts me "in" it, on the paragraph clicked: lit until I click another, press Esc or leave
    // (Ümit #11622, #11855). A second click on the same paragraph steps out again: a phone has no Esc (Ümit #12975).
    const at = textBlocks(li).findIndex((block) => block.contains(event.target as Node));
    const part = at >= 0 ? at : undefined;
    const again = state.selectedSeq === message.seq && state.selectedPart === part;
    selectMessage(again ? undefined : message.seq, part);
    if (!again) noteAttention(message.seq, "tapped");
    if (!PHONE.matches) return;
    tapOpen(li, message.seq, !again, actions);
  });

  // A reply to the message right above it shows no quote of it (Can #14203); one to a paragraph keeps it, since it
  // says which part (codex-ui #14204).
  if (message.quote && (message.quote.seq !== previousSeq || message.quote.part)) li.append(renderQuote(message.quote));
  if (deleted) {
    li.classList.add("msg-deleted");
    const gone = h("div", "msg-text msg-deleted-text", "Message deleted");
    if (message.deletedAt) gone.title = `Deleted by ${message.from} ${fullFormat.format(message.deletedAt)}`;
    li.append(gone);
  } else {
    const box = editBox(message);
    if (box) li.append(box);
    else if (message.text) li.append(renderText(message.text, message.files));
  }
  // A forwarded copy, under the forwarder's note (Can #12470).
  if (message.forwarded && !deleted) li.append(renderForwarded(message.forwarded));
  // Attachments `/inline{#n}` shows in the text are not listed again (Can #14170).
  const inText = deleted || !message.text.includes("/inline") ? new Set<FileRef>() : inlinedFiles(message.text, message.files);
  const listed = message.files.filter((f) => !inText.has(f));
  if (listed.length > 0) {
    const files = h("ul", "msg-files");
    for (const file of listed) files.append(renderFile(file));
    // Phones: a voice message is mostly its player, which keeps every tap for itself, so its buttons (🗑 among them)
    // were out of reach (Ümit #13297). ⋯ next to it opens them, as a tap on a written message does.
    if (!deleted && message.files.some((f) => f.mimeType.startsWith("audio/"))) {
      const more = h("button", "msg-action-btn msg-more-btn", "⋯");
      more.type = "button";
      more.title = "This message's buttons";
      more.setAttribute("aria-label", `Buttons for message #${message.seq}`);
      more.addEventListener("click", () => {
        const open = state.tappedSeq !== message.seq;
        selectMessage(open ? message.seq : undefined);
        tapOpen(li, message.seq, open, actions);
      });
      const item = h("li", "msg-more");
      item.append(more);
      files.append(item);
    }
    li.append(files);
  }
  // Where it was forwarded, for its readers (only they get the message).
  const forwards = renderForwards(message);
  if (forwards) li.append(forwards);
  const badge = renderTaskBadge(message);
  if (badge) li.append(badge);
  const receipts = renderReceipts(message);
  if (receipts) li.append(receipts);
  const ask = deleteQuestion(message);
  if (ask) li.append(ask);
  // Last: on phones it is a row under the message (on wider screens it floats top right).
  li.append(actions);
  markReadParts(li, message.seq);
  if (state.selectedSeq === message.seq) markSelected(li);
  if (state.tappedSeq === message.seq) li.classList.add("msg-tapped");
  const pulsed = pulseAt(message);
  if (pulsed !== undefined) {
    li.classList.add("msg-pulse");
    // A redraw mid-pulse carries on where it was instead of starting again.
    li.style.animationDelay = `-${Math.round(pulsed)}ms`;
  }
  return li;
}

/** The unread messages of the conversation just opened, and when their pulse began (set at their first drawing). */
let pulse: { conversationId: string; since: number; start?: number } | undefined;

/**
 * Opening a conversation with unread messages: they pulse once, a flash that fades back, while its banners fade out
 * (Can #11976). `since`: what I had read up to.
 */
export function pulseUnread(conversationId: string, since: number): void {
  pulse = { conversationId, since };
}

/** How far into its pulse `message` is, if it is one of the unread ones still pulsing. */
function pulseAt(message: Message): number | undefined {
  if (!pulse || pulse.conversationId !== message.conversationId) return undefined;
  if (message.createdAt <= pulse.since || message.from === state.me) return undefined;
  pulse.start ??= performance.now();
  const elapsed = performance.now() - pulse.start;
  if (elapsed < PULSE_MS) return elapsed;
  pulse = undefined;
  return undefined;
}

/**
 * Phones: a tapped message's buttons open as a row under it; at the lower edge that row was below the visible
 * messages (Ümit #11869). Scroll the messages just enough to show it, nothing else moves.
 */
function revealActions(actions: HTMLElement): void {
  const below = actions.getBoundingClientRect().bottom - dom.messageScroll.getBoundingClientRect().bottom + 8;
  if (below > 0) dom.messageScroll.scrollBy({ top: below, behavior: "smooth" });
}

/** Phones: opens (or closes) message `seq`'s row of buttons; only one message has it open. */
function tapOpen(li: HTMLElement, seq: number, open: boolean, actions: HTMLElement): void {
  for (const other of dom.messageList.querySelectorAll(".msg-tapped")) other.classList.remove("msg-tapped");
  state.tappedSeq = open ? seq : undefined;
  if (!open) return;
  li.classList.add("msg-tapped");
  requestAnimationFrame(() => revealActions(actions));
}

/**
 * Computers: a message's buttons sit at its top right. On a long message read further down that top was out of view,
 * so clicking a paragraph seemed to give no buttons until scrolling back up (Ümit #13234). The buttons of the
 * message under the pointer follow the top of the visible messages, down to the message's end.
 */
function keepActionsInView(li: HTMLElement): void {
  const actions = li.querySelector<HTMLElement>(":scope > .msg-actions");
  if (!actions || PHONE.matches) return;
  const above = dom.messageScroll.getBoundingClientRect().top - li.getBoundingClientRect().top;
  actions.style.top = above > 0 ? `${Math.max(4, Math.min(above + 4, li.offsetHeight - actions.offsetHeight - 4))}px` : "";
}

let pointedMessage: HTMLElement | undefined;
dom.messageScroll.addEventListener("scroll", () => pointedMessage?.isConnected && keepActionsInView(pointedMessage), { passive: true });

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

/** ⧉ copies the whole message as shown (without Markdown signs or controls), matching the whole-message frame and Reply. */
function copyButton(message: Message): HTMLButtonElement {
  return copier("copy", "Copy the whole message", () => {
    const shown = actionsOwner(message)?.querySelector<HTMLElement>(".msg-text");
    if (!shown) return message.text;
    const clean = shown.cloneNode(true) as HTMLElement;
    for (const button of clean.querySelectorAll("button")) button.remove();
    // `innerText` preserves rendered paragraph/list/code line breaks only while connected; keep the clone off-screen.
    clean.setAttribute("aria-hidden", "true");
    Object.assign(clean.style, { position: "fixed", left: "-10000px", top: "0", width: `${shown.clientWidth}px`, pointerEvents: "none" });
    document.body.append(clean);
    try {
      return clean.innerText.trim() || message.text;
    } finally {
      clean.remove();
    }
  }, "Copy");
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
export async function copyText(value: string): Promise<boolean> {
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
  const field = h("textarea");
  field.readOnly = true;
  field.value = value;
  field.rows = Math.min(4, Math.max(2, value.split("\n").length));
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

/** A message action that copies `text()`: visibly says ✓ Copied only when it was (#10401, Ümit #15385). */
function copier(name: IconName, title: string, text: () => string, visibleLabel?: string): HTMLButtonElement {
  const button = h("button", "msg-action-btn msg-copy-btn");
  const copyLabel = visibleLabel ? h("span", "msg-copy-label", visibleLabel) : undefined;
  setIcon(button, name);
  if (copyLabel) button.append(copyLabel);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", async () => {
    const value = text();
    const copied = await copyText(value);
    const short = value.length > 40 ? `${value.slice(0, 39)}…` : value;
    // A name beside an overflow action (Ümit #14570) and Copy's visible phone label stay through the ✓.
    const extraLabel = button.querySelector(".msg-extra-label");
    setIcon(button, copied ? "check" : "x");
    if (copyLabel) {
      copyLabel.textContent = copied ? "Copied" : "Copy below";
      button.append(copyLabel);
    }
    if (extraLabel) button.append(extraLabel);
    button.classList.toggle("copy-confirmed", copied);
    button.classList.toggle("copy-failed", !copied);
    button.title = copied ? "Copied" : "Not copied";
    button.setAttribute("aria-label", button.title);
    announce(copied ? `Copied ${short}` : "Not copied automatically: the text is selected below the message, copy it from there");
    if (!copied) manualCopy(button.closest(".msg"), value);
    setTimeout(() => {
      setIcon(button, name);
      if (copyLabel) {
        copyLabel.textContent = visibleLabel ?? "";
        button.append(copyLabel);
      }
      if (extraLabel) button.append(extraLabel);
      button.classList.remove("copy-confirmed", "copy-failed");
      button.title = title;
      button.setAttribute("aria-label", title);
    }, 1500);
  });
  return button;
}

function renderText(text: string, files: FileRef[]): HTMLDivElement {
  const body = h("div", "msg-text");
  const inline = files.length > 0 && text.includes("/inline");
  body.append(...renderMarkdown(inline ? markInlined(text, files) : text, mentionNodes));
  if (inline) placeInlined(body, files);
  return body;
}
