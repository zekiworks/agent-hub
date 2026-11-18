// Web pages the bus serves (`serve --ext NAME=URL[,launcher=LABEL]`) in the Workspace, each in a sandboxed frame. Two
// kinds: without a launcher a page belongs to NAME, a tab of the project @@NAME and the DM with
// agent NAME (builder's board); with one it is a global item opened from the top bar (gpudash's dashboard as
// "GPUs"), no agent needed. The frame gets scripts but not the website's origin, so the page cannot read the session;
// clipboard writes are allowed for click-to-copy.
import { extensionUrl } from "./api";
import { dom } from "./dom";
import { h } from "./html";
import { globalShown, onWorkspaceChange, registerExtension, toggleGlobal } from "./pane";
import { directAgentOf, state, type View } from "./state";

const registered = new Set<string>();

/** `view` is the project @@name (or a draft of it) or the DM with agent `name`. */
function belongsTo(view: View, name: string): boolean {
  if (view.kind === "draft") return view.project === name || (view.to.length === 1 && view.to[0] === name);
  const conv = state.conversations.get(view.id);
  return conv?.kind === "project" ? conv.name === name : directAgentOf(view) === name;
}

/** Registers each page the bus serves (from /api/state); pages already registered keep their frame. */
export function registerAgentPages(names: readonly string[], launchers: Readonly<Record<string, string>>): void {
  for (const name of names) {
    if (registered.has(name)) continue;
    registered.add(name);
    const id = `ext-${name}`;
    const launcher = launchers[name];
    let frame: HTMLIFrameElement | undefined;
    registerExtension({
      id,
      order: 30,
      ...(launcher ? { scope: "global" as const } : {}),
      title: () => launcher ?? name,
      applies: (view) => (launcher ? !!state.me : belongsTo(view, name)),
      render: (body) => {
        // Drawn once: switching conversations must not reload a live dashboard.
        if (frame && frame.parentElement === body) return;
        frame = h("iframe", "agent-page");
        frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
        frame.setAttribute("allow", "clipboard-write");
        frame.title = launcher ?? name;
        frame.src = extensionUrl(name);
        // Who is looking, so the page offers Release / +2 h / Shared-Private only on that person's holds. The
        // only thing a page learns from the website: no keys, no messages.
        const page = frame;
        page.addEventListener("load", () => page.contentWindow?.postMessage({ type: "agent-bus:viewer", id: state.me }, "*"));
        body.replaceChildren(frame);
      },
    });
    if (!launcher) continue;
    const button = h("button", "link-btn launcher-btn", launcher);
    button.type = "button";
    button.title = `${launcher} in the Workspace`;
    button.addEventListener("click", () => toggleGlobal(id));
    dom.launchers.append(button);
    onWorkspaceChange(() => {
      const on = globalShown(id);
      button.classList.toggle("active", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
}

/** At most one pointerleave notice per frame this often (ms). */
const POINTERLEAVE_EVERY_MS = 250;
let lastPointerleave = 0;

// A pointer jumping straight out of a frame onto the website leaves the page inside with a stuck hover: it gets no
// mouseleave, and the frame element's own pointer events are unreliable. The page's pointermove is not, so while the
// pointer moves over the website, shown pages hear {type: "agent-bus:pointerleave"}.
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
