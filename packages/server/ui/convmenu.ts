// The menu behind a conversation's name (Can #11463): its tab (pin, move; Can #11480) for every conversation, and for a
// group DM or project also members and adding people, my notifications there, leaving, turning a group DM into a
// project, a project's topic, visibility and name, archiving (POST /api/conversations/:id/…).
import type { Conversation, ConversationResponse, NotifyLevel, ProjectVisibility } from "@agent-bus/protocol";
import { postJson } from "./api";
import { closeWindowButton } from "./dialogs";
import { dom } from "./dom";
import { errorText } from "./format";
import { h } from "./html";
import { loadState } from "./loading";
import { renderAll } from "./render";
import { navigate } from "./routing";
import { renderSidebar } from "./sidebar";
import { conversationTitle, state } from "./state";
import { isTab, moveTab, onTabsChange, setTab } from "./tabs";

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

async function act(conv: Conversation, action: string, body: Record<string, unknown>): Promise<void> {
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

/** The tab part (Can #11480): pin as tab or unpin it, and move it among my tabs (the keyboard's and the phone's way). */
function tabSection(conv: Conversation): HTMLElement[] {
  const on = isTab(conv.id);
  const row = h("div", "conv-row conv-tab-row");
  row.append(button(on ? "Unpin tab" : "Pin as tab", () => void setTab(conv.id, !on)));
  if (on) {
    const i = state.tabs.indexOf(conv.id);
    const left = button("‹ Move tab left", () => moveTab(conv.id, -1));
    const right = button("Move tab right ›", () => moveTab(conv.id, 1));
    left.disabled = i <= 0;
    right.disabled = i >= state.tabs.length - 1;
    row.append(left, right);
  }
  const hint = on
    ? "Unpinning removes only the tab; the conversation stays. A mouse can also drag the tab."
    : "A tab above the conversation, to come back to it in one click. Only you see your tabs.";
  return [h("h3", "", "Tab"), row, h("p", "dialog-hint", hint)];
}

function render(): void {
  const conv = current();
  if (!conv) {
    dom.convDialog.close();
    return;
  }
  const member = conv.members.includes(state.me);
  const head = h("div", "gpu-head");
  const close = button("✕", () => dom.convDialog.close());
  close.className = "link-btn";
  close.title = "Close (Esc)";
  head.append(h("h2", "", conversationTitle(conv)), close);
  const body: HTMLElement[] = [head, ...tabSection(conv)];
  // DMs and #all: their tab is all there is to it.
  if (conv.kind !== "group" && conv.kind !== "project") {
    dom.convDialog.replaceChildren(...body, closeWindowButton(dom.convDialog));
    return;
  }

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

    body.push(h("h3", "", "Under project"), parentSelect(conv));

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
      // A room (Can, 15 Nov): a named conversation, addressed only as #name, optionally under a project; stays private.
      body.push(h("h3", "", "Turn into a room"), h("p", "dialog-hint", "A name (#name), optionally under a project; it stays private to its members."));
      const roomName = h("input");
      roomName.type = "text";
      roomName.placeholder = "room-name (#room-name)";
      const roomParent = h("select");
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
        button("Turn into room", () => void act(conv, "room", { name: roomName.value.trim().toLowerCase().replace(/^#/, ""), ...(roomParent.value ? { parent: roomParent.value } : {}) }), true)
      );
      body.push(row5, row6);
    } else {
      body.push(h("h3", "", conv.room ? "Room" : "Project"));
      const topic = h("input");
      topic.type = "text";
      topic.placeholder = "one line: what it is about";
      topic.value = conv.topic ?? "";
      const row3 = h("div", "conv-row");
      row3.append(topic, button("Set topic", () => void act(conv, "project", { topic: topic.value })));
      body.push(row3, select(VISIBILITY, conv.visibility ?? "open", (visibility) => void act(conv, "project", { visibility })));
      // The name people read, and the address links and agents use (#10623): renaming changes the name only.
      const title = h("input");
      title.type = "text";
      title.maxLength = 80;
      title.value = conv.title ?? "";
      title.placeholder = conv.name ?? "";
      title.setAttribute("aria-label", "Name");
      const row4 = h("div", "conv-row");
      row4.append(title, button("Rename", () => void act(conv, "project", { title: title.value })));
      const address = h("input");
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
            void act(conv, "project", { name: next });
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
}

// The name opens it (Can #11463), where the conversation has one (render.ts setNameMenu).
dom.convMenuBtn.addEventListener("click", () => {
  if (dom.convMenuBtn.classList.contains("no-menu")) return;
  render();
  if (!dom.convDialog.open) dom.convDialog.showModal();
});

// Moving or unpinning (here, on the row, or on another of my pages) redraws the open menu's buttons.
onTabsChange(() => {
  if (dom.convDialog.open) render();
});
