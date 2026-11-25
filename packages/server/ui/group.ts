// The New group dialog, and the same dialog as New room (Ümit, 16 Nov): a name, an optional parent project, the people
// and agents in it, and a first message; the room is made in one go, private (its members chose each other).
import { slugFromTitle, type ConversationResponse, type PostMessageResponse } from "@agent-bus/protocol";
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
    showAddress();
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
    dom.groupChoices.replaceChildren(h("li", "side-empty", "Nobody else is on the Hub yet."));
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

/**
 * The address a name gets (#10623): "Model Research" → "model-research"; when a project or room this person can see
 * already has it, "-2", "-3"… Names others keep private are found out at creation (the bus refuses them).
 */
function addressesFor(title: string): string[] {
  const base = slugFromTitle(title);
  if (!/[a-z]/.test(base)) return [];
  const taken = new Set(Array.from(state.conversations.values(), (c) => (c.kind === "project" ? c.name : undefined)));
  const out: string[] = [];
  for (let n = 1; out.length < 6 && n < 50; n++) {
    const candidate = n === 1 ? base : `${base.slice(0, 45)}-${n}`;
    if (!taken.has(candidate) && candidate !== "all") out.push(candidate);
  }
  return out;
}

/** Under the name: the address it will get, or why there is none yet. */
function showAddress(): void {
  const title = dom.roomName.value.trim();
  const first = addressesFor(title)[0];
  dom.roomAddress.textContent = !title ? "" : first ? `Address: #${first} (links and agents use it; it stays when you rename)` : "The name needs at least one letter (a–z).";
}
dom.roomName.addEventListener("input", showAddress);

/** Makes the room: its first message to "#address" creates it; then its name, members, parent, and private. */
async function openRoom(picked: string[]): Promise<void> {
  const title = dom.roomName.value.replace(/\s+/g, " ").trim().replace(/^#/, "");
  const text = dom.roomFirst.value.trim();
  const fail = (why: string) => {
    dom.groupError.textContent = why;
    dom.groupError.hidden = false;
  };
  if (!title) return fail("Give the room a name.");
  const candidates = addressesFor(title);
  if (candidates.length === 0) return fail("The name needs at least one letter (a–z), for its address.");
  if (!text) return fail("Write a first message: what is this room for?");
  try {
    // A name someone else keeps private is refused by the bus (403/409): the next free form is tried.
    let res: PostMessageResponse | undefined;
    let lastError: unknown;
    for (const address of candidates) {
      try {
        res = await postJson<PostMessageResponse>("/api/messages", { from: state.me, to: `#${address}`, text });
        break;
      } catch (error) {
        lastError = error;
        // The bus's answers when the address is someone else's: a private room or project, the other kind, an agent's name.
        if (!/is not open|is a project|is a room|'s name; only/.test(errorText(error))) throw error;
      }
    }
    if (!res) throw lastError;
    const id = res.conversation.id;
    const action = (what: string, body: Record<string, unknown>) =>
      postJson<ConversationResponse>(`/api/conversations/${encodeURIComponent(id)}/${what}`, { from: state.me, ...body });
    // Name and privacy first, so agents added next get the room's first message with its name (codex-ui #10727).
    await action("project", { visibility: "private", title });
    if (picked.length > 0) await action("members", { ids: picked });
    if (dom.roomParent.value) await action("parent", { parent: dom.roomParent.value });
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
