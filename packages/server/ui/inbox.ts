// Tasks on the website (Can, 15 Nov): the ✉ Inbox button (yellow: open tasks; red: some unread) opens the Inbox tab of
// the right pane, with the tasks assigned to you and those you assigned. A task is a message (its #number its id);
// ✓ finishes it (approves an approval), ✕ rejects it, "On it" accepts it, ↩ answers it with a quote. Each step is
// posted in the conversation as a reply to the task by the bus.
import type { Conversation, Message, Task, TasksResponse } from "@agent-bus/protocol";
import { api, postJson } from "./api";
import { setReplyTo } from "./composer";
import { dom, PHONE } from "./dom";
import { errorText, relativeTime } from "./format";
import { h } from "./html";
import { renderMarkdown } from "./markdown";
import { closePane, globalShown, onWorkspaceChange, refreshPane, registerExtension, toggleGlobal } from "./pane";
import { navigate, viewHash } from "./routing";
import { conversationTitle, state } from "./state";
import { mentionNodes } from "./text";

type Box = "mine" | "assigned";
let box: Box = "mine";
let showClosed = false;
let data: TasksResponse | undefined;
let counts = { open: 0, unread: 0 };
let visible = false;

const LABEL: Record<Task["type"], string> = { task: "Task", approval: "Approval", chore: "Chore" };

/** Fetches the counts for the button, and the list when the Inbox is open. */
export async function refreshInbox(): Promise<void> {
  if (!state.me) return;
  try {
    const mine = await api<TasksResponse>(`/api/tasks?box=mine&state=open`);
    counts = { open: mine.open, unread: mine.unread };
    data = box === "mine" && !showClosed ? mine : await api<TasksResponse>(`/api/tasks?box=${box}&state=${showClosed ? "all" : "open"}`);
  } catch {
    return; // offline: the button keeps its last state; the next frame or reload tries again
  }
  renderButton();
  refreshPane("inbox");
  if (visible) markShownRead();
}

function renderButton(): void {
  const btn = dom.inboxBtn;
  btn.textContent = counts.open > 0 ? `✉ ${counts.open}` : "✉";
  btn.classList.toggle("inbox-open", counts.open > 0 && counts.unread === 0);
  btn.classList.toggle("inbox-unread", counts.unread > 0);
  btn.title =
    counts.open === 0
      ? "Your inbox: no open tasks"
      : `Your inbox: ${counts.open} open task${counts.open === 1 ? "" : "s"}${counts.unread ? `, ${counts.unread} unread` : ""}`;
  dom.inboxRow.hidden = !state.me;
  dom.inboxRowCount.textContent = counts.open > 0 ? String(counts.open) : "";
  dom.inboxRow.classList.toggle("inbox-unread", counts.unread > 0);
}

/** Marks the tasks shown under "For me" as read (the button turns from red to yellow). */
function markShownRead(): void {
  if (box !== "mine" || !data) return;
  for (const message of data.messages) {
    const mine = message.task?.assignees.find((a) => a.id === state.me);
    if (mine && mine.readAt === undefined) {
      mine.readAt = Date.now();
      void postJson(`/api/tasks/${message.seq}/read`, { from: state.me }).catch(() => undefined);
    }
  }
  counts.unread = 0;
  renderButton();
}

/**
 * Phones: the inbox covers the conversation, so opening a task's message (↩, or its #number) leaves it, and the
 * conversation shows "Back to your inbox" (#10107); the inbox keeps its part of the page, so it returns where it was.
 */
function leaveForMessage(): void {
  if (!PHONE.matches) return;
  dom.inboxReturn.hidden = false;
  closePane();
}

/** ↩: the task's conversation, replying to it (the reply quotes the task). */
function replyTo(message: Message): void {
  const view = { kind: "conversation" as const, id: message.conversationId };
  leaveForMessage();
  if (location.hash === viewHash(view)) {
    setReplyTo(message);
    return;
  }
  window.addEventListener("hashchange", () => setTimeout(() => setReplyTo(message), 0), { once: true });
  navigate(view);
}

async function step(message: Message, action: "accept" | "done" | "reject" | "withdraw", note: HTMLElement, reason?: string): Promise<void> {
  note.textContent = "…";
  try {
    await postJson(`/api/tasks/${message.seq}/${action}`, { from: state.me, ...(reason ? { reason } : {}) });
    await refreshInbox();
  } catch (error) {
    note.textContent = `Not saved: ${errorText(error)}`;
  }
}

/** One line of markdown, inline. */
function inline(text: string): Node[] {
  const nodes = renderMarkdown(text, mentionNodes);
  const only = nodes[0];
  return nodes.length === 1 && only instanceof HTMLElement && only.classList.contains("md-p") ? Array.from(only.childNodes) : nodes;
}

/** "@beta: accepted · @carol: open", each state its colour. */
export function taskStates(task: Task): HTMLElement {
  const line = h("span", "task-states");
  task.assignees.forEach((a, i) => {
    if (i > 0) line.append(" · ");
    const chip = h("span", `task-state task-${a.state}`, `@${a.id}: ${a.state}${a.reason ? ` (${a.reason})` : ""}`);
    if (a.at) chip.title = `${a.state} ${relativeTime(a.at)}${a.verified ? " · signed in" : ""}`;
    line.append(chip);
  });
  return line;
}

/** The line under a task message in the conversation: "Approval · @can: open". */
export function renderTaskBadge(message: Message): HTMLElement | null {
  if (!message.task) return null;
  const el = h("div", `msg-task task-type-${message.task.type}`);
  el.append(h("span", "task-label", LABEL[message.task.type]), " · ", taskStates(message.task));
  return el;
}

function renderCard(message: Message, conversation: Conversation | undefined): HTMLElement {
  const task = message.task as Task;
  const card = h("li", "inbox-item");
  const head = h("div", "inbox-head");
  head.append(h("span", `task-label task-type-${task.type}`, LABEL[task.type]));
  head.append(...mentionNodes(` #${message.seq} from @${message.from}`));
  if (conversation) head.append(h("span", "inbox-where", ` in ${conversationTitle(conversation)}`));
  head.append(h("span", "inbox-when", ` · ${relativeTime(message.createdAt)}`));
  const text = h("div", "inbox-text");
  text.append(...inline(message.text.length > 600 ? `${message.text.slice(0, 599)}…` : message.text));
  const actions = h("div", "inbox-actions");
  const note = h("span", "inbox-note");
  const button = (label: string, title: string, run: () => void) => {
    const b = h("button", "btn inbox-btn", label);
    b.type = "button";
    b.title = title;
    b.addEventListener("click", run);
    actions.append(b);
  };
  const mine = task.assignees.find((a) => a.id === state.me);
  const live = (s: string) => s === "open" || s === "accepted";
  /**
   * ✕ / Withdraw ask for an optional reason in the card itself, not with prompt(): on phones prompt() can be missing,
   * and its Cancel silently dropped the step (Ümit, 16 Nov: "Deny doesn't work").
   */
  const withReason = (action: "reject" | "withdraw", label: string) => {
    const form = h("div", "inbox-reason");
    const input = h("input");
    input.type = "text";
    input.placeholder = action === "reject" ? "Why? (optional, shown in the conversation)" : "Why? (optional)";
    const go = h("button", "btn btn-primary inbox-btn", label);
    go.type = "button";
    go.addEventListener("click", () => void step(message, action, note, input.value.trim() || undefined));
    const cancel = h("button", "btn inbox-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => form.remove());
    form.append(input, go, cancel);
    actions.before(form);
    input.focus();
  };
  if (box === "mine" && mine && live(mine.state)) {
    if (mine.state === "open") button("On it", "Accept: you are working on it", () => void step(message, "accept", note));
    button(task.type === "approval" ? "✓ Approve" : "✓ Done", task.type === "approval" ? "Approve (signed in: it counts)" : "Mark it done", () => void step(message, "done", note));
    const deny = task.type === "approval" ? "✕ Deny" : "✕ Reject";
    button(deny, "Reject it, with a reason if you like", () => withReason("reject", deny));
  }
  if (box === "assigned" && task.assignees.some((a) => live(a.state))) {
    button("Withdraw", "Take the task back", () => withReason("withdraw", "Withdraw"));
  }
  button("↩", "Reply to it in its conversation (quotes it)", () => replyTo(message));
  actions.append(note);
  card.classList.toggle("inbox-unread", box === "mine" && mine?.readAt === undefined);
  card.append(head, text, taskStates(task), actions);
  return card;
}

registerExtension({
  id: "inbox",
  order: 40,
  // Yours, not the conversation's (Can, #10037): a Workspace item of its own, beside whatever is open on the left.
  scope: "global",
  title: () => (counts.open > 0 ? `Your inbox · ${counts.open} open` : "Your inbox"),
  applies: () => !!state.me,
  render: (body) => {
    const root = h("div", "inbox pane-pad");
    // A task's #number opens its message: on phones, out of the inbox and with the way back.
    root.addEventListener("click", (event) => {
      if ((event.target as Element).closest("a.msg-ref")) leaveForMessage();
    });
    const bar = h("div", "inbox-bar");
    for (const [value, label] of [["mine", "For me"], ["assigned", "Assigned by me"]] as const) {
      const b = h("button", value === box ? "inbox-box active" : "inbox-box", label);
      b.type = "button";
      b.addEventListener("click", () => {
        box = value;
        void refreshInbox();
      });
      bar.append(b);
    }
    const closed = h("label", "inbox-closed");
    const check = h("input");
    check.type = "checkbox";
    check.checked = showClosed;
    check.addEventListener("change", () => {
      showClosed = check.checked;
      void refreshInbox();
    });
    closed.append(check, " closed too");
    bar.append(closed);
    root.append(bar);
    if (!data) root.append(h("p", "check-note", "Loading…"));
    else if (data.messages.length === 0) root.append(h("p", "check-note", box === "mine" ? "No tasks for you." : "No tasks you assigned."));
    else {
      const list = h("ul", "inbox-list");
      const byId = new Map(data.conversations.map((c) => [c.id, c]));
      for (const message of data.messages) list.append(renderCard(message, byId.get(message.conversationId)));
      root.append(list);
    }
    body.replaceChildren(root);
  },
  shown: (on) => {
    visible = on;
    if (on) markShownRead();
  },
});

dom.inboxBtn.addEventListener("click", () => toggleGlobal("inbox"));
dom.inboxRow.addEventListener("click", () => toggleGlobal("inbox"));
// ✉ and the row are lit while the Workspace shows your inbox; showing it again ends the phone's way back.
onWorkspaceChange(() => {
  const on = globalShown("inbox");
  dom.inboxBtn.classList.toggle("active", on);
  dom.inboxBtn.setAttribute("aria-pressed", on ? "true" : "false");
  dom.inboxRow.classList.toggle("active", on);
  if (on) dom.inboxReturn.hidden = true;
});
dom.inboxReturn.addEventListener("click", () => toggleGlobal("inbox"));
