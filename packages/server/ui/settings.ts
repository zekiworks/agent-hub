// The Settings dialog: a person's own settings. On the bus (POST /api/settings): who writes their English voice
// messages as text. In this browser: whether the routing lines under messages show (#10096), and typing suggestions.
import type { AgentSettings } from "@agent-bus/protocol";
import { postJson } from "./api";
import { closeWindowButton } from "./dialogs";
import { dom } from "./dom";
import { errorText } from "./format";
import { h } from "./html";
import { state } from "./state";
import { setSuggestionsOn, suggestionBox, suggestionsOn } from "./suggest";
import { autoSendMs, chosenMicrophone, microphones, setAutoSendMs, setChosenMicrophone } from "./voice";
import { pushState, testPush, turnPushOff, turnPushOn, type PushState } from "./push";
import { setThreadsOn, threadsOn } from "./threads";
import { hooks } from "./hooks";

type EnglishSpeech = NonNullable<AgentSettings["englishSpeech"]>;

const CHOICES: Array<[EnglishSpeech, string]> = [
  ["whisper", "Whisper large-v3-turbo — English: 4.9% wrong words, 1.5 s per recording"],
  ["liquid", "Liquid LFM3-Audio — English: 5.3% wrong words, 0.4 s per recording"],
];

function render(): void {
  const me = state.participants.find((p) => p.id === state.me);
  const head = h("div", "gpu-head");
  const close = h("button", "link-btn dialog-x", "✕");
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
    notificationsSetting(),
    decisionModelsSetting(me?.settings.needsInbox),
    voiceLanguageSetting(me?.settings.voiceLanguage),
    h("h3", "", "Voice messages in English are written by"),
    select,
    h(
      "p",
      "dialog-hint",
      "Whisper detects the language first; only English goes to the model chosen here, and every other language stays " +
        "with Whisper. Wrong words and time per recording were measured on CPU (FLEURS, 100 English recordings); " +
        "lower is better."
    ),
    note,
    voiceRecordingSetting(),
    routingSetting(),
    suggestionSetting(),
    closeWindowButton(dom.settingsDialog)
  );
}

/** Account-wide opt-in for judging Inbox messages and collecting explicit usefulness labels (Ümit #16320). */
function decisionModelsSetting(current: boolean | undefined): HTMLElement | string {
  if (!Object.values(state.boxes).includes("needs")) return "";
  const box = h("input");
  box.type = "checkbox";
  box.checked = current !== false;
  const note = h("p", "dialog-hint", "");
  box.addEventListener("change", async () => {
    box.disabled = true;
    try {
      await postJson("/api/settings", { from: state.me, key: "needsInbox", value: box.checked });
      note.textContent = box.checked
        ? "On: decision models judge relevant agent messages; your green/red choices become training examples."
        : "Off: messages are not judged for you and decision-model choices leave your Inbox.";
    } catch (error) {
      box.checked = !box.checked;
      note.textContent = errorText(error);
    } finally {
      box.disabled = false;
    }
  });
  const label = h("label", "settings-check");
  label.append(box, " Decision models for my Inbox");
  const section = h("div");
  section.append(
    h("h3", "", "Decision models"),
    label,
    h(
      "p",
      "dialog-hint",
      "On: show ✓, ✓✓ or ✕ predictions and let me label selected and rejected messages. Labels are collected for a " +
        "reviewed fine-tuning run; they do not retrain the live models immediately."
    ),
    note
  );
  return section;
}


/** The language of my voice messages (codex-ui #10803): only mine change; the bus's rule is the default. */
function voiceLanguageSetting(current: AgentSettings["voiceLanguage"]): HTMLElement {
  const select = h("select");
  for (const [value, label] of [
    ["default", "The Hub's default language (set by whoever runs it)"],
    ["en", "English"],
    ["tr", "Turkish"],
    ["auto", "Detect for each message"],
  ] as const) {
    const option = h("option", "", label);
    option.value = value;
    select.append(option);
  }
  select.value = current ?? "default";
  const note = h("p", "dialog-hint", "Short messages are where automatic detection guesses wrong most; setting your language avoids that.");
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

/**
 * Notifications on this device while Agent Hub is closed (Ümit #13927, #13934): DMs, messages that name me, replies to
 * my messages; a banner on the iPhone once Agent Hub is on the Home Screen.
 */
function notificationsSetting(): HTMLElement {
  const section = h("div");
  const line = h("p", "dialog-hint", "");
  const on = h("button", "link-btn", "Turn on");
  const off = h("button", "link-btn", "Turn off");
  const test = h("button", "link-btn", "Send me a test");
  for (const b of [on, off, test]) b.type = "button";
  const buttons = h("p", "");
  const TEXT: Record<PushState, string> = {
    unsupported: "This browser can't take notifications from Agent Hub here (it needs https and a newer browser).",
    "home-screen-first":
      "On the iPhone: Share (the square with the arrow) → Add to Home Screen, then open Agent Hub from that icon " +
      "and turn them on here. Safari itself can't take them.",
    denied: "Notifications are blocked for this site: allow them in the browser's (or the iPhone's) settings for Agent Hub, then come back.",
    off: "Off on this device.",
    on: "On for this device: a banner when a message needs you, even with Agent Hub closed.",
  };
  const show = (state: PushState, note = ""): void => {
    line.textContent = `${TEXT[state]}${note ? ` ${note}` : ""}`;
    buttons.replaceChildren(...(state === "off" ? [on] : state === "on" ? [test, " · ", off] : []));
  };
  on.addEventListener("click", () => {
    // The permission is asked from inside the click: an iPhone allows it only then.
    turnPushOn().then(
      (state) => show(state),
      (err) => show("off", `It didn't work: ${errorText(err)}`)
    );
  });
  off.addEventListener("click", () => void turnPushOff().then(() => show("off")));
  test.addEventListener("click", () => {
    testPush().then(
      () => show("on", "Sent: it should show in a moment."),
      (err) => show("on", `The test failed: ${errorText(err)}`)
    );
  });
  void pushState().then((state) => show(state));
  section.append(
    h("h3", "", "Notifications on this device"),
    line,
    buttons,
    h(
      "p",
      "dialog-hint",
      "For DMs, messages that name you, and replies to your messages; a conversation whose 🔔 is set to none stays " +
        "quiet. The text goes encrypted through the phone's or browser's push service (Apple, Google, Mozilla)."
    )
  );
  return section;
}

/** Which microphone 🎤 uses (Can #13887) and whether a pause sends the recording (Can #13890, #13892); this browser only. */
function voiceRecordingSetting(): HTMLElement {
  const mic = h("select");
  const micNote = h("p", "dialog-hint", "");
  const fill = async (): Promise<void> => {
    const devices = await microphones().catch(() => [] as MediaDeviceInfo[]);
    const chosen = chosenMicrophone();
    const options = [["", "The browser's default"] as [string, string]];
    devices.forEach((d, i) => {
      if (d.deviceId && d.deviceId !== "default") options.push([d.deviceId, d.label || `Microphone ${i + 1}`]);
    });
    if (chosen && !options.some(([id]) => id === chosen)) options.push([chosen, "The one chosen before (not connected now)"]);
    mic.replaceChildren(
      ...options.map(([id, label]) => {
        const option = h("option", "", label);
        option.value = id;
        return option;
      })
    );
    mic.value = chosen;
    micNote.textContent = devices.some((d) => d.label)
      ? "If the chosen one is not connected, the default records instead, and the recording bar says which one it uses."
      : "Microphone names show once this page has used the microphone (record with 🎤 once, then open Settings again).";
  };
  void fill();
  mic.addEventListener("change", () => setChosenMicrophone(mic.value));

  const pause = h("select");
  for (const [ms, label] of [
    [0, "Off: Send (or 🎤 again) sends it"],
    [500, "After a pause of half a second"],
    [1000, "After a pause of 1 second"],
    [2000, "After a pause of 2 seconds"],
  ] as const) {
    const option = h("option", "", label);
    option.value = String(ms);
    pause.append(option);
  }
  pause.value = String(autoSendMs());
  if (pause.value === "") pause.value = "0";
  pause.addEventListener("change", () => setAutoSendMs(Number(pause.value)));

  const section = h("div");
  section.append(
    h("h3", "", "Microphone"),
    mic,
    micNote,
    h("h3", "", "Send a voice message when I stop talking"),
    pause,
    h(
      "p",
      "dialog-hint",
      "When a delay is chosen, a pause longer than it sends what you said so far. It applies to a recording started " +
        "with a tap on 🎤 (holding 🎤 sends when you let go), and only after you have said something; ⏸ stops it while " +
        "you think. Only this browser."
    )
  );
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
    ),
    threadsSetting()
  );
  return section;
}

/** Threads (Can #14203): reply chains as child conversations of the room; this browser only. */
function threadsSetting(): HTMLElement {
  const box = h("input");
  box.type = "checkbox";
  box.checked = threadsOn();
  box.addEventListener("change", () => {
    setThreadsOn(box.checked);
    // The room as it is shown changes now; an open thread closes when they go off.
    if (!box.checked && state.thread !== undefined && state.view.kind === "conversation") location.hash = `#/c/${encodeURIComponent(state.view.id)}`;
    else hooks.applyView(state.view);
  });
  const label = h("label", "settings-check");
  label.append(box, " Threads: show reply chains as threads of the room");
  const wrap = h("div");
  wrap.append(
    label,
    h(
      "p",
      "dialog-hint",
      "A message with replies shows \"↳ 3 replies\" in the room; a click opens the chain on its own, under a way back to " +
        "the room (or Esc). Writing there answers the chain. Built from the messages the page has loaded. Only this browser."
    )
  );
  return wrap;
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
    ? " The next words come from a small model on the Hub's own computer: your draft and the conversation's latest " +
      "messages go to it, and nothing is kept (English only)."
    : "";
  const section = h("div", "");
  section.append(
    h("h3", "", "Typing"),
    label,
    h(
      "p",
      "dialog-hint",
      // "The rest of the word" undersold it once the Hub suggests whole phrases (demo review D2).
      "As you type, a suggestion appears in grey after the cursor: Tab adds it, → (or Ctrl+→) one word at a time " +
        "(on a phone, tap it in the row of buttons, or × to dismiss it). Escape drops it, and typing something else " +
        "makes it go. Enter still sends what you typed. The rest of the word being typed comes from English and " +
        "Turkish word lists (Turkish also typed without ç ğ ı ö ş ü) " +
        `and from the conversation itself, inside this page.${model} Only this browser.`
    )
  );
  return section;
}



dom.settingsBtn.addEventListener("click", () => {
  render();
  dom.settingsDialog.showModal();
});
