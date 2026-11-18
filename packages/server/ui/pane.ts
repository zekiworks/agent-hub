// The Workspace: the right-hand area beside the conversation (docs/right-pane.md).
// It shows one item at a time:
// - an entity's extensions (Live, Home, Checklist, Files, an agent's page) as tabs, headed by the entity
//   ("Agent · @webapp"); they belong to the thing on the left and open from its "Open in Workspace" menu;
// - or a global extension (your Inbox, GPUs) on its own, opened by its button in the top bar.
// The Workspace keeps its item while the main panel moves, and keeps a short history walked with ‹ ›
//. While it shows the entity open on the left, both headers share one tint.
import { dom, PHONE } from "./dom";
import { h } from "./html";
import { conversationTitle, hasProjectColor, projectColor, state, type View } from "./state";
import { setPhoneList } from "./phones";
import { navigate, viewHash } from "./routing";

export interface PaneExtension {
  id: string;
  /** Place among the entity's tabs (or menu items), lowest first (modules load in no fixed order). */
  order: number;
  /** "global": a Workspace item of its own, opened by a button outside any conversation (Inbox, GPUs); "entity" (the
   * default): a tab of the thing on the left. */
  scope?: "entity" | "global";
  /** The tab's label (entity) or the Workspace heading (global). */
  title(): string;
  /** Entity: whether it has something for this view (its tab and menu item show only then). Global: whether it is
   * available at all. */
  applies(view: View): boolean;
  /**
   * Fills its own part of the Workspace's body for `view` (an entity's; a global one gets the main panel's). Called
   * when that view changes while it is shown, and after `refreshPane(id)`; not on tab switches or every redraw, so
   * what it shows keeps its scroll position.
   */
  render(body: HTMLElement, view: View): void;
  /** It became visible (true) or stopped being visible (false): e.g. Live streams only while seen. */
  shown?(visible: boolean): void;
}

/** What the Workspace shows: an entity (its view, and the tab chosen there), or a global extension. */
type Item = { view: View; tab: string } | { global: string };

const extensions: PaneExtension[] = [];

/** Open or closed, and the last entity tab, kept per browser; the history is kept per browser tab. */
const OPEN_KEY = "agent-bus.paneOpen";
const TAB_KEY = "agent-bus.paneTab";
const HISTORY_KEY = "agent-bus.workspace";
const HISTORY_MAX = 20;

let open = localStorage.getItem(OPEN_KEY) === "1";
let history: Item[] = [];
let at = -1;
try {
  const saved = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? "null") as { history: Item[]; at: number } | null;
  if (saved && Array.isArray(saved.history) && saved.history.length > 0) {
    history = saved.history.slice(-HISTORY_MAX);
    at = Math.min(Math.max(saved.at, 0), history.length - 1);
  }
} catch {
  // A broken entry: start without history.
}

function save(): void {
  localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  const item = history[at];
  if (item && "tab" in item) localStorage.setItem(TAB_KEY, item.tab);
  sessionStorage.setItem(HISTORY_KEY, JSON.stringify({ history, at }));
}

function keyOf(item: Item): string {
  return "global" in item ? `g:${item.global}` : `e:${viewHash(item.view)}`;
}

/** The item shown now, if the Workspace is open. After a reload without history: the open view, last tab. */
function current(): Item | undefined {
  if (!open) return undefined;
  if (at < 0) {
    history = [{ view: state.view, tab: localStorage.getItem(TAB_KEY) ?? "" }];
    at = 0;
  }
  return history[at];
}

/** The entity the open Workspace is about, if it shows one. */
export function paneView(): View | undefined {
  const item = current();
  return item && "view" in item ? item.view : undefined;
}

/** The extension visible now, if any (for `shown`). */
let visibleId: string | undefined;

function setVisible(id: string | undefined): void {
  if (id === visibleId) return;
  const before = extensions.find((e) => e.id === visibleId);
  visibleId = id;
  before?.shown?.(false);
  extensions.find((e) => e.id === id)?.shown?.(true);
}

/** Each extension's part of the body (kept while hidden: switching keeps scroll positions). */
const hosts = new Map<string, HTMLElement>();
/** What each extension last drew for, so an unchanged one is not drawn again. */
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

/** The entity extensions `view` has (its tabs, and its "Open in Workspace" menu). */
export function entityExtensions(view: View): PaneExtension[] {
  return extensions.filter((e) => (e.scope ?? "entity") === "entity" && e.applies(view));
}

/** Shows `item`: the item last shown (open or closed since) only changes its tab; anything else is a new step
 * (forward steps are dropped). */
function show(item: Item): void {
  const now = history[at];
  if (now && keyOf(now) === keyOf(item)) history[at] = item;
  else {
    history = [...history.slice(0, at + 1), item].slice(-HISTORY_MAX);
    at = history.length - 1;
  }
  open = true;
  // Phones: opened from the conversation list (✉ Your inbox, GPUs), the Workspace must come in front of it.
  setPhoneList(false);
  save();
  renderPane();
}

/**
 * Opens extension `id`: a global one as its own item, an entity one for the view open on the left, drawn afresh (an
 * extension calls this with something new, e.g. a file opened from a message).
 */
export function openPane(id: string): void {
  const extension = extensions.find((e) => e.id === id);
  if (!extension) return;
  drawnFor.delete(id);
  show(extension.scope === "global" ? { global: id } : { view: state.view, tab: id });
}

/** A global button (✉, a launcher): opens its item, or leaves it if it is shown (back a step, or closed). */
export function toggleGlobal(id: string): void {
  const item = open ? history[at] : undefined;
  if (item && "global" in item && item.global === id) {
    if (at > 0) step(-1);
    else closePane();
  } else openPane(id);
}

/** Whether global extension `id` is the item shown (its button is lit). */
export function globalShown(id: string): boolean {
  const item = open ? history[at] : undefined;
  return !!item && "global" in item && item.global === id;
}

function step(by: number): void {
  const next = at + by;
  if (next < 0 || next >= history.length) return;
  at = next;
  open = true;
  save();
  renderPane();
}

export function closePane(): void {
  open = false;
  save();
  renderPane();
}

/** Draws extension `id` again if it is the one shown (its data changed). */
export function refreshPane(id: string): void {
  drawnFor.delete(id);
  renderPane();
}

/** The heading for an entity: what kind of thing it is and its name. */
function subjectLabel(view: View): string {
  const agent = (id: string | undefined) => !!id && state.participants.some((p) => p.id === id && p.kind === "agent");
  if (view.kind === "draft") {
    if (view.project) return `Project · @@${view.project}`;
    return view.to.length === 1 && agent(view.to[0]) ? `Agent · @${view.to[0]}` : `Group · ${view.to.join(", ")}`;
  }
  const conv = state.conversations.get(view.id);
  if (!conv) return "";
  const name = conversationTitle(conv);
  if (conv.kind === "all") return `Room · ${name}`;
  if (conv.kind === "project") return `${conv.room ? "Room" : "Project"} · ${name}`;
  if (conv.kind === "dm") {
    const other = conv.members.find((id) => id !== state.me);
    return agent(other) ? `Agent · @${other}` : `Person · ${name}`;
  }
  return `Group · ${name}`;
}

/** The tint both headers share while the Workspace shows the entity on the left: a project's own colour, else accent. */
function tintOf(view: View): string {
  const conv = view.kind === "conversation" ? state.conversations.get(view.id) : undefined;
  return conv && hasProjectColor(conv) ? projectColor(conv) : "var(--accent)";
}

/** Shows the Workspace as its item wants it; called on every redraw of the page. */
export function renderPane(): void {
  const item = current();
  let extension: PaneExtension | undefined;
  let view = state.view;
  let tabs: PaneExtension[] = [];
  if (item && "global" in item) {
    extension = extensions.find((e) => e.id === item.global && e.scope === "global" && e.applies(state.view));
  } else if (item) {
    view = item.view;
    tabs = entityExtensions(view);
    extension = tabs.find((e) => e.id === item.tab) ?? tabs[0];
  }
  const entity = !!extension && !!item && "view" in item;
  const linked = entity && viewHash(view) === viewHash(state.view);
  dom.pane.hidden = !extension;
  dom.app.classList.toggle("with-pane", !!extension);
  dom.app.classList.toggle("ws-linked", linked);
  dom.app.classList.toggle("ws-global", !!extension && !entity);
  if (linked) dom.app.style.setProperty("--ws-tint", tintOf(view));
  renderOpenMenuButton(entity && linked ? (extension?.id ?? "") : "");
  for (const listener of globalListeners) listener();
  if (!extension) {
    dom.paneTabs.replaceChildren();
    setVisible(undefined);
    return;
  }
  dom.wsBack.disabled = at <= 0;
  dom.wsForward.disabled = at >= history.length - 1;
  const label = entity ? subjectLabel(view) : extension.title();
  dom.paneSource.textContent = label;
  // An entity not open on the left: its heading is a link back to it. The full name shows on hover when it is cut.
  dom.paneSource.classList.toggle("elsewhere", entity && !linked);
  dom.paneSource.title = entity && !linked ? `${label}: not the conversation on the left; click to open it` : label;
  dom.paneTabs.hidden = !entity;
  dom.paneTabs.replaceChildren(
    ...tabs.map((e) => {
      const button = h("button", e === extension ? "pane-tab active" : "pane-tab", e.title());
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", e === extension ? "true" : "false");
      button.addEventListener("click", () => show({ view, tab: e.id }));
      return button;
    })
  );
  for (const [id, host] of hosts) host.hidden = id !== extension.id;
  const host = hostOf(extension.id);
  host.hidden = false;
  const key = entity ? viewHash(view) : "global";
  if (drawnFor.get(extension.id) !== key) {
    drawnFor.set(extension.id, key);
    extension.render(host, view);
  }
  setVisible(extension.id);
}

/** Global buttons (✉, launchers) redraw their lit state with the Workspace. */
const globalListeners: Array<() => void> = [];
export function onWorkspaceChange(listener: () => void): void {
  globalListeners.push(listener);
}

// "Open in Workspace": the entity on the left lists what it has; choosing one opens it on the right.
function renderOpenMenuButton(shownId: string): void {
  const list = entityExtensions(state.view);
  dom.paneBtn.hidden = list.length === 0;
  dom.paneBtn.classList.toggle("on", shownId !== "");
  dom.paneBtn.setAttribute("aria-pressed", shownId !== "" ? "true" : "false");
  dom.paneBtn.dataset.shown = shownId;
}

let menu: HTMLElement | undefined;
function closeMenu(): void {
  menu?.remove();
  menu = undefined;
}

dom.paneBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  if (menu) return closeMenu();
  const shown = dom.paneBtn.dataset.shown ?? "";
  menu = h("div", "entry-menu ws-menu");
  menu.setAttribute("role", "menu");
  for (const e of entityExtensions(state.view)) {
    const item = h("button", "entry-menu-item", `${e.id === shown ? "✓ " : ""}${e.title()}`);
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.addEventListener("click", () => {
      closeMenu();
      show({ view: state.view, tab: e.id });
    });
    menu.append(item);
  }
  if (shown) {
    const close = h("button", "entry-menu-item ws-menu-close", "Close Workspace");
    close.type = "button";
    close.addEventListener("click", () => {
      closeMenu();
      closePane();
    });
    menu.append(close);
  }
  const r = dom.paneBtn.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - 220)))}px`;
  document.body.append(menu);
});
document.addEventListener("click", closeMenu);

dom.wsBack.addEventListener("click", () => step(-1));
dom.wsForward.addEventListener("click", () => step(1));
// The heading: another entity's opens it; otherwise, on a phone, a tap shows a long name whole (like the title).
dom.paneSource.addEventListener("click", () => {
  const item = open ? history[at] : undefined;
  if (item && "view" in item && viewHash(item.view) !== viewHash(state.view)) navigate(item.view);
  else if (PHONE.matches) dom.paneSource.classList.toggle("expanded");
});
// ✕: a global item (your inbox, GPUs) gives the Workspace back to what it showed before; else it closes.
dom.paneClose.addEventListener("click", () => {
  const item = history[at];
  if (item && "global" in item && at > 0) step(-1);
  else closePane();
});
// The shared band runs straight across: the Workspace's head is as tall as the conversation's header.
const convHeader = document.querySelector<HTMLElement>(".conv-header");
if (convHeader) {
  new ResizeObserver(() => dom.app.style.setProperty("--conv-head-h", `${convHeader.offsetHeight}px`)).observe(convHeader);
}
// Esc closes the menu, else the Workspace, unless something else (mention menu, reply bar, a dialog) used it first.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (menu) return closeMenu();
  if (dom.pane.hidden || document.querySelector("dialog[open]")) return;
  closePane();
});

// Resizing: drag the Workspace's left edge; the width is kept per browser. Desktop only (the CSS hides the
// handle where the Workspace covers the conversation).
const WIDTH_KEY = "agent-bus.workspaceWidth";
const MIN_WIDTH = 320;
/** The conversation keeps at least this much (its message box must stay usable). */
const MIN_MAIN = 420;
/** The Workspace's width now: the dragged one, or the default's actual size. */
function currentWidth(): number {
  return parseInt(dom.app.style.getPropertyValue("--ws-width"), 10) || Math.round(dom.pane.getBoundingClientRect().width) || 420;
}

function setWidth(px: number): void {
  const max = Math.max(MIN_WIDTH, innerWidth - 280 - MIN_MAIN);
  const width = Math.round(Math.min(Math.max(px, MIN_WIDTH), max));
  dom.app.style.setProperty("--ws-width", `${width}px`);
  dom.wsResize.setAttribute("aria-valuenow", String(width));
  dom.wsResize.setAttribute("aria-valuemin", String(MIN_WIDTH));
  dom.wsResize.setAttribute("aria-valuemax", String(max));
  dom.wsReset.hidden = false;
}

function saveWidth(): void {
  const width = parseInt(dom.app.style.getPropertyValue("--ws-width"), 10);
  if (width > 0) localStorage.setItem(WIDTH_KEY, String(width));
}

function resetWidth(): void {
  localStorage.removeItem(WIDTH_KEY);
  dom.app.style.removeProperty("--ws-width");
  dom.wsResize.removeAttribute("aria-valuenow");
  dom.wsReset.hidden = true;
}

const savedWidth = Number(localStorage.getItem(WIDTH_KEY));
if (savedWidth > 0) setWidth(savedWidth);

// Dragging: a drag ends however the pointer goes away (up, cancelled by the system, capture lost), once.
dom.wsResize.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  dom.wsResize.setPointerCapture(event.pointerId);
  dom.app.classList.add("ws-resizing");
  const move = (e: PointerEvent) => setWidth(innerWidth - e.clientX);
  const finish = () => {
    dom.wsResize.removeEventListener("pointermove", move);
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) dom.wsResize.removeEventListener(type, finish);
    dom.app.classList.remove("ws-resizing");
    saveWidth();
  };
  dom.wsResize.addEventListener("pointermove", move);
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) dom.wsResize.addEventListener(type, finish);
});
// Keyboard: the edge is a focusable separator; ← widens, → narrows (16 px a step), Home or "Reset width" gives
// the default back. Double-click does too.
dom.wsResize.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    setWidth(currentWidth() + (event.key === "ArrowLeft" ? 16 : -16));
    saveWidth();
  } else if (event.key === "Home") {
    event.preventDefault();
    resetWidth();
  }
});
dom.wsResize.addEventListener("dblclick", resetWidth);
dom.wsReset.addEventListener("click", resetWidth);
