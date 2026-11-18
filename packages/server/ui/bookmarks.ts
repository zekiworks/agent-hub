// My own bookmarks: messages I saved for myself, from any conversation I read, in one list in the
// Workspace ("☆ Bookmarks" under "✉ Your inbox"). Nobody else sees them, and the message itself is never touched:
// ☆ on a message saves it, ★ drops it. The bus keeps the list, so it is the same on every device.
import type { Bookmark, Message } from "@agent-bus/protocol";
import { postJson } from "./api";
import { dom, PHONE } from "./dom";
import { errorText, relativeTime } from "./format";
import { hooks } from "./hooks";
import { h } from "./html";
import { icon } from "./icons";
import { closePane, globalShown, onWorkspaceChange, refreshPane, registerExtension, toggleGlobal } from "./pane";
import { renderMessages } from "./render";
import { conversationTitle, state } from "./state";
import { fetchMessage } from "./text";

export function isBookmarked(seq: number): boolean {
  return state.bookmarks.some((b) => b.seq === seq);
}

async function setBookmarked(seq: number, bookmarked: boolean): Promise<void> {
  const res = await postJson<{ bookmarks: Bookmark[] }>("/api/bookmarks", { from: state.me, seq, bookmarked });
  bookmarksChanged(res.bookmarks);
}

/** The list as the bus has it now (my answer, or another of my pages changed it). */
export function bookmarksChanged(bookmarks: Bookmark[]): void {
  state.bookmarks = bookmarks;
  renderMessages();
  refreshPane("bookmarks");
}

/** ☆ (save for myself) or ★ (saved; a click drops it) among a message's actions. */
export function bookmarkButton(message: Message): HTMLButtonElement {
  const on = isBookmarked(message.seq);
  const button = h("button", `msg-action-btn msg-bookmark-btn${on ? " bookmarked" : ""}`);
  button.append(icon("star", on));
  button.type = "button";
  button.title = on ? "In your bookmarks; click to remove it (only you see them)" : "Bookmark it for yourself (only you see your bookmarks)";
  button.setAttribute("aria-label", on ? `Remove message #${message.seq} from your bookmarks` : `Bookmark message #${message.seq}`);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.addEventListener("click", () => {
    button.disabled = true;
    setBookmarked(message.seq, !on).catch((error) => {
      button.disabled = false;
      button.title = `Not saved: ${errorText(error)}`;
    });
  });
  return button;
}

/** Phones: the list covers the conversation, so opening a message leaves it, with the way back (as the inbox does). */
function open(seq: number): void {
  if (PHONE.matches) {
    dom.bookmarksReturn.hidden = false;
    closePane();
  }
  void hooks.showMessage(seq);
}

registerExtension({
  id: "bookmarks",
  order: 41,
  scope: "global",
  title: () => (state.bookmarks.length > 0 ? `Your bookmarks · ${state.bookmarks.length}` : "Your bookmarks"),
  applies: () => !!state.me,
  render: (body) => {
    const root = h("div", "pinned pane-pad");
    if (state.bookmarks.length === 0) {
      root.append(h("p", "check-note", "No bookmarks yet. Save a message for yourself with ☆ on it (hover, or tap it on a phone); only you see your bookmarks."));
      body.replaceChildren(root);
      return;
    }
    const list = h("ul", "pinned-list");
    for (const bookmark of state.bookmarks) {
      const li = h("li", "pinned-item");
      const button = h("button", "pinned-open");
      button.type = "button";
      const title = h("span", "pinned-title", `#${bookmark.seq}`);
      const detail = h("span", "pinned-detail", `saved ${relativeTime(bookmark.at)}`);
      button.append(title, detail);
      button.addEventListener("click", () => open(bookmark.seq));
      const remove = h("button", "link-btn pinned-unpin", "Remove");
      remove.type = "button";
      remove.title = "Remove it from your bookmarks (the message stays where it is)";
      remove.addEventListener("click", () => {
        remove.disabled = true;
        setBookmarked(bookmark.seq, false).catch((error) => {
          remove.disabled = false;
          remove.textContent = `Not removed: ${errorText(error)}`;
        });
      });
      li.append(button, remove);
      list.append(li);
      // Sender, text and conversation from the bus (it may not be loaded on the left). One I can no longer read (I
      // left the room) or that its writer deleted says so; Remove still works.
      void fetchMessage(bookmark.seq).then(
        ({ message, conversation }) => {
          const text = message.deletedAt
            ? "(message deleted)"
            : message.text.replace(/\s+/g, " ").trim() || (message.files.length > 0 ? `(${message.files.map((f) => f.name).join(", ")})` : "");
          title.textContent = `@${message.from}: ${text}`;
          detail.textContent = `${conversationTitle(state.conversations.get(conversation.id) ?? conversation)} · saved ${relativeTime(bookmark.at)}`;
        },
        (error) => {
          title.textContent = `#${bookmark.seq} (${errorText(error)})`;
        }
      );
    }
    root.append(list, h("p", "check-foot", "Only you see your bookmarks, newest first; the same on every device you sign in on."));
    body.replaceChildren(root);
  },
});

// "☆ Bookmarks" in the list and ☆ beside ✉ in the top bar both open the list, and are lit while it shows.
onWorkspaceChange(() => {
  const on = globalShown("bookmarks");
  dom.bookmarksRowCount.textContent = state.bookmarks.length > 0 ? String(state.bookmarks.length) : "";
  for (const button of [dom.bookmarksRow, dom.bookmarksBtn]) {
    button.hidden = !state.me;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
  if (on) dom.bookmarksReturn.hidden = true;
});
dom.bookmarksRow.addEventListener("click", () => toggleGlobal("bookmarks"));
dom.bookmarksBtn.addEventListener("click", () => toggleGlobal("bookmarks"));
dom.bookmarksReturn.addEventListener("click", () => toggleGlobal("bookmarks"));
