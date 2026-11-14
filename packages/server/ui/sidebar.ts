// The sidebar: agents (a row is my DM with it), mentions, projects and group DMs, their filters and toggles.
import type { Conversation, Participant } from "@agent-bus/protocol";
import { dom } from "./dom";
import { agentDetail, nameList, relativeTime } from "./format";
import { h } from "./html";
import { renderAgentPanel } from "./live";
import { applyTitle, renderNotifyButton } from "./notify";
import { renderBackBadge } from "./phones";
import { navigate } from "./routing";
import {
  AGENT_DMS_KEY,
  agents,
  browsableProjects,
  conversationTitle,
  currentDirectAgent,
  dmWith,
  INCLUDE_OFFLINE_KEY,
  isCurrent,
  passesFilter,
  sortedConversations,
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
  renderAgentDmsToggle();
  renderConversationList();
  renderAgentList();
  renderAgentPanel();
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

function renderAgentDmsToggle(): void {
  dom.agentDmsBtn.classList.toggle("on", state.agentDms);
  dom.agentDmsBtn.setAttribute("aria-pressed", String(state.agentDms));
  dom.agentDmsBtn.title = state.agentDms
    ? "Showing agents' conversations without a person in them — click to hide them"
    : "Also show agents' conversations without a person in them (DMs and groups between agents)";
}

dom.agentDmsBtn.addEventListener("click", () => {
  state.agentDms = !state.agentDms;
  localStorage.setItem(AGENT_DMS_KEY, state.agentDms ? "1" : "0");
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
  const what =
    conv.kind === "project"
      ? (conv.topic ?? `${conv.visibility ?? "open"} project`)
      : conv.kind === "group"
        ? "group DM"
        : conv.kind === "dm"
          ? "DM"
          : "everyone";
  const meta = h(
    "span",
    "side-item-detail",
    conv.kind === "all" ? what : `${what} · ${conv.members.length} members${conv.members.includes(state.me) ? "" : " · you're not in it"}`
  );
  if (conv.kind === "project") button.classList.add("conv-project");
  if (conv.notify?.[state.me]) button.classList.add("conv-muted");
  const text = h("span", "side-item-text");
  text.append(title, meta);
  button.append(text);
  const unread = state.unread.get(conv.id) ?? 0;
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
  else if (conv.lastMessageAt > 0) button.append(h("span", "side-item-time", relativeTime(conv.lastMessageAt)));
  button.title = conv.kind === "all" ? "Delivered to every agent" : `Members: ${nameList(conv.members)}`;
  button.addEventListener("click", () => navigate({ kind: "conversation", id: conv.id }));
  li.append(button);
  return li;
}

function renderConversationList(): void {
  renderMentionList();
  const conversations = sortedConversations().filter((c) => !hasMention(c));
  const shown = conversations.filter(passesFilter);
  renderFilterNote(conversations.filter((c) => !passesFilter(c)));
  const items = shown.map(conversationItem);
  if (state.view.kind === "draft" && (state.view.project !== undefined || state.view.to.length > 1)) {
    const li = h("li");
    const button = h("button", "side-item conv-item active");
    button.type = "button";
    const text = h("span", "side-item-text");
    const title = state.view.project !== undefined ? `@@${state.view.project}` : nameList(state.view.to);
    text.append(h("span", "side-item-title", title), h("span", "side-item-detail", "new — not sent yet"));
    button.append(text);
    li.append(button);
    items.splice(1, 0, li);
  }
  if (state.unreadOnly && shown.every((c) => isCurrent(c.id))) {
    items.push(h("li", "side-empty", "No unread conversations."));
  } else if (!state.unreadOnly && state.filter.size > 0 && shown.every((c) => c.kind === "all")) {
    items.push(h("li", "side-empty", `No conversations with ${nameList([...state.filter])} yet.`));
  }
  dom.conversationList.replaceChildren(...items);
  const browsable = browsableProjects();
  dom.browseBtn.hidden = browsable.length === 0;
  dom.browseBtn.textContent = `${state.browsing ? "▾" : "▸"} Browse projects (${browsable.length})`;
  dom.browseList.hidden = !state.browsing || browsable.length === 0;
  dom.browseList.replaceChildren(...(state.browsing ? browsable.map(conversationItem) : []));
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

function renderAgentList(): void {
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
      const dot = h("span", `dot ${busy ? "dot-busy" : agent.online ? "dot-on" : "dot-off"}`);
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
          ? `${busy ? "busy" : "idle"}, online (${agent.connections} connection${agent.connections === 1 ? "" : "s"})`
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
