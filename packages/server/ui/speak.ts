// ▶ next to ↩ Reply: the message read aloud by the bus's text-to-speech server (POST /api/speech: LFM3-Audio on
// bariton, good Turkish; phones' own voices often have none). ▶ plays, ⏸ pauses, ▶ again goes on. One at a time.
// It is read one sentence at a time, so the page can follow it as Hilde does: the sentence being read is highlighted
// exactly, and the word, estimated by its share of the sentence's audio, more strongly. While it plays, a bar above
// the message box names it (⏸/▶, ■ stop, a link back to it), and the message is outlined.
import type { Message } from "@agent-bus/protocol";
import { SESSION_KEY } from "./api";
import { showError } from "./composer";
import { dom } from "./dom";
import { errorText } from "./format";
import { hooks } from "./hooks";
import { h } from "./html";

/** A sentence of the message as shown: its place in the rendered text, and its audio once made. */
interface Sentence {
  start: number;
  end: number;
  text: string;
  audio?: Promise<string>;
}

/** The message being read (or paused). */
let current:
  | { seq: number; from: string; audio: HTMLAudioElement; sentences: Sentence[]; index: number; loading: boolean }
  | undefined;

/** The CSS Custom Highlight API (Chrome, Safari 17.2+, Firefox 140+); without it, only the bar and outline show. */
const HIGHLIGHTS = "highlights" in CSS ? CSS.highlights : undefined;
const canHighlight = typeof Highlight === "function" && HIGHLIGHTS !== undefined;

const bar = h("div", "speak-bar");
bar.setAttribute("role", "status");
bar.hidden = true;
dom.composer.prepend(bar);

function playing(): boolean {
  return !!current && !current.loading && !current.audio.paused;
}

/** Sentences of `text` with their offsets: up to . ! ? … or a line break, short ones joined to the next. */
function sentencesOf(text: string): Sentence[] {
  const out: Sentence[] = [];
  const re = /[^.!?…\n]*(?:[.!?…]+|\n|$)/g;
  let pending: Sentence | undefined;
  for (const match of text.matchAll(re)) {
    const raw = match[0];
    if (raw === "") continue;
    const start = match.index ?? 0;
    const piece = { start, end: start + raw.length, text: raw };
    pending = pending ? { start: pending.start, end: piece.end, text: pending.text + raw } : piece;
    if (pending.text.trim().length >= 25) {
      if (pending.text.trim()) out.push(pending);
      pending = undefined;
    }
  }
  if (pending?.text.trim()) out.push(pending);
  return out;
}

/** The text of message `seq` as shown, or "" when it is not on screen. */
function shownText(seq: number): HTMLElement | null {
  return dom.messageList.querySelector<HTMLElement>(`[data-seq="${seq}"] .msg-text`);
}

/** A DOM Range over characters [start, end) of `root`'s text. */
function rangeOf(root: HTMLElement, start: number, end: number): Range | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start <= offset + length) {
      range.setStart(node, Math.max(0, start - offset));
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, Math.max(0, end - offset));
      return range;
    }
    offset += length;
  }
  return undefined;
}

/** Highlights the sentence being read and the word estimated from how far its audio has played. */
function highlight(): void {
  if (!canHighlight || !HIGHLIGHTS) return;
  HIGHLIGHTS.delete("speak-sentence");
  HIGHLIGHTS.delete("speak-word");
  if (!current || current.loading) return;
  const sentence = current.sentences[current.index];
  const root = shownText(current.seq);
  if (!sentence || !root) return;
  const range = rangeOf(root, sentence.start, sentence.end);
  if (range) HIGHLIGHTS.set("speak-sentence", new Highlight(range));
  const { duration, currentTime } = current.audio;
  if (!duration || !Number.isFinite(duration)) return;
  // The word whose share of the sentence's letters matches the share of its audio played.
  const at = sentence.start + Math.floor((currentTime / duration) * (sentence.end - sentence.start));
  const words = [...sentence.text.matchAll(/\S+/g)].map((m) => ({ start: sentence.start + (m.index ?? 0), end: sentence.start + (m.index ?? 0) + m[0].length }));
  const word = words.find((w) => at < w.end) ?? words[words.length - 1];
  const wordRange = word ? rangeOf(root, word.start, word.end) : undefined;
  if (wordRange) HIGHLIGHTS.set("speak-word", new Highlight(wordRange));
}

/** The ▶ buttons, the outline on the message, the highlights and the bar, from `current`. */
function show(): void {
  for (const el of dom.messageList.querySelectorAll(".msg-speaking")) el.classList.remove("msg-speaking");
  for (const b of dom.messageList.querySelectorAll<HTMLButtonElement>(".msg-speak-btn")) {
    const mine = current?.seq === Number(b.dataset.seq);
    b.textContent = mine ? (current?.loading ? "…" : playing() ? "⏸" : "▶") : "▶";
    b.title = mine ? (playing() ? "Pause" : "Go on reading") : "Read it aloud";
    if (mine) b.closest(".msg")?.classList.add("msg-speaking");
  }
  highlight();
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
  const where = current.sentences.length > 1 ? ` (${current.index + 1}/${current.sentences.length})` : "";
  bar.replaceChildren(
    h("span", "", current.loading ? "Preparing to read " : playing() ? "Reading " : "Paused: "),
    find,
    h("span", "", where),
    toggle,
    stop
  );
  bar.hidden = false;
}

function forget(): void {
  if (current) {
    current.audio.pause();
    for (const s of current.sentences) void s.audio?.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
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

async function speech(text: string): Promise<string> {
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
  return URL.createObjectURL(await res.blob());
}

/** Sentence `index`'s audio, asked for once (the next one is fetched while this one plays). */
function audioOf(sentence: Sentence): Promise<string> {
  sentence.audio ??= speech(sentence.text);
  return sentence.audio;
}

/** Plays sentence `index` of the current message, then the next, until the last. */
async function playFrom(mine: NonNullable<typeof current>, index: number): Promise<void> {
  const sentence = mine.sentences[index];
  if (!sentence) {
    if (current === mine) forget();
    return;
  }
  mine.loading = true;
  mine.index = index;
  show();
  const url = await audioOf(sentence);
  if (current !== mine) return; // stopped, or another ▶ pressed meanwhile
  const next = mine.sentences[index + 1];
  if (next) void audioOf(next).catch(() => undefined);
  mine.loading = false;
  mine.audio.src = url;
  await mine.audio.play();
  show();
}

/** After the message list is redrawn: the playing message keeps its outline, ⏸ and highlights. */
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
    // The text as shown (without markdown signs), so what is highlighted is what is heard.
    const shown = shownText(message.seq)?.textContent ?? message.text;
    const sentences = sentencesOf(shown);
    if (sentences.length === 0) return;
    // An Audio made inside the click may play after the await (Safari allows sound only from a user's gesture).
    const audio = new Audio();
    const mine = { seq: message.seq, from: message.from, audio, sentences, index: 0, loading: true };
    current = mine;
    audio.addEventListener("ended", () => current === mine && void playFrom(mine, mine.index + 1).catch(fail));
    audio.addEventListener("pause", show);
    audio.addEventListener("play", show);
    audio.addEventListener("timeupdate", highlight);
    const fail = (err: unknown) => {
      if (current === mine) forget();
      showError(`Could not read it aloud: ${errorText(err)}`);
    };
    await playFrom(mine, 0).catch(fail);
  });
  return button;
}
