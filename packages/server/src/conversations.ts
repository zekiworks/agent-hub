// Who may read a conversation, and changing its members and settings: adding people (agents first get the last
// messages), leaving, notifications, turning a group DM into a project, a project's settings, archiving. See
// docs/projects.md.
import {
  projectName,
  type AddMembersRequest,
  type ArchiveRequest,
  type Conversation,
  type ConversationResponse,
  type NotifyLevel,
  type NotifyRequest,
  type ProjectRequest,
  type ProjectVisibility,
} from "@agent-bus/protocol";
import type { BusContext } from "./context";
import type { ParticipantRecord } from "./db";
import { HttpError, readJsonObject } from "./http";

/** Earlier messages an agent added to a conversation gets before anything new. */
export const JOIN_CONTEXT_MESSAGES = 5;

const NOTIFY_LEVELS: readonly NotifyLevel[] = ["all", "mentions", "none"];
const VISIBILITIES: readonly ProjectVisibility[] = ["open", "discoverable", "private"];

/**
 * Whether `reader` may read `conversation`'s messages: `all`; its own conversations; open projects; and, for people,
 * every conversation without a person in it (agents' DMs and groups, for oversight; the website hides them behind
 * a switch).
 */
export function canRead(ctx: BusContext, conversation: Conversation, reader: { id: string; kind: "agent" | "human" }): boolean {
  return readable(conversation, reader, (id) => ctx.hub.isHuman(id));
}

/** `canRead` without the context (the hub filters its viewer broadcasts with it). */
export function readable(
  conversation: Pick<Conversation, "kind" | "members" | "visibility">,
  reader: { id: string; kind: "agent" | "human" },
  isHuman: (id: string) => boolean
): boolean {
  if (conversation.kind === "all" || conversation.members.includes(reader.id)) return true;
  if (conversation.kind === "project" && conversation.visibility === "open") return true;
  return reader.kind === "human" && !conversation.members.some(isHuman);
}

/**
 * A reader of the HTTP routes: a person, an agent (`id`), or an agent token that did not say which agent (`id` "").
 * `all`: agents asking for every conversation (scope=all, or a token without an agent) also read other agents'
 * conversations, never a person's (docs/projects.md).
 */
export type Reader = { id: string; kind: "agent" | "human"; all?: boolean; tokenHash?: string };

export function mayRead(ctx: BusContext, conversation: Conversation, reader: Reader): boolean {
  if (canRead(ctx, conversation, reader)) return true;
  // A token that did not say which of its agents reads (clients from before projects) reads what any of them may:
  // agents on one machine share its token and can already write as one another.
  if (reader.tokenHash && conversation.members.some((id) => ctx.db.agentTokenHash(id) === reader.tokenHash)) return true;
  return reader.kind === "agent" && reader.all === true && conversation.kind !== "project" && !conversation.members.some((id) => ctx.hub.isHuman(id));
}

/** Whether `reader` may see that `conversation` exists: what it may read, plus discoverable projects (name, topic, members). */
export function canSee(ctx: BusContext, conversation: Conversation, reader: { id: string; kind: "agent" | "human" }): boolean {
  return canRead(ctx, conversation, reader) || (conversation.kind === "project" && conversation.visibility === "discoverable");
}

/**
 * Adds `ids` (known participants) to a group DM or project; agents among them first get its last messages as
 * context. Returns the updated conversation; viewers are told.
 */
export function addMembers(ctx: BusContext, conversation: Conversation, ids: readonly string[]): Conversation {
  const { db, hub } = ctx;
  if (conversation.kind !== "group" && conversation.kind !== "project") {
    throw new HttpError(400, "Only group DMs and projects take new members: start a group DM (@{a,b}) or a project (@@name)");
  }
  const newcomers: ParticipantRecord[] = [];
  for (const id of ids) {
    const participant = hub.knownParticipant(id);
    if (!participant) throw new HttpError(400, `Unknown participant "${id}". Known ids: ${hub.knownIds().join(", ")}`);
    if (!conversation.members.includes(participant.id) && !newcomers.some((p) => p.id === participant.id)) newcomers.push(participant);
  }
  for (const p of newcomers) db.addMember(conversation.id, p.id);
  const updated = db.getConversation(conversation.id) ?? conversation;
  for (const p of newcomers) {
    if (p.kind !== "agent") continue;
    for (const earlier of db.addContextReceipts(updated.id, p.id, JOIN_CONTEXT_MESSAGES)) {
      hub.deliver(hub.deliveryTargets(p.id), earlier, updated, p);
    }
  }
  if (newcomers.length > 0) hub.conversationsChanged();
  return updated;
}

/** The member `from` leaves group DM or project `conversation`; 400 for `all` and DMs. */
export function leave(ctx: BusContext, conversation: Conversation, from: string): Conversation {
  if (conversation.kind !== "group" && conversation.kind !== "project") {
    throw new HttpError(400, conversation.kind === "dm" ? "A DM cannot be left" : "Nobody leaves @all");
  }
  if (!ctx.db.removeMember(conversation.id, from)) throw new HttpError(400, `@${from} is not in ${conversation.id}`);
  ctx.hub.conversationsChanged();
  return ctx.db.getConversation(conversation.id) ?? conversation;
}

/** A project name that is valid and not taken by a participant (`@@logic` next to `@logic` would confuse). */
export function checkedProjectName(ctx: BusContext, input: string): string {
  let name: string;
  try {
    name = projectName(input);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
  if (ctx.hub.knownParticipant(name)) throw new HttpError(400, `"${name}" is a participant's id; pick another project name`);
  return name;
}

/** The participant `body.from`, checked as the request's writer, and conversation `id` with it as a member. */
function memberRequest(ctx: BusContext, req: Request, body: Record<string, unknown>, id: string) {
  if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
  const writer = ctx.hub.knownParticipant(body.from.trim().toLowerCase());
  if (!writer) throw new HttpError(400, `Unknown participant "${body.from}"`);
  ctx.checkWriter(req, writer);
  const conversation = ctx.db.getConversation(id);
  if (!conversation) throw new HttpError(404, `Unknown conversation "${id}"`);
  if (!conversation.members.includes(writer.id)) throw new HttpError(403, `@${writer.id} is not in ${conversation.id}`);
  return { writer, conversation };
}

/** POST /api/conversations/:id/{members,leave,notify,project,archive}; null for any other path. */
export async function handleConversationRoute(
  ctx: BusContext,
  req: Request,
  id: string,
  action: string
): Promise<ConversationResponse | null> {
  const body = await readJsonObject(req);
  const { db } = ctx;
  switch (action) {
    case "members": {
      const { conversation } = memberRequest(ctx, req, body, id);
      const ids = (body as Partial<AddMembersRequest>).ids;
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((v): v is string => typeof v === "string")) {
        throw new HttpError(400, "ids must be a non-empty array of participant ids");
      }
      return { conversation: addMembers(ctx, conversation, ids.map((v) => v.trim().replace(/^@/, "").toLowerCase())) };
    }
    case "leave": {
      const { writer, conversation } = memberRequest(ctx, req, body, id);
      return { conversation: leave(ctx, conversation, writer.id) };
    }
    case "notify": {
      const { writer, conversation } = memberRequest(ctx, req, body, id);
      const level = (body as Partial<NotifyRequest>).level;
      if (!level || !NOTIFY_LEVELS.includes(level)) throw new HttpError(400, `level must be one of ${NOTIFY_LEVELS.join(", ")}`);
      if (conversation.kind === "dm" || conversation.kind === "all") {
        throw new HttpError(400, "Notifications are set per group DM or project (DMs always notify; @all has its own setting)");
      }
      db.setNotify(conversation.id, writer.id, level);
      ctx.hub.conversationsChanged();
      return { conversation: db.getConversation(conversation.id) ?? conversation };
    }
    case "project": {
      const { writer, conversation } = memberRequest(ctx, req, body, id);
      const request = body as Partial<ProjectRequest>;
      if (conversation.kind !== "group" && conversation.kind !== "project") {
        throw new HttpError(400, "Only a group DM can become a project");
      }
      const rename = typeof request.name === "string" && request.name.trim() !== "" && request.name.trim().toLowerCase() !== conversation.name;
      if (conversation.kind === "group" && !rename) throw new HttpError(400, "A project needs a name");
      if (conversation.kind === "project" && rename && writer.kind !== "human") throw new HttpError(403, "Only people rename projects");
      const name = rename ? checkedProjectName(ctx, request.name as string) : undefined;
      if (name && db.projectByName(name)) throw new HttpError(409, `A project "${name}" exists already`);
      if (request.visibility !== undefined && !VISIBILITIES.includes(request.visibility)) {
        throw new HttpError(400, `visibility must be one of ${VISIBILITIES.join(", ")}`);
      }
      if (request.topic !== undefined && typeof request.topic !== "string") throw new HttpError(400, "topic must be a string");
      db.updateProject(conversation.id, {
        ...(name ? { name } : {}),
        ...(request.topic !== undefined ? { topic: request.topic.trim().slice(0, 200) } : {}),
        ...(request.visibility ? { visibility: request.visibility } : {}),
      });
      ctx.hub.conversationsChanged();
      return { conversation: db.getConversation(conversation.id) ?? conversation };
    }
    case "archive": {
      const { writer, conversation } = memberRequest(ctx, req, body, id);
      if (writer.kind !== "human") throw new HttpError(403, "Only people archive conversations");
      if (conversation.kind !== "group" && conversation.kind !== "project") {
        throw new HttpError(400, "Only group DMs and projects can be archived");
      }
      db.setArchived(conversation.id, (body as Partial<ArchiveRequest>).archived === true);
      ctx.hub.conversationsChanged();
      return { conversation: db.getConversation(conversation.id) ?? conversation };
    }
    default:
      return null;
  }
}
