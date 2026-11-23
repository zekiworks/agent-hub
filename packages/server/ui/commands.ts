// Slash commands supplied by extension manifests. Enter runs the command and shows its proposal; the next Send posts
// that reviewed proposal as a normal message.
import type { ExtensionCommandResponse } from "@agent-bus/protocol";
import { postJson } from "./api";
import { autosize, hideError, showError, updateComposerState } from "./composer";
import { dom } from "./dom";
import { errorText } from "./format";
import { state } from "./state";

let proposal: ExtensionCommandResponse["proposal"] | undefined;
let running = false;

export function proposalId(): string | undefined {
  return proposal?.id;
}

export function clearProposal(): void {
  proposal = undefined;
  dom.commandProposal.hidden = true;
  dom.commandProposalText.textContent = "";
}

function showProposal(next: ExtensionCommandResponse["proposal"]): void {
  proposal = next;
  dom.commandProposalText.textContent = `${next.label} · edit the text if needed, then Send`;
  dom.commandProposal.hidden = false;
}

dom.commandProposalCancel.addEventListener("click", () => {
  clearProposal();
  dom.input.focus();
});

window.addEventListener("hashchange", clearProposal);

dom.composer.addEventListener(
  "submit",
  (event) => {
    if (proposal || running) return;
    const match = /^\/([a-z0-9][a-z0-9_-]*)(?:\s+(.*))?$/s.exec(dom.input.value.trim());
    if (!match?.[1]) return;
    const command = state.commands.find((entry) => entry.name === match[1]);
    if (!command) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (state.view.kind !== "conversation") {
      showError(`/${command.name} needs an existing conversation. Open or create it first.`);
      return;
    }
    running = true;
    hideError();
    updateComposerState();
    void postJson<ExtensionCommandResponse>(`/api/ext/${encodeURIComponent(command.extension)}/command`, {
      from: state.me,
      conversationId: state.view.id,
      command: command.name,
      raw: match[2] ?? "",
    })
      .then((answer) => {
        dom.input.value = answer.proposal.text;
        autosize();
        showProposal(answer.proposal);
        dom.input.focus();
      })
      .catch((cause) => showError(errorText(cause)))
      .finally(() => {
        running = false;
        updateComposerState();
      });
  },
  { capture: true }
);

// A bare slash shows the available extension commands without taking over normal message text.
dom.input.addEventListener("input", () => {
  if (proposal || !dom.input.value.startsWith("/") || dom.input.value.includes("\n")) return;
  const typed = dom.input.value.slice(1).toLowerCase();
  const matches = state.commands.filter((command) => command.name.startsWith(typed.split(/\s/, 1)[0] ?? ""));
  dom.input.title = matches.length > 0 ? matches.map((command) => `${command.usage} — ${command.help}`).join("\n") : "";
});
