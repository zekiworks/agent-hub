// The Settings dialog: a person's own settings. On the bus (POST /api/settings): who writes their English voice
// messages as text. In this browser: whether the routing lines under messages show, and typing suggestions.
import type { AgentSettings } from "@agent-bus/protocol";
import { postJson } from "./api";
import { closeWindowButton } from "./dialogs";
import { dom } from "./dom";
import { errorText } from "./format";
import { h } from "./html";
import { state } from "./state";
import { setSuggestionsOn, suggestionBox, suggestionsOn } from "./suggest";

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
    voiceLanguageSetting(me?.settings.voiceLanguage),
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
      "Measured on CPU with FLEURS: English, 100 recordings (14 Nov); Turkish, 50 recordings (6 Nov, " +
        "with Whisper large-v3, the larger sibling of the turbo the bus runs). Lower is better."
    ),
    note,
    routingSetting(),
    suggestionSetting(),
    closeWindowButton(dom.settingsDialog)
  );
}

/** The language of my voice messages: only mine change; the bus's rule is the default. */
function voiceLanguageSetting(current: AgentSettings["voiceLanguage"]): HTMLElement {
  const select = h("select");
  for (const [value, label] of [
    ["default", "Turkish, unless clearly English (the bus's rule)"],
    ["en", "English"],
    ["tr", "Turkish"],
    ["auto", "Detect for each message"],
  ] as const) {
    const option = h("option", "", label);
    option.value = value;
    select.append(option);
  }
  select.value = current ?? "default";
  const note = h("p", "dialog-hint", "Short messages are where the rule guesses wrong most; setting your language avoids that.");
  select.addEventListener("change", async () => {
    try {
      await postJson("/api/settings", { from: state.me, key: "voiceLanguage", value: select.value });
      note.textContent = "Saved: your next voice message uses it.";
    } catch (err) {
      note.textContent = errorText(err);
    }
  });
  const section = h("div");
  section.append(h("h3", "", "My voice messages are in"), select, note);
  return section;
}

/** Whether "✓ · woke builder" lines show under every message (on), or only when something is wrong or on hover. */
const ROUTING_KEY = "agent-bus.showRouting";
function applyRouting(): void {
  dom.app.classList.toggle("routing-hidden", localStorage.getItem(ROUTING_KEY) === "0");
}
applyRouting();

function routingSetting(): HTMLElement {
  const box = h("input");
  box.type = "checkbox";
  box.checked = localStorage.getItem(ROUTING_KEY) !== "0";
  box.addEventListener("change", () => {
    localStorage.setItem(ROUTING_KEY, box.checked ? "1" : "0");
    applyRouting();
  });
  const label = h("label", "settings-check");
  label.append(box, " Show routing details under messages (✓ delivered, who it woke)");
  const section = h("div", "");
  section.append(
    h("h3", "", "Messages"),
    label,
    h(
      "p",
      "dialog-hint",
      "Off: those lines appear when you hover or tap a message. Messages still waiting, held or expired always show " +
        "theirs. Only this browser; nothing changes for who gets or is woken by a message."
    )
  );
  return section;
}

/** Typing suggestions, when the bus has a "complete" box extension; off until turned on. */
function suggestionSetting(): HTMLElement | string {
  if (!suggestionBox()) return "";
  const box = h("input");
  box.type = "checkbox";
  box.checked = suggestionsOn();
  box.addEventListener("change", () => setSuggestionsOn(box.checked));
  const label = h("label", "settings-check");
  label.append(box, " Suggest how to go on while I type");
  const section = h("div", "");
  section.append(
    h("h3", "", "Typing"),
    label,
    h(
      "p",
      "dialog-hint",
      "As you type, a few grey words appear after the cursor: Tab adds them, → (or Ctrl+→) only the next word (on a " +
        "phone, tap them under the text). Escape drops them, and typing other letters makes them go. Enter " +
        "still sends what you typed. Your draft and the conversation's latest " +
        "messages go to a small model on the bus's own machine, and nothing is kept. English only. Only this browser."
    )
  );
  return section;
}

dom.settingsBtn.addEventListener("click", () => {
  render();
  dom.settingsDialog.showModal();
});
