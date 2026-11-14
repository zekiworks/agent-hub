// ▶ next to ↩ Reply: the message read aloud by the bus's text-to-speech server (POST /api/speech: LFM3-Audio on
// bariton, good Turkish; phones' own voices often have none). ▶ plays, ⏸ pauses, ▶ again goes on. One at a time.
import { SESSION_KEY } from "./api";
import { showError } from "./composer";
import { errorText } from "./format";
import { h } from "./html";

/** The message being read (or paused), its button, and its audio. */
let current: { button: HTMLButtonElement; audio: HTMLAudioElement; url: string } | undefined;

function forget(): void {
  if (!current) return;
  current.audio.pause();
  URL.revokeObjectURL(current.url);
  current.button.textContent = "▶";
  current.button.title = "Read it aloud";
  current = undefined;
}

function showPlaying(button: HTMLButtonElement, playing: boolean): void {
  button.textContent = playing ? "⏸" : "▶";
  button.title = playing ? "Pause" : "Go on reading";
}

async function speech(text: string): Promise<Blob> {
  const session = localStorage.getItem(SESSION_KEY);
  const res = await fetch("/api/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session}` } : {}) },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.blob();
}

export function speakButton(text: string): HTMLButtonElement {
  const button = h("button", "msg-action-btn msg-speak-btn", "▶");
  button.type = "button";
  button.title = "Read it aloud";
  button.addEventListener("click", async () => {
    if (current?.button === button) {
      // This message: pause or go on.
      if (current.audio.paused) await current.audio.play();
      else current.audio.pause();
      showPlaying(button, !current.audio.paused);
      return;
    }
    forget();
    // An Audio made inside the click may play after the await (Safari allows sound only from a user's gesture).
    const audio = new Audio();
    current = { button, audio, url: "" };
    button.textContent = "…";
    button.title = "Making the speech…";
    try {
      const url = URL.createObjectURL(await speech(text));
      if (current?.audio !== audio) return URL.revokeObjectURL(url); // another ▶ was pressed meanwhile
      current.url = url;
      audio.src = url;
      audio.addEventListener("ended", forget, { once: true });
      await audio.play();
      showPlaying(button, true);
    } catch (err) {
      if (current?.audio === audio) forget();
      showError(`Could not read it aloud: ${errorText(err)}`);
    }
  });
  return button;
}
