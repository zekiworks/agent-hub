// The message box: its state, size, reply bar and staged files. Sending is send.ts.
import { formatBytes, type Message } from "@agent-bus/protocol";
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

/** Agents of the open conversation (or draft) that are offline now: a message for them is held until they are back. */
function offlineRecipients(): string[] {
  const view = state.view;
  const ids = view.kind === "draft" ? view.to : (state.conversations.get(view.id)?.members ?? []);
  return ids.filter((id) => {
    const p = state.participants.find((x) => x.id === id);
    return p?.kind === "agent" && !p.online;
  });
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
 * Height the user gave the message box with its grip (px), or undefined: it grows with its text. Kept per browser. The
 * Expand button that also did this went (Ümit #13153: two controls for one thing); a "max" kept from it reads as none.
 */
const COMPOSER_HEIGHT_KEY = "agent-bus.composerHeight";
const COMPOSER_MIN = 40;
const COMPOSER_AUTO_MAX = 240;
let composerHeight: number | undefined = Number(localStorage.getItem(COMPOSER_HEIGHT_KEY)) || undefined;

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
  if (height === undefined) localStorage.removeItem(COMPOSER_HEIGHT_KEY);
  else localStorage.setItem(COMPOSER_HEIGHT_KEY, String(height));
  autosize();
  dom.composerGrip.setAttribute("aria-valuenow", String(dom.input.offsetHeight));
}
setIcon(dom.attachBtn, "paperclip");

// Dragging the grip: read the sizes once at the start, then write only the box's height (one write per frame). A tap,
// or a slip of a few pixels while reaching for the box, changes nothing (Ümit #11235: the box was not stable enough).
{
  const grip = dom.composerGrip;
  let drag: { startY: number; startHeight: number; max: number; stick: boolean; target: number; frame: number; moving: boolean } | undefined;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone (released before this ran): the drag still follows moves over the grip.
    }
    const startHeight = dom.input.offsetHeight;
    drag = { startY: event.clientY, startHeight, max: composerMax(), stick: nearBottom(), target: startHeight, frame: 0, moving: false };
  });
  grip.addEventListener("pointermove", (event) => {
    const d = drag;
    if (!d) return;
    if (!d.moving) {
      if (Math.abs(event.clientY - d.startY) < 6) return;
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
}

/**
 * The reply bar shows one line; a tap on it opens the whole message it answers, to read while writing, and closes it
 * again (Ümit #14607: replying on the phone she could not see what she was answering).
 */
function setReplyExpanded(on: boolean): void {
  dom.replyBar.classList.toggle("expanded", on);
  dom.replyBarText.setAttribute("aria-expanded", String(on));
  dom.replyBarText.title = on ? "Tap to show one line again" : "Tap to see the whole message";
}
const toggleReply = () => setReplyExpanded(!dom.replyBar.classList.contains("expanded"));
dom.replyBar.addEventListener("click", (event) => {
  if (!(event.target as Element).closest("#reply-cancel")) toggleReply();
});
dom.replyBarText.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  toggleReply();
});

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

// Touch screens (an iPhone) get the keyboard's word suggestions, as in ChatGPT's app (Ümit #12553, #12554). With a mouse
// (a Mac) only the red spelling lines stay, corrected by right-click: no inline completion, which took Enter for itself
// (Ümit #11651), and no automatic correction, whose blue underlines and quickly vanishing bubbles confused her (#12652).
if (window.matchMedia("(hover: none) and (pointer: coarse)").matches) dom.input.setAttribute("writingsuggestions", "true");
else dom.input.setAttribute("autocorrect", "off");

// Ctrl/⌘+V of an image (a screenshot) or of copied files attaches them; text pastes as usual. When the clipboard holds
// text as well (copied from Notes, Mail or a web page, which also carry a picture of it), the text is what was meant:
// it pastes and nothing is attached (Ümit #12591: on the iPhone the text vanished and an image was attached instead).
dom.input.addEventListener("paste", (event) => {
  const data = event.clipboardData;
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
