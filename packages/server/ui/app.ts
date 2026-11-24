// The conversations page (index.html): wires the modules together, routes between views and boots.
import { QUOTE_TEXT_CHARS, type Conversation, type Message, type ViewerServerFrame } from "@agent-bus/protocol";
import { api, PROFILE_KEY, setFileKey } from "./api";
import { bookmarksChanged } from "./bookmarks";
import { tabsChanged } from "./tabs";
import { hideError, moveStaged, resetComposerHeight, setReplyTo, showError, updateComposerState } from "./composer";
import { dom, nearBottom, PHONE, scrollToBottom } from "./dom";
import { rememberAddress, restoreAddress, takeDraftLink } from "./compose";
import { loadDraft } from "./drafts";
import { errorText } from "./format";
import "./group";
import { resourcesChanged } from "./gpus";
import { hooks } from "./hooks";
import { applyActivity, syncWatch } from "./live";
import { loadEarlier, loadMessages, loadState, receive } from "./loading";
import { loadAgentRequests } from "./machines";
import { closeMention, updateMention } from "./mentions";
import { setDetails, setPhoneList, wasOnPhoneList } from "./phones";
import { askProfile } from "./profile";
import { applyReceipt, pulseUnread, renderAll, renderMessages, showEmpty, updateSeenLine } from "./render";
import { navigate, parseHash, parseThread, threadHash, viewHash } from "./routing";
import { threadsOf, threadsOn } from "./threads";
import "./commands";
import "./send";
import "./convmenu";
import { checklistChanged } from "./checklist";
import { ownTasksChanged, refreshInbox, refreshWaiting } from "./inbox";
import "./files";
import "./column";
import "./settings";
import "./suggest";
import "./ask";
import "./stats";
import "./tools";
import "./search";
import "./voice";
import "./attention";
import { renderSidebar } from "./sidebar";
import { connectViewer, setLinkStatus } from "./socket";
import { draftConversation, isCurrent, state, type View } from "./state";
import { flashMessage, fetchMessage, forgetFetched, selectMessage, shownMessage } from "./text";
import { refreshPane } from "./pane";
import { clearAnswersFor } from "./toast";
import { loadReadMarkers, markRead, refreshUnread } from "./unread";

// Esc outside a text field steps out of the message I am in (Ümit #11622).
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || state.selectedSeq === undefined) return;
  if ((event.target as Element | null)?.closest("input, textarea, select, dialog")) return;
  selectMessage(undefined);
});

// ---- Routing (#/c/<id>, #/to/<a,b>) ----

/** Drafts whose group already exists open the conversation instead. */
function resolveView(view: View): View {
  if (view.kind !== "draft") return view;
  const existing = draftConversation(view);
  return existing ? { kind: "conversation", id: existing.id } : view;
}

/**
 * Where I was reading in each conversation I left scrolled up (Can #11480: switching tabs back and forth keeps the
 * place); left at the bottom, it opens at the newest message as before. This page only.
 */
const readingAt = new Map<string, number>();

/** The place a view is kept under in readingAt: the conversation, or one thread of it. */
const placeKey = (view: View, thread: number | undefined): string => `${viewHash(view)}${thread === undefined ? "" : `/t/${thread}`}`;

function applyView(view: View): void {
  const resolved = resolveView(view);
  if (resolved !== view) {
    history.replaceState(null, "", viewHash(resolved));
  }
  // A thread of the conversation (threads.ts; Can #14203): its own place, so the room's is kept for coming back.
  const thread = resolved.kind === "conversation" ? parseThread() : undefined;
  const changed = placeKey(resolved, thread) !== placeKey(state.view, state.thread);
  if (changed && state.view.kind === "conversation") {
    const key = placeKey(state.view, state.thread);
    if (nearBottom()) readingAt.delete(key);
    else readingAt.set(key, dom.messageScroll.scrollTop);
  }
  moveStaged(viewHash(state.view), viewHash(resolved));
  state.view = resolved;
  state.thread = thread;
  if (resolved.kind === "conversation") {
    // What was unread pulses once as I arrive, and its banners fade with it (Can #11976).
    if (changed && (state.unread.get(resolved.id) ?? 0) > 0) pulseUnread(resolved.id, state.readAt[resolved.id] ?? 0);
    markRead(resolved.id);
    clearAnswersFor(resolved.id);
    if (!state.caches.has(resolved.id)) void loadMessages(resolved.id);
  }
  if (changed) {
    resetComposerHeight();
    hideError();
    closeMention();
    setReplyTo(undefined);
    setDetails(false);
    // The message I was in belongs to the conversation I left.
    state.selectedSeq = undefined;
    state.tappedSeq = undefined;
  }
  setPhoneList(false);
  renderAll();
  if (changed) {
    loadDraft();
    const at = resolved.kind === "conversation" && state.caches.has(resolved.id) ? readingAt.get(placeKey(resolved, thread)) : undefined;
    if (at === undefined) scrollToBottom();
    else dom.messageScroll.scrollTop = at;
  }
}

/** A task's state changed: the conversation shows the message as it is now, and the inbox refreshes. */
function taskChanged(message: Message, conversation: Conversation): void {
  state.conversations.set(conversation.id, conversation);
  const cache = state.caches.get(conversation.id);
  const i = cache?.messages.findIndex((m) => m.seq === message.seq) ?? -1;
  if (cache && i >= 0) {
    // Keep receipts the page already tracks live; the task is what changed.
    cache.messages[i] = { ...cache.messages[i], ...message, receipts: cache.messages[i]?.receipts ?? message.receipts };
    if (isCurrent(conversation.id)) renderMessages();
  }
  void refreshInbox();
}

/**
 * A message was edited or deleted by its writer (Ümit #10890): shown as it is now, and the replies quoting it quote the
 * new text (an empty quote with no files reads "message deleted").
 */
function messageChanged(message: Message, conversation: Conversation): void {
  // A bookmark or #number tooltip of it asks the bus again (it fetched the old text).
  forgetFetched(message.seq);
  if (state.bookmarks.some((b) => b.seq === message.seq)) refreshPane("bookmarks");
  const cache = state.caches.get(conversation.id);
  if (!cache) return;
  const quote = message.text.length > QUOTE_TEXT_CHARS ? `${message.text.slice(0, QUOTE_TEXT_CHARS - 1)}…` : message.text;
  cache.messages = cache.messages.map((m) =>
    m.seq === message.seq
      ? message
      : m.quote?.seq === message.seq
        ? { ...m, quote: { ...m.quote, text: quote, files: message.files.length } }
        : m
  );
  if (isCurrent(conversation.id)) renderMessages();
}

/**
 * An address #/m/<n> (Can, 15 Nov: a message by its number without writing a reference to it): becomes that message's
 * conversation, scrolled to the message. Returns the number, after putting the conversation view in its place.
 */
function takeMessageLink(): number | undefined {
  const match = /^#\/m\/#?(\d{1,9})$/.exec(location.hash);
  if (!match?.[1]) return undefined;
  history.replaceState(null, "", "#/c/all");
  return Number(match[1]);
}

window.addEventListener("hashchange", () => {
  const seq = takeMessageLink();
  if (seq !== undefined) {
    void showMessage(seq);
    return;
  }
  takeDraftLink();
  applyView(parseHash());
});

// "#…" in the top bar: go to a message by its number.
dom.gotoBtn.addEventListener("click", () => {
  const answer = prompt("Go to message number:");
  const seq = Number((answer ?? "").trim().replace(/^#/, ""));
  if (Number.isSafeInteger(seq) && seq > 0) void showMessage(seq);
});

/** Opens the conversation of message `seq` (loading earlier pages as needed), scrolls to it and flashes it. */
async function showMessage(seq: number): Promise<void> {
  const here = shownMessage(seq);
  if (here) return flashMessage(here);
  let id: string;
  try {
    id = (await fetchMessage(seq)).conversation.id;
  } catch (err) {
    showError(`Message #${seq}: ${errorText(err)}`);
    return;
  }
  if (!state.caches.has(id)) await loadMessages(id);
  if (!isCurrent(id)) {
    const view: View = { kind: "conversation", id };
    history.pushState(null, "", viewHash(view));
    applyView(view);
  }
  for (;;) {
    const cache = state.caches.get(id);
    const first = cache?.messages[0]?.seq;
    if (cache?.messages.some((m) => m.seq === seq) || !cache?.hasEarlier || !isCurrent(id) || first === undefined || first < seq) break;
    await loadEarlier();
    if (state.caches.get(id)?.messages[0]?.seq === first) break; // the page failed to load
  }
  // With threads on, a message folded into a thread opens that thread; a room message, the room (Can #14203).
  const cache = state.caches.get(id);
  if (threadsOn() && cache?.messages.some((m) => m.seq === seq)) {
    const root = threadsOf(cache.messages).rootOf.get(seq) ?? seq;
    // A reply is only in its thread; a root is in the room, and in its own thread when that is open.
    const want = root !== seq ? root : state.thread === seq ? seq : undefined;
    if (want !== state.thread) {
      history.pushState(null, "", want === undefined ? viewHash({ kind: "conversation", id }) : threadHash(id, want));
      applyView({ kind: "conversation", id });
    }
  }
  const target = shownMessage(seq);
  if (target) flashMessage(target);
}

hooks.applyView = applyView;
hooks.showMessage = showMessage;

// Information dialogs close on a click outside them (on the dimmed page), as well as with their ✕ or Esc.
for (const dialog of [dom.settingsDialog, dom.convDialog, dom.statsDialog, dom.gpuDialog, dom.groupDialog]) {
  dialog.addEventListener("click", (event) => {
    const r = dialog.getBoundingClientRect();
    const outside = event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
    // Keyboard-made clicks on buttons inside have no position (0, 0): only a real click outside closes.
    if (outside && (event.clientX !== 0 || event.clientY !== 0)) dialog.close();
  });
}

// ---- Viewer socket ----

function handleFrame(frame: ViewerServerFrame): void {
  switch (frame.type) {
    case "participants":
      state.participants = frame.participants;
      renderSidebar();
      if (state.mention.open) updateMention();
      // Who is offline changes the "kept for" choice under the box.
      updateComposerState();
      break;
    case "message":
      receive(frame.message, frame.conversation);
      if (frame.message.task) void refreshInbox();
      break;
    case "task":
      taskChanged(frame.message, frame.conversation);
      break;
    case "changed":
      messageChanged(frame.message, frame.conversation);
      if (frame.message.ext?.task) void refreshInbox();
      break;
    case "bookmarks":
      bookmarksChanged(frame.bookmarks);
      break;
    case "ownTasks":
      ownTasksChanged(frame.ownTasks);
      break;
    case "needs":
      void refreshWaiting();
      break;
    case "seen": {
      // Someone in it saw a conversation (Ümit #12323): its row and "Seen by" follow.
      const conv = state.conversations.get(frame.conversationId);
      if (!conv) break;
      conv.seen = { ...conv.seen, [frame.participant]: Math.max(frame.at, conv.seen?.[frame.participant] ?? 0) };
      renderSidebar();
      if (isCurrent(conv.id)) updateSeenLine();
      break;
    }
    case "tabs":
      tabsChanged(frame.tabs);
      break;
    case "checklist":
      checklistChanged(frame.conversationId);
      break;
    case "conversations":
      // Members, notifications or a project's settings changed somewhere.
      void loadState().then(() => {
        renderSidebar();
        if (state.view.kind === "conversation" && !state.conversations.has(state.view.id)) navigate({ kind: "conversation", id: "all" });
        else renderAll();
      });
      break;
    case "receipt":
    case "expired":
      applyReceipt(frame);
      break;
    case "activity":
      applyActivity(frame);
      break;
    case "agent-tokens":
      void loadAgentRequests();
      break;
    case "resources":
      resourcesChanged();
      break;
    case "error":
      // The session ended (signed out elsewhere, passkey removed): sign in again.
      location.assign("/auth");
      break;
  }
}

/** After a reconnect: refresh state and drop message caches (they may have gaps). */
async function resync(): Promise<void> {
  await loadAuth().catch(() => undefined);
  void loadAgentRequests();
  try {
    await loadState();
  } catch (err) {
    setLinkStatus("offline", `state refresh failed: ${errorText(err)}`);
    return;
  }
  state.caches.clear();
  applyView(state.view);
  await refreshUnread();
}

// ---- Boot ----

/**
 * The signed-in human (GET /api/auth/state), or undefined; also renews the key file links carry. Everyone on the
 * bus is signed in, so without a session the page goes to the sign-in page.
 */
async function loadAuth(): Promise<string | undefined> {
  const auth = await api<{ me: string | null; fileKey?: string }>("/api/auth/state");
  if (!auth.me) return undefined;
  setFileKey(auth.fileKey ?? "");
  // The account, once, at the right of the top bar (Can #11389): the name, a link to passkeys, machines, sign out.
  dom.authLink.hidden = false;
  dom.authLink.textContent = `✓ ${auth.me}`;
  dom.authLink.title = `Signed in as ${auth.me} with a passkey: passkeys, machines on the bus, sign out`;
  dom.authLink.setAttribute("aria-label", `Your account: signed in as ${auth.me} (passkeys, machines on the bus, sign out)`);
  return auth.me;
}

async function boot(): Promise<void> {
  let signedIn: string | undefined;
  try {
    signedIn = await loadAuth();
    if (!signedIn) {
      rememberAddress();
      location.replace("/auth");
      return;
    }
    await loadState();
  } catch (err) {
    setLinkStatus("offline", "server unreachable");
    showEmpty(`Could not reach the bus: ${errorText(err)}. Reload to retry.`);
    return;
  }
  // A signed-in browser is that human (the server refuses any other `from`).
  state.me = state.humans.includes(signedIn) ? signedIn : "";
  localStorage.setItem(PROFILE_KEY, signedIn);
  void loadAgentRequests();
  // File keys last a day; pages stay open longer.
  setInterval(() => void loadAuth().catch(() => undefined), 3600_000);
  if (state.me) loadReadMarkers();
  connectViewer({
    onOpen: (reconnected) => {
      if (reconnected) void resync();
      syncWatch(true);
    },
    onFrame: handleFrame,
  });
  restoreAddress();
  // Only a reload goes back to the list it was on (Ümit #11664); a link or an address typed in opens its conversation.
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const reloaded = navigation?.type === "reload";
  const linkedSeq = takeMessageLink();
  takeDraftLink();
  // Phones opened without a conversation in the address, or reloaded on the list, start on the conversation list.
  const startOnList = location.hash === "" || (reloaded && wasOnPhoneList());
  applyView(parseHash());
  if (startOnList) setPhoneList(true);
  if (linkedSeq !== undefined) void showMessage(linkedSeq);
  loadDraft();
  if (!state.me) askProfile();
  else {
    // On phones the keyboard should open only when the box is tapped.
    if (!PHONE.matches) dom.input.focus();
    void refreshUnread();
    void refreshInbox();
  }
}

void boot();
// Keeps "n min ago" labels in the sidebar current.
setInterval(renderSidebar, 60_000);
