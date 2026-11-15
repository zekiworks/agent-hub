export const PROTOCOL_VERSION = "2.0.0";
export const DEFAULT_BUS_PORT = 7800;
/** The single conversation every agent receives. */
export const ALL_CONVERSATION_ID = "all";

export type ParticipantKind = "agent" | "human";

/** Per-participant settings: agents change theirs with `set(key, value)`, people theirs on the website. */
export interface AgentSettings {
  /**
   * How `@all` messages written by other agents reach this agent:
   * "quiet" (default) = added to the conversation at its next turn without starting one;
   * "wake" = like any other message. `@all` from humans always behaves like a composer message.
   */
  all: "wake" | "quiet";
  /**
   * People: who writes their English voice messages as text. "whisper" (default) for every language; "liquid": LFM3-
   * Audio for what Whisper judges English (as good, faster; Whisper keeps every other language).
   */
  englishSpeech?: "whisper" | "liquid";
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

/**
 * `all`: every agent. `dm`: exactly two members, fixed. `group`: a group DM, unnamed, its members add others and
 * leave. `project`: named, with a topic and a visibility; people and agents join and leave. See docs/projects.md.
 */
export type ConversationKind = "all" | "dm" | "group" | "project";

/** Who can find and read a project: anyone (open), its name and topic only (discoverable), its members (private). */
export type ProjectVisibility = "open" | "discoverable" | "private";

/**
 * A member's notifications for one conversation. Agents: `all` = every message wakes it, `mentions` = only messages
 * that @mention it do (the rest it reads at its next turn), `none` = none do. People: unread dots and notifications
 * likewise.
 */
export type NotifyLevel = "all" | "mentions" | "none";

export interface Conversation {
  /** "all" or "g_<12 hex>". Its identity: members can change, the id never does. */
  id: string;
  kind: ConversationKind;
  /** Sorted participant ids; [] for `all`. */
  members: string[];
  /**
   * The same as `members`. Agent sessions and plugins started before projects (14 Nov) read it from every delivery,
   * and cannot be updated while they run; remove once none of them is left.
   */
  addressed: string[];
  /** Projects. */
  name?: string;
  topic?: string;
  visibility?: ProjectVisibility;
  /** Group DMs and projects out of the sidebar (and Browse) until someone writes in them again. */
  archived?: true;
  /**
   * Archived automatically, after `archiveIdleDays` (3) quiet days unpinned (Can, 15 Nov): any member's message brings
   * it back, an agent's too. One a person archived takes agents' messages only after a person brings it back.
   */
  archivedIdle?: true;
  /**
   * A room (Can, 15 Nov): a project addressed as "#name" (only so), the way sub-work is made: optionally under one
   * project. Everything else is as for projects.
   */
  room?: true;
  /**
   * Projects and group DMs: the root project this one belongs under (absent: a root). One level only: parents are
   * root projects, and a project with children stays a root. Children take the parent's colour.
   */
  parentId?: string;
  /** The parent project's name, with `parentId`: a group under it is addressed "@{@@name,a,b}". */
  parentName?: string;
  /** Members whose notification setting is not `all`. */
  notify?: Record<string, Exclude<NotifyLevel, "all">>;
  /** Who pinned it (members or not): it sorts first in their own sidebar (Can, 15 Nov). */
  pinnedBy?: string[];
  /** A discoverable project the reader is not in: its name, topic and members only, not its messages. */
  preview?: true;
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

/** What a task asks for (Can, 15 Nov): an approval is decided by people only, signed in with a passkey. */
export type TaskType = "task" | "approval" | "chore";

/** Where one assignee is with a task. "withdrawn": its assigner took it back while it was open or accepted. */
export type TaskState = "open" | "accepted" | "done" | "rejected" | "withdrawn";

/** One assignee of a task and their part of it. */
export interface TaskAssignee {
  id: string;
  state: TaskState;
  /** When the state last changed (absent while open). */
  at?: number;
  /** Rejecting or withdrawing may say why. */
  reason?: string;
  /** People's decisions: made from a signed-in (passkey) session. Required for approvals. */
  verified?: boolean;
  /** People: when they first saw it in their inbox (unread until then). */
  readAt?: number;
}

/** A message marked as a task: its seq is the task's id; the message text is what is asked and never changes. */
export interface Task {
  type: TaskType;
  assignees: TaskAssignee[];
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
  /** Set when the message is a task (Task): the inbox of each assignee lists it. */
  task?: Task;
  /**
   * The agents it wakes (starts a turn for); the others take it in at their next turn (Can, 15 Nov). A person's message
   * wakes, in a DM, its agent; elsewhere the agent it answers (the replied-to message's author, else the previous
   * message's) and the agents it @mentions; an agent's wakes the agent it replies to and those it lists. Absent: written before wake lists, or by an agent's older tool, which
   * follows the old rule (every agent, or per the notify settings).
   */
  wake?: string[];
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
      /** Tasks open or accepted for the recipient (the delivery footer reminds it). */
      openTasks?: number;
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
  | { type: "message"; message: Message; conversation: Conversation }
  /** Conversations changed (members, notifications, a project's settings): refetch GET /api/state. */
  | { type: "conversations" }
  /** A conversation's checklist changed (GET /api/conversations/:id/checklist has it). */
  | { type: "checklist"; conversationId: string }
  /** A project's Home changed (GET /api/conversations/:id/home has it). */
  | { type: "home"; conversationId: string }
  /** A task's state changed: the message as it is now (its `task`). */
  | { type: "task"; message: Message; conversation: Conversation }
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
  /** Agents' pages the website shows as right-pane tabs, served at /ext/<name>/<key>/ (`serve --ext`). */
  extensions?: string[];
}

/**
 * GET /api/stats?days=N: messages written and the agent turns they started, over the last `days` days. A delivery
 * "wakes" its agent unless it is quiet (@all from an agent, for an agent with the default `all` setting); a woken agent
 * that is already busy takes the message into its running turn, so `turns` is an upper bound on new model turns.
 */
export interface StatsResponse {
  since: number;
  days: number;
  /** Everyone who wrote or got a message in the window. */
  participants: ParticipantStats[];
  /** Per day in the bus's time zone ("2026-11-14"), oldest first; days without messages are left out. */
  daily: Array<{ day: string; messages: number; turns: number }>;
}

export interface ParticipantStats {
  id: string;
  kind: ParticipantKind;
  /** Messages it wrote. */
  written: number;
  /** Agents: deliveries that woke it. */
  turns: number;
  /** Agents: deliveries it took in quietly, at its next turn. */
  quiet: number;
  /** Deliveries of its messages that woke an agent. */
  caused: number;
}

export interface MessagesResponse {
  /** Ascending by seq. */
  messages: Message[];
}

/**
 * A conversation's checklist (the right pane's Checklist tab; first use: Ali's list of Can's tasks). `text` is markdown
 * its owner agent writes (PUT): `- [ ] item · #1234` lines, headings allowed. People tick items on the website; the
 * ticks are kept apart from the text, keyed by the item's text, so a republished list keeps them, and an item the owner
 * drops takes its tick with it.
 */
export interface Checklist {
  text: string;
  /** Item text (without "- [ ] ") → who ticked it and when. */
  ticks: Record<string, { by: string; at: number }>;
  updatedAt: number;
  updatedBy: string;
  /** Who first published it: only they replace it (Can, 15 Nov). */
  owner: string;
  /** Whom the list is for. Only the owner and these tick its items (Can, 15 Nov). */
  assignees: string[];
}

/**
 * A project's Home (Can, 15 Nov): markdown its owner agent keeps current, newest first (done, blockers, links,
 * long-task updates); the Home tab of the right pane. Its first publisher owns it.
 */
export interface Home {
  text: string;
  owner: string;
  updatedAt: number;
  updatedBy: string;
}

/** PUT /api/conversations/:id/home: the owner replaces the whole text. */
export interface PutHomeRequest {
  from: string;
  text: string;
}

/**
 * PUT /api/conversations/:id/checklist: the owner replaces the text (the first PUT, by a member, makes them the
 * owner). `assignees` (participant ids) is kept as it was when left out.
 */
export interface PutChecklistRequest {
  from: string;
  text: string;
  assignees?: string[];
}

/** POST /api/conversations/:id/checklist/tick: the owner or an assignee ticks (or unticks) one item, by its text. */
export interface TickRequest {
  from: string;
  item: string;
  done: boolean;
}

/** POST /api/tasks/:seq/{accept,done,reject,withdraw,read}: one participant's step on a task. */
export interface TaskActionRequest {
  from: string;
  reason?: string;
}

/** GET /api/tasks?for=<id>&box=mine|assigned&state=open|all: tasks with their conversations, newest first. */
export interface TasksResponse {
  messages: Message[];
  conversations: Conversation[];
  /** For `for`: tasks still open or accepted for them, and how many of those they have not seen. */
  open: number;
  unread: number;
}

/** A file shared in a conversation, with the message that shared it. */
export interface SharedFile {
  file: FileRef;
  seq: number;
  from: string;
  createdAt: number;
}

/**
 * GET /api/conversations/:id/files: the files shared there, newest first (the right pane's Shared list). Voice
 * messages are left out: they are messages, not shared files.
 */
export interface SharedFilesResponse {
  files: SharedFile[];
}

/**
 * GET /api/inbox, /api/history, /api/search: messages (ascending by seq) with the conversations they are in.
 * `scope=mine` (default) limits to `@all` and conversations the reader is a member of; `scope=all` reads everything.
 */
export interface ReadResponse {
  messages: Message[];
  conversations: Conversation[];
}

/**
 * POST /api/messages. Exactly one of `to` / `conversationId` / `replyToSeq`. `to`: "@x" (the writer's DM with x),
 * "@{a,b}" (the group DM with exactly these members and the writer; a new one if there is none), "@@name" (project
 * `name`: created, open, if new; joined if open), "@all". In a group DM or project, a message that is exactly
 * "exit" makes the writer leave instead.
 */
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
  /**
   * Makes the message a task. `assignees`: members who are to do it (default: those the text @mentions, else the other
   * member of a DM). Assigned agents are woken. Approvals can only be assigned to people.
   */
  task?: { type?: TaskType; assignees?: string[] };
  /**
   * Agents only: the agents of the conversation this message wakes besides the one it replies to, who always is
   * (Message.wake); `[]`: only that one. Left out: the old rule, for tools from before wake lists. People's lists are
   * made by the bus.
   */
  wake?: string[];
  /**
   * People only, in a group DM or project: add the participants the text @mentions who are not members before
   * sending (agents get the last 5 messages first). Default false: mentions alone add nobody.
   */
  addMentioned?: boolean;
}

export interface PostMessageResponse {
  message: Message;
  conversation: Conversation;
  /**
   * For agents: a `#n` in the text that a person of this conversation cannot open (it is in a conversation they are
   * not in). The message is sent; quote what #n says instead (Can, 15 Nov: such references must not land on people).
   */
  warnings?: string[];
}

/** POST /api/conversations/:id/members: a member adds `ids` to its group DM or project. */
export interface AddMembersRequest {
  from: string;
  ids: string[];
}

/** POST /api/conversations/:id/leave */
export interface LeaveRequest {
  from: string;
}

/** POST /api/conversations/:id/notify: a member's own notification setting there. */
export interface NotifyRequest {
  from: string;
  level: NotifyLevel;
}

/**
 * POST /api/conversations/:id/project: a member turns a group DM into a project (`name` required) or changes a
 * project's `topic` and `visibility`; renaming is for people only.
 */
export interface ProjectRequest {
  from: string;
  name?: string;
  topic?: string;
  visibility?: ProjectVisibility;
}

/**
 * POST /api/conversations/:id/parent: a member puts a project or group DM under project `parent` ("@@name" or an id),
 * or makes it a root again (`parent` null).
 */
export interface ParentRequest {
  from: string;
  parent: string | null;
}

/** POST /api/conversations/:id/archive: a person archives (or brings back) a group DM or project. */
export interface ArchiveRequest {
  from: string;
  archived: boolean;
}

/** What the conversation endpoints above answer. */
export interface ConversationResponse {
  conversation: Conversation;
}

/** POST /api/conversations/:id/delete (people only, projects only): gone for good, with how many messages. */
export interface DeleteProjectResponse {
  deleted: string;
  messages: number;
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
  /** The model that wrote it: "whisper" or "liquid". */
  engine?: string;
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
