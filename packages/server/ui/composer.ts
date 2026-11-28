// The message box: its state, size, reply bar and staged files. Sending is send.ts.
import { formatBytes, mentionedIds, type Message } from "@agent-bus/protocol";
import { dom, nearBottom, PHONE, scrollToBottom, showInView } from "./dom";
import { nameList } from "./format";
import { h } from "./html";
import { setIcon } from "./icons";
import { viewHash } from "./routing";
import { conversationTitle, state } from "./state";

export function showError(text: string): void {
  dom.composerError.textContent = text;
  dom.composerError.hidden = false;
}

export function hideError(): void {
  dom.composerError.hidden = true;
  dom.composerError.textContent = "";
}

/**
 * Offline agents the message being written is for: it is held until they are back. In a DM (or a new message) that is
 * every offline recipient; in a room, project or group only an offline agent the draft names (@id) or answers (the
 * message replied to is its): a room member who sleeps but is not addressed only reads the message later anyway, and a
 * standing "@x is offline" under the box said nothing she could act on (Ümit #18332).
 */
function offlineRecipients(): string[] {
  const view = state.view;
  const conv = view.kind === "conversation" ? state.conversations.get(view.id) : undefined;
  const members = view.kind === "draft" ? view.to : (conv?.members ?? []);
  const offline = members.filter((id) => {
    const p = state.participants.find((x) => x.id === id);
    return p?.kind === "agent" && !p.online;
  });
  if (view.kind === "draft" || conv?.kind === "dm") return offline;
  const named = new Set(mentionedIds(dom.input.value));
  if (state.replyTo) named.add(state.replyTo.from);
  return offline.filter((id) => named.has(id));
}

/** Hours to hold the next message for offline agents (the box's "kept for" choice), or undefined for the default. */
export function holdHours(): number | undefined {
  if (dom.holdBar.hidden) return undefined;
  const hours = Number(dom.holdSelect.value);
  return hours === 1 ? undefined : hours;
}

export function updateComposerState(): void {
  // Nobody else in the open conversation (they all left): a message there reaches no one (Can, 14 Nov).
  const view0 = state.view;
  const open = view0.kind === "conversation" ? state.conversations.get(view0.id) : undefined;
  const alone = !!open && open.kind !== "all" && open.members.every((id) => id === state.me);
  dom.nobodyBar.hidden = !alone;
  if (open && alone) {
    // Short, without the name, so it never fills a phone's screen with the keyboard up (codex-ui #11719).
    const what = open.kind === "project" ? (open.room ? "room" : "project") : open.kind === "group" ? "group" : "conversation";
    const add = open.kind === "project" || open.kind === "group" ? " Add people with the gear ⚙ next to its name." : "";
    dom.nobodyBar.textContent = `Only you are in this ${what}: a message here reaches no one.${add}`;
  }
  const offline = offlineRecipients();
  dom.holdBar.hidden = offline.length === 0;
  if (offline.length > 0) {
    dom.holdBarText.textContent = `${offline.map((id) => `@${id}`).join(", ")} ${offline.length > 1 ? "are" : "is"} offline: your message waits for ${offline.length > 1 ? "them" : "it"},`;
  }
  const hasContent = dom.input.value.trim().length > 0 || state.staged.length > 0;
  dom.sendBtn.disabled = state.sending || !state.me || (!hasContent && !state.voiceLatched);
  setIcon(dom.sendBtn, "send");
  const sendName = state.sending ? "Sending" : state.voiceLatched ? "Send the voice message" : "Send";
  dom.sendBtn.setAttribute("aria-label", sendName);
  dom.sendBtn.title = state.sending ? "Sending…" : `${sendName} (Enter)`;
  const view = state.view;
  const conv = view.kind === "conversation" ? state.conversations.get(view.id) : undefined;
  const target = view.kind === "draft" ? nameList(view.to) : conv ? conversationTitle(conv) : "";
  // A short, quiet placeholder (Ümit #10686: the long one read like text still in the box); the conversation header
  // names the room, screen readers get it from the label, the keys from the tooltip.
  dom.input.placeholder = "Write a message…";
  dom.input.setAttribute("aria-label", target ? `Message to ${target}` : "Message");
  dom.input.title = PHONE.matches ? "" : "Enter sends, Shift+Enter starts a new line, @ mentions someone";
}

/**
 * Height dragged for the room currently open, or undefined: it grows with its text. It deliberately does not persist
 * or follow the person to another room (Ümit #15889); every room opens at the same automatic baseline.
 */
const COMPOSER_MIN = 40;
const COMPOSER_AUTO_MAX = 240;
localStorage.removeItem("agent-bus.composerHeight"); // Remove the old cross-room preference.
let composerHeight: number | undefined;

/**
 * Tallest the text may be dragged: the whole box (its 📎 🎤 row and grip included) at most 70% of the chat, leaving room
 * to see the newest messages. With the keyboard up a tall box shrinks to that (codex-ui #11237: it ran under the keyboard).
 */
function composerMax(): number {
  const chat = dom.composer.parentElement;
  const chrome = dom.composer.offsetHeight - dom.input.offsetHeight;
  return Math.max(COMPOSER_MIN, Math.floor((chat?.clientHeight ?? window.innerHeight) * 0.7) - chrome);
}

export function autosize(): void {
  if (composerHeight !== undefined) {
    dom.input.style.height = `${Math.min(composerHeight, composerMax())}px`;
    return;
  }
  dom.input.style.height = "auto";
  // Growing with the text stops at 240 px, or sooner when the screen is short (keyboard up, big text), so Send and the
  // newest messages stay in view (codex-ui #11709).
  dom.input.style.height = `${Math.min(dom.input.scrollHeight, COMPOSER_AUTO_MAX, composerMax())}px`;
}

function setComposerHeight(height: number | undefined): void {
  composerHeight = height;
  autosize();
  dom.composerGrip.setAttribute("aria-valuenow", String(dom.input.offsetHeight));
}

/** Returns the box to the automatic baseline; a draft may then grow it only as its text needs. */
export function resetComposerHeight(): void {
  setComposerHeight(undefined);
}

/** A drag must not leave an empty phone composer covering the conversation when the person returns to it. */
export function resetEmptyPhoneComposer(): void {
  if (PHONE.matches && dom.input.value.length === 0 && composerHeight !== undefined) resetComposerHeight();
}
setIcon(dom.attachBtn, "paperclip");

// Dragging the grip: read the sizes once at the start, then write only the box's height (one write per frame). A tap,
// or a slip of a few pixels while reaching for the box, changes nothing (Ümit #11235: the box was not stable enough).
{
  const grip = dom.composerGrip;
  let drag:
    | { startY: number; startHeight: number; max: number; threshold: number; stick: boolean; target: number; frame: number; moving: boolean }
    | undefined;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone (released before this ran): the drag still follows moves over the grip.
    }
    const startHeight = dom.input.offsetHeight;
    drag = {
      startY: event.clientY,
      startHeight,
      max: composerMax(),
      threshold: event.pointerType === "touch" ? 14 : 6,
      stick: nearBottom(),
      target: startHeight,
      frame: 0,
      moving: false,
    };
  });
  grip.addEventListener("pointermove", (event) => {
    const d = drag;
    if (!d) return;
    if (!d.moving) {
      if (Math.abs(event.clientY - d.startY) < d.threshold) return;
      d.moving = true;
      grip.classList.add("dragging");
    }
    d.target = Math.round(Math.min(d.max, Math.max(COMPOSER_MIN, d.startHeight + d.startY - event.clientY)));
    d.frame ||= requestAnimationFrame(() => {
      d.frame = 0;
      dom.input.style.height = `${d.target}px`;
      // Writing (not reading) the scroll position keeps the newest message in view while the box grows.
      if (d.stick) dom.messageScroll.scrollTop = 1e9;
    });
  });
  const end = (): void => {
    const d = drag;
    if (!d) return;
    drag = undefined;
    cancelAnimationFrame(d.frame);
    grip.classList.remove("dragging");
    if (!d.moving) return;
    if (d.target !== d.startHeight) setComposerHeight(d.target);
    if (d.stick) scrollToBottom();
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  // Safari on the iPhone scrolls the page with a finger on the grip despite touch-action: pulling down took the page
  // along, and the scroll took the pointer (pointercancel), so pulling up did nothing (Ümit #13147). The grip's touches
  // are its own.
  grip.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false });
  grip.addEventListener("touchmove", (event) => event.preventDefault(), { passive: false });
  grip.addEventListener("dblclick", () => setComposerHeight(undefined));
  grip.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.key === "ArrowUp" ? 24 : -24;
    setComposerHeight(Math.min(composerMax(), Math.max(COMPOSER_MIN, dom.input.offsetHeight + step)));
  });
  grip.setAttribute("aria-valuemin", String(COMPOSER_MIN));
}

/**
 * Sets (or, with undefined, cancels) the message the next send replies to; also cancels a checklist item's reply.
 * `part`: the paragraph it answers, when one was framed (Ümit #13981); the reply then quotes only that.
 */
export function setReplyTo(message: Message | undefined, part?: string): void {
  state.replyTo = message;
  state.replyPart = message ? part : undefined;
  state.itemReply = undefined;
  dom.replyBar.hidden = !message;
  setReplyExpanded(false);
  // The message being replied to stays framed until the reply is sent or cancelled (✕, Esc, Reply again).
  for (const li of dom.messageList.querySelectorAll<HTMLLIElement>(".msg-replying")) li.classList.remove("msg-replying");
  if (message) {
    const li = dom.messageList.querySelector<HTMLLIElement>(`.msg[data-seq="${message.seq}"]`);
    li?.classList.add("msg-replying");
    // Its ⋯ row folds again: writing, the screen is for the box and what it answers (Ümit #14607).
    li?.querySelector(".msg-actions")?.classList.remove("msg-actions-open");
    const text = (part ?? message.text).trim();
    const what = part ? "this paragraph of" : "";
    dom.replyBarText.textContent = `Replying to ${what ? `${what} ` : ""}${message.from}: ${text || "(file)"}`;
    dom.input.focus();
    // The iPhone keyboard animates in after focus and repeatedly shortens the message view. Keep moving the message
    // answered into that shrinking view; otherwise the fixed composer covers it (Ümit #15082).
    if (PHONE.matches && li) {
      for (const ms of [0, 100, 400, 800]) {
        setTimeout(() => {
          if (state.replyTo?.seq === message.seq) showInView(li);
        }, ms);
      }
    }
  }
  // Answering an offline agent's message holds it for that agent: the "is offline" line follows the reply.
  updateComposerState();
}

/**
 * The reply bar stays one line. An explicit Show/Hide button opens the whole quote; the text itself is inert so an
 * accidental tap while reaching the message box cannot cover the original message (Ümit #15105).
 */
function setReplyExpanded(on: boolean): void {
  dom.replyBar.classList.toggle("expanded", on);
  dom.replyToggle.setAttribute("aria-expanded", String(on));
  dom.replyToggle.textContent = on ? "Hide ▴" : "Show ▾";
  dom.replyToggle.title = on ? "Hide the quoted message" : "Show the whole quoted message";
}
dom.replyToggle.addEventListener("click", () => setReplyExpanded(!dom.replyBar.classList.contains("expanded")));

/**
 * ↩ on a checklist item (Ümit #11598): the item shows above the message box like a reply, and goes in front of the
 * message as a quote when it is sent. The box keeps only what she writes; ↩ again replaces it, never adds a line.
 */
export function setItemReply(conversationId: string, item: string): void {
  setReplyTo(undefined);
  state.itemReply = { conversationId, item };
  dom.replyBar.hidden = false;
  dom.replyBarText.textContent = `Replying to the checklist item: ${item}`;
  dom.input.focus();
}

dom.replyCancel.addEventListener("click", () => setReplyTo(undefined));

/** Object URLs of the staged image previews currently shown; revoked on every re-render. */
let stagedPreviewUrls: string[] = [];

export function renderStaged(): void {
  for (const url of stagedPreviewUrls) URL.revokeObjectURL(url);
  stagedPreviewUrls = [];
  dom.stagedFiles.hidden = state.staged.length === 0;
  dom.stagedFiles.replaceChildren(
    ...state.staged.map((file, index) => {
      const li = h("li", "staged-file");
      if (file.type.startsWith("image/")) {
        const url = URL.createObjectURL(file);
        stagedPreviewUrls.push(url);
        const img = h("img", "staged-preview");
        img.src = url;
        img.alt = file.name;
        li.append(img);
      }
      li.append(h("span", "file-name", file.name), h("span", "file-size", formatBytes(file.size)));
      const remove = h("button", "staged-remove", "×");
      remove.type = "button";
      remove.title = "Remove";
      remove.disabled = state.sending;
      remove.addEventListener("click", () => {
        state.staged.splice(index, 1);
        renderStaged();
        updateComposerState();
      });
      li.append(remove);
      return li;
    })
  );
}

function stageFiles(files: Iterable<File>): void {
  for (const file of files) state.staged.push(file);
  renderStaged();
  updateComposerState();
  dom.input.focus();
}

/**
 * Files waiting in the box belong to the conversation they were added in (Ümit #14611: a pasted screenshot followed her
 * into #science-bench): leaving it keeps them there for coming back, and the box of the one opened shows its own.
 */
const stagedElsewhere = new Map<string, File[]>();
export function moveStaged(from: string, to: string): void {
  if (from === to) return;
  if (state.staged.length > 0) stagedElsewhere.set(from, state.staged);
  state.staged = stagedElsewhere.get(to) ?? [];
  stagedElsewhere.delete(to);
  renderStaged();
}

/** Sent files leave the box, wherever it is now (the conversation may have changed while they uploaded). */
export function unstage(files: readonly File[]): void {
  state.staged = state.staged.filter((f) => !files.includes(f));
  for (const [place, list] of stagedElsewhere) {
    const left = list.filter((f) => !files.includes(f));
    if (left.length > 0) stagedElsewhere.set(place, left);
    else stagedElsewhere.delete(place);
  }
  renderStaged();
}

/** The files waiting in the box of `place` (a view's hash): the open box's, or one left behind. */
export function stagedFor(place: string): File[] {
  return place === viewHash(state.view) ? [...state.staged] : [...(stagedElsewhere.get(place) ?? [])];
}

/** Browsers name every pasted image "image.png"; give each a distinct, dated name instead. */
function pastedName(file: File, index: number): File {
  if (file.name && file.name !== "image.png" && file.name !== "image.jpeg") return file;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return new File([file], `pasted-${stamp}${index > 0 ? `-${index + 1}` : ""}.${ext}`, { type: file.type });
}

// Safari's writing and autocorrection bubbles covered the right side of the phone composer, including Send
// (Ümit #15934, #15992). Keep both native overlays off; the keyboard's prediction bar and Agent Hub's dismissible
// local suggestion remain available.
dom.input.setAttribute("autocorrect", "off");

/** A cell's text on one line, its `|` escaped so it stays one Markdown cell. */
function cellText(cell: Element): string {
  return (cell.textContent ?? "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

/** `table` as a Markdown table, its first row the header (as messages show it). */
function markdownTable(table: HTMLTableElement): string {
  return markdownRows(Array.from(table.rows).map((row) => Array.from(row.cells).map(cellText)));
}

/** Rows of cells as a Markdown table, the first row the header; shorter rows are filled with empty cells. */
function markdownRows(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: readonly string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [head = [], ...body] = rows;
  return [line(head), line(Array<string>(width).fill("---")), ...body.map(line)].join("\n");
}

const BLOCKS = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "SECTION", "ARTICLE", "HEADER", "FOOTER"]);

/**
 * Pasted HTML with a table as text, the tables as Markdown (Ümit #17989: a table copied from a message, a spreadsheet
 * or a page pasted as cells separated by invisible tabs). Read from the parsed HTML without putting it in the page.
 * Undefined when it has no table: the browser's own paste is fine then.
 */
function pastedWithTables(html: string): string | undefined {
  if (!/<table[\s>]/i.test(html)) return undefined;
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc.querySelector("table")) return undefined;
  const out: string[] = [];
  const walk = (node: Node, pre: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(pre ? (node.textContent ?? "") : (node.textContent ?? "").replace(/\s+/g, " "));
      return;
    }
    if (!(node instanceof Element) || ["SCRIPT", "STYLE", "TEMPLATE"].includes(node.tagName)) return;
    if (node.tagName === "TABLE") return void out.push(`\n\n${markdownTable(node as HTMLTableElement)}\n\n`);
    if (node.tagName === "BR") return void out.push("\n");
    const block = BLOCKS.has(node.tagName) || node.tagName === "PRE";
    if (block) out.push("\n");
    for (const child of Array.from(node.childNodes)) walk(child, pre || node.tagName === "PRE");
    if (block) out.push("\n");
  };
  walk(doc.body, false);
  return out
    .join("")
    .split("\n")
    .map((line) => (line.startsWith("|") ? line : line.replace(/^ +| +$/g, "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Plain text whose runs of two or more tab-separated lines (the same number of tabs on each, not indentation) become
 * Markdown tables: what a copied table is on a clipboard without its HTML (Ümit #17997: Safari on the iPhone pastes
 * only the text into the message box). Undefined when it has no such run.
 */
function pastedTabTables(text: string): string | undefined {
  if (!text.includes("\t") || !text.includes("\n")) return undefined;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const tabs = (line: string) => line.split("\t").length - 1;
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length; ) {
    // A header row whose empty first cell was dropped has one tab fewer than the rows under it.
    const next = i + 1 < lines.length ? tabs(lines[i + 1] as string) : 0;
    const short = tabs(lines[i] as string) === next - 1 && next > 1;
    const count = short ? next : tabs(lines[i] as string);
    let end = i + 1;
    while (count > 0 && end < lines.length && tabs(lines[end] as string) === count) end++;
    const run = lines.slice(i, end);
    // Indented code starts most lines with a tab; a table's first cell starts at most the header row empty.
    if (run.length >= 2 && run.filter((line) => line.startsWith("\t")).length <= 1) {
      const rows = run.map((line) => line.split("\t").map((cell) => cell.trim().replace(/\|/g, "\\|")));
      if (short) rows[0]?.unshift("");
      // A blank line on each side, or Markdown would read the next line of text as another row.
      if (out.length > 0 && out.at(-1)?.trim() !== "") out.push("");
      out.push(markdownRows(rows));
      if (end < lines.length && (lines[end] as string).trim() !== "") out.push("");
      changed = true;
    } else out.push(...run);
    i = end;
  }
  return changed ? out.join("\n") : undefined;
}

// Ctrl/⌘+V of an image (a screenshot) or of copied files attaches them; text pastes as usual. When the clipboard holds
// text as well (copied from Notes, Mail or a web page, which also carry a picture of it), the text is what was meant:
// it pastes and nothing is attached (Ümit #12591: on the iPhone the text vanished and an image was attached instead).
// Copied tables paste as Markdown tables (pastedWithTables, else pastedTabTables).
dom.input.addEventListener("paste", (event) => {
  const data = event.clipboardData;
  const withTables = pastedWithTables(data?.getData("text/html") ?? "") ?? pastedTabTables(data?.getData("text/plain") ?? "");
  if (withTables !== undefined) {
    event.preventDefault();
    const { selectionStart: from, selectionEnd: to, value: before } = dom.input;
    // insertText keeps ⌘Z working; where it inserted nothing, the text is put in directly.
    if (!document.execCommand("insertText", false, withTables) || dom.input.value === before) {
      dom.input.setRangeText(withTables, from, to, "end");
      dom.input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return;
  }
  const files = Array.from(data?.files ?? []);
  if (files.length === 0 || (data?.getData("text/plain") ?? "").trim() !== "") return;
  event.preventDefault();
  stageFiles(files.map(pastedName));
});

dom.attachBtn.addEventListener("click", () => dom.fileInput.click());
dom.fileInput.addEventListener("change", () => {
  if (dom.fileInput.files) stageFiles(Array.from(dom.fileInput.files));
  dom.fileInput.value = "";
});

// Drag and drop anywhere on the page.
let dragDepth = 0;

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

document.addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  dom.dropOverlay.hidden = false;
});
document.addEventListener("dragover", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dom.dropOverlay.hidden = true;
});
document.addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dom.dropOverlay.hidden = true;
  if (event.dataTransfer) stageFiles(Array.from(event.dataTransfer.files));
});
