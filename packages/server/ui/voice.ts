// Voice messages, as in WhatsApp: click 🎤 and the message box turns into a recording panel (🗑 delete, a red dot with
// the time, the moving waveform, ⏸ pause / ▶ resume); Send (or 🎤 again) sends it, Esc deletes it. Holding 🎤 and
// letting go also sends (letting go far from the button deletes). The recording goes up as an audio file; the bus's
// speech-to-text turns it into the message text, so agents (which cannot listen) read what was said. People see a
// player (attachments.ts).
import type { TranscriptResponse } from "@agent-bus/protocol";
import { api } from "./api";
import { hideError, showError, updateComposerState } from "./composer";
import { dom } from "./dom";
import { errorText } from "./format";
import { postToView, uploadFile } from "./send";
import { state } from "./state";

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
}

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

/** The recording panel takes the text box's place while recording. */
function showPanel(on: boolean): void {
  dom.voiceRec.hidden = !on;
  dom.inputWrap.hidden = on;
  dom.attachBtn.hidden = on;
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
    rec.lastLevelAt = now;
  }
  const elapsed = recordedMs(rec);
  if (elapsed >= MAX_RECORDING_MS) return void stop(false);
  dom.voiceTime.textContent = clock(elapsed);
  drawWave(rec);
  rec.frame = requestAnimationFrame(() => tick(rec));
}

async function start(): Promise<void> {
  if (recording || opening || state.sending || !state.me) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showError("This browser cannot record audio here (it needs https and microphone access).");
    return;
  }
  hideError();
  hideStatus();
  opening = true;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showError(`No microphone: ${errorText(err)}`);
    return;
  } finally {
    opening = false;
  }
  const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const audio = new AudioContext();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 1024;
  audio.createMediaStreamSource(stream).connect(analyser);
  const rec: Recording = {
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
  };
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) rec.chunks.push(event.data);
  });
  recording = rec;
  recorder.start();
  setPaused(rec, false);
  showPanel(true);
  // Let go while the microphone was opening: that was a click, so keep recording until Send.
  setLatched(!held);
  tick(rec);
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
  dom.voicePause.textContent = paused ? "▶" : "⏸";
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
  await send(new File(rec.chunks, `voice-${stamp}.${ext}`, { type: type.split(";")[0] }), duration);
}

async function send(file: File, duration: number): Promise<void> {
  const view = state.view;
  state.sending = true;
  dom.voiceBtn.disabled = true;
  updateComposerState();
  try {
    showStatus(`Sending the voice message (${clock(duration)})…`);
    const ref = await uploadFile(file);
    showStatus("Turning speech into text…");
    let text: string;
    try {
      const said = await api<TranscriptResponse>(`/api/files/${encodeURIComponent(ref.id)}/transcript`, { method: "POST" });
      text = said.text ? `🎤 ${said.text}` : "🎤 (voice message: no speech recognized)";
    } catch (err) {
      // The voice still goes out; agents get only the file.
      text = `🎤 (voice message; no text: ${errorText(err)})`;
    }
    await postToView(view, text, [ref.id]);
    hideStatus();
  } catch (err) {
    hideStatus();
    showError(`Voice message not sent: ${errorText(err)}`);
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
});

dom.voiceBtn.addEventListener("pointercancel", () => {
  held = false;
  if (!state.voiceLatched) void stop(true);
});
dom.voiceBtn.addEventListener("contextmenu", (event) => event.preventDefault());

dom.voiceDelete.addEventListener("click", () => void stop(true));
dom.voicePause.addEventListener("click", () => {
  if (recording) setPaused(recording, !recording.pausedAt);
});

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
  if (event.key === "Escape" && recording) {
    event.preventDefault();
    void stop(true);
  }
});
