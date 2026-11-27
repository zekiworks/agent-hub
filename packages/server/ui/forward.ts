// Forwarding a message (Can #12470, #12471): ↪ in its actions opens a dialog that picks a person, an agent or a
// conversation and takes an optional note; the bus answers with a reply that mentions them where they can read it, or a
// copy in a DM or the conversation (POST /api/messages/:seq/forward). The copy shows as a box (renderForwarded); under
// the message, its readers see where it went (renderForwards).
import type { Conversation, ForwardedMessage, ForwardResponse, Message } from "@agent-bus/protocol";
import { postJson } from "./api";
import { renderFile } from "./attachments";
import { dom, PHONE } from "./dom";
import { errorText, fullFormat } from "./format";
import { h } from "./html";
import { setIcon } from "./icons";
import { renderMarkdown } from "./markdown";
import { mentionCandidates } from "./mentions";
import { conversationAddress, conversationTitle, participantDisplayName, state } from "./state";
import { mentionNodes, refLink } from "./text";
import { noteAttention } from "./attention";

/** At most this many choices are listed; the search narrows them. */
const MAX_CHOICES = 50;

/** A place a message can be forwarded to: `to` is what the bus takes ("can", "#room", "@{a,b}"). */
interface Choice {
  to: string;
  label: string;
  hint: string;
}

/** The address I write to `conv` with, if I can write there: #all, my rooms and projects (or open ones), my groups. */
function writableAddress(conv: Conversation): string | undefined {
  if (conv.archived || conv.preview) return undefined;
  if (conv.kind === "all") return "#all";
  const member = conv.members.includes(state.me);
  if (conv.kind === "project") return member || conv.visibility === "open" ? conversationAddress(conv) : undefined;
  if (conv.kind !== "group" || !member) return undefined;
  const others = conv.members.filter((id) => id !== state.me);
  return `@{${[...(conv.parentName ? [`@@${conv.parentName}`] : []), ...others].join(",")}}`;
}

/** People and agents (the @ autocomplete's, without @all), then the conversations I can write to, newest first. */
function choices(message: Message): Choice[] {
  const people = mentionCandidates()
    .filter((c) => c.id !== "all")
    // A renamed agent by its name too ("Trainer (@ml-train)"), as everywhere else on the page.
    .map((c) => {
      const name = participantDisplayName(c.id);
      return { to: c.id, label: name === c.id ? c.label : `${name} (@${c.id})`, hint: c.hint };
    });
  const places = Array.from(state.conversations.values())
    .filter((c) => c.id !== message.conversationId)
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .flatMap((c) => {
      const to = writableAddress(c);
      if (!to) return [];
      const title = conversationTitle(c);
      // The address under a name ("Model Research", "@@model-research"); a bare address says what it is.
      return [{ to, label: title, hint: title !== to ? to : c.kind === "project" && !c.room ? "project" : "room" }];
    });
  return [...people, ...places];
}

/** The open dialog's message, choices and the highlighted one. */
let current: { message: Message; all: Choice[]; shown: Choice[]; index: number } | undefined;

function openForward(message: Message): void {
  if (!state.me) return;
  const all = choices(message);
  current = { message, all, shown: all.slice(0, MAX_CHOICES), index: 0 };
  const dialog = dom.forwardDialog;
  const search = h("input", "forward-search");
  search.type = "search";
  search.placeholder = "Person, agent or conversation";
  search.setAttribute("aria-label", "Forward to");
  search.setAttribute("role", "combobox");
  search.setAttribute("aria-controls", "forward-choices");
  search.setAttribute("aria-expanded", "true");
  search.autocomplete = "off";
  const list = h("ul", "forward-choices");
  list.id = "forward-choices";
  list.setAttribute("role", "listbox");
  const note = h("textarea", "forward-note");
  note.rows = 2;
  note.placeholder = "Add a note (optional)";
  note.setAttribute("aria-label", "Note");
  const error = h("div", "composer-error");
  error.hidden = true;
  error.setAttribute("role", "alert");
  const cancel = h("button", "btn", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close());
  const send = h("button", "btn btn-primary", "Forward");
  send.type = "button";
  const actions = h("div", "dialog-actions");
  actions.append(cancel, send);
  // A copy without a note is previewed by the copy's text.
  const text = (message.text || message.forwarded?.text || "").replace(/\s+/g, " ").trim();
  const preview = text || [...message.files, ...(message.forwarded?.files ?? [])].map((f) => f.name).join(", ");
  dialog.replaceChildren(
    h("h2", "", `Forward #${message.seq}`),
    h("p", "dialog-hint forward-preview", `@${message.from}: ${preview.length > 120 ? `${preview.slice(0, 119)}…` : preview || "(no text)"}`),
    search,
    list,
    note,
    error,
    actions
  );

  const draw = (): void => {
    if (!current) return;
    const { shown, index } = current;
    if (shown.length === 0) {
      list.replaceChildren(h("li", "forward-empty", "Nobody and nothing by that name."));
      search.removeAttribute("aria-activedescendant");
      return;
    }
    list.replaceChildren(
      ...shown.map((choice, i) => {
        const li = h("li", i === index ? "forward-choice selected" : "forward-choice");
        li.id = `forward-choice-${i}`;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === index));
        li.append(h("span", "forward-label", choice.label), h("span", "forward-hint", choice.hint));
        li.addEventListener("click", () => {
          if (current) current.index = i;
          draw();
          note.focus();
        });
        return li;
      })
    );
    search.setAttribute("aria-activedescendant", `forward-choice-${index}`);
    list.children[index]?.scrollIntoView({ block: "nearest" });
  };

  // One forward at a time: Enter in the search or the note while one is on its way must not send it again
  // (codex-ui #12869: a disabled button did not stop the keys).
  let forwarding = false;
  const forward = async (): Promise<void> => {
    if (forwarding) return;
    const picked = current?.shown[current.index];
    if (!current || !picked) {
      error.textContent = "Pick a person, an agent or a conversation.";
      error.hidden = false;
      search.focus();
      return;
    }
    forwarding = true;
    send.disabled = true;
    error.hidden = true;
    try {
      const res = await postJson<ForwardResponse>(`/api/messages/${current.message.seq}/forward`, {
        from: state.me,
        to: picked.to,
        note: note.value.trim(),
      });
      dialog.close();
      noteAttention(current.message.seq, "forwarded");
      showForwarded(`Forwarded to ${res.to}`);
    } catch (err) {
      error.textContent = errorText(err);
      error.hidden = false;
      send.disabled = false;
    } finally {
      forwarding = false;
    }
  };

  search.addEventListener("input", () => {
    if (!current) return;
    const q = search.value.trim().toLowerCase().replace(/^[@#]+/, "");
    current.shown = current.all
      .filter((c) => !q || c.to.toLowerCase().includes(q) || c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q))
      .slice(0, MAX_CHOICES);
    current.index = 0;
    draw();
  });
  search.addEventListener("keydown", (event) => {
    if (!current || event.isComposing) return;
    const n = current.shown.length;
    if (event.key === "ArrowDown" && n > 0) current.index = (current.index + 1) % n;
    else if (event.key === "ArrowUp" && n > 0) current.index = (current.index - 1 + n) % n;
    else if (event.key === "Enter") void forward();
    else return;
    event.preventDefault();
    draw();
  });
  // Enter forwards from the note too; Shift+Enter is a new line.
  note.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void forward();
  });
  send.addEventListener("click", () => void forward());
  draw();
  dialog.showModal();
  // Phones: no keyboard over the list until the person taps the search (they mostly pick from the list).
  if (!PHONE.matches) search.focus();
}

dom.forwardDialog.addEventListener("close", () => {
  current = undefined;
  dom.forwardDialog.replaceChildren();
});

/** "Forwarded to @b", briefly, where it is seen whatever is open (and read out by screen readers). */
function showForwarded(text: string): void {
  document.querySelector(".forward-toast")?.remove();
  const toast = h("div", "forward-toast", text);
  toast.setAttribute("role", "status");
  // At the top of the message list, under the conversation's title: never over the message box or the newest message,
  // which is often the one just forwarded (demo review D2, D3). Without a list on screen, the default place.
  const list = dom.messageScroll.getBoundingClientRect();
  if (list.height > 0) Object.assign(toast.style, { top: `${Math.round(list.top + 12)}px`, bottom: "auto" });
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2500);
}

/** ↪ in a message's actions: forward it. */
export function forwardButton(message: Message): HTMLButtonElement {
  const button = h("button", "msg-action-btn msg-forward-btn");
  setIcon(button, "forward");
  button.type = "button";
  button.title = "Forward it to a person, an agent or a conversation";
  button.setAttribute("aria-label", `Forward message #${message.seq}`);
  button.addEventListener("click", () => openForward(message));
  return button;
}

/**
 * The copy a forwarded message carries: "↪ Forwarded from @x in #room · #12 · time", its text and files. The room and
 * the number link to the original only for those who can read it; for anyone else they are plain text.
 */
export function renderForwarded(forwarded: ForwardedMessage): HTMLElement {
  const source = state.conversations.get(forwarded.conversationId);
  const readable = source !== undefined && !source.preview;
  const box = h("div", "msg-forwarded");
  const head = h("div", "msg-forwarded-head");
  let where: Node = document.createTextNode(forwarded.conversationTitle);
  if (readable) {
    const link = h("a", "msg-ref", conversationTitle(source));
    link.href = `#/c/${encodeURIComponent(source.id)}`;
    where = link;
  }
  const time = h("time", "msg-forwarded-time", fullFormat.format(forwarded.createdAt));
  time.dateTime = new Date(forwarded.createdAt).toISOString();
  head.append(
    "↪ Forwarded from ",
    h("span", "msg-forwarded-from", `@${forwarded.from}`),
    " in ",
    where,
    " · ",
    readable ? refLink(forwarded.seq) : document.createTextNode(`#${forwarded.seq}`),
    " · ",
    time
  );
  box.append(head);
  if (forwarded.text) {
    const body = h("div", "msg-forwarded-text");
    body.append(...renderMarkdown(forwarded.text, readable ? mentionNodes : (text) => mentionNodes(text, false)));
    box.append(body);
  }
  if (forwarded.files.length > 0) {
    const files = h("ul", "msg-files");
    for (const file of forwarded.files) files.append(renderFile(file));
    box.append(files);
  }
  return box;
}

/** Under a message, for those who read it: "Forwarded to @b by @a; to #room by @c". */
export function renderForwards(message: Message): HTMLElement | null {
  const forwards = message.forwards ?? [];
  if (forwards.length === 0) return null;
  const line = h("div", "msg-forwards", `Forwarded ${forwards.map((f) => `to ${f.to} by @${f.by}`).join("; ")}`);
  line.title = forwards.map((f) => `${f.to} by @${f.by}, ${fullFormat.format(f.at)}`).join("\n");
  return line;
}
