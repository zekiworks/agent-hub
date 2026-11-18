// Right-pane extension "Checklist": a conversation's checklist, the one place agents track the instructions people give
// them. Agents add steps under a heading naming the instruction
// (POST /api/conversations/:id/checklist/edit); each item shows who owns it, the message it came from, what blocks it
// and who ticked it. People who are members tick any item here and pin or unpin the list. Its tab shows wherever a
// list exists, pinned or not.
import type { Checklist, ChecklistItem } from "@agent-bus/protocol";
import { postJson, SESSION_KEY } from "./api";
import { setItemReply } from "./composer";
import { PHONE } from "./dom";
import { errorText, relativeTime } from "./format";
import { h } from "./html";
import { renderMarkdown } from "./markdown";
import { closePane, refreshPane, registerExtension, renderPane } from "./pane";
import { navigate } from "./routing";
import { isCurrent, state } from "./state";
import { mentionNodes } from "./text";

/** One line of markdown, inline (bold, code, links, #n, @mentions), as the website renders messages. */
function inline(text: string): Node[] {
  const nodes = renderMarkdown(text, mentionNodes);
  const only = nodes[0];
  return nodes.length === 1 && only instanceof HTMLElement && only.classList.contains("md-p") ? Array.from(only.childNodes) : nodes;
}

/**
 * ↩ on an item: opens the list's conversation replying to the item. The item shows above the message
 * box and goes in front of the message as a quote when it is sent; it is not written into the box, where taps added
 * it again and again.
 */
function replyToItem(conversationId: string, item: string): void {
  // On a phone the Workspace covers the conversation: it gives way to the message box.
  if (PHONE.matches) closePane();
  if (isCurrent(conversationId)) {
    setItemReply(conversationId, item);
    return;
  }
  // Switching conversations cancels any reply: this one is set after the switch.
  window.addEventListener("hashchange", () => setTimeout(() => setItemReply(conversationId, item), 0), { once: true });
  navigate({ kind: "conversation", id: conversationId });
}

/** Per conversation: its list, none, or loading (no entry: not asked yet). */
const lists = new Map<string, { list?: Checklist; none?: true; error?: string }>();
/** Per conversation, the latest load asked for: an answer to an earlier one is dropped. */
const loads = new Map<string, number>();

async function load(conversationId: string): Promise<void> {
  const generation = (loads.get(conversationId) ?? 0) + 1;
  loads.set(conversationId, generation);
  // A list on screen stays while its newer version loads.
  if (!lists.get(conversationId)?.list) lists.set(conversationId, {});
  let answer: { list?: Checklist; none?: true; error?: string };
  try {
    // fetch, not api(): a 404 ("no checklist here") is an answer, not an error.
    const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/checklist`, {
      headers: { Authorization: `Bearer ${localStorage.getItem(SESSION_KEY) ?? ""}` },
    });
    if (res.status === 404) answer = { none: true };
    else if (!res.ok) throw new Error(`HTTP ${res.status}`);
    else answer = { list: (await res.json()) as Checklist };
  } catch (error) {
    answer = { error: errorText(error) };
  }
  if (loads.get(conversationId) !== generation) return;
  // Never an older version over a newer one (a tick's answer may have come first).
  const shown = lists.get(conversationId)?.list;
  if (answer.list && shown && shown.version > answer.list.version) return;
  lists.set(conversationId, answer);
  refreshPane("checklist");
  renderPane(); // the tab appears (or goes) with the answer; the pin count follows `pinned`
}

/** The list of `conversationId` changed on the bus (live frame): fetched again. */
export function checklistChanged(conversationId: string): void {
  if (lists.has(conversationId)) void load(conversationId);
}

/** A newer list from the bus (the answer to a tick or a pin) replaces the shown one, unless a newer one came meanwhile. */
function show(conversationId: string, list: Checklist): void {
  const shown = lists.get(conversationId)?.list;
  if (shown && shown.version > list.version) return;
  lists.set(conversationId, { list });
  refreshPane("checklist");
  renderPane();
}

/** Whether the signed-in person ticks (any item) and pins this list: a member, or someone it is for. */
function mayTick(conversationId: string, list: Checklist): boolean {
  return !!state.conversations.get(conversationId)?.members.includes(state.me) || list.assignees.includes(state.me);
}

/** One item: its box, text, owner, source message, what blocks it, who ticked it, and ↩. */
function itemRow(conversationId: string, list: Checklist, item: ChecklistItem): HTMLLIElement {
  const li = h("li", "check-item");
  const box = h("input");
  box.type = "checkbox";
  box.checked = !!item.done;
  const allowed = mayTick(conversationId, list);
  box.disabled = !allowed;
  if (!allowed) box.title = "Members of this conversation tick its list";
  const label = h("label", "check-label");
  const text = h("span", "check-text");
  text.append(...inline(item.text));
  label.append(box, text);
  const reply = h("button", "check-reply", "↩");
  reply.type = "button";
  reply.title = "Reply to this item: it shows above the message box and is quoted when you send";
  reply.addEventListener("click", () => replyToItem(conversationId, item.text));
  li.append(label, reply);
  // Whose step it is and where it came from, under the text.
  const meta = h("div", "check-meta");
  if (item.owner) meta.append(h("span", "check-owner", `@${item.owner}`));
  if (item.source !== undefined) {
    const source = h("span", "check-source");
    source.append(...inline(`#${item.source}`));
    meta.append(source);
  }
  if (item.done) meta.append(h("span", "check-done-by", `✓ ${item.done.by} · ${relativeTime(item.done.at)}`));
  if (meta.childNodes.length > 0) li.append(meta);
  if (item.blocked) {
    const blocked = h("div", "check-blocked");
    blocked.append(h("strong", undefined, "Blocked: "), ...inline(item.blocked));
    li.append(blocked);
  }
  // The lines under an item of a markdown list, and more an agent wrote about it: muted, under the item.
  if (item.detail) {
    const detail = h("div", "check-detail");
    detail.append(...renderMarkdown(item.detail, mentionNodes));
    li.append(detail);
  }
  li.classList.toggle("done", box.checked);
  li.classList.toggle("blocked", !!item.blocked && !item.done);
  box.addEventListener("change", async () => {
    const done = box.checked;
    li.classList.toggle("done", done);
    li.querySelector(".check-error")?.remove();
    try {
      // The version on screen: a tick on a list someone changed meanwhile is refused, not applied to a reworded item.
      const updated = await postJson<Checklist>(`/api/conversations/${encodeURIComponent(conversationId)}/checklist/tick`, {
        from: state.me,
        id: item.id,
        done,
        base: list.version,
      });
      show(conversationId, updated);
    } catch (error) {
      box.checked = !done;
      li.classList.toggle("done", !done);
      const stale = /changed meanwhile/.test(errorText(error));
      li.append(h("span", "check-error", stale ? " The list changed meanwhile; it is shown again, look and tick again." : ` Not saved: ${errorText(error)}`));
      if (stale) void load(conversationId);
    }
  });
  return li;
}

/** Pin / Unpin (people who are members): an unpinned list leaves the pin count but stays here. */
function pinBar(conversationId: string, list: Checklist): HTMLElement {
  const bar = h("div", "check-pinbar");
  bar.append(h("span", "check-pinstate", list.pinned ? "📌 Pinned in this conversation" : "Not pinned: only here in the Workspace"));
  if (state.conversations.get(conversationId)?.members.includes(state.me)) {
    const button = h("button", "link-btn check-pin", list.pinned ? "Unpin" : "Pin");
    button.type = "button";
    button.title = list.pinned ? "Take the list out of this conversation's pinned things (it stays here)" : "Count the list among this conversation's pinned things";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        show(conversationId, await postJson<Checklist>(`/api/conversations/${encodeURIComponent(conversationId)}/checklist/pin`, { from: state.me, pinned: !list.pinned }));
      } catch (error) {
        button.disabled = false;
        button.textContent = `Not saved: ${errorText(error)}`;
      }
    });
    bar.append(button);
  }
  return bar;
}

registerExtension({
  id: "checklist",
  order: 5,
  title: () => "Checklist",
  applies: (view) => {
    if (view.kind !== "conversation") return false;
    const entry = lists.get(view.id);
    if (!entry) void load(view.id);
    return !!entry?.list;
  },
  render: (body, view) => {
    const entry = view.kind === "conversation" ? lists.get(view.id) : undefined;
    if (view.kind !== "conversation" || !entry?.list) return;
    const { list } = entry;
    const root = h("div", "checklist pane-pad");
    root.append(pinBar(view.id, list));
    if (list.title) {
      const title = h("h3", "check-title");
      title.append(...inline(list.title));
      root.append(title);
    }
    if (list.intro) {
      const intro = h("div", "check-intro");
      intro.append(...renderMarkdown(list.intro, mentionNodes));
      root.append(intro);
    }
    // Items under the same heading are next to each other (the bus keeps them so): one list per heading.
    let current: HTMLUListElement | undefined;
    let heading: string | undefined;
    for (const item of list.items) {
      if (!current || item.heading !== heading) {
        heading = item.heading;
        if (heading) {
          const h4 = h("h4", "check-heading");
          h4.append(...inline(heading));
          root.append(h4);
        }
        current = h("ul", "check-list");
        root.append(current);
      }
      current.append(itemRow(view.id, list, item));
    }
    if (list.items.length === 0) root.append(h("p", "check-note", "No items yet."));
    const forWhom = list.assignees.length > 0 ? ` For ${list.assignees.map((a) => `@${a}`).join(", ")}.` : "";
    root.append(h("p", "check-foot", `Started by @${list.creator}, updated ${relativeTime(list.updatedAt)} by @${list.updatedBy}.${forWhom} Ticks go back to the bus; the agents read them.`));
    body.replaceChildren(root);
  },
});

/** Items in `list`, and how many are done. */
export function checklistProgress(list: Checklist): { done: number; total: number } {
  return { done: list.items.filter((item) => item.done).length, total: list.items.length };
}

/** The checklist of `conversationId`, once known (asking for it the first time starts loading it). */
export function checklistOf(conversationId: string): Checklist | undefined {
  const entry = lists.get(conversationId);
  if (!entry) void load(conversationId);
  return entry?.list;
}

/** A checklist's name for lists of pinned things: its title, else its first heading, else "Checklist". */
export function checklistName(list: Checklist): string {
  return list.title ?? list.items.find((item) => item.heading)?.heading ?? "Checklist";
}
