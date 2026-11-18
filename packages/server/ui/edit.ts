// Editing and deleting one's own messages: ✎ and 🗑 among a message's actions, the edit box or the
// "Delete it?" question inside the message. The list is redrawn whenever anything arrives, so what is being edited
// (and the text typed so far) lives here, not in the page, and the redrawn message gets it back.
import type { Message } from "@agent-bus/protocol";
import { postJson } from "./api";
import { errorText } from "./format";
import { h } from "./html";
import { setIcon } from "./icons";
import { renderMessages } from "./render";
import { state } from "./state";

/** The edit box as tall as its text, within reason (the CSS caps it). */
function autosize(box: HTMLTextAreaElement): void {
  box.style.height = "auto";
  box.style.height = `${box.scrollHeight + 2}px`;
}

/** The message being edited, the text so far and the caret; or the one whose deletion is being asked. */
let editing: { seq: number; text: string; caret: number; error?: string; busy?: boolean } | undefined;
let deleting: { seq: number; error?: string; busy?: boolean } | undefined;

/** One of mine that can change: not a task (those are withdrawn), not deleted. */
export function changeable(message: Message): boolean {
  return message.from === state.me && !message.task && !message.deletedAt;
}

/** ✎ and 🗑 for my own messages. */
export function changeButtons(message: Message): HTMLButtonElement[] {
  if (!changeable(message)) return [];
  const edit = h("button", "msg-action-btn msg-edit-btn");
  setIcon(edit, "pencil");
  edit.type = "button";
  edit.title = "Edit this message";
  edit.setAttribute("aria-label", `Edit message #${message.seq}`);
  edit.addEventListener("click", () => {
    editing = { seq: message.seq, text: message.text, caret: message.text.length };
    deleting = undefined;
    renderMessages();
  });
  const remove = h("button", "msg-action-btn msg-delete-btn");
  setIcon(remove, "trash");
  remove.type = "button";
  remove.title = "Delete this message";
  remove.setAttribute("aria-label", `Delete message #${message.seq}`);
  remove.addEventListener("click", () => {
    deleting = { seq: message.seq };
    editing = undefined;
    renderMessages();
  });
  return [edit, remove];
}

/** Agents that already have it keep the version they got: said where it matters. */
function agentsNote(message: Message): string {
  const got = message.receipts.filter((r) => r.deliveredAt !== null).length;
  return got === 0 ? "" : `${got === 1 ? "The agent that already received it keeps" : `The ${got} agents that already received it keep`} the original.`;
}

/** The edit box in place of the text, while `message` is being edited. */
export function editBox(message: Message): HTMLElement | undefined {
  if (editing?.seq !== message.seq) return undefined;
  const now = editing;
  const form = h("form", "msg-edit");
  const box = h("textarea", "msg-edit-input");
  box.value = now.text;
  box.rows = 2;
  box.setAttribute("aria-label", `Edit message #${message.seq}`);
  box.addEventListener("input", () => {
    now.text = box.value;
    now.caret = box.selectionStart;
    autosize(box);
  });
  box.addEventListener("keyup", () => (now.caret = box.selectionStart));
  box.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  const save = h("button", "btn btn-primary", now.busy ? "Saving…" : "Save");
  save.type = "submit";
  save.disabled = !!now.busy;
  const cancelBtn = h("button", "btn", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", cancel);
  const row = h("div", "msg-edit-actions");
  const note = agentsNote(message);
  row.append(h("span", "msg-edit-hint", `Ctrl/⌘+Enter saves, Esc cancels.${note ? ` ${note}` : ""}`), cancelBtn, save);
  form.append(box);
  if (now.error) form.append(h("p", "msg-edit-error", now.error));
  form.append(row);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (now.busy) return;
    const text = now.text.trim();
    if (text === message.text) return cancel();
    now.busy = true;
    now.error = undefined;
    renderMessages();
    try {
      await postJson(`/api/messages/${message.seq}/edit`, { from: state.me, text });
      // The bus's "changed" frame brings the message as it is now.
      if (editing === now) editing = undefined;
    } catch (error) {
      now.busy = false;
      now.error = `Not saved: ${errorText(error)}`;
    }
    renderMessages();
  });
  // Back in the box after each redraw, the caret where it was.
  queueMicrotask(() => {
    if (!box.isConnected) return;
    autosize(box);
    box.focus();
    box.setSelectionRange(now.caret, now.caret);
  });
  return form;
}

/** "Delete this message?" under it, while asked. */
export function deleteQuestion(message: Message): HTMLElement | undefined {
  if (deleting?.seq !== message.seq) return undefined;
  const now = deleting;
  const box = h("div", "msg-delete-ask");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", `Delete message #${message.seq}?`);
  const note = agentsNote(message);
  box.append(h("span", "msg-delete-text", `Delete this message?${note ? ` ${note}` : ""}`));
  const yes = h("button", "btn btn-danger", now.busy ? "Deleting…" : "Delete");
  yes.type = "button";
  yes.disabled = !!now.busy;
  const no = h("button", "btn", "Cancel");
  no.type = "button";
  no.addEventListener("click", () => {
    deleting = undefined;
    renderMessages();
  });
  box.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    deleting = undefined;
    renderMessages();
  });
  yes.addEventListener("click", async () => {
    now.busy = true;
    now.error = undefined;
    renderMessages();
    try {
      await postJson(`/api/messages/${message.seq}/delete`, { from: state.me });
      if (deleting === now) deleting = undefined;
    } catch (error) {
      now.busy = false;
      now.error = `Not deleted: ${errorText(error)}`;
    }
    renderMessages();
  });
  box.append(no, yes);
  if (now.error) box.append(h("p", "msg-edit-error", now.error));
  queueMicrotask(() => {
    if (box.isConnected && !now.busy) no.focus();
  });
  return box;
}

function cancel(): void {
  editing = undefined;
  renderMessages();
}
