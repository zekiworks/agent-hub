// The ⋯ menu of a group DM or project: members and adding people, my notifications there, leaving, turning a group
// DM into a project, a project's topic, visibility and name, archiving (POST /api/conversations/:id/…).
import type { Conversation, ConversationResponse, NotifyLevel, ProjectVisibility } from "@agent-bus/protocol";
import { postJson } from "./api";
import { dom } from "./dom";
import { errorText, nameList } from "./format";
import { h } from "./html";
import { loadState } from "./loading";
import { renderAll } from "./render";
import { navigate } from "./routing";
import { renderSidebar } from "./sidebar";
import { conversationTitle, state } from "./state";

const NOTIFY: Array<[NotifyLevel, string]> = [
  ["all", "All messages"],
  ["mentions", "Only when I'm @mentioned"],
  ["none", "None"],
];
const VISIBILITY: Array<[ProjectVisibility, string]> = [
  ["open", "Open: anyone can find, read and join it"],
  ["discoverable", "Discoverable: its name and topic show under Browse; a member adds people"],
  ["private", "Private: only members know it exists"],
];

function current(): Conversation | undefined {
  return state.view.kind === "conversation" ? state.conversations.get(state.view.id) : undefined;
}

async function act(conv: Conversation, action: string, body: Record<string, unknown>): Promise<void> {
  const error = dom.convDialog.querySelector<HTMLElement>(".composer-error");
  try {
    if (error) error.hidden = true;
    await postJson<ConversationResponse>(`/api/conversations/${encodeURIComponent(conv.id)}/${action}`, { from: state.me, ...body });
    await loadState();
    renderSidebar();
    if (action === "leave") {
      dom.convDialog.close();
      navigate({ kind: "conversation", id: "all" });
      return;
    }
    renderAll();
    render();
  } catch (err) {
    if (error) {
      error.textContent = errorText(err);
      error.hidden = false;
    }
  }
}

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

function render(): void {
  const conv = current();
  if (!conv || (conv.kind !== "group" && conv.kind !== "project")) {
    dom.convDialog.close();
    return;
  }
  const member = conv.members.includes(state.me);
  const head = h("div", "gpu-head");
  const close = button("✕", () => dom.convDialog.close());
  close.className = "link-btn";
  close.title = "Close (Esc)";
  head.append(h("h2", "", conversationTitle(conv)), close);
  const body: HTMLElement[] = [head];

  body.push(h("h3", "", `Members (${conv.members.length})`), h("p", "dialog-hint", nameList(conv.members)));
  if (member) {
    const add = h("input");
    add.type = "text";
    add.placeholder = "ids to add, e.g. logic, turkce";
    const row = h("div", "conv-row");
    row.append(
      add,
      button("Add", () => {
        const ids = add.value.split(/[\s,]+/).map((s) => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
        if (ids.length > 0) void act(conv, "members", { ids });
      })
    );
    body.push(row, h("p", "dialog-hint", "Agents you add first get the last 5 messages."));

    body.push(h("h3", "", "My notifications here"));
    body.push(select(NOTIFY, conv.notify?.[state.me] ?? "all", (level) => void act(conv, "notify", { level })));

    if (conv.kind === "group") {
      body.push(h("h3", "", "Turn into a project"), h("p", "dialog-hint", "A name others can find and join; members and history stay."));
      const name = h("input");
      name.type = "text";
      name.placeholder = "project-name";
      const row2 = h("div", "conv-row");
      row2.append(name, button("Turn into project", () => void act(conv, "project", { name: name.value.trim().toLowerCase() }), true));
      body.push(row2);
    } else {
      body.push(h("h3", "", "Project"));
      const topic = h("input");
      topic.type = "text";
      topic.placeholder = "one line: what it is about";
      topic.value = conv.topic ?? "";
      const row3 = h("div", "conv-row");
      row3.append(topic, button("Set topic", () => void act(conv, "project", { topic: topic.value })));
      body.push(row3, select(VISIBILITY, conv.visibility ?? "open", (visibility) => void act(conv, "project", { visibility })));
      const rename = h("input");
      rename.type = "text";
      rename.value = conv.name ?? "";
      const row4 = h("div", "conv-row");
      row4.append(rename, button("Rename", () => void act(conv, "project", { name: rename.value.trim().toLowerCase() })));
      body.push(row4);
    }

    const footer = h("div", "dialog-actions");
    footer.append(
      button(conv.archived ? "Bring back" : "Archive", () => void act(conv, "archive", { archived: !conv.archived })),
      button("Leave", () => {
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
  const error = h("div", "composer-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  body.push(error);
  dom.convDialog.replaceChildren(...body);
}

dom.convMenuBtn.addEventListener("click", () => {
  render();
  if (!dom.convDialog.open) dom.convDialog.showModal();
});
