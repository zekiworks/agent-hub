// An answer elsewhere (Ümit, 16 Nov: "I write in one room and go to another; how do I know an answer came?"): a banner
// at the top, "↩ @logic in #toolbench-models: …", that opens the message when tapped. Phones show no browser
// notifications in a Safari tab, and the conversation list is hidden while a conversation is open. A banner stays
// until tapped or closed with ✕ (Ümit #10168: 12 s was too short to catch); the message itself is in its conversation.
import type { Conversation, Message } from "@agent-bus/protocol";
import { hooks } from "./hooks";
import { h } from "./html";
import { conversationTitle, state } from "./state";

/** How many show at once (the oldest goes first). */
const MAX_SHOWN = 3;

let box: HTMLElement | undefined;

/** `message` answers me: it quotes me, mentions me, follows my own last message there, or is in a DM with me. */
export function answersMe(message: Message, conversation: Conversation, previous: Message | undefined): boolean {
  if (!state.me || message.from === state.me) return false;
  if (conversation.kind !== "all" && !conversation.members.includes(state.me)) return false;
  if (message.quote?.from === state.me) return true;
  if (previous?.from === state.me) return true;
  if (conversation.kind === "dm") return true;
  return new RegExp(`(^|[^\\w@])@${state.me}(?![\\w-])`, "i").test(message.text);
}

export function showAnswer(message: Message, conversation: Conversation): void {
  if (!box) {
    box = h("div", "answer-toasts");
    box.setAttribute("aria-live", "polite");
    document.body.append(box);
  }
  const text = message.text.replace(/\s+/g, " ").trim();
  const toast = h("div", "answer-toast");
  const open = h("button", "answer-toast-open");
  open.type = "button";
  // The whole text, a few lines of it shown; "More" lets the rest out (Ümit #10782: she could not read them).
  const body = h("span", "answer-toast-text", text || "(file)");
  open.append(h("span", "answer-toast-head", `↩ @${message.from} in ${conversationTitle(conversation)}`), body);
  const dismiss = h("button", "answer-toast-close", "✕");
  dismiss.type = "button";
  dismiss.title = "Close (the message stays in its conversation)";
  dismiss.setAttribute("aria-label", "Close this notification");
  open.addEventListener("click", () => {
    toast.remove();
    void hooks.showMessage(message.seq);
  });
  dismiss.addEventListener("click", () => toast.remove());
  toast.append(open, dismiss);
  box.append(toast);
  while (box.childElementCount > MAX_SHOWN) box.firstElementChild?.remove();
  if (body.scrollHeight > body.clientHeight + 1) {
    const more = h("button", "link-btn answer-toast-more", "More");
    more.type = "button";
    more.addEventListener("click", () => {
      const expanded = body.classList.toggle("expanded");
      more.textContent = expanded ? "Less" : "More";
    });
    toast.append(more);
  }
}
