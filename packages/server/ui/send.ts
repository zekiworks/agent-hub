// Sending what the message box holds, and the box's keys.
import {
  ALL_CONVERSATION_ID,
  formatAddress,
  mentionedIds,
  type FileRef,
  type Message,
  type PostMessageRequest,
  type PostMessageResponse,
} from "@agent-bus/protocol";
import { api, postJson } from "./api";
import { autosize, hideError, holdHours, renderStaged, setReplyTo, showError, unstage, updateComposerState } from "./composer";
import { dom, PHONE } from "./dom";
import { draftThread, readDraft, saveDraft } from "./drafts";
import { errorText } from "./format";
import { chosenSession } from "./live";
import { loadMessages, receive } from "./loading";
import { closeMention, handleMentionKey, updateMention } from "./mentions";
import { navigate, viewHash } from "./routing";
import { currentDirectAgent, state, type ItemReply, type View } from "./state";
import { draftReplaced } from "./suggest";
import { askSent } from "./ask";
import { noteAttention } from "./attention";
import { clearProposal, proposalId } from "./commands";
import { threadTail } from "./threads";

export async function uploadFile(file: File): Promise<FileRef> {
  const params = new URLSearchParams({ from: state.me, name: file.name });
  const res = await api<{ file: FileRef }>(`/api/files?${params}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  return res.file;
}

/** What a message answers, taken when its sending (or recording) starts (codex-ui #10825, #11603, #11711). */
export interface Chosen {
  reply: Message | undefined;
  item: ItemReply | undefined;
  /** The paragraph of `reply` it answers (Ümit #13981). */
  part?: string;
}

/** What the open conversation's message answers now: a message (or one paragraph of it), or a checklist item. */
export function chosenNow(view: View): Chosen {
  const here = (id: string) => view.kind === "conversation" && id === view.id;
  const chosen = state.replyTo && here(state.replyTo.conversationId) ? state.replyTo : undefined;
  const item = state.itemReply && here(state.itemReply.conversationId) ? state.itemReply : undefined;
  // In an open thread a message goes on the thread: it answers the thread's newest (Can #14203).
  const reply = chosen ?? (!item && view.kind === "conversation" ? threadTail(view.id) : undefined);
  return {
    reply,
    item,
    ...(chosen && state.replyPart ? { part: state.replyPart } : {}),
  };
}

/**
 * Posts `text` and `fileIds` to `view` (as a reply to `chosen`, taken when sending or recording started; a checklist
 * item goes in front as a quote), to the session picked on an agent's page, kept for the chosen hours, and shows it.
 * The reply it answered is cleared, not a newer one picked meanwhile. Typed text and staged files are the caller's.
 */
export async function postToView(view: View, text: string, fileIds: string[], chosen: Chosen): Promise<void> {
  const { reply: replyTo, item } = chosen;
  const request: PostMessageRequest = { from: state.me, text: item ? `> ${item.item}\n\n${text}` : text };
  const proposal = proposalId();
  if (proposal) request.proposal = proposal;
  if (fileIds.length > 0) request.fileIds = fileIds;
  if (replyTo) {
    request.replyToSeq = replyTo.seq;
    if (chosen.part) request.quoteText = chosen.part;
  } else if (view.kind === "draft") request.to = view.project !== undefined ? `@@${view.project}` : formatAddress(view.to);
  else if (view.id === ALL_CONVERSATION_ID) request.to = "@all";
  else request.conversationId = view.id;
  // @mentioning someone who is not in a group DM or project: add them, or only name them (as in Google Chat).
  const target = view.kind === "conversation" ? state.conversations.get(view.id) : undefined;
  const known = new Set(state.participants.map((p) => p.id));
  const outsiders = target && target.kind !== "all" ? mentionedIds(text).filter((id) => known.has(id) && !target.members.includes(id)) : [];
  if (target && outsiders.length > 0) {
    const names = outsiders.map((id) => `@${id}`).join(", ");
    if (target.kind === "dm") {
      showError(`${names} ${outsiders.length > 1 ? "are" : "is"} not in this DM and will not see it: a DM stays between two. Use + Group or a project to bring them in.`);
    } else if (confirm(`${names} ${outsiders.length > 1 ? "are" : "is"} not in this conversation.\n\nOK: add ${outsiders.length > 1 ? "them" : "them"} and send (they also see the earlier messages).\nCancel: send only, without adding anyone.`)) {
      request.addMentioned = true;
    }
  }
  // On an agent's page with a session picked, the message goes to that session.
  const agent = currentDirectAgent();
  const session = agent ? chosenSession(agent) : undefined;
  if (session !== undefined) request.toSession = session;
  const hold = holdHours();
  if (hold !== undefined) request.holdHours = hold;

  const res = await postJson<PostMessageResponse>("/api/messages", request);
  if (proposal) clearProposal();
  if (replyTo) noteAttention(replyTo.seq, "replied");
  // Clear the reply this message answered, not a newer one chosen meanwhile (a message or a checklist item).
  const same = (replyTo && state.replyTo?.seq === replyTo.seq) || (item && state.itemReply === item);
  if (same) setReplyTo(undefined);
  // Groups not loaded yet (e.g. a draft that just became a group) get their history fetched.
  if (!state.caches.has(res.conversation.id)) void loadMessages(res.conversation.id);
  receive(res.message, res.conversation);
  // A draft became a conversation, or the bus put it elsewhere (a person writing in a DM between others goes to the
  // group DM of its members and them): follow it there.
  if (view.kind === "draft" || res.conversation.id !== view.id) navigate({ kind: "conversation", id: res.conversation.id });
}

async function send(): Promise<void> {
  if (state.sending || !state.me) return;
  browsing = undefined;
  const text = dom.input.value;
  if (!text.trim() && state.staged.length === 0) return;
  const view = state.view;
  // The place it was written in: the conversation, or a thread of it (its draft is its own; codex-ui #14246).
  const thread = draftThread(view);
  const place = () => `${viewHash(state.view)}/${draftThread(state.view) ?? ""}`;
  const sentFrom = `${viewHash(view)}/${thread ?? ""}`;
  // Taken now: a reply picked or a conversation opened while files upload belongs to the next message (codex-ui
  // #11603, #11711), and so do files added meanwhile.
  const chosen = chosenNow(view);
  const files = [...state.staged];
  state.sending = true;
  hideError();
  updateComposerState();
  renderStaged();
  try {
    const fileIds: string[] = [];
    for (const file of files) {
      try {
        fileIds.push((await uploadFile(file)).id);
      } catch (err) {
        throw new Error(`Upload of ${file.name} failed: ${errorText(err)}`);
      }
    }
    await postToView(view, text, fileIds, chosen);
    if (view.kind === "conversation") askSent(view.id, text, !!(chosen.reply || chosen.item));
    // Clear what was sent, from the conversation it was sent in: another one opened meanwhile keeps its draft, and
    // text typed after Send stays (codex-ui #11711).
    const stillThere = place() === sentFrom;
    const left = stillThere ? dom.input.value : readDraft(view, thread);
    const rest = left === text ? "" : left.startsWith(text) ? left.slice(text.length).replace(/^\n+/, "") : left;
    saveDraft(view, rest, thread);
    unstage(files);
    if (stillThere) {
      dom.input.value = rest;
      autosize();
      // What was suggested for the sent text is no suggestion for what comes next (codex-ui #12875).
      draftReplaced();
    }
  } catch (err) {
    showError(errorText(err));
  } finally {
    state.sending = false;
    renderStaged();
    updateComposerState();
    if (place() === sentFrom) dom.input.focus();
  }
}

dom.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void send();
});

// Tapping Send keeps the input focused: the keyboard stays up and nothing moves before the tap lands. Safari sends no
// click after a pointerdown kept from the focus, so Send took several taps (Ümit #13345): such a tap sends on
// pointerup, and a click that still follows (Chrome) does not send twice. Pointer capture keeps that pointerup attached
// to Send if iOS adjusts the visual viewport under the finger during the press (Ümit #15089).
let sendPressed = false;
let sentOnPointerUp = false;
dom.sendBtn.addEventListener("pointerdown", (event) => {
  sentOnPointerUp = false;
  sendPressed = PHONE.matches && document.activeElement === dom.input;
  if (sendPressed) {
    event.preventDefault();
    dom.sendBtn.setPointerCapture(event.pointerId);
  }
});
dom.sendBtn.addEventListener("pointercancel", () => (sendPressed = false));
dom.sendBtn.addEventListener("pointerup", () => {
  if (!sendPressed) return;
  sendPressed = false;
  sentOnPointerUp = true;
  if (!dom.sendBtn.disabled) dom.composer.requestSubmit(dom.sendBtn);
});
dom.sendBtn.addEventListener("click", (event) => {
  if (!sentOnPointerUp) return;
  sentOnPointerUp = false;
  event.preventDefault();
});

/**
 * Enter sends; Shift+Enter is a new line. While an input method or the system holds unfinished text, Enter belongs to
 * it (choosing a candidate must never send, codex-ui #11646): the next Enter sends. On a touch screen the keyboard's
 * return key makes a new line and only ➤ sends, as in the phone's own messaging apps: return sent half-written
 * messages, and a running voice recording, without Ümit touching ➤ (#13021, #13045, #13046, #13047).
 */
const TOUCH = window.matchMedia("(hover: none) and (pointer: coarse)");
dom.input.addEventListener("keydown", (event) => {
  if (state.mention.open && handleMentionKey(event)) return;
  if (event.key === "Escape" && (state.replyTo || state.itemReply)) {
    event.preventDefault();
    setReplyTo(undefined);
    return;
  }
  if ((event.key === "ArrowUp" || event.key === "ArrowDown") && recall(event)) {
    event.preventDefault();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !TOUCH.matches) {
    event.preventDefault();
    dom.composer.requestSubmit();
  }
});

/**
 * ↑ and ↓ in the box go through what I sent here, newest first, as a shell's history does (Can #14522): ↑ on the box's
 * first line starts, and while one is shown ↑ / ↓ go on to the one before / after; past the newest the draft I had
 * comes back. Typing ends it, keeping what is shown as the new draft. Otherwise the arrows move the cursor as usual.
 */
let browsing: { conversationId: string; at: number; draft: string } | undefined;

function recall(event: KeyboardEvent): boolean {
  const view = state.view;
  const step = event.key === "ArrowUp" ? 1 : -1;
  if (view.kind !== "conversation" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return false;
  if (browsing?.conversationId !== view.id) browsing = undefined;
  const caret = dom.input.selectionStart;
  const value = dom.input.value;
  // Not yet going through them: only ↑ on the first line (with nothing selected) starts.
  if (!browsing && (step === -1 || caret !== dom.input.selectionEnd || value.slice(0, caret).includes("\n"))) return false;
  const mine = (state.caches.get(view.id)?.messages ?? []).filter((m) => m.from === state.me && !m.deletedAt && m.text.trim()).reverse();
  const at = (browsing?.at ?? -1) + step;
  if (at >= mine.length) return browsing !== undefined;
  const draft = browsing?.draft ?? value;
  browsing = at === -1 ? undefined : { conversationId: view.id, at, draft };
  dom.input.value = at === -1 ? draft : mine[at]!.text;
  dom.input.setSelectionRange(dom.input.value.length, dom.input.value.length);
  autosize();
  updateComposerState();
  return true;
}

dom.input.addEventListener("input", () => {
  browsing = undefined;
  autosize();
  updateComposerState();
  updateMention();
  saveDraft(state.view, dom.input.value);
});
dom.input.addEventListener("click", () => updateMention());
dom.input.addEventListener("blur", () => closeMention());
