// A project's Home: markdown its owner agent publishes and keeps current, newest first (what it has
// done, blockers, links to messages, updates on long tasks), shown as the Home tab of the right pane.
import type { Conversation, Home, PutHomeRequest } from "@agent-bus/protocol";
import type { BusContext } from "./context";
import { mayRead, type Reader } from "./conversations";
import { HttpError, readJsonObject } from "./http";

/** Longest Home accepted: owners trim old entries rather than grow without end. */
const MAX_HOME_CHARS = 100_000;

/** GET /api/conversations/:id/home */
export function getHome(ctx: BusContext, id: string, reader: Reader): Home {
  const conversation = ctx.db.getConversation(id);
  if (!conversation || !mayRead(ctx, conversation, reader)) throw new HttpError(404, `Unknown conversation "${id}"`);
  const home = ctx.db.getHome(conversation.id);
  if (!home) throw new HttpError(404, `${conversation.id} has no Home yet`);
  return home;
}

/** PUT /api/conversations/:id/home: the owner (its first publisher, a member) replaces the text. */
export async function putHome(ctx: BusContext, req: Request, id: string): Promise<Home> {
  const body = await readJsonObject(req);
  if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
  const from = ctx.hub.knownParticipant(body.from.trim().toLowerCase());
  if (!from) throw new HttpError(400, `Unknown participant "${body.from}"`);
  ctx.checkWriter(req, from);
  const conversation: Conversation | null = ctx.db.getConversation(id);
  if (!conversation) throw new HttpError(404, `Unknown conversation "${id}"`);
  if (conversation.kind !== "project") throw new HttpError(400, "A Home belongs to a project or room");
  const before = ctx.db.getHome(conversation.id);
  if (before && before.owner !== from.id) throw new HttpError(403, `This Home is @${before.owner}'s; only @${before.owner} replaces it`);
  if (!before && !conversation.members.includes(from.id)) throw new HttpError(403, `@${from.id} is not in ${conversation.id}`);
  const { text } = body as Partial<PutHomeRequest>;
  if (typeof text !== "string") throw new HttpError(400, "text must be the Home's markdown");
  if (text.length > MAX_HOME_CHARS) throw new HttpError(400, `text is longer than ${MAX_HOME_CHARS} characters: trim the oldest entries`);
  const home: Home = { text, owner: before?.owner ?? from.id, updatedAt: Date.now(), updatedBy: from.id };
  ctx.db.saveHome(conversation.id, home);
  ctx.hub.homeChanged(conversation);
  return home;
}
