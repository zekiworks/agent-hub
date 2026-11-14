// The bus's live state: the agents' and viewers' sockets and everything sent over them (participant lists with
// status, deliveries, receipts, live-output watching). Everything else is in the database.
import {
  replyAddress,
  shouldWake,
  type AgentServerFrame,
  type AgentSession,
  type AgentStatus,
  type Conversation,
  type ExpiredFrame,
  type Message,
  type Participant,
  type Receipt,
  type ReceiptFrame,
  type ViewerServerFrame,
} from "@agent-bus/protocol";
import { readable } from "./conversations";
import type { BusDatabase, ParticipantRecord } from "./db";

/** How long a session keeps its number after its last connection closed (a reconnect after a short drop). */
const SESSION_HOLD_MS = 60_000;
/** An agent whose connections dropped this many times within FLAP_WINDOW_MS is reported offline with an error. */
export const FLAP_DROPS = 4;
export const FLAP_WINDOW_MS = 2 * 60_000;

export type SocketData =
  | {
      kind: "agent";
      host: string | null;
      path: string | null;
      name: string | null;
      harness: string | null;
      /** SHA-256 of the agent's token (query `token`): it must be approved, and binds or must match the id. */
      tokenHash: string | null;
      /** The network address the connection came from (shown when asking a person to allow the token). */
      addr: string | null;
      /**
       * The session this connection belongs to: the harness's key (query `session`, one per window or task, kept
       * across reconnects), or a key of its own for harnesses that send none.
       */
      sessionKey: string;
      /** The session's number within the agent (from 1); 0 until joined. */
      sessionNo: number;
      /** Last time this connection joined or started working: messages that name no session go to the latest. */
      activeAt: number;
      /** Deliveries sent here and not acked yet: handed to another session if this one goes away. */
      inflight: Set<number>;
      /** Assigned on open; "" until joined. */
      id: string;
      /** Latest status this connection reported, when, and when its first report arrived. */
      status?: AgentStatus;
      statusAt?: number;
      reportingSince?: number;
    }
  | {
      kind: "viewer";
      /** Signed in (passkey session or approved agent token, at upgrade or by the first frame); before that it gets nothing. */
      signedIn: boolean;
      /** The person signed in, if a person (an agent token sees only what agents may read). */
      human?: string;
      /** Agent whose live output this viewer watches, and which session (undefined: its most recently active one). */
      watching?: string;
      watchingSession?: number;
    };

export type Socket = Bun.ServerWebSocket<SocketData>;

export function sendFrame(ws: Socket, frame: AgentServerFrame | ViewerServerFrame): void {
  ws.send(JSON.stringify(frame));
}

type ReceiptWaiter = { done: (r: Receipt) => boolean; resolve: () => void };

export class Hub {
  /** Live agent sockets by participant id. */
  private readonly agentSockets = new Map<string, Set<Socket>>();
  private readonly viewers = new Set<Socket>();
  /** Viewers by the agent they watch; the agent streams while it has at least one. */
  private readonly watchers = new Map<string, Set<Socket>>();
  /** GET /api/messages/:seq?waitMs= callers, resolved once `done` holds for every receipt of the message. */
  private readonly receiptWaiters = new Map<number, Set<ReceiptWaiter>>();
  /** Agent sockets whose machine account's token waits for a person's decision, by token hash. */
  private readonly pending = new Map<string, Set<Socket>>();
  /**
   * Session numbers kept for a while after a session's last connection closed, so a session that reconnects after a
   * short drop keeps its number: agent id → session key → {number, until}.
   */
  private readonly heldSessions = new Map<string, Map<string, { n: number; until: number }>>();
  private lastStamp = 0;
  private viewerParticipantsTimer: Timer | undefined;
  private resourcesTimer: Timer | undefined;
  private conversationsTimer: Timer | undefined;
  /** When each agent's connections dropped, within the last FLAP_WINDOW_MS (see `connectionError`). */
  private readonly drops = new Map<string, number[]>();
  /** Per flapping agent: the broadcast that clears its error once the window has passed without drops. */
  private readonly flapTimers = new Map<string, Timer>();

  constructor(
    private readonly db: BusDatabase,
    /** Configured human ids; other stored humans are not participants. */
    private readonly humans: ReadonlySet<string>
  ) {}

  // ---- Participants ----

  /** Returns the participant if `id` may act as a writer: any stored agent or a configured human. */
  knownParticipant(id: string): ParticipantRecord | null {
    const record = this.db.getParticipant(id);
    if (!record) return null;
    return record.kind === "agent" || this.humans.has(record.id) ? record : null;
  }

  knownIds(): string[] {
    return this.knownRecords().map((p) => p.id);
  }

  private knownRecords(): ParticipantRecord[] {
    return this.db.listParticipants().filter((p) => p.kind === "agent" || this.humans.has(p.id));
  }

  isHuman(id: string): boolean {
    return this.humans.has(id);
  }

  /** Ids of the agents connected now. */
  onlineAgentIds(): Iterable<string> {
    return this.agentSockets.keys();
  }

  /** Status of a set of connections: a busy one beats an idle one; among equals, the latest report wins. */
  private statusOf(sockets: Iterable<Socket>): AgentStatus | undefined {
    let best: { status: AgentStatus; at: number } | undefined;
    for (const ws of sockets) {
      const data = ws.data;
      if (data.kind !== "agent" || !data.status) continue;
      const at = data.statusAt ?? 0;
      const busy = data.status.state === "busy";
      const bestBusy = best?.status.state === "busy";
      if (!best || (busy && !bestBusy) || (busy === bestBusy && at > best.at)) best = { status: data.status, at };
    }
    return best?.status;
  }

  // ---- Sessions: the windows or tasks of one agent, numbered from 1 ----

  /** The live sessions of `id`: number → its connections, joined order. */
  private sessionsMap(id: string): Map<number, Socket[]> {
    const sessions = new Map<number, Socket[]>();
    for (const ws of this.agentSockets.get(id) ?? []) {
      if (ws.data.kind !== "agent") continue;
      const list = sessions.get(ws.data.sessionNo) ?? [];
      list.push(ws);
      sessions.set(ws.data.sessionNo, list);
    }
    return sessions;
  }

  sessionsOf(id: string): AgentSession[] {
    return [...this.sessionsMap(id)]
      .map(([n, sockets]) => {
        const status = this.statusOf(sockets);
        const activeAt = Math.max(...sockets.map((ws) => (ws.data.kind === "agent" ? ws.data.activeAt : 0)));
        return { n, ...(status ? { status } : {}), activeAt };
      })
      .sort((a, b) => a.n - b.n);
  }

  /**
   * The number for session `key` of agent `id`: the one it has (live, or held after a short drop), else the lowest
   * number no live or held session uses.
   */
  sessionNumber(id: string, key: string, now = Date.now()): number {
    const held = this.heldSessions.get(id);
    for (const [k, h] of held ?? []) if (h.until < now) held?.delete(k);
    for (const ws of this.agentSockets.get(id) ?? []) {
      if (ws.data.kind === "agent" && ws.data.sessionKey === key && ws.data.sessionNo > 0) return ws.data.sessionNo;
    }
    const mine = held?.get(key);
    if (mine) {
      held?.delete(key);
      return mine.n;
    }
    const used = new Set([...this.sessionsMap(id).keys(), ...[...(held?.values() ?? [])].map((h) => h.n)]);
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  /** The live session number of `key` for agent `id`, if it is connected. */
  liveSessionNumber(id: string, key: string): number | undefined {
    for (const ws of this.agentSockets.get(id) ?? []) {
      if (ws.data.kind === "agent" && ws.data.sessionKey === key && ws.data.sessionNo > 0) return ws.data.sessionNo;
    }
    return undefined;
  }

  /**
   * A time for "this session is active now", strictly later than any given before, so two sessions that become
   * active in the same millisecond are still ordered.
   */
  activityStamp(): number {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return this.lastStamp;
  }

  /** Marks session `key` of `id` as just active (it wrote, or started working): it now gets un-numbered messages. */
  touchSession(id: string, key: string): void {
    const now = this.activityStamp();
    for (const ws of this.agentSockets.get(id) ?? []) {
      if (ws.data.kind === "agent" && ws.data.sessionKey === key) ws.data.activeAt = now;
    }
  }

  /**
   * Where a delivery for `id` goes: session `n` when given and live, else the most recently active session (all its
   * connections). Empty when the agent is offline: the message then waits for its next session.
   */
  deliveryTargets(id: string, n?: number): Socket[] {
    const sessions = this.sessionsMap(id);
    if (n !== undefined && sessions.has(n)) return sessions.get(n) ?? [];
    let best: { at: number; sockets: Socket[] } | undefined;
    for (const sockets of sessions.values()) {
      const at = Math.max(...sockets.map((ws) => (ws.data.kind === "agent" ? ws.data.activeAt : 0)));
      if (!best || at > best.at) best = { at, sockets };
    }
    return best?.sockets ?? [];
  }

  /** The most recently active session number of `id`, if online. */
  private latestSession(id: string): number | undefined {
    const target = this.deliveryTargets(id)[0];
    return target?.data.kind === "agent" ? target.data.sessionNo : undefined;
  }

  /**
   * Messages waiting for an agent's model, counted only since its status-reporting connection joined: a harness
   * that reports status also reports `seen`; older sessions never do, so their deliveries would count forever.
   */
  private waitingOf(id: string): number | undefined {
    let since: number | undefined;
    for (const ws of this.agentSockets.get(id) ?? []) {
      const data = ws.data;
      if (data.kind === "agent" && data.reportingSince !== undefined) {
        since = Math.min(since ?? data.reportingSince, data.reportingSince);
      }
    }
    return since === undefined ? undefined : this.db.waitingCount(id, since);
  }

  /** Why `id` counts as offline although it may be connected right now: its connections keep dropping. */
  private connectionError(id: string, now = Date.now()): string | undefined {
    const recent = (this.drops.get(id) ?? []).filter((t) => t > now - FLAP_WINDOW_MS);
    if (recent.length === 0) this.drops.delete(id);
    else this.drops.set(id, recent);
    if (recent.length < FLAP_DROPS) return undefined;
    return `Keeps reconnecting: ${recent.length} dropped connections in the last ${FLAP_WINDOW_MS / 60_000} minutes`;
  }

  toParticipant(record: ParticipantRecord): Participant {
    const connections = record.kind === "agent" ? (this.agentSockets.get(record.id)?.size ?? 0) : 0;
    const connectionError = record.kind === "agent" ? this.connectionError(record.id) : undefined;
    const participant: Participant = {
      id: record.id,
      kind: record.kind,
      online: connections > 0 && connectionError === undefined,
      connections,
      lastSeenAt: record.lastSeenAt,
      settings: record.settings,
    };
    if (connectionError !== undefined) participant.connectionError = connectionError;
    if (record.harness !== null) participant.harness = record.harness;
    if (record.path !== null) participant.path = record.path;
    if (record.host !== null) participant.host = record.host;
    if (record.kind === "agent") {
      const status = this.statusOf(this.agentSockets.get(record.id) ?? []);
      if (status) participant.status = status;
      if (connections > 0) participant.sessions = this.sessionsOf(record.id);
      const waiting = this.waitingOf(record.id);
      if (waiting !== undefined) participant.waiting = waiting;
    }
    return participant;
  }

  /** Agents and configured humans; online first, then by id. */
  listParticipants(): Participant[] {
    return this.knownRecords()
      .map((record) => this.toParticipant(record))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
  }

  broadcastParticipants(): void {
    const frame = JSON.stringify({ type: "participants", participants: this.listParticipants() });
    for (const sockets of this.agentSockets.values()) {
      for (const ws of sockets) ws.send(frame);
    }
    for (const ws of this.viewers) ws.send(frame);
  }

  /** Status and waiting counts change often; viewers get them coalesced, agents not at all. */
  scheduleViewerParticipants(): void {
    if (this.viewerParticipantsTimer || this.viewers.size === 0) return;
    this.viewerParticipantsTimer = setTimeout(() => {
      this.viewerParticipantsTimer = undefined;
      const frame = JSON.stringify({ type: "participants", participants: this.listParticipants() });
      for (const ws of this.viewers) ws.send(frame);
    }, 250);
  }

  /** The schedule changed: viewers refetch GET /api/resources (coalesced). */
  resourcesChanged(): void {
    if (this.resourcesTimer || this.viewers.size === 0) return;
    this.resourcesTimer = setTimeout(() => {
      this.resourcesTimer = undefined;
      const frame = JSON.stringify({ type: "resources" } satisfies ViewerServerFrame);
      for (const ws of this.viewers) ws.send(frame);
    }, 250);
  }

  /** Members or a conversation's settings changed: viewers refetch GET /api/state (coalesced). */
  conversationsChanged(): void {
    if (this.conversationsTimer || this.viewers.size === 0) return;
    this.conversationsTimer = setTimeout(() => {
      this.conversationsTimer = undefined;
      const frame = JSON.stringify({ type: "conversations" } satisfies ViewerServerFrame);
      for (const ws of this.viewers) ws.send(frame);
    }, 250);
  }

  // ---- Sockets ----

  addAgentSocket(id: string, ws: Socket): void {
    let sockets = this.agentSockets.get(id);
    if (!sockets) {
      sockets = new Set();
      this.agentSockets.set(id, sockets);
    }
    sockets.add(ws);
  }

  /**
   * Drops one connection of `id`; returns how many it still has, or undefined when it had none. The session's number
   * is held for a minute when this was its last connection, and deliveries it had not acked go to the agent's most
   * recently active remaining session (if none is left, they wait for the next one to join, as backlog).
   */
  removeAgentSocket(id: string, ws: Socket, now = Date.now()): number | undefined {
    const sockets = this.agentSockets.get(id);
    if (!sockets) return undefined;
    sockets.delete(ws);
    if (sockets.size === 0) this.agentSockets.delete(id);
    this.noteDrop(id, now);
    const data = ws.data;
    if (data.kind !== "agent") return sockets.size;
    if (!this.liveSessionNumber(id, data.sessionKey)) {
      let held = this.heldSessions.get(id);
      if (!held) this.heldSessions.set(id, (held = new Map()));
      held.set(data.sessionKey, { n: data.sessionNo, until: now + SESSION_HOLD_MS });
    }
    if (sockets.size > 0 && data.inflight.size > 0) this.handOver(id, [...data.inflight]);
    return sockets.size;
  }

  /** Records a dropped connection; a flapping agent's error clears by itself (one broadcast) after a quiet window. */
  private noteDrop(id: string, now: number): void {
    const drops = this.drops.get(id) ?? [];
    drops.push(now);
    this.drops.set(id, drops);
    clearTimeout(this.flapTimers.get(id));
    const timer = setTimeout(() => {
      this.flapTimers.delete(id);
      this.broadcastParticipants();
    }, FLAP_WINDOW_MS + 1000);
    timer.unref();
    this.flapTimers.set(id, timer);
  }

  /** Re-delivers `seqs` (not acked by the session that got them) to `id`'s current target session. */
  private handOver(id: string, seqs: number[]): void {
    const recipient = this.db.getParticipant(id);
    if (!recipient) return;
    for (const seq of seqs.sort((a, b) => a - b)) {
      const message = this.db.getMessage(seq);
      const receipt = message?.receipts.find((r) => r.to === id);
      const conversation = message && this.db.getConversation(message.conversationId);
      if (!message || !receipt || receipt.deliveredAt !== null || !conversation) continue;
      this.deliver(this.deliveryTargets(id), message, conversation, recipient);
    }
  }

  /** Sends a delivery to `sockets` and remembers it there until acked; `held`: it waited while the agent was offline. */
  deliver(sockets: Socket[], message: Message, conversation: Conversation, recipient: ParticipantRecord, held = false): void {
    const frame = JSON.stringify(this.deliverFrame(message, conversation, recipient, held));
    for (const ws of sockets) {
      if (ws.data.kind === "agent") ws.data.inflight.add(message.seq);
      ws.send(frame);
    }
  }

  /** Viewers whose person (or agent token) may read `conversation` (see `readable`). */
  private viewersOf(conversation: Pick<Conversation, "kind" | "members" | "visibility"> | null): Socket[] {
    if (!conversation) return [];
    return [...this.viewers].filter(
      (ws) =>
        ws.data.kind === "viewer" &&
        readable(conversation, ws.data.human ? { id: ws.data.human, kind: "human" } : { id: "", kind: "agent" }, (id) => this.isHuman(id))
    );
  }

  /** Tells the viewers and each writer's agent connections that a message expired for a recipient that stayed offline. */
  announceExpired(expired: ReadonlyArray<{ seq: number; conversationId: string; from: string; to: string }>): void {
    for (const e of expired) {
      const frame = JSON.stringify({ type: "expired", seq: e.seq, conversationId: e.conversationId, to: e.to } satisfies ExpiredFrame);
      for (const ws of this.viewersOf(this.db.getConversation(e.conversationId))) ws.send(frame);
      for (const ws of this.agentSockets.get(e.from) ?? []) ws.send(frame);
    }
  }

  addPending(hash: string, ws: Socket): void {
    let sockets = this.pending.get(hash);
    if (!sockets) this.pending.set(hash, (sockets = new Set()));
    sockets.add(ws);
  }

  /** Removes and returns the sockets waiting on `hash`. */
  takePending(hash: string): Socket[] {
    const sockets = [...(this.pending.get(hash) ?? [])];
    this.pending.delete(hash);
    return sockets;
  }

  removePending(ws: Socket): void {
    for (const [hash, sockets] of this.pending) {
      if (!sockets.delete(ws)) continue;
      if (sockets.size === 0) this.pending.delete(hash);
      return;
    }
  }

  pendingTokenHashes(): string[] {
    return [...this.pending.keys()];
  }

  /** Token hashes of the agents connected now. */
  connectedTokenHashes(): string[] {
    const hashes = new Set<string>();
    for (const sockets of this.agentSockets.values()) {
      for (const ws of sockets) if (ws.data.kind === "agent" && ws.data.tokenHash) hashes.add(ws.data.tokenHash);
    }
    return [...hashes];
  }

  agentSocketsOfToken(hash: string): Socket[] {
    const out: Socket[] = [];
    for (const sockets of this.agentSockets.values()) {
      for (const ws of sockets) if (ws.data.kind === "agent" && ws.data.tokenHash === hash) out.push(ws);
    }
    return out;
  }

  /** Viewers refetch GET /api/agent-tokens: a new request to join, or a decision. */
  agentTokensChanged(): void {
    const frame = JSON.stringify({ type: "agent-tokens" } satisfies ViewerServerFrame);
    for (const ws of this.viewers) ws.send(frame);
  }

  addViewer(ws: Socket): void {
    this.viewers.add(ws);
    sendFrame(ws, { type: "participants", participants: this.listParticipants() });
  }

  removeViewer(ws: Socket): void {
    this.setWatching(ws, undefined);
    this.viewers.delete(ws);
  }

  // ---- Messages and receipts ----

  deliverFrame(message: Message, conversation: Conversation, recipient: ParticipantRecord, held = false): AgentServerFrame {
    return {
      type: "deliver",
      message,
      conversation,
      replyTo: replyAddress(conversation, recipient.id),
      wake: shouldWake(conversation, message, recipient.id, recipient.settings),
      ...(held ? { held } : {}),
    };
  }

  /** Delivers a new message to its connected recipients and shows it to the viewers. */
  publishMessage(message: Message, conversation: Conversation): void {
    for (const { to, session } of message.receipts) {
      const recipient = this.db.getParticipant(to);
      if (!recipient) continue;
      this.deliver(this.deliveryTargets(to, session), message, conversation, recipient);
    }
    const viewerFrame = JSON.stringify({ type: "message", message, conversation } satisfies ViewerServerFrame);
    for (const ws of this.viewersOf(conversation)) ws.send(viewerFrame);
  }

  /** Records `agentId`'s ack/seen of `seq` and tells viewers, the writer's agent connections and receipt waiters. */
  recordReceipt(agentId: string, seq: number, state: "ack" | "seen"): void {
    const receipt = this.db.markReceipt(agentId, seq, state);
    if (!receipt || receipt.deliveredAt === null) return;
    this.scheduleViewerParticipants();
    const message = this.db.getMessage(seq);
    if (!message) return;
    const update: ReceiptFrame = {
      type: "receipt",
      seq,
      conversationId: message.conversationId,
      to: agentId,
      deliveredAt: receipt.deliveredAt,
      seenAt: receipt.seenAt,
    };
    const frame = JSON.stringify(update);
    for (const ws of this.viewersOf(this.db.getConversation(message.conversationId))) ws.send(frame);
    for (const ws of this.agentSockets.get(message.from) ?? []) ws.send(frame);
    for (const waiter of this.receiptWaiters.get(seq) ?? []) {
      if (message.receipts.every(waiter.done)) waiter.resolve();
    }
  }

  /** Resolves once `done` holds for every receipt of message `seq` (checked on each receipt), or after `waitMs`. */
  async waitForReceipts(seq: number, done: (r: Receipt) => boolean, waitMs: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const waiter = { done, resolve };
    let waiters = this.receiptWaiters.get(seq);
    if (!waiters) this.receiptWaiters.set(seq, (waiters = new Set()));
    waiters.add(waiter);
    const timer = setTimeout(resolve, waitMs);
    await promise;
    clearTimeout(timer);
    waiters.delete(waiter);
    if (waiters.size === 0) this.receiptWaiters.delete(seq);
  }

  // ---- Live output ----

  isWatched(agentId: string): boolean {
    return this.watchers.has(agentId);
  }

  private sendToAgent(agentId: string, frame: AgentServerFrame): void {
    for (const ws of this.agentSockets.get(agentId) ?? []) sendFrame(ws, frame);
  }

  /**
   * The viewer watches `agentId`'s live output: session `session`, or (undefined) whichever is most recently active.
   * Every session of a watched agent streams; `relayActivity` passes on only the watched session's entries.
   */
  setWatching(viewer: Socket, agentId: string | undefined, session?: number): void {
    const data = viewer.data;
    if (data.kind !== "viewer" || (data.watching === agentId && data.watchingSession === session)) return;
    const previous = data.watching;
    if (previous !== undefined && previous !== agentId) {
      const set = this.watchers.get(previous);
      set?.delete(viewer);
      if (set && set.size === 0) {
        this.watchers.delete(previous);
        this.sendToAgent(previous, { type: "watch", on: false });
      }
    }
    data.watching = agentId;
    data.watchingSession = session;
    if (agentId === undefined) return;
    let set = this.watchers.get(agentId);
    if (!set) {
      set = new Set();
      this.watchers.set(agentId, set);
    }
    set.add(viewer);
    // Sent for every new watcher, not just the first: each one needs the agent's replay of recent entries.
    this.sendToAgent(agentId, { type: "watch", on: true });
  }

  /** Sends an `activity` frame from session `session` of its agent to the viewers watching that session. */
  relayActivity(frame: Extract<ViewerServerFrame, { type: "activity" }>, session: number): void {
    const text = JSON.stringify(frame);
    const latest = this.latestSession(frame.agentId);
    for (const viewer of this.watchers.get(frame.agentId) ?? []) {
      if (viewer.data.kind !== "viewer") continue;
      if ((viewer.data.watchingSession ?? latest) === session) viewer.send(text);
    }
  }

  // ---- Shutdown ----

  /** Before the servers stop: resolves every receipt waiter and cancels the coalescing timers. */
  stop(): void {
    for (const waiters of this.receiptWaiters.values()) for (const waiter of waiters) waiter.resolve();
    this.receiptWaiters.clear();
    clearTimeout(this.viewerParticipantsTimer);
    clearTimeout(this.resourcesTimer);
    clearTimeout(this.conversationsTimer);
    for (const timer of this.flapTimers.values()) clearTimeout(timer);
    this.flapTimers.clear();
  }

  /** After the servers stopped. */
  dropSockets(): void {
    this.agentSockets.clear();
    this.viewers.clear();
    this.pending.clear();
  }
}
