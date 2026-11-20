// The Workspace: the right-hand area beside the conversation (docs/right-pane.md; Can, 16 Nov: "like a desktop").
// It holds tabs (Can #12898), one per thing opened in it, each named by what and whose: "Live · @webapp",
// "Checklist · #launch", "Your inbox". The tab opened last and not pinned is the passing one: the next thing opened
// replaces it, and an entity's follows the conversation on the left (Checklist · #launch becomes Checklist · #design;
// where the new one has none, it says so). Pinned tabs keep what they show, across conversations and reloads, in
// this browser. ✕ on a tab closes it; ✕ at the top hides the Workspace and keeps the pinned tabs. While the tab shown
// is about the conversation on the left, both headers share one tint (#10122).
import { dom } from "./dom";
import { h } from "./html";
import { conversationAddress, conversationTitle, hasProjectColor, projectColor, state, type View } from "./state";
import { setPhoneList } from "./phones";
import { navigate, viewHash } from "./routing";

export interface PaneExtension {
  id: string;
  /** Place among the entity's menu items, lowest first (modules load in no fixed order). */
  order: number;
  /** "global": a Workspace item of its own, opened by a button outside any conversation (Inbox, GPUs); "entity" (the
   * default): about the thing on the left. */
  scope?: "entity" | "global";
  /** Its name ("Live", "Checklist"), or a global one's heading ("Your inbox · 2 open"). */
  title(): string;
  /** Entity: whether it has something for this view (its menu item shows only then). Global: whether it is
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
  /**
   * What a tab of it is about, when that is not simply the conversation: Live is about one agent, the same in its DM,
   * a group with it, or a draft to it. Two tabs about the same subject are the same tab (Can #13093, #13103).
   */
  subject?(view: View): string | undefined;
}

/** A Workspace tab: extension `ext`, about `view` (a pinned entity tab), the conversation on the left (the passing
 * entity tab: no view), or nothing (a global extension). */
interface Tab {
  ext: string;
  view?: View;
  pinned: boolean;
}

const extensions: PaneExtension[] = [];

/** Open or hidden, and the pinned tabs, kept per browser. */
const OPEN_KEY = "agent-bus.paneOpen";
const PINNED_KEY = "agent-bus.workspaceTabs";

let open = localStorage.getItem(OPEN_KEY) === "1";
let tabs: Tab[] = [];
/** The tab shown, and the one shown before it (a global item closed with its button gives the Workspace back). */
let active: Tab | undefined;
/** The tab drawn as the active one: `active`, or the pinned tab standing for it (renderPane; Can #13093). */
let shownActive: Tab | undefined;
let before: Tab | undefined;
try {
  const saved = JSON.parse(localStorage.getItem(PINNED_KEY) ?? "null") as { tabs: Tab[]; active: number } | null;
  if (saved && Array.isArray(saved.tabs)) {
    tabs = saved.tabs.filter((t) => typeof t.ext === "string").map((t) => ({ ext: t.ext, view: t.view, pinned: true }));
    active = tabs[saved.active];
  }
} catch {
  // A broken entry: start without pinned tabs.
}

function save(): void {
  localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  const pinned = tabs.filter((t) => t.pinned);
  localStorage.setItem(PINNED_KEY, JSON.stringify({ tabs: pinned, active: active ? pinned.indexOf(active) : -1 }));
}

function extensionOf(tab: Tab): PaneExtension | undefined {
  return extensions.find((e) => e.id === tab.ext);
}

function isGlobal(tab: Tab): boolean {
  return extensionOf(tab)?.scope === "global";
}

/** What an entity tab is about: its own view if pinned, else the conversation on the left. */
function viewOf(tab: Tab): View {
  return tab.view ?? state.view;
}

/** Each tab's part of the body is its own, kept while hidden: switching tabs keeps scroll positions and selections. */
function keyOf(tab: Tab): string {
  return isGlobal(tab) ? `g:${tab.ext}` : `${tab.ext}:${tab.view ? viewHash(tab.view) : "here"}`;
}

/** The entity the Workspace's shown tab is about, if it shows one. */
export function paneView(): View | undefined {
  return open && active && !isGlobal(active) ? viewOf(active) : undefined;
}

/** The extension visible now, if any (for `shown`). */
let visibleId: string | undefined;

function setVisible(id: string | undefined): void {
  if (id === visibleId) return;
  const was = extensions.find((e) => e.id === visibleId);
  visibleId = id;
  was?.shown?.(false);
  extensions.find((e) => e.id === id)?.shown?.(true);
}

const hosts = new Map<string, HTMLElement>();
/** What each host last drew, so an unchanged one is not drawn again. */
const drawnFor = new Map<string, string>();

function hostOf(key: string): HTMLElement {
  let host = hosts.get(key);
  if (!host) {
    host = h("div", "pane-host");
    hosts.set(key, host);
    dom.paneBody.append(host);
  }
  return host;
}

export function registerExtension(extension: PaneExtension): void {
  extensions.push(extension);
  extensions.sort((a, b) => a.order - b.order);
}

/** The entity extensions `view` has (its "Workspace ▾" menu). */
export function entityExtensions(view: View): PaneExtension[] {
  return extensions.filter((e) => (e.scope ?? "entity") === "entity" && e.applies(view));
}

function activate(tab: Tab): void {
  if (active !== tab) before = active;
  active = tab;
  open = true;
  // Phones: opened from the conversation list (✉ Your inbox, GPUs), the Workspace must come in front of it.
  setPhoneList(false);
  save();
  renderPane();
}

/**
 * Opens extension `id`: a global one as its own tab, an entity one for the conversation on the left. One already open
 * for the same thing is shown again; otherwise the passing tab becomes this one (or one is added).
 */
export function openPane(id: string): void {
  const extension = extensions.find((e) => e.id === id);
  if (!extension) return;
  const global = extension.scope === "global";
  // A pinned tab about the same thing first, then the passing one (codex-ui #12902: reopening shows the tab open).
  const same =
    tabs.find((t) => t.ext === id && (global || (t.pinned && subjectKey(t) === subjectKey({ ext: id, pinned: false })))) ??
    tabs.find((t) => t.ext === id && !t.pinned);
  if (same) {
    drawnFor.delete(keyOf(same)); // something new to show (e.g. a file opened from a message): drawn afresh
    return activate(same);
  }
  const tab: Tab = { ext: id, pinned: false };
  // One passing tab of each kind: an entity's, and a global one (Your inbox, GPUs), so closing a global one with its
  // button gives back the entity's that was there (#10107).
  const passing = tabs.findIndex((t) => !t.pinned && isGlobal(t) === global);
  if (passing >= 0) tabs[passing] = tab;
  else tabs.push(tab);
  drawnFor.delete(keyOf(tab));
  activate(tab);
}

/** A global button (✉, a launcher): shows its tab, or, when that is the one shown, gives back what was shown before. */
export function toggleGlobal(id: string): void {
  if (globalShown(id) && active) {
    const leaving = active;
    if (!leaving.pinned) tabs = tabs.filter((t) => t !== leaving);
    active = before && tabs.includes(before) ? before : undefined;
    before = undefined;
    if (!active) open = false;
    save();
    renderPane();
  } else openPane(id);
}

/** Whether global extension `id` is the tab shown (its button is lit). */
export function globalShown(id: string): boolean {
  return open && !!active && active.ext === id && isGlobal(active);
}

/** Hides the Workspace; its pinned tabs stay for the next time. */
export function closePane(): void {
  open = false;
  save();
  renderPane();
}

function closeTab(tab: Tab): void {
  const at = tabs.indexOf(tab);
  tabs = tabs.filter((t) => t !== tab);
  hosts.get(keyOf(tab))?.remove();
  hosts.delete(keyOf(tab));
  drawnFor.delete(keyOf(tab));
  if (active === tab) active = (before && tabs.includes(before) ? before : undefined) ?? tabs[Math.max(0, at - 1)];
  if (!active) open = false;
  save();
  renderPane();
}

/** What a tab shows, for telling two tabs of the same thing apart: its extension's subject, else its conversation. */
function subjectKey(tab: Tab): string {
  const view = viewOf(tab);
  return `${tab.ext}:${extensionOf(tab)?.subject?.(view) ?? viewHash(view)}`;
}

/** Another pinned tab showing exactly what `tab` shows (same kind, same subject), if there is one. */
function pinnedTwin(tab: Tab): Tab | undefined {
  if (isGlobal(tab)) return undefined;
  const shows = subjectKey(tab);
  return tabs.find((t) => t !== tab && t.pinned && subjectKey(t) === shows);
}

/** Pins the tab to what it shows now (a passing entity tab keeps this conversation), or unpins it. */
function togglePin(tab: Tab): void {
  const oldKey = keyOf(tab);
  if (tab.pinned) {
    tab.pinned = false;
    // One passing tab of each kind: another one gives way.
    tabs = tabs.filter((t) => t === tab || t.pinned || isGlobal(t) !== isGlobal(tab));
    if (!isGlobal(tab)) tab.view = undefined;
  } else {
    // Already pinned once (a passing tab that followed the conversation onto a pinned one's): that one is shown
    // instead of a second copy (Can #13093: two "Live · @bariton-os").
    const twin = pinnedTwin(tab);
    if (twin) {
      tabs = tabs.filter((t) => t !== tab);
      return activate(twin);
    }
    tab.pinned = true;
    if (!isGlobal(tab)) tab.view = viewOf(tab);
  }
  // Its drawn part goes with it to its new name.
  const host = hosts.get(oldKey);
  if (host) {
    hosts.delete(oldKey);
    hosts.set(keyOf(tab), host);
    const drawn = drawnFor.get(oldKey);
    drawnFor.delete(oldKey);
    if (drawn) drawnFor.set(keyOf(tab), drawn);
  }
  save();
  renderPane();
}

/** Draws extension `id` again in the tab shown, if it is that one (its data changed). */
export function refreshPane(id: string): void {
  for (const tab of tabs) if (tab.ext === id) drawnFor.delete(keyOf(tab));
  renderPane();
}

/** Whose a tab is, with its sigil: "@webapp", "#launch", "@@docs", "can, umit". */
function subjectOf(view: View): string {
  if (view.kind === "draft") return view.project !== undefined ? `@@${view.project}` : view.to.map((id) => `@${id}`).join(", ");
  const conv = state.conversations.get(view.id);
  if (!conv) return "";
  if (conv.kind === "dm") return `@${conv.members.find((id) => id !== state.me) ?? conv.members[0]}`;
  return conversationAddress(conv) ?? conversationTitle(conv);
}

function labelOf(tab: Tab): string {
  const extension = extensionOf(tab);
  if (!extension) return tab.ext;
  return isGlobal(tab) ? extension.title() : `${extension.title()} · ${subjectOf(viewOf(tab))}`;
}

/** The tint both headers share while the Workspace shows the entity on the left: a project's own colour, else accent. */
function tintOf(view: View): string {
  const conv = view.kind === "conversation" ? state.conversations.get(view.id) : undefined;
  return conv && hasProjectColor(conv) ? projectColor(conv) : "var(--accent)";
}

function tabButton(tab: Tab): HTMLElement {
  const on = tab === shownActive;
  const el = h("div", `tab${on ? " active" : ""}${tab.pinned ? " pinned" : " passing"}`);
  const label = labelOf(tab);
  const openBtn = h("button", "tab-open", label);
  openBtn.type = "button";
  openBtn.setAttribute("role", "tab");
  openBtn.setAttribute("aria-selected", on ? "true" : "false");
  openBtn.tabIndex = on ? 0 : -1;
  const elsewhere = tab.pinned && !isGlobal(tab) && viewHash(viewOf(tab)) !== viewHash(state.view);
  openBtn.title = elsewhere && on ? `${label}: click again to open it on the left` : tab.pinned ? label : `${label} (follows the conversation; pin it to keep it)`;
  openBtn.addEventListener("click", () => {
    // The tab shown, about another conversation: a second click opens that one on the left.
    if (on && elsewhere) navigate(viewOf(tab));
    else activate(tab);
  });
  const pin = h("button", "tab-pin");
  pin.type = "button";
  pin.textContent = "📌";
  pin.title = tab.pinned ? "Unpin: it follows the conversation again, and is replaced by the next thing opened" : "Pin: keep this tab, with what it shows now";
  pin.setAttribute("aria-label", tab.pinned ? `Unpin ${label}` : `Pin ${label}`);
  pin.setAttribute("aria-pressed", tab.pinned ? "true" : "false");
  pin.tabIndex = -1;
  pin.addEventListener("click", () => togglePin(tab));
  const close = h("button", "tab-close", "✕");
  close.type = "button";
  close.title = `Close ${label}`;
  close.setAttribute("aria-label", `Close ${label}`);
  close.tabIndex = -1;
  close.addEventListener("click", () => closeTab(tab));
  el.append(openBtn, pin, close);
  return el;
}

/** Shows the Workspace as its tabs want it; called on every redraw of the page. */
export function renderPane(): void {
  // Tabs of extensions that are gone (not on this bus any more) go too.
  tabs = tabs.filter((t) => extensionOf(t));
  // Two pinned tabs of the same thing (pinned before #13093 was fixed, kept in the browser): the first one stays.
  const pinnedKeys = new Map<string, Tab>();
  for (const t of tabs.filter((t) => t.pinned && !isGlobal(t))) {
    const first = pinnedKeys.get(subjectKey(t));
    if (!first) pinnedKeys.set(subjectKey(t), t);
    else if (active === t) active = first;
  }
  tabs = tabs.filter((t) => !t.pinned || isGlobal(t) || pinnedKeys.get(subjectKey(t)) === t);
  if (active && !tabs.includes(active)) active = tabs[0];
  // A passing tab that has followed the conversation onto a pinned tab's subject would show the same thing twice
  // (Can #13093): it stays, to go on following, but only the pinned one shows and stands for it.
  const hidden = new Set(tabs.filter((t) => !t.pinned && !isGlobal(t) && pinnedTwin(t)));
  shownActive = active && hidden.has(active) ? pinnedTwin(active) : active;
  const tab = open ? active : undefined;
  const extension = tab ? extensionOf(tab) : undefined;
  const global = !!tab && isGlobal(tab);
  const view = tab && !global ? viewOf(tab) : state.view;
  // The Workspace shows the entity on the left: the same conversation, or the same subject (Live of the agent of the
  // open DM, pinned elsewhere): then the headers share a tint and Workspace ▾ ticks it (Can #13114).
  const linked = !!tab && !global && subjectKey(tab) === subjectKey({ ext: tab.ext, pinned: false });
  dom.pane.hidden = !extension;
  dom.app.classList.toggle("with-pane", !!extension);
  dom.app.classList.toggle("ws-linked", linked);
  dom.app.classList.toggle("ws-global", global);
  if (linked) dom.app.style.setProperty("--ws-tint", tintOf(view));
  renderOpenMenuButton(linked && extension ? extension.id : "");
  for (const listener of globalListeners) listener();
  if (!tab || !extension) {
    dom.paneTabs.replaceChildren();
    setVisible(undefined);
    return;
  }
  const focused = dom.paneTabs.contains(document.activeElement);
  dom.paneTabs.replaceChildren(...tabs.filter((t) => !hidden.has(t)).map(tabButton));
  if (focused) dom.paneTabs.querySelector<HTMLElement>(".tab.active .tab-open")?.focus();
  const key = keyOf(tab);
  for (const [k, host] of hosts) host.hidden = k !== key;
  const host = hostOf(key);
  host.hidden = false;
  // An entity's passing tab where the conversation on the left has none of it: said, not swapped for something else
  // (codex-ui #12902).
  if (!global && !extension.applies(view)) {
    drawnFor.set(key, `none:${viewHash(view)}`);
    host.replaceChildren(h("p", "doc-note pane-pad", `${subjectOf(view) || "This conversation"} has no ${extension.title()}.`));
    setVisible(undefined);
    return;
  }
  const drawn = global ? "global" : viewHash(view);
  // Drawn afresh when its subject changed, or when an extension that moves one element between tabs (Live, a page)
  // took it away from this one.
  if (drawnFor.get(key) !== drawn || host.childElementCount === 0) {
    drawnFor.set(key, drawn);
    extension.render(host, view);
  }
  setVisible(extension.id);
}

/** Global buttons (✉, launchers) redraw their lit state with the Workspace. */
const globalListeners: Array<() => void> = [];
export function onWorkspaceChange(listener: () => void): void {
  globalListeners.push(listener);
}

// "Workspace ▾" (#10215): the entity on the left lists what it has; choosing one opens it in a tab.
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
      openPane(e.id);
    });
    menu.append(item);
  }
  if (open && active) {
    const close = h("button", "entry-menu-item ws-menu-close", "Hide Workspace");
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

// Keyboard (codex-ui #12902): the tabs are one tab stop; ← → move between them, Home and End go to the ends, Delete
// closes the one shown.
dom.paneTabs.addEventListener("keydown", (event) => {
  if (!active) return;
  const at = tabs.indexOf(active);
  let next: Tab | undefined;
  if (event.key === "ArrowRight") next = tabs[(at + 1) % tabs.length];
  else if (event.key === "ArrowLeft") next = tabs[(at - 1 + tabs.length) % tabs.length];
  else if (event.key === "Home") next = tabs[0];
  else if (event.key === "End") next = tabs[tabs.length - 1];
  else if (event.key === "Delete") {
    event.preventDefault();
    closeTab(active);
    dom.paneTabs.querySelector<HTMLElement>(".tab.active .tab-open")?.focus();
    return;
  }
  if (!next) return;
  event.preventDefault();
  activate(next);
  dom.paneTabs.querySelector<HTMLElement>(".tab.active .tab-open")?.focus();
});
// ✕ at the top: hides the Workspace; the pinned tabs stay.
dom.paneClose.addEventListener("click", () => closePane());
// The shared band (#10122) runs straight across: the Workspace's head ends where the conversation's header does, the
// conversation tabs above that header included (they pushed it 33 px lower than the Workspace's head).
const convHeader = document.querySelector<HTMLElement>(".conv-header");
const tabRow = document.getElementById("tab-row");
if (convHeader) {
  const sync = () => dom.app.style.setProperty("--conv-head-h", `${convHeader.offsetHeight + (tabRow && !tabRow.hidden ? tabRow.offsetHeight : 0)}px`);
  const observer = new ResizeObserver(sync);
  observer.observe(convHeader);
  if (tabRow) observer.observe(tabRow);
}
// Esc closes the menu, else hides the Workspace, unless something else (mention menu, reply bar, a dialog) used it.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (menu) return closeMenu();
  if (dom.pane.hidden || document.querySelector("dialog[open]")) return;
  closePane();
});

// Resizing (#10103): drag the Workspace's left edge; the width is kept per browser. Desktop only (the CSS hides the
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

// Dragging: a drag ends however the pointer goes away (up, cancelled by the system, capture lost), once (#10400).
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
// Keyboard (#10400): the edge is a focusable separator; ← widens, → narrows (16 px a step), Home or "Reset width" gives
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
