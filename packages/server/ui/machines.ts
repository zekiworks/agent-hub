// Machines asking to put agents on the bus. The first time an agent connects with a machine account's token, the bus
// holds it and shows the request here, like ssh asking about a new host; a signed-in person allows or denies it.
import type { AgentTokenInfo } from "@agent-bus/protocol";
import { api, postJson } from "./api";
import { el, h } from "./html";

const box = el<HTMLDivElement>("agent-requests");

/** Fetches the agent tokens and shows the waiting ones (at boot, and on every `agent-tokens` frame). */
export async function loadAgentRequests(): Promise<void> {
  let tokens: AgentTokenInfo[];
  try {
    ({ tokens } = await api<{ tokens: AgentTokenInfo[] }>("/api/agent-tokens"));
  } catch {
    return;
  }
  const pending = tokens.filter((t) => t.state === "pending");
  box.hidden = pending.length === 0;
  box.replaceChildren(...pending.map(requestCard));
}

function requestCard(t: AgentTokenInfo): HTMLElement {
  const card = h("div", "agent-request");
  const where = `${t.host ?? "an unknown machine"}${t.addr ? ` (${t.addr})` : ""}`;
  const error = h("div", "agent-request-error");
  const decide = (action: "approve" | "deny"): void => {
    postJson(`/api/agent-tokens/${encodeURIComponent(t.id)}/${action}`, {}).then(
      () => void loadAgentRequests(),
      (err: Error) => (error.textContent = err.message)
    );
  };
  const allow = h("button", "btn btn-primary", "Allow");
  allow.type = "button";
  allow.addEventListener("click", () => decide("approve"));
  const deny = h("button", "btn", "Deny");
  deny.type = "button";
  deny.addEventListener("click", () => decide("deny"));
  const actions = h("div", "agent-request-actions");
  actions.append(allow, deny);
  card.append(
    h("div", "agent-request-title", "A new machine wants to put agents on the bus"),
    h("div", "agent-request-what", `${where}: ${t.agents.join(", ")}`),
    h("div", "agent-request-code", `Code ${t.code}. Allow only if the agent shows the same code.`),
    actions,
    error
  );
  return card;
}
