// The New group dialog, and the same dialog as New room (Ümit, 16 Nov): a name, an optional parent project, the people
// and agents in it, and a first message; the room is made in one go, private (its members chose each other).
import type { ConversationResponse, PostMessageResponse } from "@agent-bus/protocol";
import { postJson } from "./api";
import { dom } from "./dom";
import { agentDetail, errorText, sortedUnique } from "./format";
import { h } from "./html";
import { navigate } from "./routing";
import { agents, state } from "./state";

/** The dialog is open as New room (else New group). */
let roomMode = false;

function openGroupDialog(asRoom = false): void {
  if (!state.me) return;
  roomMode = asRoom;
  dom.groupHeading.textContent = asRoom ? "New room" : "New group";
  dom.groupOpen.textContent = asRoom ? "Open room" : "Open conversation";
  dom.roomFields.hidden = !asRoom;
  if (asRoom) {
    dom.roomName.value = "";
    dom.roomFirst.value = "";
    dom.roomParent.replaceChildren(new Option("No project", ""));
    for (const p of Array.from(state.conversations.values())
      .filter((c) => c.kind === "project" && !c.room && !c.parentId && !c.archived)
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))) {
      dom.roomParent.append(new Option(`@@${p.name}`, p.id));
    }
  }
  dom.groupError.hidden = true;
  const choices: { id: string; detail: string; dot: string }[] = [
    ...agents().map((a) => ({ id: a.id, detail: agentDetail(a, true), dot: a.online ? "dot-on" : "dot-off" })),
    ...state.humans.filter((id) => id !== state.me).map((id) => ({ id, detail: "human", dot: "dot-human" })),
  ];
  if (choices.length === 0) {
    dom.groupChoices.replaceChildren(h("li", "side-empty", "Nobody else is on the bus yet."));
  } else {
    dom.groupChoices.replaceChildren(
      ...choices.map((choice) => {
        const li = h("li");
        const label = h("label", "group-choice");
        const box = h("input");
        box.type = "checkbox";
        box.value = choice.id;
        const text = h("span", "side-item-text");
        text.append(h("span", "side-item-title", choice.id), h("span", "side-item-detail", choice.detail));
        label.append(box, h("span", `dot ${choice.dot}`), text);
        li.append(label);
        return li;
      })
    );
  }
  dom.groupDialog.showModal();
}

dom.newGroupBtn.addEventListener("click", () => openGroupDialog(false));
dom.newRoomBtn.addEventListener("click", () => openGroupDialog(true));

/** Makes the room: its first message to "#name" creates it; then its members, its parent, and private. */
async function openRoom(picked: string[]): Promise<void> {
  const name = dom.roomName.value.trim().toLowerCase().replace(/^#/, "");
  const text = dom.roomFirst.value.trim();
  const fail = (why: string) => {
    dom.groupError.textContent = why;
    dom.groupError.hidden = false;
  };
  if (!name) return fail("Give the room a name.");
  if (!text) return fail("Write a first message: what is this room for?");
  try {
    const res = await postJson<PostMessageResponse>("/api/messages", { from: state.me, to: `#${name}`, text });
    const id = res.conversation.id;
    const action = (what: string, body: Record<string, unknown>) =>
      postJson<ConversationResponse>(`/api/conversations/${encodeURIComponent(id)}/${what}`, { from: state.me, ...body });
    if (picked.length > 0) await action("members", { ids: picked });
    if (dom.roomParent.value) await action("parent", { parent: dom.roomParent.value });
    await action("project", { visibility: "private" });
    dom.groupDialog.close();
    navigate({ kind: "conversation", id });
  } catch (error) {
    fail(errorText(error));
  }
}
dom.groupCancel.addEventListener("click", () => dom.groupDialog.close());
dom.groupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const picked = Array.from(dom.groupChoices.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")).map(
    (box) => box.value
  );
  if (roomMode) {
    void openRoom(picked);
    return;
  }
  if (picked.length === 0) {
    dom.groupError.textContent = "Pick at least one participant.";
    dom.groupError.hidden = false;
    return;
  }
  dom.groupDialog.close();
  navigate({ kind: "draft", to: sortedUnique(picked) });
  dom.input.focus();
});
