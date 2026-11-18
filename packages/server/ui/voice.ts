// Voice messages, as in WhatsApp: click 🎤 and the message box turns into a recording panel (🗑 delete, a red dot with
// the time, the moving waveform, ⏸ pause / ▶ resume); Send (or 🎤 again) sends it, Esc deletes it. Holding 🎤 and
// letting go also sends (letting go far from the button deletes). The recording goes up as an audio file; the bus's
// speech-to-text turns it into the message text, so agents (which cannot listen) read what was said. People see a
// player (attachments.ts).
import type { TranscriptResponse } from "@agent-bus/protocol";
import { api } from "./api";
import { hideError, showError, updateComposerState } from "./composer";
import { dom } from "./dom";
import { errorText, nameList } from "./format";
import { h } from "./html";
import { setIcon } from "./icons";
import { viewHash } from "./routing";
import { chosenNow, postToView, uploadFile, type Chosen } from "./send";
import { conversationTitle, state, type View } from "./state";

/** A press shorter than this is a click: recording goes on until Send. Longer: hold to talk, let go to send. */
const MIN_RECORDING_MS = 600;
/** Recordings stop (and send) by themselves after this much recorded time. */
const MAX_RECORDING_MS = 5 * 60_000;
/** Letting go farther than this outside the button deletes a held recording. */
const CANCEL_DISTANCE_PX = 60;
/** Recording formats in order of preference: Chrome/Firefox take webm/opus, Safari mp4/aac. */
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
/** The waveform gets one bar per this many ms of recording, newest on the right. */
const WAVE_STEP_MS = 60;
const WAVE_BAR_PX = 3;
const WAVE_GAP_PX = 2;

interface Recording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  startedAt: number;
  /** When it was paused, while paused. */
  pausedAt?: number;
  /** Paused time so far (not recorded). */
  pausedMs: number;
  audio: AudioContext;
  analyser: AnalyserNode;
  /** Loudness per WAVE_STEP_MS, 0–1. */
  levels: number[];
  lastLevelAt: number;
  frame: number;
  /** Where it goes: the conversation it was started in, even if another one is open by the time it is sent (codex-ui
   * #10593: it went to whatever was open at Send, after the asynchronous stop). */
  view: View;
  /** What it answers, a message or a checklist item, as chosen when it was started (codex-ui #10825, #11603): a reply
   * changed or cancelled meanwhile does not move it to another quote. */
  chosen: Chosen;
  /** The level meter has seen anything but exact silence (a shortcut: then the recording is not checked for silence). */
  heard: boolean;
  /** The microphone has sent something (or SIGNAL_WAIT_MS passed): the timer runs from here. */
  live: boolean;
}

/** "#room-a", "@@website", "logic, umit": where a recording started elsewhere will go. */
function viewLabel(view: View): string {
  if (view.kind === "draft") return view.project !== undefined ? `@@${view.project}` : nameList(view.to);
  const conv = state.conversations.get(view.id);
  return conv ? conversationTitle(conv) : "the conversation it started in";
}

/** Escape or 🎤 again while the microphone is still opening: the recording must not begin (codex-ui #10631). */
let startCancelled = false;

let recording: Recording | undefined;
/** The microphone is being opened (the permission prompt may be up). */
let opening = false;
/** The 🎤 button is pressed right now. */
let held = false;

/** Recorded time so far (pauses excluded). */
const recordedMs = (rec: Recording): number => (rec.pausedAt ?? Date.now()) - rec.startedAt - rec.pausedMs;

const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Click-started recording (not a hold): Send, or 🎤 again, sends it. */
function setLatched(on: boolean): void {
  state.voiceLatched = on;
  updateComposerState();
  dom.voiceHint.textContent = on ? "" : "let go to send";
}

function showStatus(text: string): void {
  dom.voiceBar.textContent = text;
  dom.voiceBar.hidden = false;
}

function hideStatus(): void {
  dom.voiceBar.hidden = true;
}

/** The recording panel takes the draft's place inside the box while recording; the microphone and Send stay (Can #11807). */
function showPanel(on: boolean): void {
  dom.voiceRec.hidden = !on;
  dom.inputWrap.classList.toggle("recording", on);
  dom.voiceBtn.classList.toggle("recording", on);
}

function drawWave(rec: Recording): void {
  const canvas = dom.voiceWave;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
  if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, width, height);
  g.fillStyle = getComputedStyle(canvas).color;
  const step = WAVE_BAR_PX + WAVE_GAP_PX;
  const bars = Math.floor(width / step);
  const shown = rec.levels.slice(-bars);
  shown.forEach((level, i) => {
    const h = Math.max(2, level * height);
    const x = width - (shown.length - i) * step;
    g.fillRect(x, (height - h) / 2, WAVE_BAR_PX, h);
  });
}

function tick(rec: Recording): void {
  if (recording !== rec) return;
  const now = Date.now();
  if (!rec.pausedAt && now - rec.lastLevelAt >= WAVE_STEP_MS) {
    const data = new Uint8Array(rec.analyser.fftSize);
    rec.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    // Speech sits around 0.02–0.2 RMS; scale so normal speaking fills most of the height.
    rec.levels.push(Math.min(1, Math.sqrt(sum / data.length) * 5));
    if (sum > 0) rec.heard = true;
    rec.lastLevelAt = now;
  }
  const elapsed = recordedMs(rec);
  if (elapsed >= MAX_RECORDING_MS) return void stop(false);
  // Until the microphone sends anything, "starting…" stands where the timer will run.
  const time = rec.live ? clock(elapsed) : "starting…";
  // Opened another conversation meanwhile: the bar says where this one goes.
  dom.voiceTime.textContent = viewHash(state.view) === viewHash(rec.view) ? time : `${time} → ${viewLabel(rec.view)}`;
  drawWave(rec);
  rec.frame = requestAnimationFrame(() => tick(rec));
}

async function start(): Promise<void> {
  if (recording || opening || state.sending || !state.me) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showError("This browser cannot record audio here (it needs https and microphone access).");
    return;
  }
  // Where it goes is decided at the tap, not after the permission prompt or the microphone's start-up (codex-ui #10622).
  const view = state.view;
  const chosen = chosenNow(view);
  hideError();
  hideStatus();
  opening = true;
  startCancelled = false;
  // The permission prompt, or a slow microphone, can take a moment: say so at once (Ümit #10669).
  showStatus("Opening the microphone… (Esc or 🎤 again cancels)");
  let rec: Recording;
  try {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      hideStatus();
      showError(microphoneError(err));
      return;
    }
    hideStatus();
    if (startCancelled) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const audio = new AudioContext();
    await audio.resume().catch(() => undefined);
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    audio.createMediaStreamSource(stream).connect(analyser);
    const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    rec = {
      recorder,
      stream,
      chunks: [],
      startedAt: Date.now(),
      pausedMs: 0,
      audio,
      analyser,
      levels: [],
      lastLevelAt: 0,
      frame: 0,
      view,
      chosen,
      heard: false,
      live: false,
    };
    const r = rec;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) r.chunks.push(event.data);
    });
    // Recording from the first moment, so no sound can be cut off; the silence before it costs nothing.
    recorder.start();
    recording = rec;
  } finally {
    opening = false;
  }
  // The panel (with 🗑 to cancel) shows at once; its timer starts with the first sound.
  setPaused(rec, false);
  showPanel(true);
  // Let go while the microphone was opening: that was a click, so keep recording until Send.
  setLatched(!held);
  tick(rec);
  await waitForSignal(rec);
  if (recording === rec) {
    rec.startedAt = Date.now();
    rec.pausedMs = 0;
    rec.live = true;
  }
}

/** Bluetooth headsets (AirPods) deliver exact silence for a moment after a page opens their microphone (Ümit's clips,
 * 16 Nov: every one began with 0.6–0.7 s of zeros, and the short ones lost most of what she said). The recorder runs
 * from the start; the timer, the cue to speak, starts once the microphone sends anything at all, or after
 * SIGNAL_WAIT_MS regardless. */
const SIGNAL_WAIT_MS = 3000;

async function waitForSignal(rec: Recording): Promise<void> {
  if (rec.audio.state !== "running") return;
  const data = new Uint8Array(rec.analyser.fftSize);
  const until = Date.now() + SIGNAL_WAIT_MS;
  while (Date.now() < until && recording === rec) {
    rec.analyser.getByteTimeDomainData(data);
    if (data.some((v) => v !== 128)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function setPaused(rec: Recording, paused: boolean): void {
  if (paused && !rec.pausedAt) {
    rec.recorder.pause();
    rec.pausedAt = Date.now();
  } else if (!paused && rec.pausedAt) {
    rec.recorder.resume();
    rec.pausedMs += Date.now() - rec.pausedAt;
    rec.pausedAt = undefined;
  }
  setIcon(dom.voicePause, paused ? "play" : "pause");
  dom.voicePause.title = paused ? "Go on recording" : "Pause";
  dom.voiceRec.classList.toggle("paused", paused);
}

/** Ends the recording; sends it unless `cancel` or it was too short to hold anything. */
async function stop(cancel: boolean): Promise<void> {
  const rec = recording;
  if (!rec) return;
  recording = undefined;
  cancelAnimationFrame(rec.frame);
  const duration = recordedMs(rec);
  setLatched(false);
  showPanel(false);
  const stopped = new Promise<void>((resolve) => rec.recorder.addEventListener("stop", () => resolve(), { once: true }));
  rec.recorder.stop();
  await stopped;
  for (const track of rec.stream.getTracks()) track.stop();
  void rec.audio.close();
  if (cancel) return;
  if (duration < MIN_RECORDING_MS) return showStatus("Too short: click 🎤, speak, then press Send.");
  const type = rec.recorder.mimeType || rec.chunks[0]?.type || "audio/webm";
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const stamp = new Date(rec.startedAt).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const file = new File(rec.chunks, `voice-${stamp}.${ext}`, { type: type.split(";")[0] });
  // Silence is judged from the recording itself, not the level meter (Ümit #10810: the meter can read nothing while
  // the recorder hears her, e.g. Safari). Even then the recording is kept: she can send it anyway or discard it.
  if (!rec.heard && (await recordingIsSilent(file))) return offerSilent(file, duration, rec.view, rec.chosen);
  await send(file, duration, rec.view, rec.chosen);
}

/**
 * True only when the recording decodes and no sample rises above −120 dBFS (Opus decodes digital silence to values
 * around 1e-34, not exact zeros); one that does not decode here counts as sound.
 */
async function recordingIsSilent(file: File): Promise<boolean> {
  try {
    const audio = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await file.arrayBuffer());
    for (let c = 0; c < audio.numberOfChannels; c++) if (audio.getChannelData(c).some((v) => Math.abs(v) > 1e-6)) return false;
    return true;
  } catch {
    return false;
  }
}

/** A silent recording: say so, keep it, and offer to send it anyway or discard it. */
function offerSilent(file: File, duration: number, view: View, chosen: Chosen): void {
  const again = h("button", "link-btn", "Send anyway");
  again.type = "button";
  const drop = h("button", "link-btn", "Discard");
  drop.type = "button";
  dom.voiceBar.replaceChildren(
    "The recording is silent (nothing reached the microphone). If you use AirPods or another headset, check it is the selected microphone. ",
    again,
    " · ",
    drop
  );
  dom.voiceBar.hidden = false;
  again.addEventListener("click", () => {
    hideStatus();
    void send(file, duration, view, chosen);
  });
  drop.addEventListener("click", hideStatus);
}

/** Sending failed: the recording is not lost; say why in plain words and offer it again (Ümit #12058). */
function offerResend(file: File, duration: number, view: View, chosen: Chosen, why: string): void {
  const again = h("button", "link-btn", "Send it again");
  again.type = "button";
  const drop = h("button", "link-btn", "Discard");
  drop.type = "button";
  dom.voiceBar.replaceChildren(`Your voice message (${clock(duration)}) was not sent: ${why} The recording is kept until you choose. `, again, " · ", drop);
  dom.voiceBar.hidden = false;
  again.addEventListener("click", () => {
    hideStatus();
    void send(file, duration, view, chosen);
  });
  drop.addEventListener("click", hideStatus);
}

/**
 * The recording's text from the bus, asked up to three times: an iPhone cancels a request while the page is in the
 * background, which showed as "no connection" though the bus was fine (Ümit #12058). Undefined: no text could be made.
 */
async function transcribe(fileId: string): Promise<string | undefined> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return (await api<TranscriptResponse>(`/api/files/${encodeURIComponent(fileId)}/transcript`, { method: "POST" })).text;
    } catch {
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  return undefined;
}

/** Why the microphone did not open, and what to do, in the person's terms rather than the browser's (Ümit #12058). */
function microphoneError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Nothing was recorded: the microphone is not allowed for this site. On the iPhone: aA (left of the address) → Website Settings → Microphone → Allow; elsewhere, the lock or site settings next to the address. Then tap the microphone again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "Nothing was recorded: this device has no microphone the page can use. If you use AirPods or a headset, check it is connected, then tap the microphone again.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "Nothing was recorded: the microphone is busy or would not start. Another app may be using it (a call, a video, another tab recording). Close that, then tap the microphone again.";
  }
  return `Nothing was recorded: the microphone did not open (${errorText(err)}). Tap the microphone again; if it keeps failing, reload the page.`;
}

async function send(file: File, duration: number, view: View, chosen: Chosen): Promise<void> {
  state.sending = true;
  dom.voiceBtn.disabled = true;
  updateComposerState();
  try {
    showStatus(`Sending the voice message (${clock(duration)})…`);
    const ref = await uploadFile(file);
    showStatus("Turning speech into text…");
    const said = await transcribe(ref.id);
    const text = said === undefined ? "🎤 (voice message: the recording only; its text could not be made)" : said ? `🎤 ${said}` : "🎤 (voice message: no speech recognized)";
    await postToView(view, text, [ref.id], chosen);
    if (said === undefined) {
      // Said in the person's terms, not as a connection error: the message did go out (Ümit #12058).
      hideStatus();
      showError("Your voice message was sent, but without its text: turning speech into text failed three times (the page was in the background, or the connection dropped). Agents get the recording, which few of them can play: if it matters, say it again or type it.");
      return;
    }
    if (viewHash(state.view) !== viewHash(view)) showStatus(`Voice message sent to ${viewLabel(view)}, where it was recorded.`);
    else hideStatus();
  } catch (err) {
    // "Nothing was lost: try again" is not true of a recording; the offer below says what is kept.
    const why = errorText(err).replace(/ Nothing was lost: try again in a moment\.$/, "").replace(/\.$/, "");
    offerResend(file, duration, view, chosen, `${why}.`);
  } finally {
    state.sending = false;
    dom.voiceBtn.disabled = false;
    updateComposerState();
  }
}

dom.voiceBtn.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault(); // no text selection or long-press menu on phones
  // 🎤 again during a click-started recording sends it.
  if (recording && state.voiceLatched) return void stop(false);
  // 🎤 again while the microphone is still starting cancels it.
  if (opening) {
    startCancelled = true;
    hideStatus();
    return;
  }
  dom.voiceBtn.setPointerCapture(event.pointerId);
  held = true;
  void start();
});

dom.voiceBtn.addEventListener("pointerup", (event) => {
  held = false;
  if (!recording || state.voiceLatched) return;
  // A short press was a click: keep recording until Send.
  if (recordedMs(recording) < MIN_RECORDING_MS) return setLatched(true);
  const box = dom.voiceBtn.getBoundingClientRect();
  const away =
    event.clientX < box.left - CANCEL_DISTANCE_PX ||
    event.clientX > box.right + CANCEL_DISTANCE_PX ||
    event.clientY < box.top - CANCEL_DISTANCE_PX ||
    event.clientY > box.bottom + CANCEL_DISTANCE_PX;
  void stop(away);
  // Not silently: a recording thrown away looks like one that failed to send (Ümit, 16 Nov).
  if (away) showStatus("Recording discarded: your finger let go away from 🎤. Tap 🎤 once, then ➤, to send without holding.");
});

dom.voiceBtn.addEventListener("pointercancel", () => {
  held = false;
  if (!state.voiceLatched) {
    void stop(true);
    showStatus("Recording discarded: the phone took the touch away. Tap 🎤 once, then ➤, to send without holding.");
  }
});
dom.voiceBtn.addEventListener("contextmenu", (event) => event.preventDefault());

dom.voiceDelete.addEventListener("click", () => void stop(true));
dom.voicePause.addEventListener("click", () => {
  if (recording) setPaused(recording, !recording.pausedAt);
});
setIcon(dom.voiceBtn, "mic");
setIcon(dom.voiceDelete, "trash");
setIcon(dom.voicePause, "pause");

// Send during a click-started recording sends the recording (capture: before send.ts sends the typed text).
dom.composer.addEventListener(
  "submit",
  (event) => {
    if (!recording || !state.voiceLatched) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void stop(false);
  },
  { capture: true }
);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (recording) {
    event.preventDefault();
    void stop(true);
  } else if (opening) {
    // Still starting (permission prompt, or waiting for the microphone): cancelled before it began (codex-ui #10631).
    event.preventDefault();
    startCancelled = true;
    hideStatus();
  }
});
