// Reading a message aloud with the browser's own speech synthesis (no server): the ▶ button next to ↩ Reply.
import { h } from "./html";

export const CAN_SPEAK = "speechSynthesis" in window;

/** The button whose message is being read now. */
let speaking: HTMLButtonElement | undefined;

/** Turkish when the text has Turkish letters, else English: the voice is picked by language. */
function language(text: string): string {
  return /[çğışöüÇĞİŞÖÜ]/.test(text) ? "tr-TR" : "en-US";
}

/** What a listener should hear: no markdown signs, code or link addresses. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/https?:\/\/\S+/g, " (link) ")
    .replace(/@\{([^}]*)\}/g, "$1")
    .replace(/[*_`#>|@]/g, " ");
}

function stop(): void {
  speechSynthesis.cancel();
  if (speaking) speaking.textContent = "▶";
  speaking = undefined;
}

export function speakButton(text: string): HTMLButtonElement {
  const button = h("button", "msg-action-btn msg-speak-btn", "▶");
  button.type = "button";
  button.title = "Read it aloud (click again to stop)";
  button.addEventListener("click", () => {
    const again = speaking === button;
    stop();
    if (again) return;
    const utterance = new SpeechSynthesisUtterance(plain(text));
    utterance.lang = language(text);
    const done = () => {
      if (speaking !== button) return;
      button.textContent = "▶";
      speaking = undefined;
    };
    utterance.addEventListener("end", done);
    utterance.addEventListener("error", done);
    speaking = button;
    button.textContent = "■";
    speechSynthesis.speak(utterance);
  });
  return button;
}
