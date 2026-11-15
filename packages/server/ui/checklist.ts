// Right-pane extension "Checklist": a conversation's checklist (Ali's list of Can's tasks on @@personal-assistant).
// The owner agent publishes the markdown (PUT /api/conversations/:id/checklist); people tick items here, and the
// owner reads the ticks back. Its tab shows only where a list exists.
import type { Checklist } from "@agent-bus/protocol";
import { postJson, SESSION_KEY } from "./api";
import { autosize, updateComposerState } from "./composer";
import { dom } from "./dom";
import { saveDraft } from "./drafts";
import { errorText, relativeTime } from "./format";
import { h } from "./html";
import { renderMarkdown } from "./markdown";
import { refreshPane, registerExtension, renderPane } from "./pane";
import { navigate, viewHash } from "./routing";
import { state, type View } from "./state";
import { mentionNodes } from "./text";

/** One line of markdown, inline (bold, code, links, #n, @mentions), as the website renders messages (Can, 15 Nov). */
function inline(text: string): Node[] {
  const nodes = renderMarkdown(text, mentionNodes);
  const only = nodes[0];
  return nodes.length === 1 && only instanceof HTMLElement && only.classList.contains("md-p") ? Array.from(only.childNodes) : nodes;
}

/**
 * ↩ on an item (Can, 15 Nov): opens the list's conversation with the item quoted at the top of the message box, so
 * what is sent reaches its owner with the item it answers. Text already in the box stays below the quote.
 */
function replyToItem(conversationId: string, item: string): void {
  const view: View = { kind: "conversation", id: conversationId };
  const quote = () => {
    const rest = dom.input.value.trim();
    dom.input.value = `> ${item}\n\n${rest}`;
    saveDraft(view, dom.input.value);
    autosize();
    updateComposerState();
    dom.input.focus();
    dom.input.setSelectionRange(dom.input.value.length, dom.input.value.length);
  };
  if (location.hash === viewHash(view)) {
    quote();
    return;
  }
  // Switching conversations loads that one's draft into the box: the quote goes in after that.
  window.addEventListener("hashchange", () => setTimeout(quote, 0), { once: true });
  navigate(view);
}

/** Per conversation: its list, none, or loading (no entry: not asked yet). */
const lists = new Map<string, { list?: Checklist; none?: true; error?: string }>();

async function load(conversationId: string): Promise<void> {
  lists.set(conversationId, {});
  try {
    // fetch, not api(): a 404 ("no checklist here") is an answer, not an error.
    const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/checklist`, {
      headers: { Authorization: `Bearer ${localStorage.getItem(SESSION_KEY) ?? ""}` },
    });
    if (res.status === 404) lists.set(conversationId, { none: true });
    else if (!res.ok) throw new Error(`HTTP ${res.status}`);
    else lists.set(conversationId, { list: (await res.json()) as Checklist });
  } catch (error) {
    lists.set(conversationId, { error: errorText(error) });
  }
  refreshPane("checklist");
  renderPane(); // the tab appears (or goes) with the answer
}

/** The list of `conversationId` changed on the bus (live frame): fetched again. */
export function checklistChanged(conversationId: string): void {
  if (lists.has(conversationId)) void load(conversationId);
}

/** One line of the list's markdown: an item, a heading, or a plain line. */
function line(conversationId: string, list: Checklist, raw: string): HTMLElement | undefined {
  const item = /^\s*[-*] \[([ xX])\] (.+)$/.exec(raw);
  if (item) {
    const text = (item[2] ?? "").trim();
    const doneByOwner = item[1] !== " ";
    const tick = list.ticks[text];
    const li = h("li", "check-item");
    const box = h("input");
    box.type = "checkbox";
    box.checked = doneByOwner || !!tick;
    // An item its owner marked done is shown so; only the owner and the assignees tick (Can, 15 Nov).
    const mayTick = state.me === list.owner || list.assignees.includes(state.me);
    box.disabled = doneByOwner || !mayTick;
    if (!mayTick) box.title = `Only ${[list.owner, ...list.assignees].map((a) => `@${a}`).join(", ")} tick this list`;
    const label = h("label", "check-label");
    label.append(box, h("span", "check-text"));
    label.lastElementChild?.append(...inline(text));
    const reply = h("button", "check-reply", "↩");
    reply.type = "button";
    reply.title = "Reply to this item: opens its conversation with the item quoted";
    reply.addEventListener("click", () => replyToItem(conversationId, text));
    li.append(label, reply);
    if (tick) li.append(h("span", "check-meta", `✓ ${tick.by} · ${relativeTime(tick.at)}`));
    li.classList.toggle("done", box.checked);
    box.addEventListener("change", async () => {
      const done = box.checked;
      li.classList.toggle("done", done);
      try {
        const updated = await postJson<Checklist>(`/api/conversations/${encodeURIComponent(conversationId)}/checklist/tick`, {
          from: state.me,
          item: text,
          done,
        });
        lists.set(conversationId, { list: updated });
        refreshPane("checklist");
      } catch (error) {
        box.checked = !done;
        li.classList.toggle("done", !done);
        li.append(h("span", "check-error", ` Not saved: ${errorText(error)}`));
      }
    });
    return li;
  }
  const heading = /^\s*#{1,6}\s+(.+)$/.exec(raw);
  if (heading) {
    const h4 = h("h4", "check-heading");
    h4.append(...inline(heading[1] ?? ""));
    return h4;
  }
  if (!raw.trim()) return undefined;
  const p = h("p", "check-note");
  p.append(...inline(raw.trim()));
  return p;
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
    // Items are grouped into lists between headings and notes.
    let current: HTMLUListElement | undefined;
    for (const raw of list.text.split("\n")) {
      const node = line(view.id, list, raw);
      if (!node) continue;
      if (node.tagName === "LI") {
        if (!current) {
          current = h("ul", "check-list");
          root.append(current);
        }
        current.append(node);
      } else {
        current = undefined;
        root.append(node);
      }
    }
    const forWhom = list.assignees.length > 0 ? ` For ${list.assignees.map((a) => `@${a}`).join(", ")}.` : "";
    root.append(
      h("p", "check-foot", `@${list.owner}'s list, updated ${relativeTime(list.updatedAt)}.${forWhom} Ticks go back to the bus; @${list.owner} reads them.`)
    );
    body.replaceChildren(root);
  },
});
