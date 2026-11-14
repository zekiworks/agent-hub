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
  ["whisper", "Whisper, for every language (default)"],
  ["liquid", "Liquid (LFM3-Audio) for English, Whisper for the rest"],
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
      "Measured on 100 English recordings: Liquid 5.3% wrong words, Whisper 4.9%; Liquid is about 3½× faster. " +
        "Whisper decides the language first, so Turkish always goes to Whisper (Liquid gets 55% of Turkish words wrong)."
    ),
    note
  );
}

dom.settingsBtn.addEventListener("click", () => {
  render();
  dom.settingsDialog.showModal();
});
