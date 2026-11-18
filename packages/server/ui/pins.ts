// What is pinned in a conversation: its checklist, while pinned (people unpin it; it then stays
// in the Workspace's Checklist tab only), and the messages its members pinned, by reference (the message
// itself is never copied or changed). The 📌 at the top right of the conversation's header shows how many: none (an
// outlined pin; a click says so), one (a click opens it), several (a click opens the "Pinned" list in the Workspace,
// where each item opens its original and members unpin).
import type { Checklist, Conversation, Message } from "@agent-bus/protocol";
import { postJson } from "./api";
import { checklistName, checklistOf, checklistProgress } from "./checklist";
import { dom, PHONE } from "./dom";
import { errorText, relativeTime } from "./format";
import { hooks } from "./hooks";
import { h } from "./html";
import { closePane, onWorkspaceChange, openPane, refreshPane, registerExtension } from "./pane";
import { state, type View } from "./state";
import { fetchMessage } from "./text";

function conversationOf(view: View): Conversation | undefined {
  return view.kind === "conversation" ? state.conversations.get(view.id) : undefined;
}

/** The checklist of `conv` while it is pinned (once known). */
function pinnedChecklist(conv: Conversation): Checklist | undefined {
  const list = checklistOf(conv.id);
  return list?.pinned ? list : undefined;
}

/** How many things are pinned in `conv`: its checklist (once known, while pinned) and its pinned messages. */
function pinCount(conv: Conversation): number {
  return (pinnedChecklist(conv) ? 1 : 0) + (conv.pinnedMessages?.length ?? 0);
}

/** Pins or unpins message `message` in its conversation (members only; the bus checks). */
export async function setMessagePinned(message: Message, pinned: boolean): Promise<void> {
  await postJson(`/api/conversations/${encodeURIComponent(message.conversationId)}/pinned`, { from: state.me, seq: message.seq, pinned });
}

/** Whether `message` is pinned in its conversation. */
export function isPinned(message: Message): boolean {
  return state.conversations.get(message.conversationId)?.pinnedMessages?.some((p) => p.seq === message.seq) ?? false;
}

// The header's 📌.
function renderHeaderButton(): void {
  const view = state.view;
  const conv = conversationOf(view);
  dom.checklistBtn.hidden = view.kind !== "conversation";
  if (!conv) return;
  const n = pinCount(conv);
  const list = pinnedChecklist(conv);
  const messages = conv.pinnedMessages?.length ?? 0;
  dom.checklistBtn.classList.toggle("pinned", n > 0);
  dom.checklistCount.textContent = n > 0 ? String(n) : "";
  // The number counts pinned things; the checklist's progress is said separately.
  const parts = [
    ...(list ? [`a checklist (${checklistProgress(list).done} of ${checklistProgress(list).total} tasks done)`] : []),
    ...(messages > 0 ? [`${messages} message${messages === 1 ? "" : "s"}`] : []),
  ];
  // The words are in its label, not on the button ("Pinned here, 2 items").
  const unpinned = n === 0 && !!checklistOf(conv.id);
  const label = n > 0 ? `Pinned here, ${n} item${n === 1 ? "" : "s"}: ${parts.join(" and ")}` : unpinned ? "Pinned here, none; an unpinned checklist" : "Pinned here, none";
  dom.checklistBtn.title = n > 0
    ? `${label}. ${n === 1 ? "Opens it" : "Opens the list in the Workspace on the right"}.`
    : unpinned ? "Nothing is pinned here. Opens the checklist, which is not pinned (Pin is at its top)" : "Nothing is pinned in this conversation yet";
  dom.checklistBtn.setAttribute("aria-label", label);
  const shown = dom.paneBtn.dataset.shown;
  const on = n > 0 && (shown === "pinned" || (shown === "checklist" && n === 1));
  dom.checklistBtn.classList.toggle("on", on);
  dom.checklistBtn.setAttribute("aria-pressed", on ? "true" : "false");
}

/** What the Pinned list last drew, per conversation: redrawn when the pins change. */
let drawnSignature = "";
onWorkspaceChange(() => {
  renderHeaderButton();
  const conv = conversationOf(state.view);
  const signature = conv ? `${conv.id}:${conv.pinnedMessages?.map((p) => p.seq).join(",") ?? ""}:${pinnedChecklist(conv) ? 1 : 0}` : "";
  if (signature !== drawnSignature) {
    drawnSignature = signature;
    refreshPane("pinned");
  }
});

let note: HTMLElement | undefined;
dom.checklistBtn.addEventListener("click", () => {
  const conv = conversationOf(state.view);
  if (!conv) return;
  const n = pinCount(conv);
  if (n > 1) return openPane("pinned");
  if (n === 1) {
    const only = conv.pinnedMessages?.[0];
    if (only) return void hooks.showMessage(only.seq);
    return openPane("checklist");
  }
  // Nothing pinned, but an unpinned checklist: the pin is its way back, with Pin at its top.
  if (checklistOf(conv.id)) return openPane("checklist");
  // Nothing pinned: say so, briefly, under the pin.
  note?.remove();
  note = h("div", "pin-note", "Nothing pinned yet. Pin a message with the pin button on it.");
  note.setAttribute("role", "status");
  const r = dom.checklistBtn.getBoundingClientRect();
  note.style.top = `${Math.round(r.bottom + 6)}px`;
  note.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - 260)))}px`;
  document.body.append(note);
  const shown = note;
  setTimeout(() => shown.remove(), 3000);
});

// The "Pinned" list in the Workspace.
function item(title: string, detail: string, open: () => void, unpin?: () => Promise<void>, unpinTitle = "Unpin (the message stays in the conversation)"): HTMLLIElement {
  const li = h("li", "pinned-item");
  const button = h("button", "pinned-open");
  button.type = "button";
  button.append(h("span", "pinned-title", title), h("span", "pinned-detail", detail));
  button.addEventListener("click", open);
  li.append(button);
  if (unpin) {
    const remove = h("button", "link-btn pinned-unpin", "Unpin");
    remove.type = "button";
    remove.title = unpinTitle;
    remove.addEventListener("click", () => {
      remove.disabled = true;
      unpin().catch((error) => {
        remove.disabled = false;
        remove.textContent = `Not unpinned: ${errorText(error)}`;
      });
    });
    li.append(remove);
  }
  return li;
}

registerExtension({
  id: "pinned",
  order: 4,
  title: () => {
    const conv = conversationOf(state.view);
    return conv ? `Pinned (${pinCount(conv)})` : "Pinned";
  },
  applies: (view) => {
    const conv = conversationOf(view);
    return !!conv && pinCount(conv) > 0;
  },
  render: (body, view) => {
    const conv = conversationOf(view);
    if (!conv) return;
    const member = conv.members.includes(state.me);
    const listEl = h("ul", "pinned-list");
    const list = pinnedChecklist(conv);
    if (list) {
      const { done, total } = checklistProgress(list);
      // Unpinned, it stays in the Checklist tab.
      listEl.append(item(`☑ ${checklistName(list)}`, `Checklist · ${done} of ${total} tasks done`, () => openPane("checklist"),
        member ? () => postJson(`/api/conversations/${encodeURIComponent(conv.id)}/checklist/pin`, { from: state.me, pinned: false }).then(() => undefined) : undefined,
        "Unpin the checklist: hides it from the pin; it stays in the Checklist tab"));
    }
    for (const pin of conv.pinnedMessages ?? []) {
      // On a phone the Workspace covers the conversation: it gives way to the message (as the inbox does).
      const open = () => {
        if (PHONE.matches) closePane();
        void hooks.showMessage(pin.seq);
      };
      const li = item(`#${pin.seq}`, `pinned by ${pin.by} ${relativeTime(pin.at)}`, open,
        member ? () => postJson(`/api/conversations/${encodeURIComponent(conv.id)}/pinned`, { from: state.me, seq: pin.seq, pinned: false }).then(() => undefined) : undefined);
      listEl.append(li);
      // The message's own sender and text, from the bus (it may not be loaded on the left).
      void fetchMessage(pin.seq).then(
        ({ message }) => {
          const text = message.text.replace(/\s+/g, " ").trim() || (message.files.length > 0 ? `(${message.files.map((f) => f.name).join(", ")})` : "");
          const title = li.querySelector(".pinned-title");
          if (title) title.textContent = `@${message.from}: ${text}`;
        },
        (error) => {
          const title = li.querySelector(".pinned-title");
          if (title) title.textContent = `#${pin.seq} (${errorText(error)})`;
        }
      );
    }
    const root = h("div", "pinned pane-pad");
    root.append(
      listEl,
      h("p", "check-foot", member ? "Pin a message with the pin button on it (hover, or tap it on a phone). Unpinning leaves the message where it is." : "Members pin and unpin.")
    );
    body.replaceChildren(root);
  },
});
