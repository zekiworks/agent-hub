// Slash commands (Can #14261; design in docs/slash-commands.md): `serve --ext NAME=URL,commands=a;b` makes `/a` and
// `/b` commands a signed-in person types in the message box. POST /api/commands/:command {conversationId, text}: the
// bus checks the person may read the conversation and posts the extension a CommandBody at `<URL>/commands/<command>`;
// the extension's {note} is shown to that person. Nothing is stored or sent by the bus itself.
import type { CommandBody, CommandResponse, Conversation } from "@agent-bus/protocol";
import type { BusContext } from "./context";
import { mayRead } from "./conversations";
import { HttpError, readJsonObject } from "./http";

const TIMEOUT_MS = 15_000;
const MAX_NOTE_CHARS = 500;

/** The agent whose page `conversation` is: the agent of a DM, or the one a project @@<id> is named after. */
export function pageAgent(ctx: BusContext, conversation: Conversation): string | undefined {
  if (conversation.kind === "dm") return conversation.members.find((id) => !ctx.hub.isHuman(id));
  if (conversation.kind !== "project" || conversation.room || !conversation.name) return undefined;
  return ctx.db.getParticipant(conversation.name)?.kind === "agent" ? conversation.name : undefined;
}

export async function postCommand(
  ctx: BusContext,
  req: Request,
  command: string,
  commands: Record<string, string>,
  extensions: Record<string, string>,
  person: string | undefined
): Promise<CommandResponse> {
  const target = commands[command] ? extensions[commands[command]] : undefined;
  if (!target) throw new HttpError(404, `No command /${command} on this bus`);
  if (!person) throw new HttpError(403, "Only a signed-in person types slash commands");
  const body = await readJsonObject(req);
  if (typeof body.conversationId !== "string" || typeof body.text !== "string") throw new HttpError(400, "Give conversationId and text");
  const conversation = ctx.db.getConversation(body.conversationId);
  if (!conversation || !mayRead(ctx, conversation, { id: person, kind: "human" })) throw new HttpError(404, `Unknown conversation "${body.conversationId}"`);
  const agent = pageAgent(ctx, conversation);
  const payload: CommandBody = {
    v: 1,
    command,
    caller: { id: person, kind: "human" },
    conversation: { id: conversation.id, kind: conversation.kind, ...(conversation.name ? { name: conversation.name } : {}), members: conversation.members },
    ...(agent ? { agent } : {}),
    text: body.text.slice(0, 4000),
  };
  let res: Response;
  try {
    res = await fetch(`${target.replace(/\/+$/, "")}/commands/${command}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new HttpError(502, `/${command} is not answering: ${error instanceof Error ? error.message : String(error)}`);
  }
  const answer = (await res.json().catch(() => ({}))) as { note?: unknown; error?: unknown };
  const text = typeof answer.note === "string" ? answer.note : typeof answer.error === "string" ? answer.error : "";
  if (!res.ok) throw new HttpError(res.status >= 500 ? 502 : 400, text || `/${command} failed (HTTP ${res.status})`);
  return { note: (text || "Done.").slice(0, MAX_NOTE_CHARS) };
}
