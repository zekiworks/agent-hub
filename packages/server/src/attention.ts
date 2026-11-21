// What a person does with agents' messages (Ümit #13977, #14109): the answer key for teaching a small model which
// messages need them. The page reports, per agent message, that it was on screen (and how long), tapped, replied to,
// forwarded, marked read, or opened from a notification or banner; the bus appends one line per event to
// `<data dir>/attention.jsonl`. Never the text: who wrote it, where, its number, and what was done.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { BusContext } from "./context";
import { mayRead } from "./conversations";
import { HttpError, readJsonObject } from "./http";

export const ATTENTION_ACTIONS = ["seen", "tapped", "replied", "forwarded", "marked-read", "notification", "banner-opened", "banner-read"] as const;
type Action = (typeof ATTENTION_ACTIONS)[number];
const MAX_EVENTS = 200;

/**
 * POST /api/attention {events: [{seq, action, ms?}]}: a signed-in person's events, kept only for agents' messages they
 * may read, and only for people listed (one id per line) in `peopleFile`: each person says yes first (Ümit #13977; not
 * Can until he asks).
 */
export async function postAttention(
  ctx: BusContext,
  req: Request,
  person: string | undefined,
  file: string,
  peopleFile: string,
  now = Date.now()
): Promise<{ ok: true; kept: number }> {
  if (!person) throw new HttpError(403, "Only a signed-in person reports what they did with messages");
  const body = await readJsonObject(req);
  const listed = existsSync(peopleFile) && readFileSync(peopleFile, "utf8").split(/\s+/).includes(person);
  if (!listed) return { ok: true, kept: 0 };
  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
  const at = new Date(now).toISOString();
  const lines: string[] = [];
  for (const e of events as Array<Record<string, unknown>>) {
    if (typeof e?.seq !== "number" || !ATTENTION_ACTIONS.includes(e.action as Action)) continue;
    const message = ctx.db.getMessage(e.seq);
    if (!message || message.fromKind !== "agent" || message.deletedAt) continue;
    const conversation = ctx.db.getConversation(message.conversationId);
    if (!conversation || !mayRead(ctx, conversation, { id: person, kind: "human" })) continue;
    const ms = typeof e.ms === "number" && e.ms >= 0 ? Math.min(Math.round(e.ms), 3_600_000) : undefined;
    lines.push(
      JSON.stringify({ at, person, seq: message.seq, conversationId: conversation.id, from: message.from, action: e.action, ...(ms === undefined ? {} : { ms }) })
    );
  }
  if (lines.length > 0) appendFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return { ok: true, kept: lines.length };
}
