// Filling the message box from elsewhere, never sending: a checklist item's ↩, a pane page's
// {type: "agent-bus:compose", to, text} (gpudash: a reservation's owner), and links #/to/<id>?draft=<text> from pages
// outside the website (gpudash opened on its own). The person reads it, finishes it and presses Send.
import { autosize, updateComposerState } from "./composer";
import { dom, PHONE } from "./dom";
import { saveDraft } from "./drafts";
import { closePane } from "./pane";
import { navigate, viewHash } from "./routing";
import { dmWith, state, type View } from "./state";

/** Longest text a page or link may put in the box. */
const MAX_COMPOSE_CHARS = 500;
/** Address to come back to after signing in (a draft link opened while signed out keeps its draft). */
const RETURN_KEY = "agent-bus.returnTo";

/**
 * Puts `text` at the top of `view`'s message box (a Workspace page's "write to…", a #/to/…?draft= link), cursor right
 * after it; what was in the box stays below. Text already at the top is not put there again (a repeated
 * tap stacked the same lines).
 */
export function prefill(view: View, text: string): void {
  const put = () => {
    const rest = dom.input.value.trim();
    if (!rest.startsWith(text.trim())) dom.input.value = rest ? `${text}\n\n${rest}` : text;
    saveDraft(view, dom.input.value);
    autosize();
    updateComposerState();
    dom.input.focus();
    dom.input.setSelectionRange(text.length, text.length);
  };
  if (location.hash === viewHash(view)) {
    put();
    return;
  }
  // Switching conversations loads that one's draft into the box: the text goes in after that.
  window.addEventListener("hashchange", () => setTimeout(put, 0), { once: true });
  navigate(view);
}

/** The DM with `id` (or a new one), if `id` is someone else on the bus. */
function dmView(id: string): View | undefined {
  if (id === state.me || !(state.participants.some((p) => p.id === id) || state.humans.includes(id))) return undefined;
  const dm = dmWith(id);
  return dm ? { kind: "conversation", id: dm.id } : { kind: "draft", to: [id] };
}

// A pane page asks to fill the box: only the website's own extension frames are heard (agentpages.ts).
window.addEventListener("message", (event) => {
  const fromPane = [...document.querySelectorAll<HTMLIFrameElement>("iframe.agent-page")].some((f) => f.contentWindow === event.source);
  const data = event.data as { type?: unknown; to?: unknown; text?: unknown } | null;
  if (!fromPane || data?.type !== "agent-bus:compose" || typeof data.to !== "string" || typeof data.text !== "string") return;
  const view = dmView(data.to.trim().replace(/^@/, "").toLowerCase());
  if (!view || data.text.length > MAX_COMPOSE_CHARS) return;
  if (PHONE.matches) closePane(); // on phones the pane covers the box
  prefill(view, data.text);
});

/** Before sending someone to sign in: keep the address (and a draft link's text) for when they are back. */
export function rememberAddress(): void {
  if (location.hash) sessionStorage.setItem(RETURN_KEY, location.hash);
}

/** After signing in: back to the address the person came with (called before the first view is shown). */
export function restoreAddress(): void {
  const hash = sessionStorage.getItem(RETURN_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  if (hash && !location.hash) history.replaceState(null, "", hash);
}

/**
 * A link #/to/<id>?draft=<text>: the address becomes the DM with <id> (without the text), and the text goes into its
 * box once it is shown. Call before the view is read from the address.
 */
export function takeDraftLink(): void {
  const match = /^#\/to\/([^?]+)\?draft=(.*)$/.exec(location.hash);
  if (!match?.[1]) return;
  let text = "";
  try {
    text = decodeURIComponent(match[2] ?? "");
  } catch {
    // a broken link opens the DM without a draft
  }
  const id = decodeURIComponent(match[1]).trim().replace(/^@/, "").toLowerCase();
  const view = dmView(id);
  history.replaceState(null, "", view ? viewHash(view) : `#/to/${encodeURIComponent(id)}`);
  if (view && text && text.length <= MAX_COMPOSE_CHARS) setTimeout(() => prefill(view, text), 0);
}
