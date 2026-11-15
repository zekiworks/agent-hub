// The right pane: extensions shown as tabs next to the conversation (docs/right-pane.md). An extension says when it
// has something for a view and fills the pane's body. The pane keeps the view it was opened for (its source): the
// main panel changing does not change it (Can, 15 Nov); only opening an extension for the current view does (▤, a
// file, a tab while they match). While the two differ, the source's name heads the pane.
import { dom } from "./dom";
import { h } from "./html";
import { conversationTitle, state, type View } from "./state";
import { navigate, viewHash } from "./routing";

export interface PaneExtension {
  id: string;
  /** Place in the tab row, lowest first (modules load in no fixed order). */
  order: number;
  /** The tab's label. */
  title(): string;
  /** Whether it has something for this view: its tab shows only then. */
  applies(view: View): boolean;
  /**
   * Fills its own part of the pane's body for `view`, the pane's source. Called when the source changes while its tab
   * is open, and after `refreshPane(id)`; not on tab switches or every redraw of the page, so what it shows keeps its
   * scroll position.
   */
  render(body: HTMLElement, view: View): void;
  /** Its tab became visible (true) or stopped being visible (false): e.g. Live streams only while seen. */
  shown?(visible: boolean): void;
}

const extensions: PaneExtension[] = [];

/** Whether the pane is open, and the tab last chosen: kept per browser. */
const OPEN_KEY = "agent-bus.paneOpen";
const TAB_KEY = "agent-bus.paneTab";
let open = localStorage.getItem(OPEN_KEY) === "1";
let tab = localStorage.getItem(TAB_KEY) ?? "";
/** The view the pane shows extensions for (set when it is opened; after a reload: the open view). */
let source: View | undefined;

/** The view the open pane is about, if it is open. */
export function paneView(): View | undefined {
  return open ? (source ?? state.view) : undefined;
}

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

function available(view: View): PaneExtension[] {
  return extensions.filter((e) => e.applies(view));
}

/**
 * Opens the pane on extension `id` for the open view and draws it afresh (an extension calls this with something
 * new, e.g. a file opened from a message).
 */
export function openPane(id: string): void {
  source = state.view;
  drawnFor.delete(id);
  selectTab(id);
}

/** Opens the pane on tab `id` of its source as it was (tab clicks, ▤): what it shows keeps its scroll position. */
function selectTab(id: string): void {
  open = true;
  source ??= state.view;
  tab = id;
  localStorage.setItem(OPEN_KEY, "1");
  localStorage.setItem(TAB_KEY, id);
  renderPane();
}

export function closePane(): void {
  open = false;
  source = undefined;
  localStorage.setItem(OPEN_KEY, "0");
  renderPane();
}

/** Draws extension `id` again if it is the one shown (its data changed). */
export function refreshPane(id: string): void {
  drawnFor.delete(id);
  renderPane();
}

/** Whether the pane's source is the view open in the main panel. */
function showsCurrent(): boolean {
  return !!source && viewHash(source) === viewHash(state.view);
}

/** Shows the pane as its source and chosen tab want it; called on every redraw of the page. */
export function renderPane(): void {
  const view = open ? (source ??= state.view) : state.view;
  const list = available(view);
  // The chosen tab if it has something for the source, else the first that does.
  const current = open ? (list.find((e) => e.id === tab) ?? list[0]) : undefined;
  dom.pane.hidden = !current;
  dom.app.classList.toggle("with-pane", !!current);
  const here = !!current && showsCurrent();
  dom.paneBtn.hidden = available(state.view).length === 0 && !current;
  dom.paneBtn.classList.toggle("on", here);
  dom.paneBtn.setAttribute("aria-pressed", here ? "true" : "false");
  dom.paneBtn.title = current && !here ? "Show this conversation's extensions on the right" : "Files shared here, and more, on the right";
  if (!current) {
    dom.paneTabs.replaceChildren();
    dom.paneSource.hidden = true;
    setVisible(undefined);
    return;
  }
  // Another conversation's extensions: its name heads the pane, and a click on it opens that conversation.
  dom.paneSource.hidden = here;
  if (!here) {
    const conv = view.kind === "conversation" ? state.conversations.get(view.id) : undefined;
    const name = conv ? conversationTitle(conv) : view.kind === "draft" ? (view.project ? `@@${view.project}` : view.to.join(", ")) : "";
    dom.paneSource.textContent = name;
    dom.paneSource.title = `Showing ${name}; click to open it`;
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
  const key = viewHash(view);
  if (drawnFor.get(current.id) !== key) {
    drawnFor.set(current.id, key);
    current.render(host, view);
  }
  setVisible(current.id);
}

// ▤: closes the pane when it shows this conversation; otherwise shows this conversation's extensions there.
dom.paneBtn.addEventListener("click", () => {
  if (!dom.pane.hidden && showsCurrent()) {
    closePane();
    return;
  }
  source = state.view;
  const list = available(state.view);
  selectTab((list.find((e) => e.id === tab) ?? list[0])?.id ?? tab);
});
dom.paneSource.addEventListener("click", () => {
  if (source) navigate(source);
});
dom.paneClose.addEventListener("click", closePane);
// Esc closes the pane unless something else (mention menu, reply bar, a dialog) used it first.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || dom.pane.hidden) return;
  if (document.querySelector("dialog[open]")) return;
  closePane();
});
