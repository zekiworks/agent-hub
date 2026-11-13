export const PROTOCOL_VERSION = "2.0.0";
export const DEFAULT_BUS_PORT = 7800;
/** The single conversation every agent receives. */
export const ALL_CONVERSATION_ID = "all";

export type ParticipantKind = "agent" | "human";

/** Per-agent settings, changed by the agent with `set(key, value)`. */
export interface AgentSettings {
  /**
   * How `@all` messages written by other agents reach this agent:
   * "quiet" (default) = added to the conversation at its next turn without starting one;
   * "wake" = like any other message. `@all` from humans always behaves like a composer message.
   */
  all: "wake" | "quiet";
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = { all: "quiet" };

export interface Participant {
  /**
   * Stable id. Agents: machine + project folder (or name, for harnesses without a folder, like Hermes) + harness; the
   * id is the folder name, with `-<harness>` added only when another harness already holds that name for the same
   * folder. Humans are configured ("carol", "uma").
   */
  id: string;
  kind: ParticipantKind;
  /** Agents: the harness ("omp", "codex", "hermes", …); part of its identity. */
  harness?: string;
  /** Agents that joined by project folder: absolute project path. */
  path?: string;
  /** Agents: hostname of the machine the agent runs on. */
  host?: string;
  /** Agents: at least one live connection. Humans: always false. */
  online: boolean;
  /** Live agent connections (one per session, more while a session reconnects). */
  connections: number;
  /**
   * Agents: the live sessions (windows, tasks) of this agent, numbered from 1. They share the agent's conversations;
   * a message reaches one of them: the one it names (`@id-2`), else the most recently active.
   */
  sessions?: AgentSession[];
  lastSeenAt: number;
  settings: AgentSettings;
  /** Agents: what the harness reports about itself, while connected (omp only today). */
  status?: AgentStatus;
  /** Agents: messages delivered to its session but not yet seen by its model. */
  waiting?: number;
  /**
   * Agents whose connections keep dropping (FLAP_DROPS disconnects within FLAP_WINDOW_MS): why, shown as a red ERR.
   * Such an agent is reported offline (`online: false`) until it has stayed connected for that window.
   */
  connectionError?: string;
}

/** One live session of an agent. */
export interface AgentSession {
  n: number;
  status?: AgentStatus;
  /** Last time it joined or started working: the most recent one gets messages that name no session. */
  activeAt: number;
}

/** An agent's own report of what it is doing; sent by the harness, never costs a model turn. */
export interface AgentStatus {
  state: "idle" | "busy";
  /** When it entered `state`. */
  since: number;
  /** Tool running right now (the oldest when several run), and since when. */
  tool?: string;
  toolSince?: number;
  /** The agent's one-line intent for its latest tool call (omp shows it as "⎋ …"). */
  activity?: string;
}

export interface Conversation {
  /** "all" or "g_<12 hex>". */
  id: string;
  kind: "all" | "group";
  /** Groups: the sorted ids the conversation was addressed to (writer included). Identity of the group; "all": []. */
  addressed: string[];
  /** Groups: `addressed` plus humans who have written in it. "all": []. */
  members: string[];
  createdAt: number;
  lastMessageAt: number;
}

export interface FileRef {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  sha256: string;
}

export interface Message {
  /** Global, monotonic. */
  seq: number;
  id: string;
  conversationId: string;
  from: string;
  fromKind: ParticipantKind;
  text: string;
  files: FileRef[];
  createdAt: number;
  /**
   * One entry per agent the message was sent to (fixed when it is written; never the writer, never humans).
   * Empty for messages written before receipts existed.
   */
  receipts: Receipt[];
  /** Set when the message was written as a reply to message `quote.seq` (same conversation). */
  quote?: Quote;
  /** The writing agent's session number, when it had several live sessions. */
  fromSession?: number;
  /**
   * Until when the bus holds it for recipients that are offline (default an hour after it was written; the writer
   * may choose longer). A recipient that has not received it by then never will: its receipt is `expired`.
   */
  expiresAt: number;
  /**
   * Only on human messages written while the bus checks who humans are (auth optional/required): true when written
   * from a signed-in session (passkey), false when not. Absent: authentication was off.
   */
  verified?: boolean;
}

/** The message a reply answers: who wrote it and the start of its text (QUOTE_TEXT_CHARS). */
export interface Quote {
  seq: number;
  from: string;
  text: string;
  /** Number of files the quoted message carried. */
  files: number;
}

export const QUOTE_TEXT_CHARS = 280;

export interface Receipt {
  to: string;
  /** The session of `to` the writer chose (`@to-2`, or the website's picker); absent: its most recently active one. */
  session?: number;
  /** The recipient's harness accepted the message into its session (queued, or started a turn). */
  deliveredAt: number | null;
  /** The message was in a request to the recipient's model, i.e. the agent has it in front of it. Implies delivered. */
  seenAt: number | null;
  /** Not delivered before the message's `expiresAt` (the recipient stayed offline): it never will be. */
  expired?: boolean;
}

/** Sent to viewers, and to the writer's own agent connections, whenever a receipt changes. */
export interface ReceiptFrame {
  type: "receipt";
  seq: number;
  conversationId: string;
  to: string;
  deliveredAt: number;
  seenAt: number | null;
}

/** A message expired for one recipient (it stayed offline): to viewers and the writer's agent connections. */
export interface ExpiredFrame {
  type: "expired";
  seq: number;
  conversationId: string;
  to: string;
}

/** What a writer's harness hears about a message after writing it: a recipient received it, or it expired for one. */
export type ReceiptEvent = ReceiptFrame | ExpiredFrame;

// ---- Agent connection: WS /ws/agent?host=<hostname>&harness=<omp|hermes|…>&path=<abs project path>  (or &name=<id> instead of path) ----

export type AgentServerFrame =
  /** `session`: this connection's session number within the agent (shown as `@id-<n>` while it has several). */
  | { type: "joined"; id: string; session: number; participants: Participant[] }
  | {
      type: "deliver";
      message: Message;
      conversation: Conversation;
      /** Address the recipient writes to for replying into the same conversation ("@all", "@id", "@{a,b}"). */
      replyTo: string;
      /** false = deliver quietly (no new turn); see AgentSettings.all. */
      wake: boolean;
      /** Held while the recipient was offline, and handed over now it is back: it may be old (see createdAt). */
      held?: boolean;
    }
  | { type: "participants"; participants: Participant[] }
  | ReceiptFrame
  | ExpiredFrame
  /** Someone is (on) or is no longer (off) watching this agent's live output; stream `activity` only while on. */
  | { type: "watch"; on: boolean }
  /**
   * This machine's agent token is not approved yet: a person allows it on the website, or runs `agent-bus approve
   * <code>` on the bus's host. The socket stays open and joins once allowed.
   */
  | { type: "pending"; code: string }
  | { type: "error"; error: string };

/**
 * One entry of an agent's live output, as its harness reports it. Entries are upserts: a later event with the
 * same `id` replaces the earlier one (streaming text grows, a tool goes from running to done).
 */
export type ActivityEvent =
  /** A prompt reaching the model: typed by the operator, or a bus delivery. */
  | { id: string; at: number; kind: "user"; text: string }
  /** `thinking`: the model's (summarized) thoughts in that message, when the provider returns them. */
  | { id: string; at: number; kind: "assistant"; text: string; thinking?: string; done: boolean }
  | {
      id: string;
      at: number;
      kind: "tool";
      name: string;
      intent?: string;
      /** The command or arguments, shortened. */
      input: string;
      /** The output so far (its tail when long). */
      output: string;
      state: "running" | "done" | "error";
    };

/**
 * `ack`: the harness accepted delivery `seq` into the session. `seen`: it was handed to the model. `status`: what the
 * agent is doing. `activity`: live output while watched (`replay`: the recent entries sent when watching starts).
 */
export type AgentClientFrame =
  | { type: "ack"; seq: number }
  | { type: "seen"; seq: number }
  | { type: "status"; status: AgentStatus }
  | { type: "activity"; events: ActivityEvent[]; replay?: boolean };

// ---- Website: WS /ws/viewer ----

export type ViewerServerFrame =
  /** `merged`: a group that this message's mention merged into `conversation` (its id is now an alias). */
  | { type: "message"; message: Message; conversation: Conversation; merged?: string }
  | { type: "participants"; participants: Participant[] }
  | ReceiptFrame
  | ExpiredFrame
  /** Live output of the agent this viewer watches. */
  | { type: "activity"; agentId: string; events: ActivityEvent[]; replay?: boolean }
  /** The schedule changed (GET /api/resources has the new state). */
  | { type: "resources" }
  /** Agent tokens changed: a new request to join, or one allowed, denied or revoked (GET /api/agent-tokens). */
  | { type: "agent-tokens" }
  | { type: "error"; error: string };

/**
 * `auth`: the first frame from a browser, which cannot set headers on a WebSocket (a passkey session; scripts may send
 * an agent token instead, or the headers at upgrade). Then the viewer watches one agent's live output at a time
 * (`agentId: null` stops): the session it names, else the agent's most recently active session.
 */
export type ViewerClientFrame =
  | { type: "auth"; session?: string; agentToken?: string }
  | { type: "watch"; agentId: string | null; session?: number };

/** A machine account's agent token as people see it: the hub stores its hash; `id` is the hash's first 12 characters. */
export interface AgentTokenInfo {
  id: string;
  state: "pending" | "approved" | "denied";
  /** Short code shown to the agent while pending (also `agent-bus approve <code>`). */
  code: string;
  host: string | null;
  /** Network address the latest request came from. */
  addr: string | null;
  /** Folders or names that asked to join with it (pending) or joined with it. */
  agents: string[];
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  lastUsedAt: number | null;
}

// ---- HTTP ----

export interface StateResponse {
  participants: Participant[];
  conversations: Conversation[];
  /** Configured human ids, for the website's profile picker. */
  humans: string[];
}

export interface MessagesResponse {
  /** Ascending by seq. */
  messages: Message[];
}

/**
 * GET /api/inbox, /api/history, /api/search: messages (ascending by seq) with the conversations they are in.
 * `scope=mine` (default) limits to `@all` and conversations the reader is a member of; `scope=all` reads everything.
 */
export interface ReadResponse {
  messages: Message[];
  conversations: Conversation[];
}

/** POST /api/messages. Exactly one of `to` / `conversationId` / `replyToSeq`. */
export interface PostMessageRequest {
  from: string;
  to?: string;
  conversationId?: string;
  /** Reply into the conversation of message `replyToSeq` (the `#n` in a delivery header). */
  replyToSeq?: number;
  text: string;
  fileIds?: string[];
  /** For a conversation with one agent: the session of that agent to reach (else its most recently active one). */
  toSession?: number;
  /** How long to hold it for recipients that are offline, in hours (default 1, at most 168). */
  holdHours?: number;
}

export interface PostMessageResponse {
  message: Message;
  conversation: Conversation;
}

/** POST /api/settings */
export interface SetSettingRequest {
  from: string;
  key: string;
  value: unknown;
}

/** POST /api/files/:id/transcript: what was said in an audio file (voice messages). */
export interface TranscriptResponse {
  text: string;
  /** Detected language code ("tr", "en", …). */
  language: string;
  /** Seconds of audio. */
  duration: number;
}

export interface HealthResponse {
  ok: true;
  version: string;
  uptimeMs: number;
  lanUrls: string[];
}

export interface ErrorResponse {
  error: string;
}
