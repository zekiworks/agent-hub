// Right-pane extension "Checklist": a conversation's checklist (Ali's list of Can's tasks on @@personal-assistant).
// The owner agent publishes the markdown (PUT /api/conversations/:id/checklist); people tick items here, and the
// owner reads the ticks back. Its tab shows only where a list exists.
import type { Checklist } from "@agent-bus/protocol";
import { postJson, SESSION_KEY } from "./api";
import { errorText, relativeTime } from "./format";
import { h } from "./html";
import { refreshPane, registerExtension, renderPane } from "./pane";
import { state } from "./state";
import { mentionNodes } from "./text";

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
    // An item its owner marked done is shown so; people tick only open ones.
    box.disabled = doneByOwner;
    const label = h("label", "check-label");
    label.append(box, h("span", "check-text"));
    label.lastElementChild?.append(...mentionNodes(text));
    li.append(label);
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
  if (heading) return h("h4", "check-heading", heading[1]);
  if (!raw.trim()) return undefined;
  const p = h("p", "check-note");
  p.append(...mentionNodes(raw.trim()));
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
    root.append(h("p", "check-foot", `Written by @${list.updatedBy}, ${relativeTime(list.updatedAt)}. Ticks go back to the bus; @${list.updatedBy} reads them.`));
    body.replaceChildren(root);
  },
});
