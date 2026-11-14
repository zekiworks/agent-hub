// ▶ next to ↩ Reply: the message read aloud by the bus's text-to-speech server (POST /api/speech: LFM3-Audio on
// bariton, good Turkish; phones' own voices often have none). ▶ plays, ⏸ pauses, ▶ again goes on. One at a time.
// While one plays, a bar above the message box names it (⏸/▶, ■ stop, ↧ back to it), and the message is outlined,
// so it can be found after scrolling away or opening another conversation.
import type { Message } from "@agent-bus/protocol";
import { SESSION_KEY } from "./api";
import { showError } from "./composer";
import { dom } from "./dom";
import { errorText } from "./format";
import { hooks } from "./hooks";
import { h } from "./html";

/** The message being read (or paused) and its audio. */
let current: { seq: number; from: string; audio: HTMLAudioElement; url: string; loading: boolean } | undefined;

const bar = h("div", "speak-bar");
bar.setAttribute("role", "status");
bar.hidden = true;
dom.composer.prepend(bar);

function playing(): boolean {
  return !!current && !current.loading && !current.audio.paused;
}

/** The ▶ buttons, the outline on the message, and the bar, from `current`. */
function show(): void {
  for (const el of dom.messageList.querySelectorAll(".msg-speaking")) el.classList.remove("msg-speaking");
  for (const b of dom.messageList.querySelectorAll<HTMLButtonElement>(".msg-speak-btn")) {
    const mine = current?.seq === Number(b.dataset.seq);
    b.textContent = mine ? (current?.loading ? "…" : playing() ? "⏸" : "▶") : "▶";
    b.title = mine ? (playing() ? "Pause" : "Go on reading") : "Read it aloud";
    if (mine) b.closest(".msg")?.classList.add("msg-speaking");
  }
  if (!current) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  const toggle = h("button", "msg-action-btn", current.loading ? "…" : playing() ? "⏸" : "▶");
  toggle.type = "button";
  toggle.title = playing() ? "Pause" : "Go on reading";
  toggle.addEventListener("click", () => void togglePause());
  const stop = h("button", "msg-action-btn", "■");
  stop.type = "button";
  stop.title = "Stop reading";
  stop.addEventListener("click", forget);
  const find = h("button", "link-btn", `#${current.seq} @${current.from}`);
  find.type = "button";
  find.title = "Show the message being read";
  const seq = current.seq;
  find.addEventListener("click", () => void hooks.showMessage(seq));
  bar.replaceChildren(h("span", "", current.loading ? "Preparing to read " : playing() ? "Reading " : "Paused: "), find, toggle, stop);
  bar.hidden = false;
}

function forget(): void {
  if (current) {
    current.audio.pause();
    if (current.url) URL.revokeObjectURL(current.url);
  }
  current = undefined;
  show();
}

async function togglePause(): Promise<void> {
  if (!current || current.loading) return;
  if (current.audio.paused) await current.audio.play();
  else current.audio.pause();
  show();
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

/** After the message list is redrawn: the playing message keeps its outline and ⏸. */
export function renderSpeaking(): void {
  show();
}

export function speakButton(message: Message): HTMLButtonElement {
  const button = h("button", "msg-action-btn msg-speak-btn", current?.seq === message.seq ? (playing() ? "⏸" : "▶") : "▶");
  button.type = "button";
  button.dataset.seq = String(message.seq);
  button.title = "Read it aloud";
  button.addEventListener("click", async () => {
    if (current?.seq === message.seq) return togglePause();
    forget();
    // An Audio made inside the click may play after the await (Safari allows sound only from a user's gesture).
    const audio = new Audio();
    const mine = { seq: message.seq, from: message.from, audio, url: "", loading: true };
    current = mine;
    show();
    try {
      const url = URL.createObjectURL(await speech(message.text));
      if (current !== mine) return URL.revokeObjectURL(url); // another ▶ was pressed meanwhile
      mine.url = url;
      mine.loading = false;
      audio.src = url;
      audio.addEventListener("ended", () => current === mine && forget(), { once: true });
      audio.addEventListener("pause", show);
      audio.addEventListener("play", show);
      await audio.play();
      show();
    } catch (err) {
      if (current === mine) forget();
      showError(`Could not read it aloud: ${errorText(err)}`);
    }
  });
  return button;
}
