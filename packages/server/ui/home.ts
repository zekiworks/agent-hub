// Right-pane extension "Home": a project's markdown page that its owner agent keeps current, newest
// first. Shown first in the pane on that project and in the DM with the agent it is named after (its home, @@<id>).
import type { Home } from "@agent-bus/protocol";
import { SESSION_KEY } from "./api";
import { errorText, relativeTime } from "./format";
import { h } from "./html";
import { renderMarkdown } from "./markdown";
import { refreshPane, registerExtension, renderPane } from "./pane";
import { directAgentOf, state, type View } from "./state";
import { mentionNodes } from "./text";

/** Per project: its Home, none, or loading (no entry: not asked yet). */
const homes = new Map<string, { home?: Home; none?: true; error?: string }>();

async function load(projectId: string): Promise<void> {
  homes.set(projectId, {});
  try {
    // fetch, not api(): a 404 ("no Home yet") is an answer, not an error.
    const res = await fetch(`/api/conversations/${encodeURIComponent(projectId)}/home`, {
      headers: { Authorization: `Bearer ${localStorage.getItem(SESSION_KEY) ?? ""}` },
    });
    if (res.status === 404) homes.set(projectId, { none: true });
    else if (!res.ok) throw new Error(`HTTP ${res.status}`);
    else homes.set(projectId, { home: (await res.json()) as Home });
  } catch (error) {
    homes.set(projectId, { error: errorText(error) });
  }
  refreshPane("home");
  renderPane();
}

/** The Home of `projectId` changed on the bus (live frame): fetched again. */
export function homeChanged(projectId: string): void {
  if (homes.has(projectId)) void load(projectId);
}

/** The project whose Home `view` shows: the project itself, or for an agent's DM its @@<agent id>. */
function projectOf(view: View): string | undefined {
  if (view.kind !== "conversation") return undefined;
  const conv = state.conversations.get(view.id);
  if (conv?.kind === "project") return conv.id;
  const agent = directAgentOf(view);
  if (!agent) return undefined;
  for (const c of state.conversations.values()) if (c.kind === "project" && !c.room && c.name === agent) return c.id;
  return undefined;
}

registerExtension({
  id: "home",
  order: -1,
  title: () => "Home",
  applies: (view) => {
    const id = projectOf(view);
    if (!id) return false;
    const entry = homes.get(id);
    if (!entry) void load(id);
    return !!entry?.home;
  },
  render: (body, view) => {
    const id = projectOf(view);
    const entry = id ? homes.get(id) : undefined;
    if (!entry?.home) return;
    const { home } = entry;
    const root = h("div", "home-page pane-pad");
    const article = h("div", "home-text msg-text");
    article.append(...renderMarkdown(home.text, mentionNodes));
    root.append(article, h("p", "check-foot", `@${home.owner}'s Home, updated ${relativeTime(home.updatedAt)}.`));
    body.replaceChildren(root);
  },
});
