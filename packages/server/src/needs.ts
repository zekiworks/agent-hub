// "Waiting for your answer" (Ümit #14881): the Inbox's list of agents' messages a person has not answered and that a
// decision model thinks need them. With `serve --ext NAME=URL,box=needs`, every new agent message in a conversation of
// a person listed in attention-people.txt is sent, in the background, to `POST <URL>/needs` (a BoxNeedsBody); the
// extension asks each of its models (d1-2B, GLiDE-2B) and the bus keeps every verdict (table needs_verdicts, and a
// line in <data dir>/finetune/needs-you/live-verdicts.jsonl, never the text) so the models can be compared later. At
// its start the bus also judges each listed person's agent messages of the last 3 days that not every model judged yet
// (a model that was down then is asked again).
// One message at a time: new messages go before the older ones. Nothing here delays a delivery, and a box that fails
// costs only its verdicts.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { mentionedIds, type BoxNeedsBody, type Conversation, type Message, type NeedsResponse } from "@agent-bus/protocol";
import { listedPeople } from "./attention";
import type { BoxExtension } from "./boxes";
import type { BusContext } from "./context";
import { mayRead } from "./conversations";
import { HttpError, readJsonObject } from "./http";

const DAY_MS = 86_400_000;
/** How far back the list goes. */
const LIST_DAYS = 7;
/** How far back the first run judges what came before it, and at most how many messages. */
const BACKFILL_DAYS = 3;
const BACKFILL_MAX = 300;
/** The list's length at most. */
const LIST_MAX = 100;
/** The messages before the judged one that go along (as in the study's dataset). */
const CONTEXT_MESSAGES = 4;
/** How long the extension may take for one message (GLiDE on the CPU may queue behind other work). */
const TIMEOUT_MS = 120_000;

type Job = { person: string; seq: number };

export class NeedsJudge {
  private readonly queue: Job[] = [];
  /** `person\nseq` of the jobs queued or running, so a message is not asked twice at once. */
  private readonly queued = new Set<string>();
  private readonly backfilled = new Set<string>();
  private running = false;
  private stopped = false;
  private controller: AbortController | undefined;
  /** The last failure logged: a box that is down is reported once, not per message. */
  private lastError = "";

  constructor(
    private readonly ctx: BusContext,
    private readonly box: BoxExtension,
    /** attention-people.txt: only these people's messages are judged. */
    private readonly peopleFile: string,
    /** live-verdicts.jsonl, the benchmark's copy of every verdict and dismissal. */
    private readonly recordFile: string,
    private readonly now: () => number = Date.now
  ) {
    mkdirSync(path.dirname(recordFile), { recursive: true });
  }

  /** At the bus's start: each listed person's recent messages that not every model judged. */
  start(): void {
    for (const person of this.people()) this.backfill(person);
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.controller?.abort();
  }

  /** Every new message (Hub.onMessage): an agent's is queued for each listed person it concerns; a person's may answer. */
  onMessage(message: Message, conversation: Conversation): void {
    if (this.stopped || message.deletedAt) return;
    const people = this.people();
    if (message.fromKind === "human") {
      if (people.includes(message.from) && this.ctx.db.hasNeeds(message.from, conversation.id, message.seq, this.now() - LIST_DAYS * DAY_MS)) {
        this.ctx.hub.needsChanged(message.from);
      }
      return;
    }
    if (!message.text.trim()) return;
    let added = false;
    for (const person of people) {
      if (this.concerns(person, message, conversation)) added = this.enqueue({ person, seq: message.seq }, true) || added;
    }
    if (added) void this.drain();
  }

  /** GET /api/needs?from=: selected messages and rejected candidates awaiting the signed-in person's feedback. */
  list(person: string): NeedsResponse {
    if (!this.people().includes(person)) return { items: [], candidates: [], conversations: [] };
    this.backfill(person);
    const reader = { id: person, kind: "human" as const };
    const conversations = new Map<string, Conversation>();
    const collect = (rows: ReturnType<BusContext["db"]["openNeeds"]>) => {
      const result: NeedsResponse["items"] = [];
      for (const { seq, verdicts } of rows) {
        const message = this.ctx.db.getMessage(seq);
        const conversation = message && (conversations.get(message.conversationId) ?? this.ctx.db.getConversation(message.conversationId));
        if (!message || !conversation || !mayRead(this.ctx, conversation, reader)) continue;
        conversations.set(conversation.id, conversation);
        result.push({ message, verdicts });
      }
      return result;
    };
    const since = this.now() - LIST_DAYS * DAY_MS;
    const items = collect(this.ctx.db.openNeeds(person, since, LIST_MAX));
    const candidates = collect(this.ctx.db.needsCandidates(person, since, LIST_MAX));
    return { items, candidates, conversations: [...conversations.values()] };
  }

  /** POST /api/needs/dismiss: record labels, or remove one/many neutrally with reason "read". */
  async dismiss(person: string, req: Request): Promise<{ ok: true }> {
    const body = await readJsonObject(req);
    if (body.from !== undefined && body.from !== person) throw new HttpError(403, `You are signed in as ${person}, not ${String(body.from)}`);
    const seqs =
      typeof body.seq === "number"
        ? [body.seq]
        : Array.isArray(body.seqs) && body.seqs.every((seq) => typeof seq === "number" && Number.isSafeInteger(seq))
          ? [...new Set(body.seqs)]
          : [];
    if (seqs.length === 0 || seqs.length > LIST_MAX * 2) throw new HttpError(400, "Give seq or up to 200 seqs");
    const reason = body.reason ?? "not-needed";
    if (reason !== "read" && reason !== "needed" && reason !== "not-needed") {
      throw new HttpError(400, "reason must be read, needed, or not-needed");
    }
    for (const seq of seqs) {
      const message = this.ctx.db.getMessage(seq);
      const conversation = message && this.ctx.db.getConversation(message.conversationId);
      if (!message || !conversation || !mayRead(this.ctx, conversation, { id: person, kind: "human" })) {
        throw new HttpError(404, `No message #${seq} for you`);
      }
    }
    const at = this.now();
    const changed = this.ctx.db.dismissNeedsMany(person, seqs, at);
    for (const seq of changed) this.record({ seq, person, dismissed: true, reason, at: new Date(at).toISOString() });
    if (changed.length > 0) this.ctx.hub.needsChanged(person);
    return { ok: true };
  }

  private people(): string[] {
    return listedPeople(this.peopleFile).filter((id) => this.ctx.hub.isHuman(id));
  }

  /** An agent's message concerns a person in their conversations; in #all, only when it names them. */
  private concerns(person: string, message: Pick<Message, "from" | "text">, conversation: Conversation): boolean {
    if (message.from === person || !mayRead(this.ctx, conversation, { id: person, kind: "human" })) return false;
    return conversation.kind === "all" ? mentionedIds(message.text).includes(person) : conversation.members.includes(person);
  }

  /** Queues a job (a new message first); false when it is already queued. */
  private enqueue(job: Job, first: boolean): boolean {
    const key = `${job.person}\n${job.seq}`;
    if (this.queued.has(key)) return false;
    this.queued.add(key);
    if (first) this.queue.unshift(job);
    else this.queue.push(job);
    return true;
  }

  /** Once per person and run of the bus: their agent messages of the last days not every model judged, newest first. */
  private backfill(person: string): void {
    if (this.stopped || this.backfilled.has(person)) return;
    this.backfilled.add(person);
    const conversations = new Map<string, Conversation | null>();
    let added = 0;
    for (const m of this.ctx.db.unjudgedAgentMessages(person, this.now() - BACKFILL_DAYS * DAY_MS, BACKFILL_MAX * 10)) {
      if (added >= BACKFILL_MAX) break;
      if (!conversations.has(m.conversationId)) conversations.set(m.conversationId, this.ctx.db.getConversation(m.conversationId));
      const conversation = conversations.get(m.conversationId);
      if (conversation && this.concerns(person, { from: "", text: m.text }, conversation) && this.enqueue({ person, seq: m.seq }, false)) added++;
    }
    if (added > 0) void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job && !this.stopped; job = this.queue.shift()) {
        try {
          await this.judge(job);
        } finally {
          this.queued.delete(`${job.person}\n${job.seq}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async judge({ person, seq }: Job): Promise<void> {
    const message = this.ctx.db.getMessage(seq);
    const conversation = message && this.ctx.db.getConversation(message.conversationId);
    if (!message || message.deletedAt || !conversation || !this.concerns(person, message, conversation)) return;
    this.controller = new AbortController();
    const timer = setTimeout(() => this.controller?.abort(), TIMEOUT_MS);
    let verdicts: Record<string, unknown>;
    try {
      const res = await fetch(`${this.box.url.replace(/\/+$/, "")}/needs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.bodyOf(person, message, conversation)),
        signal: this.controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const answer = (await res.json()) as { verdicts?: unknown };
      if (typeof answer.verdicts !== "object" || answer.verdicts === null) throw new Error("no verdicts in the answer");
      verdicts = answer.verdicts as Record<string, unknown>;
    } catch (error) {
      if (!this.stopped) this.warn(`the needs box is not answering: ${error instanceof Error ? error.message : String(error)}`);
      return;
    } finally {
      clearTimeout(timer);
    }
    if (this.stopped) return;
    const at = this.now();
    let needs = false;
    for (const [model, verdict] of Object.entries(verdicts)) {
      const v = verdict as { needs?: unknown; p?: unknown; error?: unknown };
      if (typeof v?.needs !== "boolean" || typeof v.p !== "number" || !Number.isFinite(v.p)) {
        this.warn(`${model} gave no verdict: ${typeof v?.error === "string" ? v.error : JSON.stringify(verdict)}`);
        continue;
      }
      if (!this.ctx.db.addNeedsVerdict(person, seq, model, v.needs, v.p, at)) continue;
      this.record({ seq, person, model, needs: v.needs, p: v.p, at: new Date(at).toISOString() });
      needs ||= v.needs;
    }
    if (needs) this.ctx.hub.needsChanged(person);
  }

  private bodyOf(person: string, message: Message, conversation: Conversation): BoxNeedsBody {
    const before = this.ctx.db
      .listMessages(conversation.id, message.seq, CONTEXT_MESSAGES * 2)
      .filter((m) => m.deletedAt === undefined)
      .slice(-CONTEXT_MESSAGES);
    const task = message.task?.assignees.some((a) => a.id === person) ? message.task.type : undefined;
    return {
      v: 1,
      kind: "needs",
      person,
      conversation: {
        id: conversation.id,
        kind: conversation.kind,
        ...(conversation.name ? { name: conversation.name } : {}),
        ...(conversation.title ? { title: conversation.title } : {}),
        members: conversation.members,
        people: conversation.kind === "all" ? this.ctx.humans : conversation.members.filter((id) => this.ctx.hub.isHuman(id)),
      },
      messages: before.map((m) => ({ seq: m.seq, from: m.from, fromKind: m.fromKind, text: m.text, createdAt: m.createdAt })),
      message: { seq: message.seq, from: message.from, fromKind: message.fromKind, text: message.text, createdAt: message.createdAt, ...(task ? { task } : {}) },
    };
  }

  private record(line: Record<string, unknown>): void {
    try {
      appendFileSync(this.recordFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (error) {
      this.warn(`could not write ${this.recordFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private warn(text: string): void {
    if (text === this.lastError) return;
    this.lastError = text;
    console.warn(`needs: ${text}`);
  }
}
