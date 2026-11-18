// A conversation's checklist (Checklist in the protocol): the one place agents track the instructions people give them
// (Ümit #12364, #12367; codex-ui #12365, #12369, #12379). Items have ids the bus assigns; agents change the list with
// operations on the version they read (409 when it moved on), people tick and pin it. The markdown PUT of the first
// lists (Ali's list of Can's tasks, 15 Nov) still works for the list's creator.
import { isJsonObject, type Checklist, type ChecklistItem, type Conversation } from "@agent-bus/protocol";
import { checklistItemId, checklistMarkdown, checklistTicks, parseChecklistMarkdown } from "./checklist-items";
import type { BusContext } from "./context";
import { mayRead, type Reader } from "./conversations";
import type { ParticipantRecord, StoredChecklist } from "./db";
import { HttpError, readJsonObject } from "./http";

/** Longest markdown accepted by the PUT: a list to read on one screen, not a document. */
const MAX_CHECKLIST_CHARS = 20_000;
/** Most items on one list, longest item text, heading and blocked note, and longest detail (several lines). */
const MAX_ITEMS = 300;
const MAX_TEXT_CHARS = 500;
const MAX_DETAIL_CHARS = 4000;
/** Most operations in one edit. */
const MAX_OPS = 100;

function readable(ctx: BusContext, id: string, reader: Reader): Conversation {
  const conversation = ctx.db.getConversation(id);
  if (!conversation || !mayRead(ctx, conversation, reader)) throw new HttpError(404, `Unknown conversation "${id}"`);
  return conversation;
}

function writer(ctx: BusContext, req: Request, body: Record<string, unknown>): ParticipantRecord {
  if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
  const participant = ctx.hub.knownParticipant(body.from.trim().toLowerCase());
  if (!participant) throw new HttpError(400, `Unknown participant "${body.from}"`);
  ctx.checkWriter(req, participant);
  return participant;
}

/** The conversation `from` writes the list of: they must be a member. */
function memberOf(ctx: BusContext, id: string, from: ParticipantRecord): Conversation {
  const conversation = ctx.db.getConversation(id);
  if (!conversation) throw new HttpError(404, `Unknown conversation "${id}"`);
  if (!conversation.members.includes(from.id)) throw new HttpError(403, `@${from.id} is not in ${conversation.id}`);
  return conversation;
}

/** The stored list as the protocol has it: with its markdown and ticks. */
function view(list: StoredChecklist): Checklist {
  const { nextId: _, ...rest } = list;
  return { ...rest, text: checklistMarkdown(list), ticks: checklistTicks(list.items) };
}

/** 409 unless `base` is the list's version (0: no list yet). The answer carries the list as it is now. */
function checkBase(list: StoredChecklist | null, base: unknown): void {
  if (typeof base !== "number" || !Number.isInteger(base) || base < 0) throw new HttpError(400, "base must be the version you read (0: no list yet)");
  const current = list?.version ?? 0;
  if (base === current) return;
  throw new HttpError(
    409,
    list
      ? `The checklist changed meanwhile (version ${current}, not ${base}): read it, then apply your own changes again`
      : `There is no checklist here yet; base 0 creates it`,
    { checklist: list ? view(list) : null }
  );
}

function save(ctx: BusContext, conversation: Conversation, list: StoredChecklist, from: ParticipantRecord): Checklist {
  const saved = { ...list, version: list.version + 1, updatedAt: Date.now(), updatedBy: from.id };
  ctx.db.saveChecklist(conversation.id, saved);
  ctx.hub.checklistChanged(conversation);
  return view(saved);
}

/** A one-line text field: trimmed; required unless `optional`; "" allowed only where it clears (`clears`). */
function textField(value: unknown, name: string, opts: { optional?: boolean; clears?: boolean } = {}): string | undefined {
  if (value === undefined && opts.optional) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${name} must be a string`);
  const text = value.trim();
  if (/[\r\n]/.test(text)) throw new HttpError(400, `${name} must be one line`);
  if (!text && !opts.clears) throw new HttpError(400, `${name} must not be empty`);
  if (text.length > MAX_TEXT_CHARS) throw new HttpError(400, `${name} is longer than ${MAX_TEXT_CHARS} characters`);
  return text;
}

/** An item's detail: may span lines; "" clears it. */
function detailField(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "detail must be a string");
  const detail = value.replace(/\r\n?/g, "\n").replace(/^\s*\n|\s+$/g, "");
  if (detail.length > MAX_DETAIL_CHARS) throw new HttpError(400, `detail is longer than ${MAX_DETAIL_CHARS} characters`);
  return detail;
}

/** Puts `item` after the last item under its heading; a new heading goes last, items without one first. */
function place(items: ChecklistItem[], item: ChecklistItem): void {
  let at = -1;
  items.forEach((other, i) => {
    if (other.heading === item.heading) at = i;
  });
  if (at >= 0) items.splice(at + 1, 0, item);
  else if (item.heading) items.push(item);
  else items.unshift(item);
}

/** Who may change or remove `item`: people who are members (checked by the caller), and the agent that owns it. */
function mayChange(ctx: BusContext, from: ParticipantRecord, item: ChecklistItem): void {
  if (ctx.hub.isHuman(from.id) || item.owner === from.id) return;
  throw new HttpError(403, `Item ${item.id} is ${item.owner ? `@${item.owner}'s` : "nobody's"}; only ${item.owner ? `@${item.owner} and ` : ""}people change it`);
}

function itemById(list: StoredChecklist, id: unknown): ChecklistItem {
  if (typeof id !== "string") throw new HttpError(400, "id must be an item's id");
  const item = list.items.find((i) => i.id === id);
  if (!item) throw new HttpError(400, `No item ${id} on this checklist`);
  return item;
}

/** Validated `assignees`, or the list's own when left out. */
function assigneesOf(ctx: BusContext, value: unknown, before: string[]): string[] {
  if (value === undefined) return before;
  if (!Array.isArray(value) || !value.every((a) => typeof a === "string")) throw new HttpError(400, "assignees must be a list of participant ids");
  const assigned = [...new Set(value.map((a: string) => a.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))];
  const unknown = assigned.filter((a) => !ctx.hub.knownParticipant(a));
  if (unknown.length > 0) throw new HttpError(400, `Unknown participant${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`);
  return assigned;
}

/** A list that does not exist yet, as its first writer makes it: pinned. */
function newList(from: ParticipantRecord): StoredChecklist {
  return { version: 0, pinned: true, items: [], creator: from.id, assignees: [], updatedAt: 0, updatedBy: from.id, nextId: 1 };
}

/** GET /api/conversations/:id/checklist */
export function getChecklist(ctx: BusContext, id: string, reader: Reader): Checklist {
  const conversation = readable(ctx, id, reader);
  const list = ctx.db.getChecklist(conversation.id);
  if (!list) throw new HttpError(404, `${conversation.id} has no checklist`);
  return view(list);
}

/**
 * POST /api/conversations/:id/checklist/edit: a member's operations (add, update, remove), all or none, on the version
 * it read (ChecklistEditRequest). Never changes `pinned` (Ümit #12367: only people pin and unpin).
 */
export async function editChecklist(ctx: BusContext, req: Request, id: string): Promise<Checklist> {
  const body = await readJsonObject(req);
  const from = writer(ctx, req, body);
  const conversation = memberOf(ctx, id, from);
  const before = ctx.db.getChecklist(conversation.id);
  checkBase(before, body.base);
  const { ops } = body;
  if (!Array.isArray(ops) || ops.length === 0) throw new HttpError(400, "ops must be a list of operations: add, update or remove");
  if (ops.length > MAX_OPS) throw new HttpError(400, `At most ${MAX_OPS} operations at once`);
  const list = before ?? newList(from);
  if (body.assignees !== undefined && from.id !== list.creator && !ctx.hub.isHuman(from.id)) {
    throw new HttpError(403, `Only @${list.creator} and people set whom this list is for`);
  }
  const next: StoredChecklist = { ...list, items: list.items.map((item) => ({ ...item })), assignees: assigneesOf(ctx, body.assignees, list.assignees) };
  for (const [i, op] of ops.entries()) {
    if (!isJsonObject(op)) throw new HttpError(400, `ops[${i}] must be an object`);
    switch (op.op) {
      case "add": {
        const text = textField(op.text, "text") as string;
        const heading = textField(op.heading, "heading", { optional: true, clears: true });
        if (op.source !== undefined && (typeof op.source !== "number" || !Number.isInteger(op.source) || op.source < 1)) {
          throw new HttpError(400, "source must be a message's #number");
        }
        const detail = detailField(op.detail);
        const item: ChecklistItem = {
          id: checklistItemId(next.nextId),
          ...(heading ? { heading } : {}),
          text,
          owner: from.id,
          ...(op.source !== undefined ? { source: op.source } : {}),
          ...(detail ? { detail } : {}),
        };
        next.nextId += 1;
        place(next.items, item);
        break;
      }
      case "update": {
        const item = itemById(next, op.id);
        mayChange(ctx, from, item);
        const text = textField(op.text, "text", { optional: true });
        const heading = textField(op.heading, "heading", { optional: true, clears: true });
        const blocked = textField(op.blocked, "blocked", { optional: true, clears: true });
        if (text !== undefined) item.text = text;
        if (blocked !== undefined) {
          if (blocked) item.blocked = blocked;
          else delete item.blocked;
        }
        const detail = detailField(op.detail);
        if (detail !== undefined) {
          if (detail) item.detail = detail;
          else delete item.detail;
        }
        if (heading !== undefined && heading !== (item.heading ?? "")) {
          if (heading) item.heading = heading;
          else delete item.heading;
          next.items.splice(next.items.indexOf(item), 1);
          place(next.items, item);
        }
        break;
      }
      case "remove": {
        const item = itemById(next, op.id);
        mayChange(ctx, from, item);
        next.items.splice(next.items.indexOf(item), 1);
        break;
      }
      default:
        throw new HttpError(400, `ops[${i}].op must be add, update or remove`);
    }
  }
  if (next.items.length > MAX_ITEMS) throw new HttpError(400, `A checklist holds at most ${MAX_ITEMS} items`);
  return save(ctx, conversation, next, from);
}

/**
 * PUT /api/conversations/:id/checklist: the list as markdown (PutChecklistRequest), for the agents that write it so.
 * Only its creator replaces it. Lines keep the ids, ticks and blocked notes of the items with the same text; an agent's PUT
 * keeps the items other agents and people own (an agent changes only its own items).
 */
export async function putChecklist(ctx: BusContext, req: Request, id: string): Promise<Checklist> {
  const body = await readJsonObject(req);
  const from = writer(ctx, req, body);
  const conversation = memberOf(ctx, id, from);
  const before = ctx.db.getChecklist(conversation.id);
  // The first publisher owns the list; only they replace it.
  if (before && before.creator !== from.id) throw new HttpError(403, `This checklist is @${before.creator}'s; only @${before.creator} replaces it`);
  if (body.base !== undefined) checkBase(before, body.base);
  const { text } = body;
  if (typeof text !== "string") throw new HttpError(400, "text must be the checklist's markdown");
  if (text.length > MAX_CHECKLIST_CHARS) throw new HttpError(400, `text is longer than ${MAX_CHECKLIST_CHARS} characters`);
  const list = before ?? newList(from);
  const now = Date.now();
  const unmatched = [...list.items];
  let nextId = list.nextId;
  const parsed = parseChecklistMarkdown(text);
  const items: ChecklistItem[] = parsed.items.map((line) => {
    const at = unmatched.findIndex((item) => item.text === line.text);
    const kept = at >= 0 ? unmatched.splice(at, 1)[0] : undefined;
    const item: ChecklistItem = kept ? { ...kept } : { id: checklistItemId(nextId++), text: line.text, owner: from.id };
    if (line.heading) item.heading = line.heading;
    else delete item.heading;
    // The lines under it in the text replace its detail; none keep it (a writer that never wrote details).
    if (line.detail) item.detail = line.detail;
    // `- [x]`: the writer counts it done. `- [ ]` keeps a tick: ticks were never part of the text.
    if (line.done && !item.done) item.done = { by: from.id, at: now };
    return item;
  });
  if (!ctx.hub.isHuman(from.id)) for (const other of unmatched.filter((item) => item.owner !== from.id)) place(items, other);
  if (items.length > MAX_ITEMS) throw new HttpError(400, `A checklist holds at most ${MAX_ITEMS} items`);
  // The title and intro are the text's: a PUT replaces the whole text.
  const { title: _title, intro: _intro, ...rest } = list;
  const replaced: StoredChecklist = {
    ...rest,
    ...(parsed.title ? { title: parsed.title } : {}),
    ...(parsed.intro ? { intro: parsed.intro } : {}),
    items,
    nextId,
    assignees: assigneesOf(ctx, body.assignees, list.assignees),
  };
  return save(ctx, conversation, replaced, from);
}

/**
 * POST /api/conversations/:id/checklist/tick (TickRequest): people who are members (or assignees) tick and untick any
 * item; an agent its own items, and never unticks a person's tick (Ümit #12364, codex-ui #12379).
 */
export async function tickChecklist(ctx: BusContext, req: Request, id: string): Promise<Checklist> {
  const body = await readJsonObject(req);
  const from = writer(ctx, req, body);
  const person = ctx.hub.isHuman(from.id);
  const conversation = readable(ctx, id, { id: from.id, kind: person ? "human" : "agent" });
  const list = ctx.db.getChecklist(conversation.id);
  if (!list) throw new HttpError(404, `${conversation.id} has no checklist`);
  if (!conversation.members.includes(from.id) && !(person && list.assignees.includes(from.id))) {
    throw new HttpError(403, `@${from.id} is not in ${conversation.id}`);
  }
  if (body.base !== undefined) checkBase(list, body.base);
  const { done } = body;
  if (typeof done !== "boolean") throw new HttpError(400, "done must be true or false");
  const wanted = typeof body.id === "string" ? body.id : typeof body.item === "string" ? body.item.trim() : undefined;
  if (wanted === undefined) throw new HttpError(400, "Give id (the item's id) and done (true or false)");
  const items = list.items.map((item) => ({ ...item }));
  const item = items.find((i) => (typeof body.id === "string" ? i.id === wanted : i.text === wanted));
  if (!item) throw new HttpError(409, "That item is no longer on the list (it changed meanwhile)", { checklist: view(list) });
  if (!person) {
    if (item.owner !== from.id) throw new HttpError(403, `Item ${item.id} is ${item.owner ? `@${item.owner}'s` : "nobody's"}; an agent ticks only its own items`);
    if (!done && item.done && ctx.hub.isHuman(item.done.by)) throw new HttpError(403, `@${item.done.by} ticked item ${item.id}; only people untick it`);
  }
  // Ticking a done item keeps who ticked it first.
  if (done) item.done ??= { by: from.id, at: Date.now() };
  else delete item.done;
  return save(ctx, conversation, { ...list, items }, from);
}

/** POST /api/conversations/:id/checklist/pin (ChecklistPinRequest): only people who are members (Ümit #12367). */
export async function pinChecklist(ctx: BusContext, req: Request, id: string): Promise<Checklist> {
  const body = await readJsonObject(req);
  const from = writer(ctx, req, body);
  if (!ctx.hub.isHuman(from.id)) throw new HttpError(403, "Only people pin and unpin a checklist");
  const conversation = memberOf(ctx, id, from);
  const list = ctx.db.getChecklist(conversation.id);
  if (!list) throw new HttpError(404, `${conversation.id} has no checklist`);
  if (typeof body.pinned !== "boolean") throw new HttpError(400, "pinned must be true or false");
  return save(ctx, conversation, { ...list, pinned: body.pinned }, from);
}
