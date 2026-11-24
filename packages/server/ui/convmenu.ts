// The menu behind a conversation's name (Can #11463): its tab (pin, move; Can #11480) for every conversation, and for a
// group DM or project also members and adding people, my notifications there, leaving, turning a group DM into a
// project, a project's topic, visibility and name, archiving (POST /api/conversations/:id/…).
import type { Conversation, ConversationResponse, NotifyLevel, ProjectVisibility } from "@agent-bus/protocol";
import { postJson } from "./api";
import { closeWindowButton } from "./dialogs";
import { dom, PHONE } from "./dom";
import { errorText } from "./format";
import { h } from "./html";
import { loadState } from "./loading";
import { renderAll } from "./render";
import { navigate } from "./routing";
import { renderSidebar } from "./sidebar";
import { conversationTitle, state } from "./state";
import { isTab, moveTab, setTab } from "./tabs";

const NOTIFY: Array<[NotifyLevel, string]> = [
  ["all", "All messages"],
  ["mentions", "Only when I'm @mentioned"],
  ["none", "None"],
];
const VISIBILITY: Array<[ProjectVisibility, string]> = [
  ["open", "Open: anyone can find, read and join it"],
  ["discoverable", "Discoverable: its name and topic show under Other projects; a member adds people"],
  ["private", "Private: only members know it exists"],
];

function current(): Conversation | undefined {
  return state.view.kind === "conversation" ? state.conversations.get(state.view.id) : undefined;
}

/**
 * Does `action`; the dialog is drawn again after it. `consumed` names the fields this action used up (they start
 * empty or from the new state); every other field keeps what was typed in it (Can #12939: removing a member wiped
 * the room name being typed).
 */
async function act(conv: Conversation, action: string, body: Record<string, unknown>, consumed: string[] = []): Promise<void> {
  const error = dom.convDialog.querySelector<HTMLElement>(".composer-error");
  try {
    if (error) error.hidden = true;
    await postJson<ConversationResponse>(`/api/conversations/${encodeURIComponent(conv.id)}/${action}`, { from: state.me, ...body });
    await loadState();
    renderSidebar();
    if (action === "leave" || action === "delete") {
      dom.convDialog.close();
      navigate({ kind: "conversation", id: "all" });
      return;
    }
    renderAll();
    render(consumed);
  } catch (err) {
    if (error) {
      error.textContent = errorText(err);
      error.hidden = false;
    }
  }
}

/** A field whose text survives the dialog being drawn again (`act`), under `key`. */
function kept<T extends HTMLInputElement | HTMLSelectElement>(el: T, key: string): T {
  el.dataset.keep = key;
  return el;
}

/** People and agents picked to add in the ⋯ menu's member list, kept while the dialog redraws (Ümit #14102). */
let picking: { conv: string; ids: Set<string> } = { conv: "", ids: new Set() };

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = h("button", primary ? "btn btn-primary" : "btn", label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function select<T extends string>(options: Array<[T, string]>, value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = h("select");
  for (const [v, label] of options) {
    const o = h("option", "", label);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  s.addEventListener("change", () => onChange(s.value as T));
  return s;
}

/**
 * "None" or a root project to put `conv` under (one level only, Can 14 Nov). A project with projects or groups under
 * it stays a root: then the choice says so instead.
 */
function parentSelect(conv: Conversation): HTMLElement {
  const children = Array.from(state.conversations.values()).filter((c) => c.parentId === conv.id);
  if (children.length > 0) {
    return h("p", "dialog-hint", `A root project: ${children.length} ${children.length === 1 ? "is" : "are"} under it (${children.map((c) => conversationTitle(c)).join(", ")}).`);
  }
  const options: Array<[string, string]> = [["", conv.kind === "project" && !conv.room ? "None: a root project" : "None"]];
  for (const p of Array.from(state.conversations.values())
    .filter((c) => c.kind === "project" && !c.room && !c.preview && !c.parentId && c.id !== conv.id)
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))) {
    options.push([p.id, `@@${p.name}`]);
  }
  return select(options, conv.parentId ?? "", (parent) => void act(conv, "parent", { parent: parent || null }));
}

/** The short menu under the name (Can #11480, codex-ui #11492), when open. */
let nameMenu: HTMLElement | undefined;

function closeNameMenu(focusName = false): void {
  if (!nameMenu) return;
  nameMenu.remove();
  nameMenu = undefined;
  dom.convMenuBtn.setAttribute("aria-expanded", "false");
  if (focusName) dom.convMenuBtn.focus();
}

/**
 * The name's short menu (codex-ui #11492): the tab: Pin as tab, or Move tab left / right and Unpin tab. On a phone this
 * is the only way to unpin (the tabs there have no ✕). Settings have their own ⚙ beside the name (Ümit #12288).
 */
function openNameMenu(): void {
  const conv = current();
  closeNameMenu();
  if (!conv) return;
  const menu = h("div", "entry-menu name-menu");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", conversationTitle(conv));
  menu.addEventListener("click", (e) => e.stopPropagation());
  // ↑ ↓ Home End move among the items that can be chosen, round at the ends (codex-ui #11708); Esc closes.
  menu.addEventListener("keydown", (event) => {
    const moves: Record<string, (i: number, n: number) => number> = {
      ArrowDown: (i, n) => (i + 1) % n,
      ArrowUp: (i, n) => (i - 1 + n) % n,
      Home: () => 0,
      End: (_i, n) => n - 1,
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const items = [...menu.querySelectorAll<HTMLButtonElement>(".entry-menu-item:not(:disabled)")];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[move(at < 0 ? 0 : at, items.length)]?.focus();
  });
  const item = (label: string, run: () => void, disabled = false) => {
    const b = h("button", "entry-menu-item", label);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.disabled = disabled;
    b.addEventListener("click", () => {
      closeNameMenu(true);
      run();
    });
    menu.append(b);
  };
  // The phone header stays one quiet row: its secondary controls live under the name instead of crowding the room
  // title (Ümit #15991). Their original buttons still own the behavior and availability.
  if (PHONE.matches) {
    item("Search messages", () => dom.convSearchBtn.click());
    item("Members and details", () => dom.detailsBtn.click());
    if (!dom.convSettingsBtn.hidden) item("Conversation settings", () => dom.convSettingsBtn.click());
    if (!dom.checklistBtn.hidden) item("Pinned items", () => dom.checklistBtn.click());
    if (!dom.paneBtn.hidden) item("Workspace", () => dom.paneBtn.click());
  }
  if (isTab(conv.id)) {
    const i = state.tabs.indexOf(conv.id);
    item("‹ Move tab left", () => moveTab(conv.id, -1), i <= 0);
    item("Move tab right ›", () => moveTab(conv.id, 1), i >= state.tabs.length - 1);
    item("Unpin tab", () => void setTab(conv.id, false));
  } else {
    item("Pin as tab", () => void setTab(conv.id, true));
  }
  const r = dom.convMenuBtn.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - 228)))}px`;
  document.body.append(menu);
  nameMenu = menu;
  dom.convMenuBtn.setAttribute("aria-expanded", "true");
  menu.querySelector<HTMLButtonElement>(".entry-menu-item:not(:disabled)")?.focus();
}

document.addEventListener("click", () => closeNameMenu());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && nameMenu) closeNameMenu(true);
});
window.addEventListener("hashchange", () => closeNameMenu());

/**
 * ⚙ beside the name (Ümit #12288): the settings of a room, project or group, members and adding people first. On a
 * computer the add field takes the focus (Ümit #12287: where to add names was hard to find); a phone keeps its
 * keyboard down.
 */
dom.convSettingsBtn.addEventListener("click", () => {
  // Opened afresh: nothing typed the last time comes back.
  delete dom.convDialog.dataset.conv;
  render();
  if (!dom.convDialog.open) dom.convDialog.showModal();
  if (!PHONE.matches) dom.convDialog.querySelector<HTMLInputElement>(".member-search")?.focus();
});

/** The full settings form of a group DM or project (⚙ beside its name). Fields keep what was typed in them, except
 * those `consumed` by the action just done. */
function render(consumed: string[] = []): void {
  const conv = current();
  if (!conv || (conv.kind !== "group" && conv.kind !== "project")) {
    dom.convDialog.close();
    return;
  }
  const before = new Map<string, string>();
  if (dom.convDialog.dataset.conv === conv.id) {
    for (const el of dom.convDialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-keep]")) {
      if (el.dataset.keep && !consumed.includes(el.dataset.keep)) before.set(el.dataset.keep, el.value);
    }
  }
  dom.convDialog.dataset.conv = conv.id;
  const member = conv.members.includes(state.me);
  const head = h("div", "gpu-head");
  const close = button("✕", () => dom.convDialog.close());
  close.className = "link-btn dialog-x";
  close.title = "Close (Esc)";
  head.append(h("h2", "", conversationTitle(conv)), close);
  const body: HTMLElement[] = [head];

  body.push(h("h3", "", `Members (${conv.members.length})`));
  // Each member; agents get ✕ to take them out (Ümit, 16 Nov), for a person who is in it.
  const list = h("div", "member-chips");
  const humans = new Set(state.humans);
  for (const id of conv.members) {
    const chip = h("span", "member-chip", id);
    if (member && !humans.has(id)) {
      const x = h("button", "member-remove", "✕");
      x.type = "button";
      x.title = `Remove @${id} from ${conversationTitle(conv)}`;
      x.addEventListener("click", () => {
        if (confirm(`Remove @${id} from ${conversationTitle(conv)}? It stops getting its messages; you can add it again.`)) void act(conv, "remove", { id });
      });
      chip.append(x);
    }
    list.append(chip);
  }
  body.push(list);
  if (member) {
    // Add members by picking them from a list, as Forward does (Ümit #14102: typing ids, with only the keyboard's
    // suggestions, was hard on the phone). Search narrows it; a tap picks or unpicks; Add adds the picked ones.
    if (picking.conv !== conv.id) picking = { conv: conv.id, ids: new Set() };
    const search = kept(h("input", "forward-search member-search"), "add");
    search.type = "search";
    search.placeholder = "Find a person or agent";
    search.setAttribute("aria-label", "Find a person or agent to add");
    search.autocomplete = "off";
    const choices = h("ul", "forward-choices member-choices");
    choices.setAttribute("role", "listbox");
    choices.setAttribute("aria-multiselectable", "true");
    const candidates = state.participants
      .filter((p) => !conv.members.includes(p.id))
      .sort((a, b) => Number(b.kind === "human") - Number(a.kind === "human") || Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
    const addBtn = button("Add", () => {
      const ids = [...picking.ids];
      if (ids.length === 0) return;
      picking.ids = new Set();
      void act(conv, "members", { ids }, ["add"]);
    }, true);
    const draw = (): void => {
      const q = search.value.trim().toLowerCase().replace(/^@+/, "");
      const shown = candidates.filter((p) => !q || p.id.includes(q) || picking.ids.has(p.id));
      choices.replaceChildren(
        ...(shown.length === 0
          ? [h("li", "forward-empty", candidates.length === 0 ? "Everyone on the bus is in it already." : "Nobody by that name.")]
          : shown.map((p) => {
              const on = picking.ids.has(p.id);
              const li = h("li", on ? "forward-choice selected" : "forward-choice");
              li.setAttribute("role", "option");
              li.setAttribute("aria-selected", String(on));
              const where = p.kind === "human" ? "person" : `agent · ${p.online ? "online" : "offline"}${p.host ? ` · ${p.host.split(".")[0]}` : ""}`;
              li.append(h("span", "forward-label", `${on ? "✓ " : ""}${p.id}`), h("span", "forward-hint", where));
              li.addEventListener("click", () => {
                if (picking.ids.has(p.id)) picking.ids.delete(p.id);
                else picking.ids.add(p.id);
                draw();
              });
              return li;
            }))
      );
      const n = picking.ids.size;
      addBtn.textContent = n === 0 ? "Add" : `Add ${[...picking.ids].map((id) => `@${id}`).join(", ")}`;
      addBtn.disabled = n === 0;
    };
    search.addEventListener("input", draw);
    // Enter picks the first one shown, as a tap would.
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      (choices.querySelector<HTMLLIElement>(".forward-choice:not(.selected)") ?? choices.querySelector<HTMLLIElement>(".forward-choice"))?.click();
    });
    draw();
    const row = h("div", "conv-row");
    row.append(addBtn);
    body.push(search, choices, row, h("p", "dialog-hint", "Agents you add first get the last 5 messages."));

    body.push(h("h3", "", "Under project"), parentSelect(conv));

    body.push(h("h3", "", "My notifications here"));
    body.push(select(NOTIFY, conv.notify?.[state.me] ?? "all", (level) => void act(conv, "notify", { level })));

    if (conv.kind === "group") {
      body.push(h("h3", "", "Turn into a project"), h("p", "dialog-hint", "A name others can find and join; members and history stay."));
      const name = kept(h("input"), "project-name");
      name.type = "text";
      name.placeholder = "project-name";
      const row2 = h("div", "conv-row");
      row2.append(name, button("Turn into project", () => void act(conv, "project", { name: name.value.trim().toLowerCase() }, ["project-name"]), true));
      body.push(row2);
      // A room (Can, 15 Nov): a named conversation, addressed only as #name, optionally under a project; stays private.
      body.push(h("h3", "", "Turn into a room"), h("p", "dialog-hint", "A name (#name), optionally under a project; it stays private to its members."));
      const roomName = kept(h("input"), "room-name");
      roomName.type = "text";
      roomName.placeholder = "room-name (#room-name)";
      const roomParent = kept(h("select"), "room-parent");
      roomParent.append(new Option("No parent project", ""));
      for (const p of Array.from(state.conversations.values())
        .filter((c) => c.kind === "project" && !c.room && !c.preview && !c.parentId)
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))) {
        roomParent.append(new Option(`@@${p.name}`, p.id));
      }
      // Name on its own row: beside the parent picker it was squeezed to nothing (Can, 15 Nov).
      const row5 = h("div", "conv-row");
      row5.append(roomName);
      const row6 = h("div", "conv-row");
      row6.append(
        roomParent,
        button("Turn into room", () => void act(conv, "room", { name: roomName.value.trim().toLowerCase().replace(/^#/, ""), ...(roomParent.value ? { parent: roomParent.value } : {}) }, ["room-name", "room-parent"]), true)
      );
      body.push(row5, row6);
    } else {
      body.push(h("h3", "", conv.room ? "Room" : "Project"));
      const topic = kept(h("input"), "topic");
      topic.type = "text";
      topic.placeholder = "one line: what it is about";
      topic.value = conv.topic ?? "";
      const row3 = h("div", "conv-row");
      row3.append(topic, button("Set topic", () => void act(conv, "project", { topic: topic.value }, ["topic"])));
      body.push(row3, select(VISIBILITY, conv.visibility ?? "open", (visibility) => void act(conv, "project", { visibility })));
      // The name people read, and the address links and agents use (#10623): renaming changes the name only.
      const title = kept(h("input"), "title");
      title.type = "text";
      title.maxLength = 80;
      title.value = conv.title ?? "";
      title.placeholder = conv.name ?? "";
      title.setAttribute("aria-label", "Name");
      const row4 = h("div", "conv-row");
      row4.append(title, button("Rename", () => void act(conv, "project", { title: title.value }, ["title"])));
      const address = kept(h("input"), "address");
      address.type = "text";
      address.value = conv.name ?? "";
      address.setAttribute("aria-label", "Address");
      const row4b = h("div", "conv-row");
      row4b.append(
        address,
        button("Change address", () => {
          const next = address.value.trim().replace(/^[#@]+/, "").toLowerCase();
          const now = conv.room ? "#" : "@@";
          if (next && next !== conv.name && confirm(`Change the address ${now}${conv.name} to ${now}${next}? Old ${now}${conv.name} links and agents' notes stop working.`)) {
            void act(conv, "project", { name: next }, ["address"]);
          }
        })
      );
      body.push(
        h("p", "dialog-hint", "Name: what people read, any letters and spaces."),
        row4,
        h("p", "dialog-hint", `Address: how links and agents reach it (${conv.room ? "#" : "@@"}${conv.name}). Rarely changed.`),
        row4b
      );
      // Room ↔ project (Can, 15 Nov): only the address changes; a project with something under it stays a project.
      const hasChildren = Array.from(state.conversations.values()).some((c) => c.parentId === conv.id);
      if (conv.room) {
        body.push(
          h("p", "dialog-hint", `As a project it is @@${conv.name}: a place of its own; name, members and history stay.`),
          button("Turn into a project", () => {
            if (confirm(`Turn #${conv.name} into the project @@${conv.name}? Agents then write to @@${conv.name}.`)) void act(conv, "room", { room: false });
          })
        );
      } else if (!hasChildren) {
        body.push(
          h("p", "dialog-hint", `As a room it is #${conv.name}: sub-work, which can go under another project.`),
          button("Turn into a room", () => {
            if (confirm(`Turn @@${conv.name} into the room #${conv.name}? Agents then write to #${conv.name}.`)) void act(conv, "room", { room: true });
          })
        );
      }
    }

    const footer = h("div", "dialog-actions");
    footer.append(
      button(conv.archived ? "Bring back" : "Archive", () => void act(conv, "archive", { archived: !conv.archived })),
      button(conv.kind === "project" ? (conv.room ? "Leave room" : "Leave project") : "Leave group", () => {
        if (confirm(`Leave ${conversationTitle(conv)}? You stop getting its messages; a member can add you again.`)) void act(conv, "leave", {});
      })
    );
    body.push(footer);
  } else {
    body.push(
      h(
        "p",
        "dialog-hint",
        conv.kind === "project" && conv.visibility !== "open"
          ? "You are not in it. A member can add you."
          : "You are not in it. Write a message to join."
      )
    );
  }
  // Deleting is for people, members or not (an emptied project has none), and only after typing the name.
  if (conv.kind === "project" && conv.name) {
    const name = conv.name;
    body.push(
      h("h3", "", "Delete"),
      h("p", "dialog-hint", "Gone for good: its messages, and their quotes elsewhere. What is under it becomes a root."),
      button(conv.room ? "Delete room…" : "Delete project…", () => {
        const typed = prompt(`Delete ${conversationTitle(conv)} and all its messages for good? Type its name to confirm.`);
        if (typed === null) return;
        if (typed.trim().replace(/^@@/, "").toLowerCase() !== name) {
          alert(`"${typed}" is not "${name}": nothing was deleted.`);
          return;
        }
        void act(conv, "delete", {});
      })
    );
  }
  const error = h("div", "composer-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  body.push(error, closeWindowButton(dom.convDialog));
  dom.convDialog.replaceChildren(...body);
  for (const el of dom.convDialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-keep]")) {
    const value = el.dataset.keep ? before.get(el.dataset.keep) : undefined;
    if (value !== undefined) {
      el.value = value;
      // A search kept across a redraw narrows its list again (the member picker).
      el.dispatchEvent(new Event("input"));
    }
  }
}

// The name opens its short menu (Can #11463, #11480), on every conversation (render.ts setNameMenu).
dom.convMenuBtn.addEventListener("click", (event) => {
  if (dom.convMenuBtn.classList.contains("no-menu")) return;
  event.stopPropagation();
  if (nameMenu) closeNameMenu();
  else openNameMenu();
});
