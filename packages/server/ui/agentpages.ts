// Web pages the bus serves (`serve --ext NAME=URL[,launcher=LABEL|,agents=LABEL]`) in the Workspace, each in a
// sandboxed frame. Three kinds (Can, #10206; #10211; #14261): without an option a page belongs to NAME, a tab of the
// project @@NAME and the DM with agent NAME (compactor's board); with a launcher it is a global item opened from the
// top bar (gpudash's dashboard as "GPUs"), no agent needed; with agents= a tab on every agent's page (the status
// extension's "Home"). The frame gets scripts but not the website's origin, so the page cannot read the session;
// clipboard writes are allowed for click-to-copy.
import { extensionUrl } from "./api";
import { setReplyTo, showError } from "./composer";
import { dom, PHONE } from "./dom";
import { h } from "./html";
import { hooks } from "./hooks";
import { closePane, globalShown, onWorkspaceChange, registerExtension, toggleGlobal } from "./pane";
import { directAgentOf, state, type View } from "./state";
import { fetchMessage } from "./text";

const registered = new Set<string>();

/** `view` is the project @@name (or a draft of it) or the DM with agent `name`. */
function belongsTo(view: View, name: string): boolean {
  if (view.kind === "draft") return view.project === name || (view.to.length === 1 && view.to[0] === name);
  const conv = state.conversations.get(view.id);
  return conv?.kind === "project" ? conv.name === name : directAgentOf(view) === name;
}

/** The agent whose page `view` is: the agent of a DM, or the one a project @@<id> (not a room) is named after. */
function pageAgent(view: View): string | undefined {
  const isAgent = (id: string | undefined) => !!id && state.participants.some((p) => p.id === id && p.kind === "agent");
  if (view.kind === "draft") {
    const id = view.project ?? (view.to.length === 1 ? view.to[0] : undefined);
    return isAgent(id) ? id : undefined;
  }
  const conv = state.conversations.get(view.id);
  if (conv?.kind === "dm") return conv.members.find(isAgent);
  return conv?.kind === "project" && !conv.room && isAgent(conv.name) ? conv.name : undefined;
}

/**
 * Registers each page the bus serves (from /api/state); pages already registered keep their frame. A third kind
 * (Can #14261): `agentTabs` pages are a tab on every agent's page, told which agent by ?agent=<id>.
 */
export function registerAgentPages(
  names: readonly string[],
  launchers: Readonly<Record<string, string>>,
  agentTabs: Readonly<Record<string, string>>
): void {
  for (const name of names) {
    if (registered.has(name)) continue;
    registered.add(name);
    const id = `ext-${name}`;
    const launcher = launchers[name];
    const agentTab = agentTabs[name];
    let frame: HTMLIFrameElement | undefined;
    let frameAgent: string | undefined;
    registerExtension({
      id,
      // An agent tab stands first, where the Home tab used to (Can #14261).
      order: agentTab ? -1 : 30,
      ...(launcher ? { scope: "global" as const } : {}),
      title: () => launcher ?? agentTab ?? name,
      applies: (view) => (launcher ? !!state.me : agentTab ? pageAgent(view) !== undefined : belongsTo(view, name)),
      render: (body, view) => {
        const agent = agentTab ? pageAgent(view) : undefined;
        // Drawn once (per agent): switching conversations must not reload a live dashboard.
        if (frame && frame.parentElement === body && frameAgent === agent) return;
        frameAgent = agent;
        frame = h("iframe", "agent-page");
        frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
        frame.setAttribute("allow", "clipboard-write");
        frame.title = launcher ?? agentTab ?? name;
        frame.src = agent ? `${extensionUrl(name)}?agent=${encodeURIComponent(agent)}` : extensionUrl(name);
        // Who is looking (#10194), so the page offers Release / +2 h / Shared-Private only on that person's holds. The
        // only thing a page learns from the website: no keys, no messages.
        const page = frame;
        page.addEventListener("load", () => page.contentWindow?.postMessage({ type: "agent-bus:viewer", id: state.me }, "*"));
        body.replaceChildren(frame);
      },
    });
    if (!launcher) continue;
    const button = h("button", "inbox-topbtn launcher-btn", launcher);
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

/**
 * A page in the Workspace may point at a bus message. The page has no session and cannot read messages itself:
 * the website validates that the request came from one of its frames, then opens it or sets the real reply state.
 */
window.addEventListener("message", (event) => {
  const fromPane = [...document.querySelectorAll<HTMLIFrameElement>("iframe.agent-page")].some((f) => f.contentWindow === event.source);
  const data = event.data as { type?: unknown; seq?: unknown } | null;
  if (!fromPane || (data?.type !== "agent-bus:show-message" && data?.type !== "agent-bus:reply-message")) return;
  const seq = data.seq;
  if (!Number.isSafeInteger(seq) || (seq as number) <= 0) return;
  const open = async () => {
    if (PHONE.matches) closePane();
    if (data.type === "agent-bus:show-message") return hooks.showMessage(seq as number);
    try {
      const { message } = await fetchMessage(seq as number);
      await hooks.showMessage(seq as number);
      setReplyTo(message);
    } catch (error) {
      showError(`Message #${seq}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  void open();
});

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
