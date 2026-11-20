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
import { autosize, hideError, holdHours, renderStaged, setReplyTo, showError, updateComposerState } from "./composer";
import { dom, PHONE } from "./dom";
import { readDraft, saveDraft } from "./drafts";
import { errorText } from "./format";
import { chosenSession } from "./live";
import { loadMessages, receive } from "./loading";
import { closeMention, handleMentionKey, updateMention } from "./mentions";
import { navigate, viewHash } from "./routing";
import { currentDirectAgent, state, type ItemReply, type View } from "./state";
import { setIcon } from "./icons";
import { draftReplaced } from "./suggest";

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
  /** Sent as a task (the box's Message/Task switch was on Task), and which setting of the switch that was. */
  task?: boolean;
  taskTurn?: number;
}

/** What the open conversation's message answers now: a message, or a checklist item; and whether it is a task. */
export function chosenNow(view: View): Chosen {
  const here = (id: string) => view.kind === "conversation" && id === view.id;
  return {
    reply: state.replyTo && here(state.replyTo.conversationId) ? state.replyTo : undefined,
    item: state.itemReply && here(state.itemReply.conversationId) ? state.itemReply : undefined,
    task: asTask,
    taskTurn,
  };
}

/**
 * The box's Message/Task switch (Can #12832): a speech bubble ("Message"); a click turns it into a checkbox ("Task"),
 * and the next message goes as a task for those it @mentions (else the other one in a DM). It turns back to Message
 * once that is sent, or when another conversation opens, so a task is never sent by mistake later.
 */
let asTask = false;
/** Counts every change of the switch: a send turns back only the setting it was sent with (codex-ui #12869). */
let taskTurn = 0;

function setAsTask(on: boolean): void {
  asTask = on;
  taskTurn += 1;
  setIcon(dom.kindBtn, on ? "task" : "message");
  dom.kindBtn.classList.toggle("is-task", on);
  dom.kindBtn.setAttribute("aria-pressed", String(on));
  dom.kindBtn.title = on ? "Task: this message goes as a task for the people or agents it @mentions. Click for a plain message" : "Message. Click to send it as a task instead";
  dom.kindBtn.setAttribute("aria-label", on ? "Task (click for a plain message)" : "Message (click to make it a task)");
}

setAsTask(false);
dom.kindBtn.addEventListener("click", () => setAsTask(!asTask));
window.addEventListener("hashchange", () => setAsTask(false));

/**
 * Posts `text` and `fileIds` to `view` (as a reply to `chosen`, taken when sending or recording started; a checklist
 * item goes in front as a quote), to the session picked on an agent's page, kept for the chosen hours, and shows it.
 * The reply it answered is cleared, not a newer one picked meanwhile. Typed text and staged files are the caller's.
 */
export async function postToView(view: View, text: string, fileIds: string[], chosen: Chosen): Promise<void> {
  const { reply: replyTo, item } = chosen;
  const request: PostMessageRequest = { from: state.me, text: item ? `> ${item.item}\n\n${text}` : text };
  if (fileIds.length > 0) request.fileIds = fileIds;
  if (replyTo) {
    request.replyToSeq = replyTo.seq;
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

  if (chosen.task) request.task = { type: "task" };
  const res = await postJson<PostMessageResponse>("/api/messages", request);
  // Back to Message, unless the switch was set again meanwhile (another room opened, Task picked for a new draft).
  if (chosen.task && chosen.taskTurn === taskTurn) setAsTask(false);
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
  const text = dom.input.value;
  if (!text.trim() && state.staged.length === 0) return;
  const view = state.view;
  const sentFrom = viewHash(view);
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
    // Clear what was sent, from the conversation it was sent in: another one opened meanwhile keeps its draft, and
    // text typed after Send stays (codex-ui #11711).
    const stillThere = viewHash(state.view) === sentFrom;
    const left = stillThere ? dom.input.value : readDraft(view);
    const rest = left === text ? "" : left.startsWith(text) ? left.slice(text.length).replace(/^\n+/, "") : left;
    saveDraft(view, rest);
    state.staged = state.staged.filter((f) => !files.includes(f));
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
    if (viewHash(state.view) === sentFrom) dom.input.focus();
  }
}

dom.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void send();
});

// Tapping Send keeps the input focused: the keyboard stays up and nothing moves before the tap lands.
dom.sendBtn.addEventListener("pointerdown", (event) => {
  if (PHONE.matches && document.activeElement === dom.input) event.preventDefault();
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
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !TOUCH.matches) {
    event.preventDefault();
    void send();
  }
});

dom.input.addEventListener("input", () => {
  autosize();
  updateComposerState();
  updateMention();
  saveDraft(state.view, dom.input.value);
});
dom.input.addEventListener("click", () => updateMention());
dom.input.addEventListener("blur", () => closeMention());
