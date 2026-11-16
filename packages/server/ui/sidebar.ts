// The sidebar: agents (a row is my DM with it), mentions, projects and group DMs, their filters and toggles.
import type { Conversation, Participant } from "@agent-bus/protocol";
import { dom } from "./dom";
import { postJson } from "./api";
import { agentDetail, errorText, nameList, relativeTime } from "./format";
import { h } from "./html";
import { renderLive } from "./live";
import { applyTitle, renderNotifyButton } from "./notify";
import { renderBackBadge } from "./phones";
import { navigate } from "./routing";
import {
  agents,
  browsableProjects,
  hasProjectColor,
  otherGroups,
  projectColor,
  sortedGroups,
  conversationAddress,
  conversationTitle,
  currentDirectAgent,
  dmWith,
  INCLUDE_OFFLINE_KEY,
  isCurrent,
  passesFilter,
  pinnedByMe,
  sortedConversations,
  sortedRooms,
  state,
  UNREAD_ONLY_KEY,
} from "./state";

/** How long an agent that went offline stays in the agent list (dimmed) when offline agents are hidden. */
const RECENTLY_SEEN_MS = 2 * 60_000;

/**
 * "zeki is working ···" under the messages, like Discord's typing line: the open conversation's agents that report
 * they are busy. Not for @all (some agent is always busy). The line keeps its height, so nothing jumps.
 */
function renderWorkingLine(): void {
  const view = state.view;
  const ids =
    view.kind === "draft"
      ? view.to
      : view.id === "all"
        ? []
        : (state.conversations.get(view.id)?.members ?? []);
  const busy = agents()
    .filter((a) => ids.includes(a.id) && a.online && a.status?.state === "busy")
    .map((a) => a.id);
  if (busy.length === 0) {
    dom.workingLine.replaceChildren();
    return;
  }
  const who = busy.length <= 3 ? nameList(busy) : `${busy.length} agents`;
  const dots = h("span", "working-dots");
  dots.append(h("span"), h("span"), h("span"));
  dom.workingLine.replaceChildren(dots, h("span", "", ` ${who} ${busy.length === 1 ? "is" : "are"} working`));
}

export function renderSidebar(): void {
  renderBackBadge();
  renderUnreadToggle();
  renderOfflineToggle();
  renderConversationList();
  renderAgentList();
  renderLive();
  renderWorkingLine();
  renderNotifyButton();
  applyTitle();
}

function renderOfflineToggle(): void {
  dom.offlineBtn.classList.toggle("on", state.includeOffline);
  dom.offlineBtn.setAttribute("aria-pressed", String(state.includeOffline));
  dom.offlineBtn.title = state.includeOffline
    ? "Showing offline agents and their conversations — click to hide them"
    : "Also show offline agents and the conversations with them (a message to an offline agent waits until it is back)";
}

dom.offlineBtn.addEventListener("click", () => {
  state.includeOffline = !state.includeOffline;
  localStorage.setItem(INCLUDE_OFFLINE_KEY, state.includeOffline ? "1" : "0");
  renderSidebar();
});

dom.newProjectBtn.addEventListener("click", () => {
  const raw = prompt("Project name (lowercase letters, digits, - and _):")?.trim().toLowerCase();
  if (!raw) return;
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(raw)) {
    alert(`"${raw}" is not a project name: lowercase letters, digits, - and _, at most 48.`);
    return;
  }
  const existing = Array.from(state.conversations.values()).find((c) => c.kind === "project" && c.name === raw);
  navigate(existing ? { kind: "conversation", id: existing.id } : { kind: "draft", to: [], project: raw });
});


dom.browseBtn.addEventListener("click", () => {
  state.browsing = !state.browsing;
  renderSidebar();
});

function renderUnreadToggle(): void {
  dom.unreadBtn.classList.toggle("on", state.unreadOnly);
  dom.unreadBtn.setAttribute("aria-pressed", String(state.unreadOnly));
  dom.unreadBtn.title = state.unreadOnly
    ? "Showing only conversations with unread messages — click to show all"
    : "Show only conversations with unread messages";
}

dom.unreadBtn.addEventListener("click", () => {
  state.unreadOnly = !state.unreadOnly;
  localStorage.setItem(UNREAD_ONLY_KEY, state.unreadOnly ? "1" : "0");
  renderSidebar();
});

function toggleFilter(agentId: string): void {
  if (!state.filter.delete(agentId)) state.filter.add(agentId);
  renderSidebar();
}

/** Small funnel icon for the agent filter toggle. */
function funnelIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2 3h12l-4.5 5.5V13l-3 1.5V8.5z");
  svg.append(path);
  return svg;
}

/** Unread messages for me directly (●●: they mention me, or a conversation of me and one other). */
function hasMention(conv: Conversation): boolean {
  return (state.urgent.get(conv.id) ?? 0) > 0;
}

/**
 * Mentions: conversations with unread ●● messages, newest first, whatever the filters (they are for me). Read, a
 * conversation goes back down to Conversations.
 */
function renderMentionList(): void {
  const mentions = Array.from(state.conversations.values())
    .filter(hasMention)
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  dom.mentionSection.hidden = mentions.length === 0;
  dom.mentionCount.textContent = mentions.length > 0 ? String(mentions.length) : "";
  dom.mentionList.replaceChildren(...mentions.map(conversationItem));
}

function conversationItem(conv: Conversation): HTMLLIElement {
  const li = h("li");
  const button = h("button", "side-item conv-item");
  button.type = "button";
  if (isCurrent(conv.id)) button.classList.add("active");
  const title = h("span", "side-item-title", conversationTitle(conv));
  // Second line (Can #10855, codex-ui #10856): no room type or privacy, that is for the room's details. A named room or
  // project shows its address, so two similar names stay apart (#10623); then its topic, if it has one, and the members.
  const parts =
    conv.kind === "all"
      ? ["everyone"]
      : conv.kind === "dm"
        ? ["DM"]
        : [
            ...(conv.kind === "project" && conv.title ? [conversationAddress(conv) ?? ""] : []),
            ...(conv.kind === "project" && conv.topic ? [conv.topic] : []),
            `${conv.members.length} member${conv.members.length === 1 ? "" : "s"}`,
          ];
  if (conv.kind !== "all" && !conv.members.includes(state.me)) parts.push("you're not in it");
  if (conv.archived) parts.push("archived");
  const meta = h("span", "side-item-detail", parts.join(" · "));
  if (hasProjectColor(conv)) {
    button.classList.add("conv-project");
    button.style.setProperty("--project-color", projectColor(conv));
  }
  if (conv.notify?.[state.me]) button.classList.add("conv-muted");
  const text = h("span", "side-item-text");
  // The time of the last message goes on the second line, at its end (Can #10852: in the first it hid the names);
  // there the description and member count give way to it.
  const second = h("span", "side-item-second");
  second.append(meta);
  const unread = state.unread.get(conv.id) ?? 0;
  if (unread === 0 && conv.lastMessageAt > 0) second.append(h("span", "side-item-time", relativeTime(conv.lastMessageAt)));
  text.append(title, second);
  button.append(text);
  if (unread > 0) {
    button.append(h("span", "badge", unread > 99 ? "99+" : String(unread)));
    if (hasMention(conv)) {
      const dots = h("span", "attention-dots");
      dots.append(h("span", "attention-dot"), h("span", "attention-dot"));
      dots.title = "For you directly: mentions you, or a conversation of just you and one other";
      button.append(dots);
    } else if ((state.attention.get(conv.id) ?? 0) > 0) {
      const dot = h("span", "attention-dot");
      dot.title = "In a conversation you are in";
      button.append(dot);
    }
  }
  // The whole name first: a long one is cut off in the list (Can #10852).
  button.title =
    conv.kind === "all" ? "#all: delivered to every agent" : `${conversationTitle(conv)}\nMembers: ${nameList(conv.members)}`;
  button.addEventListener("click", () => navigate({ kind: "conversation", id: conv.id }));
  li.append(button);
  if (conv.kind === "project" || conv.kind === "group") {
    if (pinnedByMe(conv)) li.append(h("span", "pin-mark", "📌"));
    li.append(entryMenuButton(conv));
  }
  return li;
}

/** Pins (or unpins) `conv` for me: first in its section, on every device (kept on the bus). */
async function setPinned(conv: Conversation, pinned: boolean): Promise<void> {
  const others = (conv.pinnedBy ?? []).filter((id) => id !== state.me);
  state.conversations.set(conv.id, { ...conv, pinnedBy: pinned ? [...others, state.me] : others });
  renderSidebar();
  try {
    await postJson(`/api/conversations/${encodeURIComponent(conv.id)}/pin`, { from: state.me, pinned });
  } catch (error) {
    state.conversations.set(conv.id, conv);
    renderSidebar();
    alert(`Could not ${pinned ? "pin" : "unpin"} it: ${errorText(error)}`);
  }
}

async function setArchived(conv: Conversation, archived: boolean): Promise<void> {
  try {
    await postJson(`/api/conversations/${encodeURIComponent(conv.id)}/archive`, { from: state.me, archived });
  } catch (error) {
    alert(`Could not ${archived ? "archive" : "bring back"} it: ${errorText(error)}`);
  }
}

/** The open entry menu, if any (one at a time). */
let openEntryMenu: HTMLElement | undefined;

function closeEntryMenu(): void {
  openEntryMenu?.remove();
  openEntryMenu = undefined;
}

document.addEventListener("click", closeEntryMenu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeEntryMenu();
});

/** ⋯ on a project, room or group in the sidebar (Can, 15 Nov): Pin/Unpin, and for its members Rename (projects and
 * rooms; Ümit #10496) and Archive. */
function entryMenuButton(conv: Conversation): HTMLButtonElement {
  const btn = h("button", "entry-btn", "⋯");
  btn.type = "button";
  btn.title = conv.kind === "project" ? `Pin, rename or archive ${conversationTitle(conv)}` : `Pin or archive ${conversationTitle(conv)}`;
  btn.setAttribute("aria-label", btn.title);
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    const wasOpen = openEntryMenu?.dataset.conv === conv.id;
    closeEntryMenu();
    if (wasOpen) return;
    const menu = h("div", "entry-menu");
    menu.dataset.conv = conv.id;
    // Clicks inside the menu (the rename field) must not close it.
    menu.addEventListener("click", (e) => e.stopPropagation());
    const item = (label: string, run: () => void, disabledWhy?: string) => {
      const b = h("button", "entry-menu-item", label);
      b.type = "button";
      if (disabledWhy) {
        b.disabled = true;
        b.title = disabledWhy;
      }
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        run();
      });
      menu.append(b);
    };
    const member = conv.members.includes(state.me);
    const pinned = pinnedByMe(conv);
    item(pinned ? "Unpin" : "Pin to the top", () => {
      closeEntryMenu();
      void setPinned(conv, !pinned);
    });
    if (conv.kind === "project") {
      const what = conv.room ? "room" : "project";
      item(member ? `Rename ${what}…` : `Rename ${what} (members only)`, () => renameIn(menu, conv), member ? undefined : `Only members of ${conversationTitle(conv)} rename it`);
    }
    if (member) {
      item(conv.archived ? "Bring back (unarchive)" : "Archive", () => {
        closeEntryMenu();
        void setArchived(conv, !conv.archived);
      });
    }
    const r = btn.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(r.right - 220, innerWidth - 228)))}px`;
    document.body.append(menu);
    openEntryMenu = menu;
  });
  return btn;
}

/**
 * The menu becomes a rename form: the current name filled in, Save or Cancel; Enter saves, Esc cancels. Renaming
 * changes the name people read, never the address (#10623): links and agents keep working.
 */
function renameIn(menu: HTMLElement, conv: Conversation): void {
  const address = conversationAddress(conv) ?? "";
  const form = h("form", "entry-rename");
  const label = h("label", "entry-rename-label", conv.room ? "Room name" : "Project name");
  const input = h("input");
  input.type = "text";
  input.maxLength = 80;
  input.value = conversationTitle(conv);
  input.autocomplete = "off";
  label.append(input);
  const hint = h("p", "entry-rename-hint", `Address stays ${address}`);
  const error = h("p", "entry-rename-error");
  error.hidden = true;
  error.setAttribute("role", "alert");
  const save = h("button", "btn btn-primary", "Save");
  save.type = "submit";
  const cancel = h("button", "btn", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", closeEntryMenu);
  const row = h("div", "entry-rename-actions");
  row.append(cancel, save);
  form.append(label, hint, error, row);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = input.value.replace(/\s+/g, " ").trim();
    if (title === conversationTitle(conv)) return closeEntryMenu();
    // Typing the address itself (or nothing) gives the address back as the name.
    const titleToSave = title === address || title === "" ? "" : title;
    save.disabled = true;
    try {
      await postJson(`/api/conversations/${encodeURIComponent(conv.id)}/project`, { from: state.me, title: titleToSave });
      closeEntryMenu();
    } catch (err) {
      error.textContent = errorText(err);
      error.hidden = false;
      save.disabled = false;
      input.focus();
    }
  });
  menu.replaceChildren(form);
  menu.classList.add("entry-menu-form");
  input.focus();
  input.select();
}

/** The open draft of a new project or group DM ("new — not sent yet"); a draft DM with an agent is its Agents row. */
function draftItem(): HTMLLIElement | undefined {
  const view = state.view;
  if (view.kind !== "draft" || (view.project === undefined && view.to.length < 2)) return undefined;
  const li = h("li");
  const button = h("button", "side-item conv-item active");
  button.type = "button";
  const text = h("span", "side-item-text");
  text.append(
    h("span", "side-item-title", view.project !== undefined ? `@@${view.project}` : nameList(view.to)),
    h("span", "side-item-detail", "new — not sent yet")
  );
  button.append(text);
  li.append(button);
  return li;
}

let otherRoomsOpen = false;
dom.otherRoomsBtn.addEventListener("click", () => {
  otherRoomsOpen = !otherRoomsOpen;
  renderSidebar();
});

function renderConversationList(): void {
  renderMentionList();
  const rooms = sortedRooms().filter((c) => !hasMention(c) && passesFilter(c));
  dom.roomList.replaceChildren(...rooms.map(conversationItem));
  // Rooms I am not in (open or discoverable ones, and my archived ones), folded like Other projects.
  const otherRooms = browsableProjects(true);
  dom.otherRoomsBtn.hidden = otherRooms.length === 0;
  dom.otherRoomsBtn.textContent = `${otherRoomsOpen ? "▾" : "▸"} Other rooms (${otherRooms.length})`;
  dom.otherRoomsList.hidden = !otherRoomsOpen || otherRooms.length === 0;
  dom.otherRoomsList.replaceChildren(...(otherRoomsOpen ? otherRooms.map(conversationItem) : []));
  const conversations = sortedConversations().filter((c) => !hasMention(c));
  const shown = conversations.filter(passesFilter);
  renderFilterNote(conversations.filter((c) => !passesFilter(c)));
  const items = shown.map(conversationItem);
  const draft = draftItem();
  if (draft && state.view.kind === "draft" && state.view.project !== undefined) items.splice(1, 0, draft);
  if (state.unreadOnly && shown.every((c) => isCurrent(c.id))) {
    items.push(h("li", "side-empty", "No unread conversations."));
  } else if (!state.unreadOnly && state.filter.size > 0 && shown.every((c) => c.kind === "all")) {
    items.push(h("li", "side-empty", `No conversations with ${nameList([...state.filter])} yet.`));
  }
  dom.conversationList.replaceChildren(...items);
  const browsable = browsableProjects();
  dom.browseBtn.hidden = browsable.length === 0;
  dom.browseBtn.textContent = `${state.browsing ? "▾" : "▸"} Other projects (${browsable.length})`;
  dom.browseList.hidden = !state.browsing || browsable.length === 0;
  dom.browseList.replaceChildren(...(state.browsing ? browsable.map(conversationItem) : []));

  const groups = sortedGroups().filter((c) => !hasMention(c) && passesFilter(c));
  const groupItems = groups.map(conversationItem);
  if (draft && state.view.kind === "draft" && state.view.project === undefined) groupItems.unshift(draft);
  dom.groupList.replaceChildren(...(groupItems.length > 0 ? groupItems : [h("li", "side-empty", "No group conversations.")]));
  // Three folds, each with its own count (Can, 16 Nov), one open at a time.
  const folds = otherGroups();
  const parts: HTMLElement[] = [];
  for (const [key, label, title] of [
    ["agentGroups", "Agents' groups", "Group DMs of agents only; you can read them"],
    ["agentDms", "Agents' DMs", "DMs between two agents; you can read them"],
    ["archived", "Archived", "Archived group DMs and DMs: yours, and agents' ones"],
  ] as const) {
    const list = folds[key];
    if (list.length === 0) continue;
    const open = state.otherGroupsOpen === key;
    const btn = h("button", "link-btn browse-btn", `${open ? "▾" : "▸"} ${label} (${list.length})`);
    btn.type = "button";
    btn.title = title;
    btn.addEventListener("click", () => {
      state.otherGroupsOpen = open ? "" : key;
      renderSidebar();
    });
    parts.push(btn);
    if (open) {
      const ul = h("ul", "side-list");
      ul.append(...list.map(conversationItem));
      parts.push(ul);
    }
  }
  dom.groupFolds.replaceChildren(...parts);
}

/** "with @a, @b · clear", plus how many unread messages the filter hides. */
function renderFilterNote(hidden: Conversation[]): void {
  if (state.filter.size === 0) {
    dom.convFilter.hidden = true;
    return;
  }
  const hiddenUnread = hidden.reduce((n, c) => n + (state.unread.get(c.id) ?? 0), 0);
  const hiddenForMe = hidden.some((c) => (state.attention.get(c.id) ?? 0) > 0);
  const clear = h("button", "link-btn", "clear");
  clear.type = "button";
  clear.addEventListener("click", () => {
    state.filter.clear();
    renderSidebar();
  });
  const parts: Array<string | HTMLElement> = [`with ${nameList([...state.filter])} · `, clear];
  if (hiddenUnread > 0) {
    const note = h("span", hiddenForMe ? "filter-hidden filter-hidden-me" : "filter-hidden", ` · ${hiddenUnread} unread hidden`);
    parts.push(note);
  }
  dom.convFilter.replaceChildren(...parts);
  dom.convFilter.hidden = false;
}

/** The Agents section folded (Can, 15 Nov), per browser. Unread DMs from agents still show under Mentions. */
const AGENTS_FOLDED_KEY = "agent-bus.agentsFolded";
let agentsFolded = localStorage.getItem(AGENTS_FOLDED_KEY) === "1";

dom.agentsToggle.addEventListener("click", () => {
  agentsFolded = !agentsFolded;
  localStorage.setItem(AGENTS_FOLDED_KEY, agentsFolded ? "1" : "0");
  renderAgentList();
});

function renderAgentList(): void {
  dom.agentsToggle.textContent = `${agentsFolded ? "▸" : "▾"} Agents`;
  dom.agentsToggle.setAttribute("aria-expanded", agentsFolded ? "false" : "true");
  dom.agentList.hidden = agentsFolded;
  dom.offlineBtn.hidden = agentsFolded;
  const all = agents();
  // Agents seen in the last two minutes stay listed (dimmed while offline): an agent that keeps reconnecting would
  // otherwise blink in and out and shift every row below it.
  const recent = Date.now() - RECENTLY_SEEN_MS;
  const list = state.includeOffline ? all : all.filter((a) => a.online || a.lastSeenAt > recent || a.id === currentDirectAgent());
  const hosts = new Set(list.map((a) => a.host ?? ""));
  const showHost = hosts.size > 1;
  const active = currentDirectAgent();
  const online = all.filter((a) => a.online).length;
  dom.agentCount.textContent = all.length > 0 ? `${online}/${all.length} online` : "";
  if (list.length === 0) {
    dom.agentList.replaceChildren(h("li", "side-empty", all.length === 0 ? "No agents have joined yet." : "No agents online."));
    return;
  }
  dom.agentList.replaceChildren(
    ...list.map((agent) => {
      const li = h("li", "agent-row");
      const button = h("button", "side-item agent-item");
      button.type = "button";
      if (agent.id === active) button.classList.add("active");
      if (!agent.online) button.classList.add("offline");
      // Busy is an orange dot, not a "busy 14 min" line: a line that comes and goes made the column jump. The duration
      // is on the agent's page.
      const busy = agent.online && agent.status?.state === "busy";
      // Online without a status (Hermes reports none yet): a green ring, not the full green of "idle" (Can, 15 Nov).
      const unknown = agent.online && !agent.status;
      const dot = h("span", `dot ${busy ? "dot-busy" : unknown ? "dot-unknown" : agent.online ? "dot-on" : "dot-off"}`);
      const text = h("span", "side-item-text");
      const name = h("span", "side-item-title", agent.id);
      if (agent.connections > 1 && agent.online) name.append(h("span", "conn-count", ` ×${agent.connections}`));
      if (agent.connectionError) {
        const err = h("span", "agent-err", "ERR");
        err.title = agent.connectionError;
        name.append(" ", err);
      }
      text.append(name);
      const detail = agentDetail(agent, showHost);
      if (detail) text.append(h("span", "side-item-detail", detail));
      button.append(dot, text);
      // The row stands for my DM with it: its unread count shows here.
      const dm = dmWith(agent.id);
      const unread = dm ? (state.unread.get(dm.id) ?? 0) : 0;
      if (unread > 0) button.append(h("span", "badge", unread > 99 ? "99+" : String(unread)));
      const tip = [
        agent.id,
        agent.harness ? `harness: ${agent.harness}` : "",
        agent.path ? `path: ${agent.path}` : "",
        agent.host ? `host: ${agent.host}` : "",
        agent.connectionError ?? "",
        agent.online
          ? `${busy ? "busy" : unknown ? "busy or idle: not reported by its harness" : "idle"}, online (${agent.connections} connection${agent.connections === 1 ? "" : "s"})`
          : `last seen ${relativeTime(agent.lastSeenAt)}`,
        "Open its page for what it is doing now.",
      ];
      button.title = tip.filter(Boolean).join("\n");
      button.addEventListener("click", () => navigate(dm ? { kind: "conversation", id: dm.id } : { kind: "draft", to: [agent.id] }));
      const filtering = state.filter.has(agent.id);
      const filter = h("button", `agent-filter${filtering ? " on" : ""}`);
      filter.type = "button";
      filter.title = filtering
        ? `Showing only conversations with ${agent.id} — click to remove`
        : `Show only conversations with ${agent.id}`;
      filter.setAttribute("aria-pressed", String(filtering));
      filter.append(funnelIcon());
      filter.addEventListener("click", () => toggleFilter(agent.id));
      li.append(button, filter);
      return li;
    })
  );
}
