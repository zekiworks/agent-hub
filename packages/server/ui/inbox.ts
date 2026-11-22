// Tasks on the website (Can, 15 Nov): the ✉ Inbox button (yellow: open tasks; red: some unread) opens the Inbox tab of
// the right pane, with the tasks assigned to you and those you assigned. A task is a message (its #number its id);
// ✓ finishes it (approves an approval), ✕ rejects it, "On it" accepts it, ↩ answers it with a quote. Each step is
// posted in the conversation as a reply to the task by the bus.
// "Waiting for your answer" (Ümit #14881) comes first under "For me" when the bus has a needs box: agents' messages a
// decision model (d1-2B, GLiDE-2B) marked as needing you, until you write in that conversation or say "Not needed".
import type { Conversation, Message, NeedsResponse, OwnTask, Task, TasksResponse } from "@agent-bus/protocol";
import { api, postJson } from "./api";
import { setReplyTo } from "./composer";
import { dom, PHONE } from "./dom";
import { errorText, relativeTime } from "./format";
import { hooks } from "./hooks";
import { h } from "./html";
import { icon, setIcon } from "./icons";
import { renderMarkdown } from "./markdown";
import { closePane, globalShown, onWorkspaceChange, refreshPane, registerExtension, toggleGlobal } from "./pane";
import { navigate, viewHash } from "./routing";
import { conversationTitle, state } from "./state";
import { fetchMessage, mentionNodes } from "./text";

type Box = "mine" | "assigned";
let box: Box = "mine";
let showClosed = false;
let data: TasksResponse | undefined;
let counts = { open: 0, unread: 0 };
let visible = false;
/** "Waiting for your answer", when the bus judges messages (a "needs" box) and has answered. */
let waiting: NeedsResponse | undefined;

const LABEL: Record<Task["type"], string> = { task: "Task", approval: "Approval" };
/** The models' names on the cards, by the short names their verdicts carry. */
const MODEL_NAMES: Record<string, string> = { d1: "d1-2B", glide: "GLiDE" };

/** Fetches the counts for the button, and the list when the Inbox is open. */
export async function refreshInbox(): Promise<void> {
  if (!state.me) return;
  try {
    const [mine] = await Promise.all([api<TasksResponse>(`/api/tasks?box=mine&state=open`), fetchWaiting()]);
    counts = { open: mine.open, unread: mine.unread };
    data = box === "mine" && !showClosed ? mine : await api<TasksResponse>(`/api/tasks?box=${box}&state=${showClosed ? "all" : "open"}`);
  } catch {
    return; // offline: the button keeps its last state; the next frame or reload tries again
  }
  renderButton();
  refreshPane("inbox");
  if (visible) markShownRead();
}

/** "Waiting for your answer" from the bus; nothing when it has no needs box. */
async function fetchWaiting(): Promise<void> {
  if (!Object.values(state.boxes).includes("needs")) {
    waiting = undefined;
    return;
  }
  waiting = await api<NeedsResponse>(`/api/needs?from=${encodeURIComponent(state.me)}`);
}

/** The list changed on the bus (a model marked a message; you answered or dismissed one): only it is fetched again. */
export async function refreshWaiting(): Promise<void> {
  if (!state.me) return;
  try {
    await fetchWaiting();
  } catch {
    return;
  }
  renderButton();
  refreshPane("inbox");
}

/** Open tasks for me: assigned ones and my own (Can #12197), and the messages waiting for my answer (Ümit #14881). */
function openTotal(): number {
  return counts.open + state.ownTasks.filter((t) => t.doneAt === undefined).length + (waiting?.items.length ?? 0);
}

function renderButton(): void {
  const btn = dom.inboxBtn;
  const open = openTotal();
  const answers = waiting?.items.length ?? 0;
  setIcon(btn, "mail", open > 0 ? String(open) : "");
  btn.setAttribute("aria-label", open > 0 ? `Your inbox, ${open} open` : "Your inbox");
  btn.classList.toggle("inbox-open", open > 0 && counts.unread === 0);
  btn.classList.toggle("inbox-unread", counts.unread > 0);
  const tasks = open - answers;
  const parts = [
    ...(tasks > 0 ? [`${tasks} open task${tasks === 1 ? "" : "s"}${counts.unread ? `, ${counts.unread} unread` : ""}`] : []),
    ...(answers > 0 ? [`${answers} waiting for your answer`] : []),
  ];
  btn.title = parts.length === 0 ? "Your inbox: no open tasks" : `Your inbox: ${parts.join("; ")}`;
  dom.inboxRow.hidden = !state.me;
  dom.inboxRowCount.textContent = open > 0 ? String(open) : "";
  dom.inboxRow.classList.toggle("inbox-unread", counts.unread > 0);
}

// ---- My own tasks (Can #12197): a message I took as a task for myself; only I see it, the message is untouched ----

/** Takes message `seq` as my task ("open"), marks it "done", or drops it ("none"). */
export async function setOwnTask(seq: number, taskState: "open" | "done" | "none"): Promise<void> {
  const res = await postJson<{ ownTasks: OwnTask[] }>("/api/own-tasks", { from: state.me, seq, state: taskState });
  ownTasksChanged(res.ownTasks);
}

/** My list as the bus has it now (my answer, or another of my pages changed it). */
export function ownTasksChanged(ownTasks: OwnTask[]): void {
  state.ownTasks = ownTasks;
  renderButton();
  refreshPane("inbox");
  for (const button of document.querySelectorAll<HTMLButtonElement>(".msg-owntask-btn")) drawOwnTaskButton(button);
}

function drawOwnTaskButton(button: HTMLButtonElement): void {
  const seq = Number(button.dataset.seq);
  const on = state.ownTasks.some((t) => t.seq === seq);
  button.classList.toggle("on", on);
  button.disabled = false;
  button.title = on ? "One of your tasks (in your inbox); click to remove it" : "Task for me: put it in your inbox as a task (only you see it)";
  button.setAttribute("aria-label", on ? `Remove message #${seq} from your tasks` : `Make message #${seq} a task for yourself`);
  button.setAttribute("aria-pressed", on ? "true" : "false");
}

/** "Task for me" among a message's actions: takes it into my inbox, or drops it again. */
export function ownTaskButton(seq: number): HTMLButtonElement {
  const button = h("button", "msg-action-btn msg-owntask-btn");
  button.type = "button";
  button.dataset.seq = String(seq);
  button.append(icon("task"));
  drawOwnTaskButton(button);
  button.addEventListener("click", () => {
    button.disabled = true;
    const on = state.ownTasks.some((t) => t.seq === seq);
    setOwnTask(seq, on ? "none" : "open").catch((error) => {
      button.disabled = false;
      button.title = `Not saved: ${errorText(error)}`;
    });
  });
  return button;
}

/** "Your own tasks" at the top of "For me": open ones, and done ones with "closed too". False when there are none. */
function renderOwnTasks(root: HTMLElement): boolean {
  const shown = state.ownTasks.filter((t) => showClosed || t.doneAt === undefined);
  if (shown.length === 0) return false;
  root.append(h("h3", "inbox-section", "Your own tasks"));
  const list = h("ul", "inbox-list");
  for (const own of shown) {
    const card = h("li", `inbox-item own-task${own.doneAt !== undefined ? " own-done" : ""}`);
    const head = h("label", "inbox-head");
    const check = h("input");
    check.type = "checkbox";
    check.checked = own.doneAt !== undefined;
    check.title = check.checked ? "Done; untick to open it again" : "Tick when done";
    const note = h("span", "inbox-note");
    check.addEventListener("change", () => {
      setOwnTask(own.seq, check.checked ? "done" : "open").catch((error) => (note.textContent = `Not saved: ${errorText(error)}`));
    });
    const from = h("span", "", ` #${own.seq}`);
    const when = h("span", "inbox-when", ` · taken ${relativeTime(own.at)}`);
    head.append(check, h("span", "task-label task-type-task", "My task"), from, when);
    const text = h("div", "inbox-text", "…");
    const actions = h("div", "inbox-actions");
    const open = h("button", "btn inbox-btn", "Open");
    open.type = "button";
    open.title = "Go to the message in its conversation";
    open.addEventListener("click", () => {
      leaveForMessage();
      void hooks.showMessage(own.seq);
    });
    const remove = h("button", "btn inbox-btn", "Remove");
    remove.type = "button";
    remove.title = "Take it off your tasks (the message stays where it is)";
    remove.addEventListener("click", () => {
      setOwnTask(own.seq, "none").catch((error) => (note.textContent = `Not removed: ${errorText(error)}`));
    });
    actions.append(open, remove, note);
    card.append(head, text, actions);
    list.append(card);
    // Sender, conversation and text from the bus (it may not be loaded on the left).
    void fetchMessage(own.seq).then(
      ({ message, conversation }) => {
        from.replaceChildren(...mentionNodes(` #${own.seq} from @${message.from}`), h("span", "inbox-where", ` in ${conversationTitle(state.conversations.get(conversation.id) ?? conversation)}`));
        const body = message.deletedAt ? "(message deleted)" : message.text;
        text.replaceChildren(...inline(body.length > 600 ? `${body.slice(0, 599)}…` : body));
      },
      (error) => (text.textContent = `(${errorText(error)})`)
    );
  }
  root.append(list);
  return true;
}

// ---- Waiting for your answer (Ümit #14881): agents' messages a decision model marked as needing you ----

/** "d1-2B ✓ · GLiDE ✓": the models that picked the message; each one's probability in the title. */
function modelMarks(verdicts: NeedsResponse["items"][number]["verdicts"]): HTMLElement {
  const line = h("span", "needs-models");
  const entries = Object.entries(verdicts);
  entries
    .filter(([, v]) => v.needs)
    .forEach(([model], i) => {
      if (i > 0) line.append(" · ");
      line.append(h("span", "needs-model", `${MODEL_NAMES[model] ?? model} ✓`));
    });
  line.title = entries.map(([model, v]) => `${MODEL_NAMES[model] ?? model}: ${v.needs ? "needs you" : "can wait"} (${Math.round(v.p * 100)}%)`).join(" · ");
  return line;
}

/** "Not needed": the message leaves the list for good. */
async function dismissWaiting(seq: number, note: HTMLElement): Promise<void> {
  note.textContent = "…";
  try {
    await postJson("/api/needs/dismiss", { from: state.me, seq });
    if (waiting) waiting = { ...waiting, items: waiting.items.filter((item) => item.message.seq !== seq) };
    renderButton();
    refreshPane("inbox");
  } catch (error) {
    note.textContent = `Not saved: ${errorText(error)}`;
  }
}

/** "Waiting for your answer" first under "For me", newest first. False when nothing waits. */
function renderWaiting(root: HTMLElement): boolean {
  if (!waiting || waiting.items.length === 0) return false;
  root.append(h("h3", "inbox-section", "Waiting for your answer"));
  const list = h("ul", "inbox-list needs-list");
  const byId = new Map(waiting.conversations.map((c) => [c.id, c]));
  for (const { message, verdicts } of waiting.items) {
    const conversation = byId.get(message.conversationId);
    const card = h("li", "inbox-item needs-item");
    card.dataset.seq = String(message.seq);
    const head = h("div", "inbox-head");
    head.append(modelMarks(verdicts), ...mentionNodes(` #${message.seq} from @${message.from}`));
    if (conversation) head.append(h("span", "inbox-where", ` in ${conversationTitle(state.conversations.get(conversation.id) ?? conversation)}`));
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
    button("Open", "Go to the message in its conversation", () => {
      leaveForMessage();
      void hooks.showMessage(message.seq);
    });
    button("↩", "Reply to it in its conversation (quotes it); it leaves this list once you write there", () => replyTo(message));
    button("Not needed", "Take it off this list: it does not need your answer", () => void dismissWaiting(message.seq, note));
    actions.append(note);
    card.append(head, text, actions);
    list.append(card);
  }
  root.append(list);
  return true;
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
  title: () => (openTotal() > 0 ? `Your inbox · ${openTotal()} open` : "Your inbox"),
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
    // Under "For me": the messages waiting for my answer, then my own tasks, then those others gave me.
    const answers = box === "mine" && renderWaiting(root);
    const own = box === "mine" && renderOwnTasks(root);
    if (!data) root.append(h("p", "check-note", "Loading…"));
    else if (data.messages.length === 0) {
      if (!own && !answers) root.append(h("p", "check-note", box === "mine" ? "No tasks for you. Make any message a task for yourself with its task button (hover, or tap it on a phone)." : "No tasks you assigned."));
    } else {
      if (own || answers) root.append(h("h3", "inbox-section", "Given to you"));
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
