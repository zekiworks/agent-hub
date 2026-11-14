// Reading for agents (no turns for anyone): GET /api/inbox, /api/history and /api/search. Their results go into a
// model's context, hence the small default page.
import { ALL_CONVERSATION_ID, type Conversation, type Message, type ReadResponse } from "@agent-bus/protocol";
import type { BusContext } from "./context";
import { mayRead as readerMayRead } from "./conversations";
import { HttpError } from "./http";

const DEFAULT_READ = 20;
const MAX_READ = 100;

function intParam(url: URL, key: string, min: number): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new HttpError(400, `${key} must be an integer ≥ ${min}`);
  return value;
}

function readLimit(url: URL): number {
  return Math.min(intParam(url, "limit", 1) ?? DEFAULT_READ, MAX_READ);
}

type ReaderScope = { id: string; kind: "agent" | "human"; all: boolean };

/** The reader (`param`, a known participant) and whether it reads everything it may (`scope=all`) or its own. */
function reader(ctx: BusContext, url: URL, param: string): ReaderScope {
  const id = (url.searchParams.get(param) ?? "").trim().toLowerCase();
  const participant = ctx.hub.knownParticipant(id);
  if (!participant) {
    throw new HttpError(400, `Unknown participant "${id}" in ${param}. Known ids: ${ctx.hub.knownIds().join(", ")}`);
  }
  const scope = url.searchParams.get("scope") ?? "mine";
  if (scope !== "mine" && scope !== "all") throw new HttpError(400, 'scope must be "mine" or "all"');
  return { id: participant.id, kind: participant.kind, all: scope === "all" };
}

const mayRead = readerMayRead;

function withConversations(ctx: BusContext, messages: Message[]): ReadResponse {
  const ids = [...new Set(messages.map((m) => m.conversationId))];
  return { messages, conversations: ids.map((id) => ctx.db.getConversation(id)).filter((c): c is Conversation => c !== null) };
}

/** Messages sent to `for` (it has a receipt), newest `limit`, after `sinceSeq`. */
export function getInbox(ctx: BusContext, url: URL): ReadResponse {
  const { id } = reader(ctx, url, "for");
  return withConversations(ctx, ctx.db.inboxFor(id, intParam(url, "sinceSeq", 0) ?? 0, readLimit(url)));
}

/**
 * The newest `limit` messages (before `beforeSeq`) of the conversation `to` names for `from` ("@x" its DM with x,
 * "@{a,b}" its group DM with them, "@@name" a project, "@all"), or of `conversationId`.
 */
export function getHistory(ctx: BusContext, url: URL): ReadResponse {
  const { db } = ctx;
  const me = reader(ctx, url, "from");
  const to = url.searchParams.get("to");
  const conversationId = url.searchParams.get("conversationId");
  let conversation: Conversation | null;
  if (conversationId) {
    conversation = db.getConversation(conversationId);
    if (!conversation) throw new HttpError(404, `Unknown conversation "${conversationId}"`);
  } else if (to) {
    const parsed = ctx.knownAddress(to);
    if (parsed.kind === "all") {
      conversation = db.getConversation(ALL_CONVERSATION_ID);
    } else if (parsed.kind === "project") {
      conversation = db.projectByName(parsed.name);
      if (!conversation) throw new HttpError(404, `No project "${parsed.name}"`);
    } else {
      const ids = Array.from(new Set([me.id, ...parsed.ids]));
      conversation = db.findByMembers(ids.length === 2 ? "dm" : "group", ids);
      if (!conversation) throw new HttpError(404, `No conversation of @${me.id} with ${to} yet`);
    }
  } else {
    throw new HttpError(400, "Give to (an address) or conversationId");
  }
  if (!conversation) throw new Error("The all conversation is missing");
  if (!mayRead(ctx, conversation, me)) {
    throw new HttpError(403, `@${me.id} is not in conversation ${conversation.id}${me.all ? "" : "; read it with scope=all"}`);
  }
  return withConversations(ctx, db.listMessages(conversation.id, intParam(url, "beforeSeq", 1), readLimit(url)));
}

/** Messages whose text contains `q` (and from `sender`), newest `limit`, in the reader's conversations or all it may read. */
export function getSearch(ctx: BusContext, url: URL): ReadResponse {
  const me = reader(ctx, url, "from");
  const sender = url.searchParams.get("sender")?.trim().replace(/^@/, "").toLowerCase() || null;
  const q = url.searchParams.get("q") ?? "";
  if (!q.trim() && !sender) throw new HttpError(400, "Give q (text to find) and/or sender");
  const ids = me.all
    ? ctx.db
        .listConversations()
        .filter((c) => mayRead(ctx, c, me))
        .map((c) => c.id)
    : ctx.db.conversationIdsOf(me.id);
  return withConversations(ctx, ctx.db.searchMessages(q.trim(), sender, ids, readLimit(url)));
}
