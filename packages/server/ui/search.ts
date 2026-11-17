// Search (Can #11398, codex-ui #11399): a Workspace item of its own, opened from "🔍 Search" under ☆ Bookmarks. One box;
// results in two parts: rooms, projects, groups and people whose name matches (from what the page already has), and
// messages whose text matches (the bus's GET /api/search, as yourself: only conversations you may read). Scope: every
// conversation, or the one open on the left. The query, scope and results stay while you go and look at a match.
import type { Conversation, Message, ReadResponse } from "@agent-bus/protocol";
import { api } from "./api";
import { dom, PHONE } from "./dom";
import { errorText, relativeTime } from "./format";
import { hooks } from "./hooks";
import { h } from "./html";
import { closePane, globalShown, onWorkspaceChange, registerExtension, toggleGlobal } from "./pane";
import { navigate } from "./routing";
import { conversationAddress, conversationTitle, state } from "./state";

const MIN_CHARS = 2;
const LIMIT = 50;

let query = "";
let scope: "all" | "here" = "all";
let messages: Message[] = [];
let conversations = new Map<string, Conversation>();
let status = "";
let searched = "";
let timer: ReturnType<typeof setTimeout> | undefined;
let input: HTMLInputElement | undefined;
let results: HTMLElement | undefined;
let hereLabel: HTMLElement | undefined;

/** The conversation open on the left, for "This conversation". */
function here(): Conversation | undefined {
  return state.view.kind === "conversation" ? state.conversations.get(state.view.id) : undefined;
}

/**
 * Whether a name matches: case, spaces, "-" and "_" alike, a leading # or @ ignored, so "launch checklist" finds
 * #launch-checklist (codex-ui #11426 screenshots: it did not).
 */
function matches(text: string, q: string): boolean {
  const plain = (s: string) => s.toLowerCase().replace(/^[#@]+/, "").replace(/[\s_-]+/g, " ").trim();
  return plain(text).includes(plain(q));
}

/** The words around the first match, the match marked. */
function excerpt(text: string, q: string): HTMLElement {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(q.toLowerCase());
  const span = h("span", "search-excerpt");
  if (at < 0) {
    span.textContent = flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
    return span;
  }
  const start = Math.max(0, at - 60);
  const end = Math.min(flat.length, at + q.length + 100);
  span.append(
    `${start > 0 ? "…" : ""}${flat.slice(start, at)}`,
    h("mark", undefined, flat.slice(at, at + q.length)),
    `${flat.slice(at + q.length, end)}${end < flat.length ? "…" : ""}`
  );
  return span;
}

/** Phones: the Workspace covers the conversation, so opening a match leaves it, with the way back. */
function leave(): void {
  if (!PHONE.matches) return;
  dom.searchReturn.hidden = false;
  closePane();
}

function nameResults(q: string): HTMLElement[] {
  if (!q) return [];
  const out: HTMLElement[] = [];
  for (const conv of state.conversations.values()) {
    if (conv.preview || conv.kind === "dm") continue;
    const title = conversationTitle(conv);
    const address = conversationAddress(conv) ?? "";
    if (!matches(title, q) && !matches(address, q) && !(conv.kind === "group" && conv.members.some((m) => matches(m, q)))) continue;
    const button = h("button", "search-hit");
    button.type = "button";
    button.append(
      h("span", "search-hit-title", title),
      h("span", "search-hit-detail", [address && address !== title ? address : "", `${conv.members.length} member${conv.members.length === 1 ? "" : "s"}`].filter(Boolean).join(" · "))
    );
    button.addEventListener("click", () => {
      leave();
      navigate({ kind: "conversation", id: conv.id });
    });
    out.push(button);
  }
  for (const p of state.participants) {
    if (p.id === state.me || !matches(p.id, q)) continue;
    const button = h("button", "search-hit");
    button.type = "button";
    button.append(h("span", "search-hit-title", `@${p.id}`), h("span", "search-hit-detail", p.kind === "agent" ? `agent${p.online ? " · online" : ""}` : "person"));
    button.addEventListener("click", () => {
      leave();
      navigate({ kind: "draft", to: [p.id] });
    });
    out.push(button);
  }
  return out.slice(0, 12);
}

function renderResults(): void {
  if (!results) return;
  const q = query.trim();
  const parts: HTMLElement[] = [];
  const names = scope === "all" ? nameResults(q) : [];
  if (names.length > 0) {
    parts.push(h("h3", "search-heading", "Rooms and people"));
    const list = h("div", "search-list");
    list.append(...names);
    parts.push(list);
  }
  if (q.length >= MIN_CHARS) {
    parts.push(h("h3", "search-heading", scope === "here" ? `Messages in ${here() ? conversationTitle(here()!) : "this conversation"}` : "Messages"));
    if (status) parts.push(h("p", "check-note", status));
    else if (searched === q && messages.length === 0) parts.push(h("p", "check-note", "No messages found."));
    const list = h("div", "search-list");
    for (const message of [...messages].reverse()) {
      const conv = conversations.get(message.conversationId) ?? state.conversations.get(message.conversationId);
      const button = h("button", "search-hit");
      button.type = "button";
      button.append(
        h("span", "search-hit-title", `@${message.from}${conv ? ` · ${conversationTitle(conv)}` : ""} · #${message.seq} · ${relativeTime(message.createdAt)}`),
        excerpt(message.text || (message.files.length > 0 ? `(${message.files.map((f) => f.name).join(", ")})` : ""), q)
      );
      button.addEventListener("click", () => {
        leave();
        void hooks.showMessage(message.seq);
      });
      list.append(button);
    }
    parts.push(list);
    if (messages.length >= LIMIT) parts.push(h("p", "check-foot", `The newest ${LIMIT} matches; type more words to narrow it.`));
  } else if (q && names.length === 0) {
    parts.push(h("p", "check-note", `Type at least ${MIN_CHARS} letters to search messages.`));
  }
  if (!q) parts.push(h("p", "check-note", "Search the names of rooms, projects, groups and people, and the text of messages you can read."));
  results.replaceChildren(...parts);
}

async function run(): Promise<void> {
  const q = query.trim();
  if (q.length < MIN_CHARS) {
    messages = [];
    status = "";
    searched = "";
    renderResults();
    return;
  }
  const conv = scope === "here" ? here() : undefined;
  if (scope === "here" && !conv) {
    status = "Open a conversation on the left to search in it.";
    renderResults();
    return;
  }
  status = "Searching…";
  renderResults();
  const params = new URLSearchParams({ from: state.me, q, scope: "all", limit: String(LIMIT), ...(conv ? { conversationId: conv.id } : {}) });
  try {
    const res = await api<ReadResponse>(`/api/search?${params}`);
    if (query.trim() !== q) return; // a newer query is on its way
    messages = res.messages;
    conversations = new Map(res.conversations.map((c) => [c.id, c]));
    status = "";
    searched = q;
  } catch (error) {
    status = `Search failed: ${errorText(error)}`;
  }
  renderResults();
}

registerExtension({
  id: "search",
  order: 42,
  scope: "global",
  title: () => "Search",
  applies: () => !!state.me,
  render: (body) => {
    const root = h("div", "search pane-pad");
    input = h("input", "search-input");
    input.type = "search";
    input.placeholder = "Search rooms, people and messages";
    input.setAttribute("aria-label", "Search");
    input.value = query;
    input.addEventListener("input", () => {
      query = input?.value ?? "";
      clearTimeout(timer);
      renderResults();
      timer = setTimeout(() => void run(), 300);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      clearTimeout(timer);
      void run();
    });
    const scopes = h("div", "search-scopes");
    scopes.setAttribute("role", "radiogroup");
    scopes.setAttribute("aria-label", "Where to search");
    for (const [value, label] of [["all", "All conversations"], ["here", "This conversation"]] as const) {
      const option = h("label", "search-scope");
      const radio = h("input");
      radio.type = "radio";
      radio.name = "search-scope";
      radio.value = value;
      radio.checked = scope === value;
      radio.addEventListener("change", () => {
        scope = value;
        void run();
      });
      const text = h("span", undefined, label);
      if (value === "here") hereLabel = text;
      option.append(radio, text);
      scopes.append(option);
    }
    results = h("div", "search-results");
    root.append(input, scopes, results);
    body.replaceChildren(root);
    renderHereLabel();
    renderResults();
    if (!PHONE.matches) queueMicrotask(() => input?.focus());
  },
});

function renderHereLabel(): void {
  const conv = here();
  if (hereLabel) hereLabel.textContent = conv ? `This conversation (${conversationTitle(conv)})` : "This conversation";
}

onWorkspaceChange(() => {
  const on = globalShown("search");
  dom.searchRow.hidden = !state.me;
  dom.searchRow.classList.toggle("active", on);
  dom.searchRow.setAttribute("aria-pressed", on ? "true" : "false");
  if (on) dom.searchReturn.hidden = true;
  renderHereLabel();
});
dom.searchRow.addEventListener("click", () => toggleGlobal("search"));
dom.searchReturn.addEventListener("click", () => toggleGlobal("search"));
// A new conversation on the left changes what "This conversation" searches.
window.addEventListener("hashchange", () => {
  if (scope === "here" && query.trim().length >= MIN_CHARS) void run();
});
