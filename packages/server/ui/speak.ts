// Reading a message aloud with the browser's own speech synthesis (no server): the ▶ button next to ↩ Reply.
import { showError } from "./composer";
import { h } from "./html";

export const CAN_SPEAK = "speechSynthesis" in window;

/** The button whose message is being read now, and its utterance (kept referenced: Chrome drops unreferenced ones). */
let speaking: { button: HTMLButtonElement; utterance: SpeechSynthesisUtterance } | undefined;

/** Turkish when the text has Turkish letters, else English: the voice is picked by language. */
function language(text: string): string {
  return /[çğışöüÇĞİŞÖÜ]/.test(text) ? "tr-TR" : "en-US";
}

/** A voice for `lang` ("tr-TR"), or for its language ("tr"), or none (the browser's default). */
function voiceFor(lang: string): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  const base = lang.slice(0, 2);
  return voices.find((v) => v.lang.replace("_", "-") === lang) ?? voices.find((v) => v.lang.toLowerCase().startsWith(base));
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
  // Safari drops an utterance spoken right after a cancel() of nothing: cancel only what is speaking.
  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
  if (speaking) speaking.button.textContent = "▶";
  speaking = undefined;
}

// Some browsers load their voices only after the first getVoices() call.
if (CAN_SPEAK) speechSynthesis.getVoices();

export function speakButton(text: string): HTMLButtonElement {
  const button = h("button", "msg-action-btn msg-speak-btn", "▶");
  button.type = "button";
  button.title = "Read it aloud (click again to stop)";
  button.addEventListener("click", () => {
    const again = speaking?.button === button;
    stop();
    if (again) return;
    const lang = language(text);
    const utterance = new SpeechSynthesisUtterance(plain(text));
    utterance.lang = lang;
    const voice = voiceFor(lang);
    if (voice) utterance.voice = voice;
    else if (speechSynthesis.getVoices().length > 0) {
      showError(`This device has no ${lang.startsWith("tr") ? "Turkish" : "English"} voice; reading with its default voice.`);
    }
    const done = () => {
      if (speaking?.utterance !== utterance) return;
      button.textContent = "▶";
      speaking = undefined;
    };
    utterance.addEventListener("end", done);
    utterance.addEventListener("error", (event) => {
      if (event.error !== "interrupted" && event.error !== "canceled") showError(`Could not read it aloud: ${event.error}`);
      done();
    });
    speaking = { button, utterance };
    button.textContent = "■";
    speechSynthesis.speak(utterance);
  });
  return button;
}
