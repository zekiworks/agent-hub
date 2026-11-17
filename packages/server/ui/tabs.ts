// Tabs above the conversation (Can #11463, #11480; codex-ui #11467, #11481, #11492): the conversations I pinned ("Pin
// as tab" in the name's menu and in the list: one set, kept per person on the bus), in my order. A click switches; on
// a wide screen ✕ unpins (only the shortcut goes) and a mouse drags one to a new place; the name's menu moves it left
// or right and unpins it (keyboard, and phones: there a finger on the row scrolls it, and the tabs have no ✕).
import { postJson } from "./api";
import { dom } from "./dom";
import { errorText } from "./format";
import { h } from "./html";
import { navigate } from "./routing";
import { conversationTitle, isCurrent, state } from "./state";

export function isTab(id: string): boolean {
  return state.tabs.includes(id);
}

/** My tabs as the bus has them now (a "tabs" frame: this page or another of mine changed them). */
export function tabsChanged(tabs: string[]): void {
  state.tabs = tabs;
  renderTabs();
}

/** Pins `id` as a tab (last) or unpins it; the conversation itself is untouched. */
export async function setTab(id: string, on: boolean): Promise<void> {
  const before = state.tabs;
  tabsChanged(on ? [...before.filter((t) => t !== id), id] : before.filter((t) => t !== id));
  try {
    await postJson(`/api/conversations/${encodeURIComponent(id)}/pin`, { from: state.me, pinned: on });
  } catch (error) {
    tabsChanged(before);
    alert(`Could not ${on ? "pin" : "unpin"} the tab: ${errorText(error)}`);
  }
}

async function saveOrder(order: string[]): Promise<void> {
  const before = state.tabs;
  tabsChanged(order);
  try {
    const res = await postJson<{ tabs: string[] }>("/api/tabs", { from: state.me, order });
    tabsChanged(res.tabs);
  } catch (error) {
    tabsChanged(before);
    alert(`Could not move the tab: ${errorText(error)}`);
  }
}

/** Moves tab `id` one place left (-1) or right (+1). */
export function moveTab(id: string, by: -1 | 1): void {
  const order = [...state.tabs];
  const i = order.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j] as string, order[i] as string];
  void saveOrder(order);
}

/** A mouse (or pen) drag of one tab: it follows the pointer, and lands between the tabs it is dropped among. */
let drag: { id: string; el: HTMLElement; startX: number; moved: boolean } | undefined;
/** The click that ends a drag must not switch to the dragged tab. */
let dragged = false;

function endDrag(drop: boolean): void {
  const d = drag;
  drag = undefined;
  if (!d) return;
  d.el.classList.remove("dragging");
  if (!d.moved) return;
  dragged = true;
  setTimeout(() => (dragged = false));
  const box = d.el.getBoundingClientRect();
  d.el.style.transform = "";
  if (!drop) return;
  const centre = box.left + box.width / 2;
  const others = [...dom.tabRow.querySelectorAll<HTMLElement>(".tab")].filter((t) => t !== d.el);
  const index = others.filter((t) => {
    const r = t.getBoundingClientRect();
    return r.left + r.width / 2 < centre;
  }).length;
  const order = state.tabs.filter((t) => t !== d.id);
  order.splice(index, 0, d.id);
  if (order.join() !== state.tabs.join()) void saveOrder(order);
}

function tabItem(id: string): HTMLElement {
  const conv = state.conversations.get(id);
  const title = conv ? conversationTitle(conv) : id;
  const current = isCurrent(id);
  const unread = state.unread.get(id) ?? 0;
  const tab = h("div", `tab${current ? " active" : ""}${unread > 0 && !current ? " unread" : ""}`);
  tab.dataset.id = id;
  const open = h("button", "tab-open", title);
  open.type = "button";
  open.title = unread > 0 ? `${title} (${unread} unread)` : title;
  if (current) open.setAttribute("aria-current", "page");
  open.addEventListener("click", () => {
    if (dragged) {
      dragged = false;
      return;
    }
    navigate({ kind: "conversation", id });
  });
  const close = h("button", "tab-close", "✕");
  close.type = "button";
  close.title = `Unpin the tab ${title} (the conversation stays)`;
  close.setAttribute("aria-label", close.title);
  close.addEventListener("click", () => void setTab(id, false));
  tab.append(open, close);
  tab.addEventListener("pointerdown", (event) => {
    // A finger on the row scrolls it (phones reorder in the name's menu); ✕ is not a handle. No pointer capture: it
    // would turn the plain click on the name into a click on the tab, and nothing would open.
    if (event.pointerType === "touch" || event.button !== 0 || (event.target as Element).closest(".tab-close")) return;
    drag = { id, el: tab, startX: event.clientX, moved: false };
    dragged = false;
  });
  return tab;
}

window.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const dx = event.clientX - drag.startX;
  if (!drag.moved && Math.abs(dx) < 6) return;
  drag.moved = true;
  drag.el.classList.add("dragging");
  drag.el.style.transform = `translateX(${dx}px)`;
});
window.addEventListener("pointerup", () => endDrag(true));
window.addEventListener("pointercancel", () => endDrag(false));

let shownActive: string | undefined;

/** Draws the row: hidden while I have no tabs (or no one is signed in). */
export function renderTabs(): void {
  if (drag) return;
  const ids = state.me ? state.tabs.filter((id) => state.conversations.has(id)) : [];
  dom.tabRow.hidden = ids.length === 0;
  dom.tabRow.replaceChildren(...ids.map(tabItem));
  // The open tab stays in view on a narrow screen, where the row scrolls sideways.
  const active = dom.tabRow.querySelector<HTMLElement>(".tab.active");
  const id = active?.dataset.id;
  if (active && id !== shownActive) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  shownActive = id;
}
