// Drafts: unsent text is kept per conversation (and per open thread of it) and profile, across navigation and reloads.
import { autosize, updateComposerState } from "./composer";
import { dom } from "./dom";
import { viewHash } from "./routing";
import { state, type View } from "./state";
import { openThread } from "./threads";

const DRAFT_KEY_PREFIX = "agent-bus.draft.";

/**
 * The thread a draft for `view` belongs to: the open one when `view` is the open view, else null (the conversation
 * itself). A thread has a draft of its own: the room's draft must not show inside a thread and be sent there as a reply
 * (codex-ui #14246). Null, not undefined, so a place taken at Send stays that place when a thread opens meanwhile
 * (codex-ui #14251).
 */
export function draftThread(view: View): number | null {
  return viewHash(view) === viewHash(state.view) ? (openThread() ?? null) : null;
}

function draftKey(view: View, thread: number | null): string {
  return `${DRAFT_KEY_PREFIX}${state.me}.${viewHash(view)}${thread === null ? "" : `/t/${thread}`}`;
}

export function saveDraft(view: View, text: string, thread: number | null = draftThread(view)): void {
  if (!state.me) return;
  if (text.trim()) localStorage.setItem(draftKey(view, thread), text);
  else localStorage.removeItem(draftKey(view, thread));
}

/** The draft kept for `view` and `thread` (null: the conversation itself; "" if none). */
export function readDraft(view: View, thread: number | null = draftThread(view)): string {
  return state.me ? (localStorage.getItem(draftKey(view, thread)) ?? "") : "";
}

export function loadDraft(): void {
  dom.input.value = readDraft(state.view);
  autosize();
  updateComposerState();
}
