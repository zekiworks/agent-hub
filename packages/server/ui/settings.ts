// The Settings dialog: a person's own settings (POST /api/settings). One so far: who writes their English voice
// messages as text.
import type { AgentSettings } from "@agent-bus/protocol";
import { postJson } from "./api";
import { dom } from "./dom";
import { errorText } from "./format";
import { h } from "./html";
import { state } from "./state";

type EnglishSpeech = NonNullable<AgentSettings["englishSpeech"]>;

const CHOICES: Array<[EnglishSpeech, string]> = [
  ["whisper", "Whisper large-v3-turbo — English: 4.9% wrong words, 1.5 s per recording"],
  ["liquid", "Liquid LFM3-Audio — English: 5.3% wrong words, 0.4 s per recording"],
];

function render(): void {
  const me = state.participants.find((p) => p.id === state.me);
  const head = h("div", "gpu-head");
  const close = h("button", "link-btn", "✕");
  close.type = "button";
  close.title = "Close (Esc)";
  close.addEventListener("click", () => dom.settingsDialog.close());
  head.append(h("h2", "", "Settings"), close);

  const select = h("select");
  for (const [value, label] of CHOICES) {
    const option = h("option", "", label);
    option.value = value;
    select.append(option);
  }
  select.value = me?.settings.englishSpeech ?? "whisper";
  const note = h("p", "dialog-hint", "");
  select.addEventListener("change", async () => {
    try {
      await postJson("/api/settings", { from: state.me, key: "englishSpeech", value: select.value });
      note.textContent = "Saved.";
    } catch (err) {
      note.textContent = errorText(err);
    }
  });
  dom.settingsDialog.replaceChildren(
    head,
    h("h3", "", "Voice messages in English are written by"),
    select,
    h(
      "p",
      "dialog-hint",
      "Whisper decides the language first; only English goes to the model chosen here. Every other language, Turkish " +
        "included, is always written by Whisper: on Turkish, Liquid gets 55% of the words wrong and Whisper 6%."
    ),
    h(
      "p",
      "dialog-hint",
      "Measured by compactor on CPU with FLEURS: English, 100 recordings (14 Nov); Turkish, 50 recordings (6 Nov, " +
        "with Whisper large-v3, the larger sibling of the turbo the bus runs). Lower is better."
    ),
    note
  );
}

dom.settingsBtn.addEventListener("click", () => {
  render();
  dom.settingsDialog.showModal();
});
