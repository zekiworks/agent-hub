// A conversation's checklist (Checklist in the protocol): the owner agent publishes markdown, people tick items.
import type { Checklist, Conversation, PutChecklistRequest, TickRequest } from "@agent-bus/protocol";
import type { BusContext } from "./context";
import { mayRead, type Reader } from "./conversations";
import { HttpError, readJsonObject } from "./http";

/** Longest list text accepted: a list to read on one screen, not a document. */
const MAX_CHECKLIST_CHARS = 20_000;

/** The items of a checklist's markdown: the text of each `- [ ] …` / `- [x] …` line. */
export function checklistItems(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*[-*] \[[ xX]\] (.+)$/.exec(line);
    if (m?.[1]) items.push(m[1].trim());
  }
  return items;
}

function readable(ctx: BusContext, id: string, reader: Reader): Conversation {
  const conversation = ctx.db.getConversation(id);
  if (!conversation || !mayRead(ctx, conversation, reader)) throw new HttpError(404, `Unknown conversation "${id}"`);
  return conversation;
}

function writer(ctx: BusContext, req: Request, body: Record<string, unknown>) {
  if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
  const participant = ctx.hub.knownParticipant(body.from.trim().toLowerCase());
  if (!participant) throw new HttpError(400, `Unknown participant "${body.from}"`);
  ctx.checkWriter(req, participant);
  return participant;
}

/** GET /api/conversations/:id/checklist */
export function getChecklist(ctx: BusContext, id: string, reader: Reader): Checklist {
  const conversation = readable(ctx, id, reader);
  const list = ctx.db.getChecklist(conversation.id);
  if (!list) throw new HttpError(404, `${conversation.id} has no checklist`);
  return list;
}

/** PUT /api/conversations/:id/checklist: a member replaces the text; ticks of items no longer in it are dropped. */
export async function putChecklist(ctx: BusContext, req: Request, id: string): Promise<Checklist> {
  const body = await readJsonObject(req);
  const from = writer(ctx, req, body);
  const conversation = ctx.db.getConversation(id);
  if (!conversation) throw new HttpError(404, `Unknown conversation "${id}"`);
  if (!conversation.members.includes(from.id)) throw new HttpError(403, `@${from.id} is not in ${conversation.id}`);
  const before = ctx.db.getChecklist(conversation.id);
  // The first publisher owns the list; only they replace it.
  if (before && before.owner !== from.id) throw new HttpError(403, `This checklist is @${before.owner}'s; only @${before.owner} replaces it`);
  const { text, assignees } = body as Partial<PutChecklistRequest>;
  if (typeof text !== "string") throw new HttpError(400, "text must be the checklist's markdown");
  if (text.length > MAX_CHECKLIST_CHARS) throw new HttpError(400, `text is longer than ${MAX_CHECKLIST_CHARS} characters`);
  let assigned = before?.assignees ?? [];
  if (assignees !== undefined) {
    if (!Array.isArray(assignees) || !assignees.every((a) => typeof a === "string")) throw new HttpError(400, "assignees must be a list of participant ids");
    assigned = [...new Set(assignees.map((a) => a.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))];
    const unknown = assigned.filter((a) => !ctx.hub.knownParticipant(a));
    if (unknown.length > 0) throw new HttpError(400, `Unknown participant${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`);
  }
  const items = new Set(checklistItems(text));
  const ticks = Object.fromEntries(Object.entries(before?.ticks ?? {}).filter(([item]) => items.has(item)));
  const list: Checklist = { text, ticks, updatedAt: Date.now(), updatedBy: from.id, owner: before?.owner ?? from.id, assignees: assigned };
  ctx.db.saveChecklist(conversation.id, list);
  ctx.hub.checklistChanged(conversation);
  return list;
}

/** POST /api/conversations/:id/checklist/tick: the owner or an assignee ticks or unticks one item, by its text. */
export async function tickChecklist(ctx: BusContext, req: Request, id: string): Promise<Checklist> {
  const body = await readJsonObject(req);
  const from = writer(ctx, req, body);
  const conversation = readable(ctx, id, { id: from.id, kind: from.kind === "human" ? "human" : "agent" });
  const list = ctx.db.getChecklist(conversation.id);
  if (!list) throw new HttpError(404, `${conversation.id} has no checklist`);
  if (from.id !== list.owner && !list.assignees.includes(from.id)) {
    const who = [list.owner, ...list.assignees].map((a) => `@${a}`).join(", ");
    throw new HttpError(403, `Only ${who} tick this checklist`);
  }
  const { item, done } = body as Partial<TickRequest>;
  if (typeof item !== "string" || typeof done !== "boolean") throw new HttpError(400, "Give item (its text) and done (true or false)");
  if (!checklistItems(list.text).includes(item.trim())) throw new HttpError(409, "That item is no longer on the list (it changed meanwhile)");
  const ticks = { ...list.ticks };
  if (done) ticks[item.trim()] = { by: from.id, at: Date.now() };
  else delete ticks[item.trim()];
  const updated = { ...list, ticks };
  ctx.db.saveChecklist(conversation.id, updated);
  ctx.hub.checklistChanged(conversation);
  return updated;
}
