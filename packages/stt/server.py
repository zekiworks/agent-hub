"""Speech to text for the bus's voice messages: POST /transcribe with the audio as the body, get JSON back.

faster-whisper large-v3-turbo (int8, CPU), loaded once. Audio in any format PyAV decodes (the browser's
webm/opus, Safari's mp4/aac, wav, mp3, ...). Listens on loopback only: the bus server is its one client.

    {"text": "...", "language": "tr", "duration": 4.2}
"""

import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import av
import numpy as np
from faster_whisper import WhisperModel

MODEL = os.environ.get("STT_MODEL", "mobiuslabsgmbh/faster-whisper-large-v3-turbo")
HOST = os.environ.get("STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("STT_PORT", "7810"))
THREADS = int(os.environ.get("STT_THREADS", "16"))
MAX_BYTES = 50 * 1024 * 1024
# The languages people speak on this bus, the usual one first. Whisper's own guess hears short Turkish clips as
# English or Icelandic, so the first language is used unless Whisper is near-certain of another one in the list.
# Empty: any language, Whisper's guess.
LANGUAGES = [code for code in os.environ.get("STT_LANGUAGES", "tr,en").split(",") if code]
OTHER_LANGUAGE_MIN = 0.85
# What Whisper writes for a moment of noise or silence (learned from subtitled videos), with full confidence, so
# segment scores cannot catch it. A transcript that is only one of these is no speech.
SILENCE_PHRASES = {
    "altyazı m.k.",
    "altyazı m.k",
    "izlediğiniz için teşekkür ederim.",
    "izlediğiniz için teşekkürler.",
    "abone olmayı unutmayın.",
    "thank you for watching.",
    "thanks for watching!",
    "thank you.",
    "subtitles by the amara.org community",
}

model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS)
# One transcription at a time: the model uses all its threads for each.
lock = threading.Lock()


def decode(audio: bytes) -> np.ndarray:
    """16 kHz mono float32 samples. faster-whisper's own decoder passes an option newer PyAV no longer takes."""
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    chunks = []
    with av.open(io.BytesIO(audio)) as container:
        if not container.streams.audio:
            raise ValueError("the file has no audio stream")
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        raise ValueError("no audio in the file")
    return np.concatenate(chunks).astype(np.float32) / 32768.0


class Handler(BaseHTTPRequestHandler):
    def reply(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            return self.reply(200, {"ok": True, "model": MODEL})
        self.reply(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path.split("?")[0] != "/transcribe":
            return self.reply(404, {"error": "not found"})
        size = int(self.headers.get("Content-Length") or 0)
        if size <= 0 or size > MAX_BYTES:
            return self.reply(400, {"error": f"body must be 1 byte to {MAX_BYTES} bytes of audio"})
        audio = self.rfile.read(size)
        started = time.monotonic()
        try:
            samples = decode(audio)
            with lock:
                language = None
                if LANGUAGES:
                    _, _, probabilities = model.detect_language(samples, vad_filter=True)
                    scores = dict(probabilities)
                    other = max(LANGUAGES[1:], key=lambda code: scores.get(code, 0.0), default=None)
                    language = other if other and scores.get(other, 0.0) >= OTHER_LANGUAGE_MIN else LANGUAGES[0]
                segments, info = model.transcribe(samples, language=language, vad_filter=True, beam_size=5)
                text = " ".join(s.text.strip() for s in segments).strip()
                if text.lower() in SILENCE_PHRASES:
                    text = ""
        except Exception as error:  # undecodable audio and the like: the caller sends the voice message without text
            return self.reply(422, {"error": f"could not transcribe: {error}"})
        print(f"transcribed {info.duration:.1f}s ({info.language}) in {time.monotonic() - started:.1f}s", file=sys.stderr, flush=True)
        self.reply(200, {"text": text, "language": info.language, "duration": round(info.duration, 2)})

    def log_message(self, format: str, *args) -> None:  # the journal gets one line per transcription instead
        pass


if __name__ == "__main__":
    print(f"stt: {MODEL} on http://{HOST}:{PORT}", file=sys.stderr, flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
