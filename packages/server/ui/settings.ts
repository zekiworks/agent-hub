// The Settings dialog: a person's own settings. On the bus (POST /api/settings): who writes their English voice
// messages as text. In this browser: whether the routing lines under messages show (#10096), and typing suggestions.
import { BOX_REPORT_OUTCOMES, type AgentSettings, type BoxReportOutcome, type BoxUsage } from "@agent-bus/protocol";
import { api, postJson } from "./api";
import { closeWindowButton } from "./dialogs";
import { dom } from "./dom";
import { errorText } from "./format";
import { h } from "./html";
import { state } from "./state";
import { setSuggestionsOn, suggestionBox, suggestionsOn } from "./suggest";
import { askAgentOn, recipientBox, setAskAgentOn } from "./ask";

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
      "Measured by compactor on CPU with FLEURS: English, 100 recordings (14 Nov); Turkish, 50 recordings (6 Nov, " +
        "with Whisper large-v3, the larger sibling of the turbo the bus runs). Lower is better."
    ),
    note,
    routingSetting(),
    suggestionSetting(),
    askAgentSetting(),
    closeWindowButton(dom.settingsDialog)
  );
}

/** The language of my voice messages (codex-ui #10803): only mine change; the bus's rule is the default. */
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

/** Whether "✓ · woke compactor" lines show under every message (on), or only when something is wrong or on hover. */
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

/**
 * Typing suggestions (Can #12841–#12853): the word being typed, from word lists in the page (Can #12953, #12955),
 * and the next words when the bus has a "complete" box extension; off until turned on.
 */
function suggestionSetting(): HTMLElement {
  const box = h("input");
  box.type = "checkbox";
  box.checked = suggestionsOn();
  box.addEventListener("change", () => setSuggestionsOn(box.checked));
  const label = h("label", "settings-check");
  label.append(box, " Suggest how to go on while I type");
  const model = suggestionBox()
    ? " The next words come from a small model on the bus's own machine: your draft and the conversation's latest " +
      "messages go to it, and nothing is kept (English only)."
    : "";
  const section = h("div", "");
  section.append(
    h("h3", "", "Typing"),
    label,
    h(
      "p",
      "dialog-hint",
      "As you type, the rest of the word appears in grey after the cursor: Tab adds it, → (or Ctrl+→) one word at a " +
        "time (on a phone, tap the word in the row of buttons). Escape drops it, and typing other letters makes it go. Enter still " +
        "sends what you typed. Words come from English and Turkish word lists (Turkish also typed without ç ğ ı ö ş ü) " +
        `and from the conversation itself, inside this page.${model} Only this browser.`
    )
  );
  return section;
}

/** "Ask @agent" (Ümit #13030, #13222): an add-on, shown when the bus has a "recipient" box extension; off until turned on. */
function askAgentSetting(): HTMLElement | string {
  const name = recipientBox();
  if (!name) return "";
  const box = h("input");
  box.type = "checkbox";
  box.checked = askAgentOn();
  box.addEventListener("change", () => setAskAgentOn(box.checked));
  const label = h("label", "settings-check");
  label.append(box, " Suggest which agent to ask (Ask @agent)");
  const section = h("div", "");
  section.append(
    h("h3", "", "Ask @agent"),
    label,
    h(
      "p",
      "dialog-hint",
      "In a room, when you write without naming anyone, a button like \"Ask @webapp\" may appear next to 📎: the agent " +
        "that, by what the room shows (who reported what, who owns which checklist step), can best answer you. A tap puts " +
        "the @name in front of your message; you still send it. Liquid AI's d1-2B decides, on the bus's own machine; " +
        "your draft and the room's latest messages go to it and are not kept. The hub counts, per message you send, " +
        "whom it offered and whether you took it (never the text); you can share those counts below. Only this browser."
    ),
    shareUsage(name)
  );
  return section;
}

/**
 * Where "Share my Ask @agent counts" opens a new issue (Ümit #13513): the public repository people install Agent Hub
 * from. Change it here if the repository moves or becomes private.
 */
const SHARE_REPO_URL = "https://github.com/zekiworks/agent-hub";

const OUTCOME_LABELS: Record<BoxReportOutcome, string> = {
  taken: "taken: sent to the offered agent",
  ignored: "ignored: offered, sent naming nobody",
  "named-other": "named-other: offered, someone else named",
  named: "named: nothing offered, someone named",
  quiet: "quiet: nothing offered, nobody named",
  reply: "reply: a Reply or checklist answer",
};

const SHARE_INTRO = "My Ask @agent counts, shared from Agent Hub's Settings. Counts only: no conversation ids, names or message text.";

/** The summary as rows: the table the person reads and the issue's Markdown come from these, so they cannot differ. */
function usageRows(usage: BoxUsage): Array<[string, string]> {
  const { answerMs, takenShare } = usage;
  return [
    ["Agent Hub version", usage.version],
    ["Days (UTC)", `${usage.firstDay} – ${usage.lastDay}`],
    ["Messages sent with Ask @agent on", String(usage.messages)],
    ...BOX_REPORT_OUTCOMES.map((o): [string, string] => [OUTCOME_LABELS[o], String(usage.outcomes[o])]),
    ["Offered, then taken", takenShare === null ? "nothing offered" : `${usage.outcomes.taken} of ${usage.offered} (${Math.round(100 * takenShare)}%)`],
    ["Answer time in the page", answerMs ? `median ${answerMs.median} ms, p90 ${answerMs.p90} ms (${answerMs.answers} answers)` : "none timed"],
    ["Asking failed before", `${usage.failed} of ${usage.messages} messages`],
  ];
}

/**
 * Sharing my Ask @agent counts with the Agent Hub team (Ümit #13513): the first button shows exactly what would go;
 * the second opens a new GitHub issue with it filled in, where the person can still edit it and decides to submit.
 * Nothing leaves the hub otherwise. Two clicks also keep `window.open` in a click of its own (Safari blocks it after
 * waiting for the counts).
 */
function shareUsage(name: string): HTMLElement {
  const section = h("div");
  const show = h("button", "btn", "Share my Ask @agent counts with the Agent Hub team");
  show.type = "button";
  const preview = h("div");
  show.addEventListener("click", async () => {
    let usage: BoxUsage;
    try {
      usage = await api<BoxUsage>(`/api/box/${encodeURIComponent(name)}/usage`);
    } catch (err) {
      preview.replaceChildren(h("p", "dialog-hint", errorText(err)));
      return;
    }
    if (usage.messages === 0) {
      preview.replaceChildren(h("p", "dialog-hint", "No messages sent with Ask @agent on yet: nothing to share."));
      return;
    }
    const rows = usageRows(usage);
    const table = h("table", "stats-table");
    for (const [what, value] of rows) {
      const tr = h("tr");
      tr.append(h("td", "", what), h("td", "num", value));
      table.append(tr);
    }
    const body = [SHARE_INTRO, "", "| | |", "|---|---|", ...rows.map(([what, value]) => `| ${what} | ${value} |`)].join("\n");
    const url = `${SHARE_REPO_URL}/issues/new?${new URLSearchParams({ title: "Ask @agent counts", body })}`;
    const open = h("button", "btn btn-primary", "Open a GitHub issue with this");
    open.type = "button";
    open.addEventListener("click", () => window.open(url, "_blank", "noopener"));
    preview.replaceChildren(
      h("p", "dialog-hint", SHARE_INTRO),
      table,
      open,
      h("p", "dialog-hint", "GitHub shows the issue before it is posted: you can change or remove anything, or not submit it.")
    );
  });
  section.append(show, preview);
  return section;
}

dom.settingsBtn.addEventListener("click", () => {
  render();
  dom.settingsDialog.showModal();
});
