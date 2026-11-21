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
  /**
   * People: the language of their voice messages (codex-ui #10803, Ümit testing in English). Absent: the bus's rule
   * (Turkish unless Whisper is near-certain it is English); "en" or "tr": always that language; "auto": Whisper's own
   * guess. Only this person's voice messages change.
   */
  voiceLanguage?: "en" | "tr" | "auto";
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
  /** Projects: the address ("#name" for a room, "@@name" for a project), a slug that does not change with the title. */
  name?: string;
  /**
   * Projects and rooms: the name people read, in any letters and with spaces ("Model Research", "Yeni model ekleme")
   * (#10623). Absent: the address is the name. Renaming changes this, never the address, so links and agents' addresses
   * keep working.
   */
  title?: string;
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
  /**
   * People who have seen it, and up to when (the time of the newest message they saw): "Seen" for the others (Ümit
   * #12323). Members only; agents have receipts instead.
   */
  seen?: Record<string, number>;
  /** Who wrote its newest message: "answered" when it is the other person (Ümit #12323). */
  lastMessageFrom?: string;
  /**
   * Messages pinned in this conversation (#10757), oldest pin first: references, never copies. The header's 📌 counts
   * them, together with the conversation's checklist.
   */
  pinnedMessages?: PinnedMessage[];
  /** A discoverable project the reader is not in: its name, topic and members only, not its messages. */
  preview?: true;
  createdAt: number;
  lastMessageAt: number;
}

/** A message pinned in its conversation: which one, who pinned it, when. */
export interface PinnedMessage {
  seq: number;
  by: string;
  at: number;
}

/** POST /api/conversations/:id/pinned: a member pins (or unpins) one of the conversation's messages. */
export interface PinMessageRequest {
  from: string;
  seq: number;
  pinned: boolean;
}

export interface FileRef {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  sha256: string;
}

/** What a task asks for (Can, 15 Nov): an approval is decided by people only, signed in with a passkey. "chore" meant
 * the same as "task" and became one (Can #12827). */
export type TaskType = "task" | "approval";

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
  /**
   * Its writer changed the text (Ümit #10890): when, last. Only the text changes; agents that already received it keep
   * the text they got (a delivery cannot be taken back), those it reaches later get the new one.
   */
  editedAt?: number;
  /**
   * Its writer deleted it (Ümit #10890): text and files are gone, the row stays so replies and #numbers still point
   * somewhere. Agents that already received it keep their copy; it is no longer handed to those that had not.
   */
  deletedAt?: number;
  /**
   * A message forwarded to someone who may not read its conversation, or to another conversation (Can #12470): the
   * original as it was then. Its text here is the forwarder's note ("" for none). Later edits or deletes of the
   * original do not change it.
   */
  forwarded?: ForwardedMessage;
  /**
   * Where this message was forwarded (Can #12470), oldest first. Only on the message itself, which only readers of its
   * conversation get; the copies never point back.
   */
  forwards?: MessageForward[];
}

/** POST /api/messages/:seq/edit: its writer changes the text. */
export interface EditMessageRequest {
  from: string;
  text: string;
}

/** POST /api/messages/:seq/delete: its writer deletes it. */
export interface DeleteMessageRequest {
  from: string;
}

/** A copy of a forwarded message as it was when forwarded (Message.forwarded; Can #12470). */
export interface ForwardedMessage {
  seq: number;
  conversationId: string;
  /** Its conversation's name then: "#room", a project's title, "#all", or the members ("@{a,b}"). */
  conversationTitle: string;
  from: string;
  createdAt: number;
  text: string;
  /** Its files: whoever has the copy opens them (GET /api/files/:id). */
  files: FileRef[];
}

/** One forward of a message (Message.forwards): who forwarded it, to whom ("@b", "#room", "@@project"), when. */
export interface MessageForward {
  by: string;
  to: string;
  at: number;
}

/**
 * POST /api/messages/:seq/forward (Can #12470): `from`, who may read message `seq`, forwards it to `to`, a participant
 * ("b", "@b") or a conversation ("#room", "@@project", "@{a,b}", "@all"), with an optional `note`.
 * - A participant who can read its conversation and is in it (or it is @all): a reply to it there, "@b <note>" (or
 *   "@b (forwarded to you)"), which wakes b as a mention does. Nothing is copied.
 * - Another participant: a message in the DM of `from` and b, its text the note, carrying a copy (Message.forwarded).
 * - A conversation: the same message there; its own conversation is refused (400).
 * The message records the forward (Message.forwards). 404 when `from` cannot read it.
 */
export interface ForwardRequest {
  from: string;
  to: string;
  note?: string;
}

/** The message written for the forward (a reply, or the one carrying the copy), and where it went ("@b", "#room"). */
export interface ForwardResponse extends PostMessageResponse {
  to: string;
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
  /** A message was edited or deleted by its writer: the message as it is now (replies quoting it refresh too). */
  | { type: "changed"; message: Message; conversation: Conversation }
  /** The viewer's own bookmarks changed (another of their pages, or this one): the list as it is now. */
  | { type: "bookmarks"; bookmarks: Bookmark[] }
  /** The viewer's own tasks changed (another of their pages, or this one): the list as it is now. */
  | { type: "ownTasks"; ownTasks: OwnTask[] }
  /** A person saw a conversation up to `at` (POST /api/conversations/:id/seen): its other members show "Seen". */
  | { type: "seen"; conversationId: string; participant: string; at: number }
  /** The viewer's own tab order changed (another of their pages, or this one). */
  | { type: "tabs"; tabs: string[] }
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
  /** Pages the website shows in the Workspace, served at /ext/<name>/<key>/ (`serve --ext`). */
  extensions?: string[];
  /** Global ones among them (#10211): name → the label of their top-bar launcher (`--ext name=url,launcher=GPUs`).
   * The others are entity extensions: a tab of @@name and of agent name's DM. */
  launchers?: Record<string, string>;
  /** Box extensions (`--ext name=url,box=complete`): name → role. The website's message box asks them, not the Workspace. */
  boxes?: Record<string, BoxRole>;
  /** The bus books GPUs (`serve --gpudash URL`): the website offers GPU booking under Tools. */
  gpuBooking?: true;
  /** The signed-in person's own bookmarks (Can #11065), newest first; only people have them. */
  bookmarks?: Bookmark[];
  /** The signed-in person's own tasks (Can #12197): messages they took as a task for themselves. */
  ownTasks?: OwnTask[];
  /**
   * The signed-in person's tabs (Can #11463, #11480): the conversations they pinned, in their order. Theirs alone; the
   * same set the list shows first ("Pin to the top").
   */
  tabs?: string[];
}

/** POST /api/tabs: a person puts their tabs in a new order (every id one of their pins). */
export interface TabsRequest {
  from: string;
  order: string[];
}

/** A message a person saved for themselves (Can #11065): only they see it; the message itself is not touched. */
export interface Bookmark {
  seq: number;
  at: number;
}

/** POST /api/bookmarks: a person saves (or drops) a message they can read in their own list. */
export interface BookmarkRequest {
  from: string;
  seq: number;
  bookmarked: boolean;
}

/**
 * A message a person took as a task for themselves (Can #12197): in their own inbox, open until they mark it done.
 * Only they see it; the message itself is not touched and nobody is told.
 */
export interface OwnTask {
  seq: number;
  /** When it was taken as a task. */
  at: number;
  /** When it was marked done (absent while open). */
  doneAt?: number;
}

/** POST /api/own-tasks: a person takes a message they can read as a task ("open"), marks it "done", or drops it ("none"). */
export interface OwnTaskRequest {
  from: string;
  seq: number;
  state: "open" | "done" | "none";
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
 * One step on a checklist. Its `id` is the bus's and never changes: rewording keeps the id and the done state (Ümit
 * #12364, codex-ui #12379).
 */
export interface ChecklistItem {
  id: string;
  /** The instruction it belongs to, e.g. "#12364 Launch prep": items with the same heading show together. */
  heading?: string;
  text: string;
  /** Who added it (stored, not parsed from the text): only they, and people, change or remove it. */
  owner?: string;
  /** The message it came from: shown as a #seq link. */
  source?: number;
  /** What is missing before it can be done. */
  blocked?: string;
  /** More about it, under the text (markdown, may span lines): e.g. the lines under an item of a markdown list. */
  detail?: string;
  done?: { by: string; at: number };
}

/**
 * A conversation's checklist (the Workspace's Checklist tab), the one place agents track the instructions people give
 * them (Ümit #12364, #12367; codex-ui #12365, #12369, #12379): items under headings naming the instruction, ticked when
 * done. `version` grows with every change (an edit, a tick, a pin), so an agent's edit names the version it read.
 */
export interface Checklist {
  version: number;
  /** Counted among the conversation's pinned things; set on creation, changed only by people. */
  pinned: boolean;
  /** The list's name (a markdown list's `# Title` line), and the text under it before the first item. */
  title?: string;
  intro?: string;
  items: ChecklistItem[];
  /** Who made it (its first writer): the only one who may replace it with the markdown PUT. */
  creator: string;
  /** Whom the list is for (Can, 15 Nov). */
  assignees: string[];
  updatedAt: number;
  updatedBy: string;
  /** The list as markdown (`# title`, intro, `## heading`, `- [x] text`, detail indented), for the markdown PUT's writers and plain displays. */
  text: string;
  /** Item text → its done state, for the markdown PUT's writers who read ticks back by text. */
  ticks: Record<string, { by: string; at: number }>;
}

/** One change in an edit (ChecklistEditRequest), applied with the others or not at all. */
export type ChecklistOp =
  /** A new item; its owner is the writer. */
  | { op: "add"; heading?: string; text: string; source?: number; detail?: string }
  /** Rewords, moves to another heading ("" for none), sets what blocks it or its detail ("" clears either). */
  | { op: "update"; id: string; text?: string; heading?: string; blocked?: string; detail?: string }
  | { op: "remove"; id: string };

/**
 * POST /api/conversations/:id/checklist/edit: `ops` applied only if `base` is the current version (0: no list yet,
 * which creates it), else 409 with `{error, checklist}`: read it, then apply your own changes again. Agents change and
 * remove only their own items; people who are members change any.
 */
export interface ChecklistEditRequest {
  from: string;
  base: number;
  ops: ChecklistOp[];
  assignees?: string[];
}

/** POST /api/conversations/:id/checklist/pin: a person who is a member pins or unpins the list. */
export interface ChecklistPinRequest {
  from: string;
  pinned: boolean;
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
 * PUT /api/conversations/:id/checklist: the list as markdown, from before items had ids (kept for the agents that
 * write it so). The first PUT, by a member, creates the list; after that only its creator replaces it, naming the
 * version it read (`base`, required once the list exists). Lines are matched to items by their exact text, so ids and
 * ticks survive; `- [x]` marks an item done. An agent's PUT may not change other owners' items, and may not drop an item
 * a person ticked while adding new lines (a rewording: use the edit). `assignees` (participant ids) is kept as it was
 * when left out.
 */
export interface PutChecklistRequest {
  from: string;
  text: string;
  assignees?: string[];
  base?: number;
}

/**
 * POST /api/conversations/:id/checklist/tick: ticks (or unticks) item `id` of the list at version `base`. People who are
 * members (or assignees) tick any item; an agent only its own, and never unticks a person's tick.
 */
export interface TickRequest {
  from: string;
  id: string;
  done: boolean;
  base: number;
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
  /**
   * With replyToSeq: the part of that message it answers (a paragraph, as the page shows it; Ümit #13981), quoted instead
   * of the message's beginning. It must be from the message.
   */
  quoteText?: string;
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
  /** The address (slug). Changing it breaks old "#name" links; the title is the name to change. */
  name?: string;
  /** The name people read; "" clears it (the address is shown again). */
  title?: string;
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

/**
 * Box extensions (Can #12841–#12853): services the message box asks while a person types, set with
 * `serve --ext NAME=URL,box=ROLE`. They are not Workspace pages. "complete" suggests the next words of a draft;
 * "recipient" (Ümit #13030) suggests the one agent of a room to ask ("Ask @webapp"), or none.
 */
export type BoxRole = "complete" | "recipient";

/** POST /api/box/:name, from the website: the draft being typed in a conversation the person reads. */
export interface BoxRequest {
  conversationId: string;
  /** The draft up to the cursor. */
  text: string;
}

/** The answer of /api/box/:name and of the extension's own `POST /complete`: the words to add after the draft, or "". */
export interface BoxResponse {
  text: string;
}

/**
 * What the bus sends a "complete" extension: `POST <its URL>/complete` with this body. Versioned: fields may be added
 * (an extension ignores what it does not know); a change in meaning raises `v`. The bus sends only what the person may
 * read. A later field could list the model servers on the bus, so an extension can pick one itself; today's do not
 * get it (Can #12853).
 */
export interface BoxCompleteBody {
  v: 1;
  kind: "complete";
  /** The person typing. */
  me: string;
  conversation: { id: string; kind: ConversationKind; name?: string; title?: string; members: string[] };
  /** Its latest messages, oldest first (deleted ones left out). */
  messages: Array<{ seq: number; from: string; text: string; createdAt: number }>;
  draft: { text: string };
}

/**
 * The answer of /api/box/:name for a "recipient" box (Ümit #13030). The extension's own `POST /recipient` answers the
 * same shape; the bus passes on only an agent of `agents` (anything else becomes null).
 */
export interface BoxRecipientResponse {
  /** The agent to offer ("Ask @webapp"), or null: the box stays quiet. */
  recipient: string | null;
  /** The model's probability for that choice, 0–1 (the extension's cut-off is already applied). */
  confidence?: number;
}

/**
 * What a person did with a recipient box's offer when a message went (Ümit #13224), as POST /api/box/:name/report
 * records it: taken (sent with the offered agent), ignored (offered, sent naming nobody), named-other (offered, someone
 * else named), named (nothing offered, someone named), quiet (nothing offered, nobody named), reply (a Reply or
 * checklist answer).
 */
export const BOX_REPORT_OUTCOMES = ["taken", "ignored", "named-other", "named", "quiet", "reply"] as const;
export type BoxReportOutcome = (typeof BOX_REPORT_OUTCOMES)[number];

/**
 * GET /api/box/:name/usage (Ümit #13513): one person's own counts from a recipient box's reports, for them to share
 * with the Agent Hub team if they choose. Counts and days only: no conversation ids, names or text.
 */
export interface BoxUsage {
  /** Messages the person sent with the add-on on. */
  messages: number;
  outcomes: Record<BoxReportOutcome, number>;
  /** Messages where an agent was offered: taken + ignored + named-other. */
  offered: number;
  /** taken / offered, 0–1; null when nothing was offered. */
  takenShare: number | null;
  /** How long the page waited for the box's answer (ms), over the messages that have a time; null when none has. */
  answerMs: { answers: number; median: number; p90: number } | null;
  /** Messages before which asking the box failed. */
  failed: number;
  /** The first and last day (UTC, YYYY-MM-DD) with a message; null when there is none. */
  firstDay: string | null;
  lastDay: string | null;
  /** This Agent Hub's version (its package.json). */
  version: string;
}

/**
 * What the bus sends a "recipient" extension: `POST <its URL>/recipient`. Versioned like BoxCompleteBody; only what the
 * person may read. Sent only for a person's draft in a room with at least two `agents`, naming none of its members.
 */
export interface BoxRecipientBody {
  v: 1;
  kind: "recipient";
  /** The person typing. */
  me: string;
  conversation: { id: string; kind: ConversationKind; name?: string; title?: string; topic?: string; members: string[] };
  /** Its latest messages, oldest first (deleted ones left out), with their authors and what they answer. */
  messages: Array<{ seq: number; from: string; fromKind: ParticipantKind; text: string; createdAt: number; replyTo?: number }>;
  /** The room's checklist steps with their owners (who added them), open ones first; [] when it has none. */
  checklist: Array<{ id: string; heading?: string; text: string; owner?: string; done: boolean; blocked?: string }>;
  /** The agents it may name: the room's agent members, besides the person. At least two. */
  agents: string[];
  draft: { text: string };
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

/**
 * Web Push (Ümit #13927, #13934): a person's device (an iPhone's Home Screen app, a desktop browser) asks to be told of
 * messages for them while Agent Hub is closed. GET /api/push/key gives the bus's VAPID key; the device's subscription
 * goes to POST /api/push/subscribe, and POST /api/push/unsubscribe or /api/push/test name it by `endpoint`.
 */
export interface PushKeyResponse {
  /** The bus's VAPID public key (uncompressed P-256 point, base64url): the device's `applicationServerKey`. */
  publicKey: string;
}

/** A PushSubscription as the browser gives it (`subscription.toJSON()`). */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSubscribeRequest {
  subscription: WebPushSubscription;
}

/** What a notification carries to the device's service worker (sw.js), encrypted for that device. */
export interface PushPayload {
  title: string;
  body: string;
  /** Opened on a tap: the conversation. */
  url: string;
  /** Notifications with one tag replace each other: one per conversation. */
  tag: string;
}
