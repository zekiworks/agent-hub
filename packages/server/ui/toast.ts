// An answer elsewhere (Ümit, 16 Nov: "I write in one room and go to another; how do I know an answer came?"): a banner
// at the top, "↩ @logic in #toolbench-models: …", that opens the message when tapped. Phones show no browser
// notifications in a Safari tab, and the conversation list is hidden while a conversation is open.
import type { Conversation, Message } from "@agent-bus/protocol";
import { hooks } from "./hooks";
import { h } from "./html";
import { conversationTitle, state } from "./state";

/** How long a banner stays (ms), and how many show at once (the oldest goes first). */
const SHOW_MS = 12_000;
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
  const toast = h("button", "answer-toast");
  toast.type = "button";
  toast.append(
    h("span", "answer-toast-head", `↩ @${message.from} in ${conversationTitle(conversation)}`),
    h("span", "answer-toast-text", text.length > 140 ? `${text.slice(0, 139)}…` : text || "(file)")
  );
  const close = () => toast.remove();
  toast.addEventListener("click", () => {
    close();
    void hooks.showMessage(message.seq);
  });
  box.append(toast);
  while (box.childElementCount > MAX_SHOWN) box.firstElementChild?.remove();
  setTimeout(close, SHOW_MS);
}
