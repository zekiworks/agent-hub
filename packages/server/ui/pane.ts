// The right pane: extensions shown as tabs next to the conversation (docs/right-pane.md). An extension says when it
// has something for the open view and fills the pane's body; the pane keeps which tab is open, per browser.
import { dom } from "./dom";
import { h } from "./html";
import { state, type View } from "./state";
import { viewHash } from "./routing";

export interface PaneExtension {
  id: string;
  /** Place in the tab row, lowest first (modules load in no fixed order). */
  order: number;
  /** The tab's label. */
  title(): string;
  /** Whether it has something for this view: its tab shows only then. */
  applies(view: View): boolean;
  /**
   * Fills its own part of the pane's body. Called when the view changes while its tab is open, and after
   * `refreshPane(id)`; not on tab switches or every redraw of the page, so what it shows keeps its scroll position.
   */
  render(body: HTMLElement): void;
  /** Its tab became visible (true) or stopped being visible (false): e.g. Live streams only while seen. */
  shown?(visible: boolean): void;
}

const extensions: PaneExtension[] = [];

/** Whether the pane is open, and the tab last chosen: kept per browser. */
const OPEN_KEY = "agent-bus.paneOpen";
const TAB_KEY = "agent-bus.paneTab";
let open = localStorage.getItem(OPEN_KEY) === "1";
let tab = localStorage.getItem(TAB_KEY) ?? "";

/** The extension whose tab is visible now, if any (for `shown`). */
let visibleId: string | undefined;

function setVisible(id: string | undefined): void {
  if (id === visibleId) return;
  const before = extensions.find((e) => e.id === visibleId);
  visibleId = id;
  before?.shown?.(false);
  extensions.find((e) => e.id === id)?.shown?.(true);
}

/** Each extension's part of the pane's body (kept while hidden: switching tabs keeps scroll positions). */
const hosts = new Map<string, HTMLElement>();
/** The view each extension last drew for, so an unchanged one is not drawn again. */
const drawnFor = new Map<string, string>();

function hostOf(id: string): HTMLElement {
  let host = hosts.get(id);
  if (!host) {
    host = h("div", "pane-host");
    hosts.set(id, host);
    dom.paneBody.append(host);
  }
  return host;
}

export function registerExtension(extension: PaneExtension): void {
  extensions.push(extension);
  extensions.sort((a, b) => a.order - b.order);
}

function available(): PaneExtension[] {
  return extensions.filter((e) => e.applies(state.view));
}

/** Opens the pane on extension `id` and draws it afresh (an extension calls this with something new, e.g. a file). */
export function openPane(id: string): void {
  drawnFor.delete(id);
  selectTab(id);
}

/** Opens the pane on tab `id` as it was (tab clicks, the ▤ button): what it shows keeps its scroll position. */
function selectTab(id: string): void {
  open = true;
  tab = id;
  localStorage.setItem(OPEN_KEY, "1");
  localStorage.setItem(TAB_KEY, id);
  renderPane();
}

export function closePane(): void {
  open = false;
  localStorage.setItem(OPEN_KEY, "0");
  renderPane();
}

/** Draws extension `id` again if it is the one shown (its data changed). */
export function refreshPane(id: string): void {
  drawnFor.delete(id);
  renderPane();
}

/** Shows the pane as the open view and the chosen tab want it; called on every redraw of the page. */
export function renderPane(): void {
  const list = available();
  dom.paneBtn.hidden = list.length === 0;
  // The chosen tab if it has something here, else the first that does.
  const current = open ? (list.find((e) => e.id === tab) ?? list[0]) : undefined;
  dom.pane.hidden = !current;
  dom.app.classList.toggle("with-pane", !!current);
  dom.paneBtn.classList.toggle("on", !!current);
  dom.paneBtn.setAttribute("aria-pressed", current ? "true" : "false");
  if (!current) {
    dom.paneTabs.replaceChildren();
    setVisible(undefined);
    return;
  }
  dom.paneTabs.replaceChildren(
    ...list.map((e) => {
      const button = h("button", e === current ? "pane-tab active" : "pane-tab", e.title());
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", e === current ? "true" : "false");
      button.addEventListener("click", () => selectTab(e.id));
      return button;
    })
  );
  for (const [id, host] of hosts) host.hidden = id !== current.id;
  const host = hostOf(current.id);
  host.hidden = false;
  const view = viewHash(state.view);
  if (drawnFor.get(current.id) !== view) {
    drawnFor.set(current.id, view);
    current.render(host);
  }
  setVisible(current.id);
}

dom.paneBtn.addEventListener("click", () => {
  if (!dom.pane.hidden) {
    closePane();
    return;
  }
  const list = available();
  selectTab((list.find((e) => e.id === tab) ?? list[0])?.id ?? tab);
});
dom.paneClose.addEventListener("click", closePane);
// Esc closes the pane unless something else (mention menu, reply bar, a dialog) used it first.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || dom.pane.hidden) return;
  if (document.querySelector("dialog[open]")) return;
  closePane();
});
