// Agents and viewers on their sockets (join after the machine account's token is approved, backlog, acks and seen,
// status, live output), the routes that approve agent tokens, agent settings, and forgetting agents that stay offline.
import {
  baseAgentId,
  isJsonObject,
  RESOURCES_AGENT_ID,
  type ActivityEvent,
  type AgentIdentity,
  type AgentSettings,
  type AgentStatus,
  type Conversation,
  type Participant,
} from "@agent-bus/protocol";
import { tokenId } from "./agent-tokens";
import { tokenHash, type BusContext } from "./context";
import { HttpError, json, readJsonObject } from "./http";
import { sendFrame, type Socket, type SocketData } from "./hub";

const BACKLOG_LIMIT = 100;
const SETTING_VALUES = ["wake", "quiet"] as const;

/** A valid `status` frame body, trimmed to display sizes; undefined otherwise. */
function parseStatus(raw: unknown): AgentStatus | undefined {
  if (!isJsonObject(raw)) return undefined;
  const { state, since, tool, toolSince, activity } = raw;
  if ((state !== "idle" && state !== "busy") || typeof since !== "number" || !Number.isFinite(since)) return undefined;
  const status: AgentStatus = { state, since };
  if (typeof tool === "string" && tool.length > 0) status.tool = tool.slice(0, 64);
  if (typeof toolSince === "number" && Number.isFinite(toolSince)) status.toolSince = toolSince;
  if (typeof activity === "string" && activity.length > 0) status.activity = activity.slice(0, 200);
  return status;
}

/** What `socketHandlers` gives the server: the `websocket` handlers, and admitting sockets once tokens are decided. */
export interface AgentSockets {
  handlers: Bun.WebSocketHandler<SocketData>;
  /**
   * Joins the sockets that waited for token `hash` if it is approved now, and refuses them if denied; closes the
   * connected agents of a token that was revoked. Called after a decision on the website, and every few seconds for
   * decisions made on the host (`agent-bus approve`).
   */
  settle(hash: string): void;
  /** `settle` for every token with waiting or connected sockets. */
  settleAll(): void;
}

/** The `websocket` handlers of `Bun.serve` for `/ws/agent` and `/ws/viewer`. */
export function socketHandlers(ctx: BusContext): AgentSockets {
  const { db, hub } = ctx;
  /** Ids no agent can take: humans and the built-in @resources. */
  const reservedIds = new Set([...ctx.humans, RESOURCES_AGENT_ID]);

  const refuse = (ws: Socket, code: number, error: string): void => {
    sendFrame(ws, { type: "error", error });
    ws.close(code, error.slice(0, 120));
  };

  const handleAgentOpen = (ws: Socket): void => {
    const data = ws.data;
    if (data.kind !== "agent") return;
    if (data.host === null) return refuse(ws, 1008, "Missing host query parameter");
    if ((data.path === null) === (data.name === null)) return refuse(ws, 1008, "Give exactly one of the path or name query parameters");
    if (data.name !== null && baseAgentId({ host: data.host, name: data.name }) === "") {
      return refuse(ws, 1008, `Name "${data.name}" has no usable id characters`);
    }
    if (data.tokenHash === null) {
      return refuse(ws, 4401, "This harness sends no agent token: update its plugin (agent-bus install <harness>) and restart it");
    }
    const state = ctx.tokens.state(data.tokenHash);
    if (state === "denied") return refuse(ws, 4403, "This machine's agent token was denied or revoked on this bus");
    if (state === "approved") return join(ws);
    // First contact from this machine account: hold the socket and ask a person (like ssh's first connection).
    const code = ctx.tokens.request(data.tokenHash, { host: data.host, addr: data.addr, agent: data.path ?? data.name ?? "" });
    hub.addPending(data.tokenHash, ws);
    sendFrame(ws, { type: "pending", code });
    hub.agentTokensChanged();
  };

  const join = (ws: Socket): void => {
    const data = ws.data;
    if (data.kind !== "agent" || data.host === null || data.tokenHash === null) return;
    const identity: AgentIdentity =
      data.path !== null ? { host: data.host, path: data.path } : { host: data.host, name: data.name ?? "" };
    const { participant, isNew } = db.joinAgent(identity, data.harness, reservedIds);
    // An agent id belongs to the first approved token that joins as it.
    const bound = db.agentTokenHash(participant.id);
    if (bound !== null && bound !== data.tokenHash) {
      return refuse(
        ws,
        4401,
        `@${participant.id} is bound to another agent token (another machine or account joined as it first). On the bus's host, \`agent-bus reset-agent ${participant.id}\` frees it.`
      );
    }
    if (bound === null) db.setAgentTokenHash(participant.id, data.tokenHash);
    ctx.tokens.noteAgent(data.tokenHash, data.path ?? data.name ?? participant.id);
    ctx.tokens.touch(data.tokenHash);
    data.id = participant.id;
    // Another session of this agent is already live: it got the unacked messages (or gets them handed over when it
    // goes away), so this one starts without backlog.
    const othersLive = hub.sessionsOf(participant.id).length > 0 && hub.liveSessionNumber(participant.id, data.sessionKey) === undefined;
    data.sessionNo = hub.sessionNumber(participant.id, data.sessionKey);
    data.activeAt = hub.activityStamp();
    hub.addAgentSocket(participant.id, ws);

    sendFrame(ws, { type: "joined", id: participant.id, session: data.sessionNo, participants: hub.listParticipants() });
    if (hub.isWatched(participant.id)) sendFrame(ws, { type: "watch", on: true });
    if (!isNew && !othersLive) {
      const conversations = new Map<string, Conversation>();
      for (const message of db.backlogFor(participant.id, participant.deliveredSeq, BACKLOG_LIMIT)) {
        let conversation = conversations.get(message.conversationId);
        if (!conversation) {
          conversation = db.getConversation(message.conversationId) ?? undefined;
          if (!conversation) continue;
          conversations.set(conversation.id, conversation);
        }
        hub.deliver([ws], message, conversation, participant, true);
      }
    }
    hub.broadcastParticipants();
  };

  const settle = (hash: string): void => {
    const state = ctx.tokens.state(hash);
    if (state === "pending") return;
    const waiting = hub.takePending(hash);
    if (state === "approved") {
      for (const ws of waiting) join(ws);
      return;
    }
    for (const ws of waiting) refuse(ws, 4403, "This machine's agent token was denied on this bus");
    for (const ws of hub.agentSocketsOfToken(hash)) refuse(ws, 4403, "This machine's agent token was revoked on this bus");
  };

  const handleAgentMessage = (ws: Socket, raw: string | Buffer): void => {
    const data = ws.data;
    if (data.kind !== "agent" || data.id === "") return;
    let frame: unknown;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      sendFrame(ws, { type: "error", error: "Frames must be JSON" });
      return;
    }
    if (
      isJsonObject(frame) &&
      (frame.type === "ack" || frame.type === "seen") &&
      typeof frame.seq === "number" &&
      Number.isSafeInteger(frame.seq) &&
      frame.seq >= 0
    ) {
      if (frame.type === "ack") db.ackDelivered(data.id, frame.seq);
      data.inflight.delete(frame.seq);
      hub.recordReceipt(data.id, frame.seq, frame.type);
      return;
    }
    if (isJsonObject(frame) && frame.type === "status") {
      const status = parseStatus(frame.status);
      if (status) {
        // A session that starts working is the one the person is using: it gets messages that name no session.
        if (status.state === "busy" && data.status?.state !== "busy") data.activeAt = hub.activityStamp();
        data.status = status;
        data.statusAt = Date.now();
        data.reportingSince ??= data.statusAt;
        hub.scheduleViewerParticipants();
        return;
      }
    }
    if (isJsonObject(frame) && frame.type === "activity" && Array.isArray(frame.events)) {
      // Relayed as is (never stored) to the viewers watching this agent; the website renders it as text only.
      hub.relayActivity(
        {
          type: "activity",
          agentId: data.id,
          events: frame.events as ActivityEvent[],
          ...(frame.replay === true ? { replay: true } : {}),
        },
        data.sessionNo
      );
      return;
    }
    sendFrame(ws, {
      type: "error",
      error: 'Expected {"type":"ack"|"seen","seq":<integer>}, {"type":"status",…} or {"type":"activity",…}',
    });
  };

  const handleViewerMessage = (ws: Socket, raw: string | Buffer): void => {
    const data = ws.data;
    if (data.kind !== "viewer") return;
    let frame: unknown;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return;
    }
    if (!isJsonObject(frame)) return;
    if (!data.signedIn) {
      // A browser cannot set headers on a WebSocket, so it signs in with its first frame.
      const session = typeof frame.session === "string" ? frame.session : undefined;
      const agentToken = typeof frame.agentToken === "string" ? frame.agentToken : undefined;
      const ok =
        frame.type === "auth" &&
        ((session !== undefined && ctx.auth.humanOfSession(session) !== undefined) ||
          (agentToken !== undefined && ctx.tokens.isApproved(tokenHash(agentToken))));
      if (!ok) return refuse(ws, 4401, "Sign in (passkey, /auth) or send an approved agent token");
      data.signedIn = true;
      const human = session !== undefined ? ctx.auth.humanOfSession(session) : undefined;
      if (human !== undefined) data.human = human;
      hub.addViewer(ws);
      return;
    }
    if (frame.type !== "watch") return;
    const agentId = typeof frame.agentId === "string" && frame.agentId !== "" ? frame.agentId : undefined;
    const session = typeof frame.session === "number" && Number.isSafeInteger(frame.session) && frame.session > 0 ? frame.session : undefined;
    hub.setWatching(ws, agentId, session);
  };

  const handleClose = (ws: Socket): void => {
    const data = ws.data;
    if (data.kind === "viewer") {
      hub.removeViewer(ws);
      return;
    }
    if (data.id === "") {
      hub.removePending(ws);
      return;
    }
    const remaining = hub.removeAgentSocket(data.id, ws);
    if (remaining === undefined) return;
    if (remaining === 0) {
      // An agent that never took part (no message written, in no group) is forgotten when it logs off.
      if (!db.removeIfIdle(data.id)) db.touchParticipant(data.id);
    } else {
      db.touchParticipant(data.id);
    }
    hub.broadcastParticipants();
  };

  return {
    handlers: {
      open(ws) {
        if (ws.data.kind === "viewer") {
          if (ws.data.signedIn) hub.addViewer(ws);
        } else handleAgentOpen(ws);
      },
      message(ws, raw) {
        if (ws.data.kind === "viewer") handleViewerMessage(ws, raw);
        else handleAgentMessage(ws, raw);
      },
      close(ws) {
        handleClose(ws);
      },
    },
    settle,
    settleAll() {
      for (const hash of new Set([...hub.pendingTokenHashes(), ...hub.connectedTokenHashes()])) settle(hash);
    },
  };
}

/** GET /api/agent-tokens and POST /api/agent-tokens/<id or code>/(approve|deny): people decide which machines join. */
export async function handleAgentTokens(ctx: BusContext, sockets: AgentSockets, req: Request, url: URL): Promise<Response> {
  const me = ctx.requireHuman(req);
  if (req.method === "GET" && url.pathname === "/api/agent-tokens") return json({ tokens: ctx.tokens.list() });
  const match = /^\/api\/agent-tokens\/([^/]+)\/(approve|deny)$/.exec(url.pathname);
  if (req.method !== "POST" || !match?.[1]) throw new HttpError(404, `No route for ${req.method} ${url.pathname}`);
  const hash = ctx.tokens.resolve(decodeURIComponent(match[1]));
  if (!hash) throw new HttpError(404, `No agent token ${match[1]}`);
  ctx.tokens.decide(hash, match[2] === "approve" ? "approved" : "denied", me);
  sockets.settle(hash);
  ctx.hub.agentTokensChanged();
  return json({ token: ctx.tokens.list().find((t) => t.id === tokenId(hash)) });
}

/** POST /api/settings {from, key, value}: an agent's own settings. */
export async function postSetting(ctx: BusContext, req: Request): Promise<{ participant: Participant }> {
  const body = await readJsonObject(req);
  const participant = typeof body.from === "string" ? ctx.db.getParticipant(body.from.trim().toLowerCase()) : null;
  if (!participant) throw new HttpError(400, "from must be a participant id; settings are per participant");
  ctx.checkWriter(req, participant);
  if (participant.kind === "human") {
    // People have one setting: who writes their English voice messages.
    if (body.key !== "englishSpeech" || (body.value !== "whisper" && body.value !== "liquid")) {
      throw new HttpError(400, 'People\'s setting is englishSpeech: "whisper" or "liquid"');
    }
    const settings: AgentSettings = { ...participant.settings, englishSpeech: body.value };
    ctx.db.setSettings(participant.id, settings);
    ctx.hub.broadcastParticipants();
    return { participant: ctx.hub.toParticipant({ ...participant, settings }) };
  }
  if (body.key !== "all") {
    throw new HttpError(400, `Unknown setting "${String(body.key)}". Valid keys: all`);
  }
  const value = body.value === "wake" || body.value === "quiet" ? body.value : null;
  if (value === null) {
    throw new HttpError(
      400,
      `Invalid value ${JSON.stringify(body.value)} for "all". Valid values: ${SETTING_VALUES.join(", ")}`
    );
  }
  const settings: AgentSettings = { ...participant.settings, all: value };
  ctx.db.setSettings(participant.id, settings);
  ctx.hub.broadcastParticipants();
  return { participant: ctx.hub.toParticipant({ ...participant, settings }) };
}

/** Forgets agents offline for more than `days` days (0: never): their participant record and pending receipts. */
export function forgetOfflineAgents(ctx: BusContext, days: number): void {
  if (days <= 0) return;
  const keep = new Set([...ctx.hub.onlineAgentIds(), RESOURCES_AGENT_ID]);
  const gone = ctx.db.forgetAgentsSeenBefore(Date.now() - days * 24 * 3600_000, keep);
  if (gone.length === 0) return;
  console.log(`forgot agents offline for more than ${days} days: ${gone.join(", ")}`);
  ctx.hub.broadcastParticipants();
}
