// Right-pane tabs for agents' own pages (`serve --ext NAME=URL`, e.g. gpudash's dashboard): one tab per page, on every
// view (a dashboard is not tied to a conversation), showing the page in a sandboxed frame. The frame gets scripts but
// not the website's origin, so the page cannot read the session; clipboard writes are allowed for click-to-copy.
import { extensionUrl } from "./api";
import { h } from "./html";
import { registerExtension } from "./pane";

const registered = new Set<string>();

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
      applies: () => true,
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
