// Right-pane tabs for agents' own pages (`serve --ext NAME=URL`, e.g. gpudash's dashboard), showing the page in a
// sandboxed frame. A page belongs to NAME (Can, 15 Nov): its tab is in the project @@NAME and the DM with agent NAME;
// the pane keeps it while other conversations are opened on the left. The frame gets scripts but
// not the website's origin, so the page cannot read the session; clipboard writes are allowed for click-to-copy.
import { extensionUrl } from "./api";
import { h } from "./html";
import { registerExtension } from "./pane";
import { directAgentOf, state, type View } from "./state";

const registered = new Set<string>();

/** `view` is the project @@name (or a draft of it) or the DM with agent `name`. */
function belongsTo(view: View, name: string): boolean {
  if (view.kind === "draft") return view.project === name || (view.to.length === 1 && view.to[0] === name);
  const conv = state.conversations.get(view.id);
  return conv?.kind === "project" ? conv.name === name : directAgentOf(view) === name;
}

/** Adds a tab for each page the bus serves (from /api/state); pages already registered keep their frame. */
export function registerAgentPages(names: readonly string[]): void {
  for (const name of names) {
    if (registered.has(name)) continue;
    registered.add(name);
    let frame: HTMLIFrameElement | undefined;
    registerExtension({
      id: `ext-${name}`,
      order: 30,
      title: () => name,
      applies: (view) => belongsTo(view, name),
      render: (body) => {
        // Drawn once: switching conversations must not reload a live dashboard.
        if (frame && frame.parentElement === body) return;
        frame = h("iframe", "agent-page");
        frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
        frame.setAttribute("allow", "clipboard-write");
        frame.title = name;
        frame.src = extensionUrl(name);
        body.replaceChildren(frame);
      },
    });
  }
}

/** At most one pointerleave notice per frame this often (ms). */
const POINTERLEAVE_EVERY_MS = 250;
let lastPointerleave = 0;

// A pointer jumping straight out of a frame onto the website leaves the page inside with a stuck hover: it gets no
// mouseleave, and the frame element's own pointer events are unreliable. The page's pointermove is not, so while the
// pointer moves over the website, shown pages hear {type: "agent-bus:pointerleave"} (gpudash, 15 Nov).
document.addEventListener(
  "pointermove",
  () => {
    const now = Date.now();
    if (now - lastPointerleave < POINTERLEAVE_EVERY_MS) return;
    lastPointerleave = now;
    for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe.agent-page")) {
      if (frame.offsetParent !== null) frame.contentWindow?.postMessage({ type: "agent-bus:pointerleave" }, "*");
    }
  },
  { passive: true }
);
