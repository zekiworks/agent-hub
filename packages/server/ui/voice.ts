// Voice messages: click 🎤 once to record and again to send, or hold it and let go to send (as in WhatsApp); Esc, or
// letting go far from the button, cancels. The recording goes up as an audio file; the bus's speech-to-text turns it
// into the message text, so agents (which cannot listen) read what was said. People see a player (attachments.ts).
import type { TranscriptResponse } from "@agent-bus/protocol";
import { api } from "./api";
import { hideError, showError, updateComposerState } from "./composer";
import { dom } from "./dom";
import { errorText } from "./format";
import { postToView, uploadFile } from "./send";
import { state } from "./state";

/** A press shorter than this is a click: recording goes on until the next click. Longer: hold to talk. */
const MIN_RECORDING_MS = 600;
/** Recordings stop (and send) by themselves after this long. */
const MAX_RECORDING_MS = 5 * 60_000;
/** Releasing farther than this outside the button cancels. */
const CANCEL_DISTANCE_PX = 60;
/** Recording formats in order of preference: Chrome/Firefox take webm/opus, Safari mp4/aac. */
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

interface Recording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  startedAt: number;
  ticker: Timer;
}

let recording: Recording | undefined;
/** The microphone is being opened (the permission prompt may be up). */
let opening = false;
/** The 🎤 button is pressed right now. */
let held = false;
const RECORDING_HINT_HOLD = "Recording — let go to send, slide away or Esc to cancel";
const RECORDING_HINT_CLICK = "Recording — click Send (or 🎤 again) to send, Esc to cancel";

/** Recording after a click (not a hold): the next click on 🎤, or Send, sends it. */
function setLatched(on: boolean): void {
  state.voiceLatched = on;
  updateComposerState();
}

function showBar(text: string, recordingNow = false): void {
  dom.voiceBar.textContent = text;
  dom.voiceBar.classList.toggle("recording", recordingNow);
  dom.voiceBar.hidden = false;
}

function hideBar(): void {
  dom.voiceBar.hidden = true;
  dom.voiceBar.classList.remove("recording");
}

const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

async function start(): Promise<void> {
  if (recording || opening || state.sending || !state.me) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showError("This browser cannot record audio here (it needs https and microphone access).");
    return;
  }
  hideError();
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
  const startedAt = Date.now();
  const rec: Recording = {
    recorder,
    stream,
    chunks: [],
    startedAt,
    ticker: setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= MAX_RECORDING_MS) return void stop(false);
      showBar(`● ${clock(elapsed)}  ${state.voiceLatched ? RECORDING_HINT_CLICK : RECORDING_HINT_HOLD}`, true);
    }, 250),
  };
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) rec.chunks.push(event.data);
  });
  recording = rec;
  recorder.start();
  dom.voiceBtn.classList.add("recording");
  // Let go while the microphone was opening: that was a click, so keep recording until the next one.
  setLatched(!held);
  showBar(`● 0:00  ${state.voiceLatched ? RECORDING_HINT_CLICK : RECORDING_HINT_HOLD}`, true);
}

/** Ends the recording; sends it unless `cancel` or it was too short to hold anything. */
async function stop(cancel: boolean): Promise<void> {
  const rec = recording;
  if (!rec) return;
  recording = undefined;
  setLatched(false);
  clearInterval(rec.ticker);
  dom.voiceBtn.classList.remove("recording");
  const stopped = new Promise<void>((resolve) => rec.recorder.addEventListener("stop", () => resolve(), { once: true }));
  rec.recorder.stop();
  await stopped;
  for (const track of rec.stream.getTracks()) track.stop();
  const duration = Date.now() - rec.startedAt;
  if (cancel) return hideBar();
  if (duration < MIN_RECORDING_MS) return showBar("Too short: click 🎤, speak, and click it again to send.");
  const type = rec.recorder.mimeType || rec.chunks[0]?.type || "audio/webm";
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const stamp = new Date(rec.startedAt).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  await send(new File(rec.chunks, `voice-${stamp}.${ext}`, { type: type.split(";")[0] }), duration);
}

async function send(file: File, duration: number): Promise<void> {
  const view = state.view;
  state.sending = true;
  dom.voiceBtn.disabled = true;
  try {
    showBar(`Sending the voice message (${clock(duration)})…`);
    const ref = await uploadFile(file);
    showBar("Turning speech into text…");
    let text: string;
    try {
      const said = await api<TranscriptResponse>(`/api/files/${encodeURIComponent(ref.id)}/transcript`, { method: "POST" });
      text = said.text ? `🎤 ${said.text}` : "🎤 (voice message: no speech recognized)";
    } catch (err) {
      // The voice still goes out; agents get only the file.
      text = `🎤 (voice message; no text: ${errorText(err)})`;
    }
    await postToView(view, text, [ref.id]);
    hideBar();
  } catch (err) {
    hideBar();
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
  // The second click of a click-started recording sends it.
  if (recording && state.voiceLatched) return void stop(false);
  dom.voiceBtn.setPointerCapture(event.pointerId);
  held = true;
  void start();
});

dom.voiceBtn.addEventListener("pointerup", (event) => {
  held = false;
  if (!recording || state.voiceLatched) return;
  // A short press was a click: keep recording until the next click.
  if (Date.now() - recording.startedAt < MIN_RECORDING_MS) {
    setLatched(true);
    showBar(`● 0:00  ${RECORDING_HINT_CLICK}`, true);
    return;
  }
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

// Send while a click-started recording runs sends the recording (capture: before send.ts sends the typed text).
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
