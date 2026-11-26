import { Database } from "bun:sqlite";
import {
  ALL_CONVERSATION_ID,
  baseAgentId,
  canonicalAddress,
  DEFAULT_AGENT_SETTINGS,
  isJsonObject,
  qualifiedAgentId,
  QUOTE_TEXT_CHARS,
  slugifyId,
  SYSTEM_AGENT_ID,
  type AgentIdentity,
  type AgentSettings,
  type Conversation,
  type ConversationKind,
  type FileRef,
  type ForwardedMessage,
  type Message,
  type MessageForward,
  type Receipt,
  type NotifyLevel,
  type ParticipantKind,
  type PinnedMessage,
  type Bookmark,
  type OwnTask,
  type ProjectVisibility,
  type Quote,
  type Checklist,
  type ChecklistItem,
  type Task,
  type MessageExtensions,
  type SharedFile,
  type StatsResponse,
} from "@agent-bus/protocol";
import { checklistItemId, checklistMarkdown, checklistTicks, parseChecklistMarkdown } from "./checklist-items";

/** A checklist as stored: the protocol's without its derived markdown and ticks, with the next item's number. */
export type StoredChecklist = Omit<Checklist, "text" | "ticks"> & { nextId: number };

interface ChecklistRow {
  updated_at: number;
  updated_by: string;
  owner: string | null;
  assignees_json: string | null;
  items_json: string | null;
  version: number | null;
  pinned: number | null;
  next_id: number | null;
  title: string | null;
  intro: string | null;
}

/** Stored participant; `online`/`connections` are live state added by the server. */
export interface ParticipantRecord {
  id: string;
  kind: ParticipantKind;
  harness: string | null;
  path: string | null;
  name: string | null;
  host: string | null;
  settings: AgentSettings;
  deliveredSeq: number;
  createdAt: number;
  lastSeenAt: number;
}

export interface JoinResult {
  participant: ParticipantRecord;
  /** True when this (host, path|name) had never joined before. */
  isNew: boolean;
}

/** An agent joined from a folder whose agent was renamed (and moved) by `agent-bus rename-agent`. */
export class AgentRenamedError extends Error {
  constructor(
    readonly oldId: string,
    readonly newId: string,
    readonly newPath: string | undefined
  ) {
    super(
      `@${oldId} was renamed to @${newId}${newPath ? `, which lives in ${newPath}` : ""}. Start the harness ${newPath ? `in ${newPath}` : `as @${newId}`}; this session is not joined.`
    );
  }
}

export interface NewMessage {
  conversationId: string;
  from: string;
  fromKind: ParticipantKind;
  text: string;
  files: FileRef[];
  createdAt: number;
  /** Agent ids the message is sent to (receipts start undelivered). */
  recipients: string[];
  /** Sessions the writer chose for some recipients (`@id-2`, the website's picker). */
  sessions?: ReadonlyMap<string, number>;
  /** The writing agent's session number, when it has several live sessions. */
  fromSession?: number;
  /** The message this one replies to (same conversation). */
  replyToSeq?: number;
  /** The part of that message it answers, when not all of it (a paragraph; Ümit #13981). */
  quoteText?: string;
  /** Human messages while authentication is on: written from a signed-in session (true) or not (false). */
  verified?: boolean;
  /** Agent ids whose harness should start a turn for this message. */
  wake?: string[];
  /** State attached by extensions. */
  ext?: MessageExtensions;
  /** Logical producer displayed through the shared @system identity. */
  systemSource?: string;
  expiresAt: number;
  /** A copy of the message it forwards (Message.forwarded; Can #12470). */
  forwarded?: ForwardedMessage;
}

interface ReceiptRow {
  seq: number;
  recipient: string;
  delivered_at: number | null;
  seen_at: number | null;
  session: number | null;
}

interface ParticipantRow {
  id: string;
  kind: string;
  harness: string | null;
  path: string | null;
  name: string | null;
  host: string | null;
  settings_json: string;
  delivered_seq: number;
  created_at: number;
  last_seen_at: number;
}

/** Column for queries over `conversations c`: the parent project's name. */
const PARENT_NAME = "(SELECT p.name FROM conversations p WHERE p.id = c.parent_id) AS parent_name";

/** A member of a conversation, as stored: their notification level. */
interface MemberRow {
  participant_id: string;
  notify: string | null;
  seen_at: number | null;
}

interface ConversationRow {
  id: string;
  kind: string;
  /** The members, kept for readers of the database that predate projects (Ali's hourly scan). */
  addressed_json: string;
  name: string | null;
  topic: string | null;
  visibility: string | null;
  archived: number | null;
  /** Null for root projects and unattached groups (and on databases from before the column). */
  parent_id?: string | null;
  /** The parent's name, joined in by the queries that read conversations. */
  parent_name?: string | null;
  created_at: number;
  last_message_at: number;
  room?: number | null;
  /** The name people read (#10623); null on databases from before the column, and when the address is the name. */
  title?: string | null;
}

interface MessageRow {
  seq: number;
  id: string;
  conversation_id: string;
  from_id: string;
  from_kind: string;
  text: string;
  files_json: string;
  created_at: number;
  reply_to_seq: number | null;
  quote_text: string | null;
  verified: number | null;
  from_session: number | null;
  expires_at: number | null;
  wake_json?: string | null;
  /** Legacy task column is read once into ext_json, then ignored. */
  task_json?: string | null;
  ext_json?: string | null;
  system_source?: string | null;
  edited_at?: number | null;
  deleted_at?: number | null;
  forwarded_json?: string | null;
}

interface FileRow {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  sha256: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'human')),
  harness TEXT,
  path TEXT,
  name TEXT,
  host TEXT,
  settings_json TEXT NOT NULL,
  delivered_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS participants_agent_path_harness
  ON participants(host, path, COALESCE(harness, '')) WHERE kind = 'agent' AND path IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS participants_agent_name_harness
  ON participants(host, name, COALESCE(harness, '')) WHERE kind = 'agent' AND name IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('all', 'dm', 'group', 'project')),
  addressed_json TEXT NOT NULL,
  name TEXT,
  topic TEXT,
  visibility TEXT CHECK (visibility IN ('open', 'discoverable', 'private')),
  archived INTEGER,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  participant_id TEXT NOT NULL,
  -- null: "all"; else "mentions" or "none" (NotifyLevel)
  notify TEXT,
  -- people: the time of the newest message they have seen here (Ümit #12323); null: not yet
  seen_at INTEGER,
  PRIMARY KEY (conversation_id, participant_id)
);
CREATE INDEX IF NOT EXISTS conversation_members_participant
  ON conversation_members(participant_id);

-- Ids of group conversations merged into another (old links keep working).
CREATE TABLE IF NOT EXISTS conversation_aliases (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL
);

-- Old ids of renamed agents (agent-bus rename-agent; Can #13874): "@old" still reaches the agent.
CREATE TABLE IF NOT EXISTS participant_aliases (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL,
  renamed_at INTEGER NOT NULL
);

-- Who pinned which conversation: it sorts first in their sidebar. Anyone who can see a project may pin it, member or
-- not (Can, 15 Nov: pinned from "Other projects").
CREATE TABLE IF NOT EXISTS pins (
  participant_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (participant_id, conversation_id)
);

-- A conversation's checklist (Checklist in the protocol): its items (items_json) with stable ids, done states and
-- owners; text and ticks_json are derived from them. owner is the list's creator. version grows with every change.
CREATE TABLE IF NOT EXISTS checklists (
  conversation_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  ticks_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  owner TEXT,
  assignees_json TEXT,
  items_json TEXT,
  version INTEGER,
  pinned INTEGER,
  next_id INTEGER,
  title TEXT,
  intro TEXT
);

-- Messages pinned in their conversation (#10757): a reference, never a copy; unpinning keeps the message.
CREATE TABLE IF NOT EXISTS pinned_messages (
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  pinned_by TEXT NOT NULL,
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);

-- Thread titles (Can #17615), by the thread's root message (seqs are global). A row without a title records the one
-- delivery that asked an agent for it (asked_to, asked_seq), so a thread is asked about once.
CREATE TABLE IF NOT EXISTS thread_titles (
  root_seq INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  title TEXT,
  set_by TEXT,
  set_at INTEGER,
  asked_to TEXT,
  asked_seq INTEGER
);

-- A person's own bookmarks (Can #11065): messages saved for themselves; nobody else sees them.
CREATE TABLE IF NOT EXISTS bookmarks (
  participant_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (participant_id, seq)
);

-- A person's own tasks (Can #12197): messages they took as a task for themselves; nobody else sees them.
CREATE TABLE IF NOT EXISTS own_tasks (
  participant_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  done_at INTEGER,
  PRIMARY KEY (participant_id, seq)
);

-- What decision models said of agents' messages for a person (Ümit #14881, the Inbox's "Waiting for your answer"):
-- one row per model, its verdict and its probability. The record for comparing the models later.
CREATE TABLE IF NOT EXISTS needs_verdicts (
  person TEXT NOT NULL,
  seq INTEGER NOT NULL,
  model TEXT NOT NULL,
  needs INTEGER NOT NULL,
  p REAL NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (person, seq, model)
);

-- Messages a person said were "Not needed" in "Waiting for your answer".
CREATE TABLE IF NOT EXISTS needs_dismissed (
  person TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (person, seq)
);

-- Where a message was forwarded (Can #12470): who, to whom ("@b", "#room"), when. The copies are messages of their own.
CREATE TABLE IF NOT EXISTS message_forwards (
  seq INTEGER NOT NULL,
  by_id TEXT NOT NULL,
  to_label TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS message_forwards_seq ON message_forwards(seq);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  from_id TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  text TEXT NOT NULL,
  files_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation_seq ON messages(conversation_id, seq);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  seq INTEGER NOT NULL REFERENCES messages(seq),
  recipient TEXT NOT NULL,
  delivered_at INTEGER,
  seen_at INTEGER,
  PRIMARY KEY (seq, recipient)
);
CREATE INDEX IF NOT EXISTS receipts_pending ON receipts(recipient) WHERE delivered_at IS NULL;
`;

/** Highest id an agent may get; matches the address grammar in @agent-bus/protocol. */
const MAX_ID_LENGTH = 48;

function parseSettings(json: string): AgentSettings {
  const parsed: unknown = JSON.parse(json);
  if (!isJsonObject(parsed)) return { ...DEFAULT_AGENT_SETTINGS };
  const all = parsed.all === "wake" || parsed.all === "quiet" ? parsed.all : DEFAULT_AGENT_SETTINGS.all;
  const displayName = typeof parsed.displayName === "string" && parsed.displayName.trim() && parsed.displayName.trim().length <= 40 ? parsed.displayName.trim() : undefined;
  const englishSpeech = parsed.englishSpeech === "whisper" || parsed.englishSpeech === "liquid" ? parsed.englishSpeech : undefined;
  const voiceLanguage = parsed.voiceLanguage === "en" || parsed.voiceLanguage === "tr" || parsed.voiceLanguage === "auto" ? parsed.voiceLanguage : undefined;
  const needsInbox = typeof parsed.needsInbox === "boolean" ? parsed.needsInbox : undefined;
  return {
    all,
    ...(displayName ? { displayName } : {}),
    ...(englishSpeech ? { englishSpeech } : {}),
    ...(voiceLanguage ? { voiceLanguage } : {}),
    ...(needsInbox !== undefined ? { needsInbox } : {}),
  };
}

function parseFiles(json: string): FileRef[] {
  return fileRefs(JSON.parse(json));
}

/** The well-formed file references in `parsed`. */
function fileRefs(parsed: unknown): FileRef[] {
  if (!Array.isArray(parsed)) return [];
  const out: FileRef[] = [];
  for (const item of parsed) {
    if (
      isJsonObject(item) &&
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      typeof item.size === "number" &&
      typeof item.mimeType === "string" &&
      typeof item.sha256 === "string"
    ) {
      out.push({
        id: item.id,
        name: item.name,
        size: item.size,
        mimeType: item.mimeType,
        sha256: item.sha256,
      });
    }
  }
  return out;
}

function toVisibility(value: string | null): ProjectVisibility {
  return value === "discoverable" || value === "private" ? value : "open";
}

function toKind(kind: string): ParticipantKind {
  return kind === "human" ? "human" : "agent";
}

function toParticipant(row: ParticipantRow): ParticipantRecord {
  return {
    id: row.id,
    kind: toKind(row.kind),
    harness: row.harness,
    path: row.path,
    name: row.name,
    host: row.host,
    settings: parseSettings(row.settings_json),
    deliveredSeq: row.delivered_seq,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** How long a message is held for offline recipients unless its writer chose otherwise. */
export const DEFAULT_HOLD_MS = 3600_000;

/** Until when `row` is held for offline recipients (messages from before holding: an hour after they were written). */
function expiresAt(row: MessageRow): number {
  return row.expires_at ?? row.created_at + DEFAULT_HOLD_MS;
}

/** The quote of a reply to a part of a message (a paragraph; Ümit #13981): that part, not the message's beginning. */
function partOf(quote: Quote | undefined, part: string | null): Quote | undefined {
  if (!quote || part === null) return quote;
  return { ...quote, text: part.length > QUOTE_TEXT_CHARS ? `${part.slice(0, QUOTE_TEXT_CHARS - 1)}…` : part, part: true };
}

function toMessage(row: MessageRow, receipts: Receipt[], quote: Quote | undefined, forwards: MessageForward[] = [], threadTitle?: string): Message {
  const ext = row.ext_json ? (JSON.parse(row.ext_json) as MessageExtensions) : undefined;
  const task = ext?.task?.data as Task | undefined;
  return {
    seq: row.seq,
    id: row.id,
    conversationId: row.conversation_id,
    from: row.from_id,
    fromKind: toKind(row.from_kind),
    text: row.text,
    files: parseFiles(row.files_json),
    createdAt: row.created_at,
    receipts,
    ...(quote ? { quote } : {}),
    ...(row.verified === null || row.verified === undefined ? {} : { verified: row.verified === 1 }),
    ...(row.from_session === null || row.from_session === undefined ? {} : { fromSession: row.from_session }),
    ...(row.wake_json ? { wake: JSON.parse(row.wake_json) as string[] } : {}),
    ...(task ? { task } : {}),
    ...(ext ? { ext } : {}),
    ...(row.system_source ? { systemSource: row.system_source } : {}),
    expiresAt: expiresAt(row),
    ...(row.edited_at ? { editedAt: row.edited_at } : {}),
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    ...(row.forwarded_json ? { forwarded: parseForwarded(row.forwarded_json) } : {}),
    ...(forwards.length > 0 ? { forwards } : {}),
    ...(threadTitle ? { threadTitle } : {}),
  };
}
/** A stored forwarded copy (Can #12470), its files checked as in files_json. */
function parseForwarded(json: string): ForwardedMessage {
  const f = JSON.parse(json) as ForwardedMessage;
  return { ...f, files: fileRefs(f.files) };
}

/** A host name as a machine: without its domain, lowercase ("MacBook-Pro-2.local" and "macbook-pro-2.home" match). */
function machineName(host: string): string {
  return host.split(".")[0]?.toLowerCase() ?? "";
}

/** How long a group DM may stay silent before the migration to projects archives it. */
const MIGRATION_ARCHIVE_AFTER_MS = 7 * 24 * 3600_000;

export class BusDatabase {
  readonly db: Database;

  constructor(dbPath: string, humans: readonly string[], now = Date.now()) {
    this.db = new Database(dbPath, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    // Databases from before the harness was part of an agent's identity allowed one agent per folder (or name).
    this.db.exec("DROP INDEX IF EXISTS participants_agent_path; DROP INDEX IF EXISTS participants_agent_name;");
    this.db.exec(SCHEMA);
    // Databases created before "seen" receipts lack the column.
    const receiptColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(receipts)").all();
    if (!receiptColumns.some((c) => c.name === "seen_at")) {
      this.db.exec("ALTER TABLE receipts ADD COLUMN seen_at INTEGER");
    }
    // Databases created before reply quotes lack the column.
    const messageColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(messages)").all();
    if (!messageColumns.some((c) => c.name === "reply_to_seq")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN reply_to_seq INTEGER");
    }
    // Threads walk replies down from their root (threadRootOf).
    this.db.exec("CREATE INDEX IF NOT EXISTS messages_reply_to ON messages(reply_to_seq) WHERE reply_to_seq IS NOT NULL");
    // Databases created before human authentication lack the column (null: written while it was off).
    if (!messageColumns.some((c) => c.name === "verified")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN verified INTEGER");
    }
    // Databases created before agent tokens lack the column (null: the agent id is not bound to a token yet).
    const participantColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(participants)").all();
    if (!participantColumns.some((c) => c.name === "token_hash")) {
      this.db.exec("ALTER TABLE participants ADD COLUMN token_hash TEXT");
    }
    // Databases created before sessions lack the columns (null: no session chosen / the agent had one session).
    // Databases created before wake lists lack the column (null: the old rule).
    if (!messageColumns.some((c) => c.name === "wake_json")) this.db.exec("ALTER TABLE messages ADD COLUMN wake_json TEXT");
    // Extension display state. Existing built-in tasks move into the task extension's annotation once.
    if (!messageColumns.some((c) => c.name === "ext_json")) this.db.exec("ALTER TABLE messages ADD COLUMN ext_json TEXT");
    if (messageColumns.some((c) => c.name === "task_json")) {
      const legacy = this.db
        .query<{ seq: number; from_id: string; task_json: string }, []>("SELECT seq, from_id, task_json FROM messages WHERE task_json IS NOT NULL AND ext_json IS NULL")
        .all();
      const update = this.db.query("UPDATE messages SET ext_json = ?2 WHERE seq = ?1");
      this.db.transaction(() => {
        for (const row of legacy) {
          const task = JSON.parse(row.task_json) as Task;
          if (task.type === ("chore" as Task["type"])) task.type = "task";
          const live = task.assignees.filter((a) => a.state === "open" || a.state === "accepted");
          const allowed: Record<string, string[]> = Object.fromEntries(
            live.map((a) => [a.id, a.state === "open" ? ["accept", "done", "reject", "read"] : ["progress", "done", "reject", "read"]])
          );
          if (live.length > 0) allowed[row.from_id] = ["cancel"];
          const annotation = {
            label: `Task · ${live.length > 0 ? "open" : "closed"} · ${task.assignees.map((a) => `@${a.id}`).join(", ")}`,
            state: live.length > 0 ? "open" : "closed",
            allowed,
            data: task,
          };
          update.run(row.seq, JSON.stringify({ task: annotation }));
        }
      })();
    }
    // Synthetic notice writers now share one visible @system identity. The source remains structured for routing.
    if (!messageColumns.some((c) => c.name === "system_source")) this.db.exec("ALTER TABLE messages ADD COLUMN system_source TEXT");
    this.db.transaction(() => {
      this.db
        .query("UPDATE messages SET from_id = ?1, system_source = 'task', text = CASE WHEN text LIKE 'task> %' THEN text ELSE 'task> ' || text END WHERE from_id = 'task'")
        .run(SYSTEM_AGENT_ID);
      this.db
        .query("UPDATE messages SET from_id = ?1, system_source = 'status', text = CASE WHEN text LIKE 'status> %' THEN text ELSE 'status> ' || text END WHERE from_id = 'status'")
        .run(SYSTEM_AGENT_ID);
      this.db
        .query("UPDATE messages SET from_id = ?1, system_source = 'resources', text = CASE WHEN text LIKE 'resources> %' THEN text ELSE 'resources> ' || text END WHERE from_id = 'resources'")
        .run(SYSTEM_AGENT_ID);
    })();
    if (!messageColumns.some((c) => c.name === "edited_at")) this.db.exec("ALTER TABLE messages ADD COLUMN edited_at INTEGER");
    if (!messageColumns.some((c) => c.name === "deleted_at")) this.db.exec("ALTER TABLE messages ADD COLUMN deleted_at INTEGER");
    // Databases created before forwarding lack the column (Can #12470; null: not a forwarded copy).
    if (!messageColumns.some((c) => c.name === "forwarded_json")) this.db.exec("ALTER TABLE messages ADD COLUMN forwarded_json TEXT");
    // Databases created before replying to a paragraph lack the column (Ümit #13981; null: the whole message).
    if (!messageColumns.some((c) => c.name === "quote_text")) this.db.exec("ALTER TABLE messages ADD COLUMN quote_text TEXT");
    // Databases created before tabs lack the column (Can #11480; null: in the order they were pinned).
    const pinColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(pins)").all();
    if (!pinColumns.some((c) => c.name === "position")) this.db.exec("ALTER TABLE pins ADD COLUMN position INTEGER");
    if (!messageColumns.some((c) => c.name === "from_session")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN from_session INTEGER");
    }
    if (!receiptColumns.some((c) => c.name === "session")) {
      this.db.exec("ALTER TABLE receipts ADD COLUMN session INTEGER");
    }
    // Databases created before holding for offline agents lack the column (null: an hour after created_at).
    if (!messageColumns.some((c) => c.name === "expires_at")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN expires_at INTEGER");
    }
    this.seed(humans, now);
    this.migrateToProjects(now);
    // Checklists from before owners and assignees (15 Nov): their last publisher owns them, nobody is assigned yet.
    const checklistColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(checklists)").all();
    if (!checklistColumns.some((c) => c.name === "owner")) {
      this.db.exec("ALTER TABLE checklists ADD COLUMN owner TEXT; ALTER TABLE checklists ADD COLUMN assignees_json TEXT;");
    }
    // Checklists from before items had ids (Ümit #12364, codex-ui #12379): each item line becomes an item owned by
    // the list's owner, done when ticked (by its text) or marked [x]; the list is pinned. Nothing is dropped: the
    // `# title`, the lines before the first item (intro) and the lines under an item (its detail) are kept.
    if (!checklistColumns.some((c) => c.name === "items_json")) {
      this.db.exec(
        "ALTER TABLE checklists ADD COLUMN items_json TEXT; ALTER TABLE checklists ADD COLUMN version INTEGER; " +
          "ALTER TABLE checklists ADD COLUMN pinned INTEGER; ALTER TABLE checklists ADD COLUMN next_id INTEGER;"
      );
    }
    if (!checklistColumns.some((c) => c.name === "title")) {
      this.db.exec("ALTER TABLE checklists ADD COLUMN title TEXT; ALTER TABLE checklists ADD COLUMN intro TEXT;");
    }
    this.migrateChecklistItems();
    // Pins were a members' column for a short while (15 Nov, 11:30): carried over to the pins table, then unused.
    if (this.db.query<{ name: string }, []>("PRAGMA table_info(conversation_members)").all().some((c) => c.name === "pinned")) {
      this.db
        .query("INSERT OR IGNORE INTO pins (participant_id, conversation_id, created_at) SELECT participant_id, conversation_id, ?1 FROM conversation_members WHERE pinned = 1")
        .run(now);
      this.db.exec("UPDATE conversation_members SET pinned = NULL WHERE pinned IS NOT NULL");
    }
    // Databases created before rooms lack the column (null: a project addressed as @@name).
    if (!this.db.query<{ name: string }, []>("PRAGMA table_info(conversations)").all().some((c) => c.name === "room")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN room INTEGER");
    }
    // Databases created before "seen" lack the column (null: not seen yet; Ümit #12323).
    if (!this.db.query<{ name: string }, []>("PRAGMA table_info(conversation_members)").all().some((c) => c.name === "seen_at")) {
      this.db.exec("ALTER TABLE conversation_members ADD COLUMN seen_at INTEGER");
    }
    // Databases created before titles lack the column (null: the address is the name; #10623).
    if (!this.db.query<{ name: string }, []>("PRAGMA table_info(conversations)").all().some((c) => c.name === "title")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN title TEXT");
    }
    // Databases created before project hierarchy lack the column (null: a root).
    if (!this.db.query<{ name: string }, []>("PRAGMA table_info(conversations)").all().some((c) => c.name === "parent_id")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN parent_id TEXT");
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS conversations_project_name ON conversations(name) WHERE kind = 'project'"
    );
  }

  /**
   * Databases from before projects: a group was its set of agents. The table is rebuilt (its CHECK changes) and each
   * group becomes a DM (two members) or a group DM (three or more), archived when silent for a week; ids, members and
   * history stay. Runs once: afterwards the table has a `name` column.
   */
  private migrateToProjects(now: number): void {
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(conversations)").all();
    if (columns.some((c) => c.name === "name")) return;
    const memberColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(conversation_members)").all();
    // foreign_keys cannot change inside a transaction; the rebuild drops the table messages and members refer to.
    this.db.exec("PRAGMA foreign_keys = OFF;");
    try {
      this.db.transaction(() => {
        if (!memberColumns.some((c) => c.name === "notify")) {
          this.db.exec("ALTER TABLE conversation_members ADD COLUMN notify TEXT");
        }
        this.db.exec(`
          CREATE TABLE conversations_new (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('all', 'dm', 'group', 'project')),
            addressed_json TEXT NOT NULL,
            name TEXT,
            topic TEXT,
            visibility TEXT CHECK (visibility IN ('open', 'discoverable', 'private')),
            archived INTEGER,
            created_at INTEGER NOT NULL,
            last_message_at INTEGER NOT NULL
          );`);
        this.db
          .query(
            `INSERT INTO conversations_new (id, kind, addressed_json, archived, created_at, last_message_at)
             SELECT c.id,
               CASE WHEN c.kind = 'all' THEN 'all' WHEN n.count = 2 THEN 'dm' ELSE 'group' END,
               CASE WHEN c.kind = 'all' THEN '[]' ELSE n.members END,
               CASE WHEN c.kind != 'all' AND n.count > 2 AND c.last_message_at < ?1 THEN 1 END,
               c.created_at, c.last_message_at
             FROM conversations c
             LEFT JOIN (SELECT conversation_id, COUNT(*) AS count,
                          json_group_array(participant_id) AS members
                        FROM (SELECT * FROM conversation_members ORDER BY participant_id)
                        GROUP BY conversation_id) n ON n.conversation_id = c.id`
          )
          .run(now - MIGRATION_ARCHIVE_AFTER_MS);
        this.db.exec("DROP TABLE conversations; ALTER TABLE conversations_new RENAME TO conversations;");
        const broken = this.db.query("PRAGMA foreign_key_check").all();
        if (broken.length > 0) throw new Error(`Projects migration left ${broken.length} broken references`);
      })();
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON;");
    }
  }

  /** A new conversation id: "g_" and 12 random hex digits, never one in use or an alias. */
  private newConversationId(): string {
    const taken = this.db.query<{ id: string }, [string]>(
      "SELECT id FROM conversations WHERE id = ?1 UNION SELECT old_id FROM conversation_aliases WHERE old_id = ?1"
    );
    for (;;) {
      const id = `g_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      if (!taken.get(id)) return id;
    }
  }

  close(): void {
    this.db.close();
  }

  private seed(humans: readonly string[], now: number): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO conversations (id, kind, addressed_json, created_at, last_message_at)
         VALUES (?1, 'all', '[]', ?2, ?2)`
      )
      .run(ALL_CONVERSATION_ID, now);
    const insertHuman = this.db.query(
      `INSERT OR IGNORE INTO participants (id, kind, settings_json, created_at, last_seen_at)
       VALUES (?1, 'human', ?2, ?3, ?3)`
    );
    for (const id of humans) {
      insertHuman.run(id, JSON.stringify(DEFAULT_AGENT_SETTINGS), now);
    }
  }

  maxSeq(): number {
    const row = this.db.query<{ seq: number | null }, []>("SELECT MAX(seq) AS seq FROM messages").get();
    return row?.seq ?? 0;
  }

  /** The participant `id`, or the agent it was renamed to (`participant_aliases`). */
  getParticipant(id: string): ParticipantRecord | null {
    const row = this.db.query<ParticipantRow, [string]>("SELECT * FROM participants WHERE id = ?1").get(id);
    if (row) return toParticipant(row);
    const renamed = this.renamedTo(id);
    return renamed ? this.getParticipant(renamed) : null;
  }

  /** The id agent `oldId` was renamed to, or undefined. */
  renamedTo(oldId: string): string | undefined {
    return this.db
      .query<{ new_id: string }, [string]>("SELECT new_id FROM participant_aliases WHERE old_id = ?1")
      .get(oldId)?.new_id;
  }

  /** Messages `agentId`'s harness accepted since `since` that its model has not seen yet. */
  waitingCount(agentId: string, since: number): number {
    const row = this.db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM receipts WHERE recipient = ?1 AND delivered_at >= ?2 AND seen_at IS NULL"
      )
      .get(agentId, since);
    return row?.n ?? 0;
  }

  /**
   * Messages written since `since`, and their deliveries split into woke/quiet by the wake rule (`shouldWake`): a
   * message with a wake list woke those listed; before wake lists only @all from an agent was quiet, for recipients
   * whose `all` setting is quiet (the default, also for forgotten agents).
   */
  stats(since: number, days: number): StatsResponse {
    const deliveries = `
      SELECT r.recipient, m.from_id, m.created_at,
        CASE WHEN m.wake_json IS NOT NULL
          THEN EXISTS (SELECT 1 FROM json_each(m.wake_json) w WHERE w.value = r.recipient)
          ELSE NOT (c.kind = 'all' AND m.from_kind = 'agent'
                    AND COALESCE(json_extract(p.settings_json, '$.all'), 'quiet') = 'quiet') END AS woke
      FROM receipts r
      JOIN messages m ON m.seq = r.seq
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN participants p ON p.id = r.recipient
      WHERE r.delivered_at IS NOT NULL AND m.created_at >= ?1`;
    const byId = new Map<string, StatsResponse["participants"][number]>();
    const row = (id: string, kind: string) => {
      let entry = byId.get(id);
      if (!entry) byId.set(id, (entry = { id, kind: toKind(kind), written: 0, turns: 0, quiet: 0, caused: 0 }));
      return entry;
    };
    for (const w of this.db
      .query<{ from_id: string; from_kind: string; n: number }, [number]>(
        "SELECT from_id, from_kind, COUNT(*) AS n FROM messages WHERE created_at >= ?1 GROUP BY from_id"
      )
      .all(since)) {
      row(w.from_id, w.from_kind).written = w.n;
    }
    for (const d of this.db
      .query<{ recipient: string; kind: string | null; turns: number; quiet: number }, [number]>(
        `SELECT d.recipient, p.kind, SUM(d.woke) AS turns, SUM(1 - d.woke) AS quiet
         FROM (${deliveries}) d LEFT JOIN participants p ON p.id = d.recipient GROUP BY d.recipient`
      )
      .all(since)) {
      const entry = row(d.recipient, d.kind ?? "agent");
      entry.turns = d.turns;
      entry.quiet = d.quiet;
    }
    for (const c of this.db
      .query<{ from_id: string; caused: number }, [number]>(
        `SELECT from_id, SUM(woke) AS caused FROM (${deliveries}) GROUP BY from_id`
      )
      .all(since)) {
      const entry = byId.get(c.from_id);
      if (entry) entry.caused = c.caused;
    }
    const day = "strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime')";
    const turnsByDay = new Map(
      this.db
        .query<{ day: string; turns: number }, [number]>(
          `SELECT ${day} AS day, SUM(woke) AS turns FROM (${deliveries}) GROUP BY day`
        )
        .all(since)
        .map((d) => [d.day, d.turns])
    );
    const daily = this.db
      .query<{ day: string; messages: number }, [number]>(
        `SELECT ${day} AS day, COUNT(*) AS messages FROM messages WHERE created_at >= ?1 GROUP BY day ORDER BY day`
      )
      .all(since)
      .map((d) => ({ day: d.day, messages: d.messages, turns: turnsByDay.get(d.day) ?? 0 }));
    const participants = [...byId.values()].sort((a, b) => b.written + b.turns - (a.written + a.turns));
    return { since, days, participants, daily };
  }

  listParticipants(): ParticipantRecord[] {
    return this.db
      .query<ParticipantRow, []>("SELECT * FROM participants ORDER BY id")
      .all()
      .map(toParticipant);
  }

  listAgents(): ParticipantRecord[] {
    return this.db
      .query<ParticipantRow, []>("SELECT * FROM participants WHERE kind = 'agent' ORDER BY id")
      .all()
      .map(toParticipant);
  }

  /** Creates the built-in agent `id` (no folder, no connection; it writes the server's notices) if missing. */
  ensureBuiltInAgent(id: string, harness: string, now = Date.now()): ParticipantRecord {
    this.db
      .query(
        `INSERT OR IGNORE INTO participants (id, kind, harness, settings_json, created_at, last_seen_at)
         VALUES (?1, 'agent', ?2, ?3, ?4, ?4)`
      )
      .run(id, harness, JSON.stringify(DEFAULT_AGENT_SETTINGS), now);
    return this.getParticipant(id) as ParticipantRecord;
  }

  /** SHA-256 (hex) of the token agent `id` is bound to, or null when it is not bound yet. */
  agentTokenHash(id: string): string | null {
    return this.db.query<{ token_hash: string | null }, [string]>("SELECT token_hash FROM participants WHERE id = ?1").get(id)?.token_hash ?? null;
  }

  /** Binds agent `id` to a token (hash), or unbinds it (null): the next join with any token claims it again. */
  setAgentTokenHash(id: string, tokenHash: string | null): boolean {
    return this.db.query("UPDATE participants SET token_hash = ?2 WHERE id = ?1 AND kind = 'agent'").run(id, tokenHash).changes > 0;
  }

  /**
   * Deletes agent `id` if it never wrote a message and is a member of no group conversation (e.g. a scratch
   * omp session that joined and left), with its receipts. Returns whether it was deleted. Callers make sure
   * the agent has no live connection.
   */
  removeIfIdle(id: string): boolean {
    return this.db.transaction((): boolean => {
      const idle = this.db
        .query<{ id: string }, [string]>(
          `SELECT id FROM participants p WHERE id = ?1 AND kind = 'agent'
             AND NOT EXISTS (SELECT 1 FROM messages WHERE from_id = p.id)
             AND NOT EXISTS (SELECT 1 FROM conversation_members WHERE participant_id = p.id)`
        )
        .get(id);
      if (!idle) return false;
      this.db.query("DELETE FROM receipts WHERE recipient = ?1").run(id);
      this.db.query("DELETE FROM participants WHERE id = ?1").run(id);
      return true;
    })();
  }

  /**
   * Agents last seen before `before` (offline since then): their participant row (settings, status) and the receipts
   * addressed to them are deleted. Messages they wrote and their conversations stay, so history reads the same; if
   * the folder joins again it gets an id by the usual rule (the same one when the name is still free).
   */
  forgetAgentsSeenBefore(before: number, keep: ReadonlySet<string>): string[] {
    return this.db.transaction((): string[] => {
      const ids = this.db
        .query<{ id: string }, [number]>("SELECT id FROM participants WHERE kind = 'agent' AND last_seen_at < ?1")
        .all(before)
        .map((r) => r.id)
        .filter((id) => !keep.has(id));
      for (const id of ids) {
        this.db.query("DELETE FROM receipts WHERE recipient = ?1").run(id);
        this.db.query("DELETE FROM participants WHERE id = ?1").run(id);
      }
      return ids;
    })();
  }

  /**
   * Finds or creates the agent for `identity` run by `harness`. The harness is part of the identity: Claude Code and
   * Codex in one folder are two agents. A row for the same folder (or name) without a harness (older databases) is
   * taken over by the first harness that joins. A new agent takes its folder name (or name) if free; if another
   * harness of the same folder holds it, `<that id>-<harness>`; else `base@<first differing part of its canonical
   * address>` (see `qualifiedAgentId`); else a numeric suffix. Ids held by humans or in `reservedIds` count as taken.
   */
  joinAgent(
    identity: AgentIdentity,
    harness: string | null,
    reservedIds: ReadonlySet<string>,
    now = Date.now()
  ): JoinResult {
    return this.db.transaction((): JoinResult => {
      // The machine is its host name without the domain, any case: a Mac reports "MacBook-Pro-2.local" on one
      // network and "macbook-pro-2.home" on another (14 Nov: its agents came back as new ids after a restart).
      const machine = `lower(CASE WHEN instr(host, '.') > 0 THEN substr(host, 1, instr(host, '.') - 1) ELSE host END)`;
      const sameFolder =
        "path" in identity
          ? this.db
              .query<ParticipantRow, [string, string]>(
                `SELECT * FROM participants WHERE kind = 'agent' AND ${machine} = ?1 AND path = ?2 ORDER BY created_at`
              )
              .all(machineName(identity.host), identity.path)
          : this.db
              .query<ParticipantRow, [string, string]>(
                `SELECT * FROM participants WHERE kind = 'agent' AND ${machine} = ?1 AND name = ?2 ORDER BY created_at`
              )
              .all(machineName(identity.host), identity.name);
      const existing =
        sameFolder.find((p) => p.harness === harness) ??
        sameFolder.find((p) => p.harness === null) ??
        (harness === null ? sameFolder[0] : undefined);
      if (existing) {
        this.db
          .query("UPDATE participants SET last_seen_at = ?2, harness = COALESCE(?3, harness), host = ?4 WHERE id = ?1")
          .run(existing.id, now, harness, identity.host);
        return {
          participant: toParticipant({ ...existing, last_seen_at: now, harness: harness ?? existing.harness, host: identity.host }),
          isNew: false,
        };
      }

      // A folder whose agent was renamed and moved: its old session is refused, not made a new agent under the old
      // name (the alias would make it a second @old).
      const base = baseAgentId(identity);
      const renamed = sameFolder.length === 0 && base ? this.renamedTo(base) : undefined;
      if (renamed) throw new AgentRenamedError(base, renamed, this.getParticipant(renamed)?.path ?? undefined);

      const first = sameFolder[0];
      const id = first && harness ? this.harnessId(first.id, harness, reservedIds) : this.pickId(identity, reservedIds);
      const deliveredSeq = this.maxSeq();
      this.db
        .query(
          `INSERT INTO participants
             (id, kind, harness, path, name, host, settings_json, delivered_seq, created_at, last_seen_at)
           VALUES (?1, 'agent', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`
        )
        .run(
          id,
          harness,
          "path" in identity ? identity.path : null,
          "name" in identity ? identity.name : null,
          identity.host,
          JSON.stringify(DEFAULT_AGENT_SETTINGS),
          deliveredSeq,
          now
        );
      const created = this.getParticipant(id);
      if (!created) throw new Error(`Failed to create participant ${id}`);
      return { participant: created, isNew: true };
    })();
  }

  /** Id of a second harness in a folder whose agent is `holderId`: `<holderId>-<harness>`, numbered if taken. */
  private harnessId(holderId: string, harness: string, reservedIds: ReadonlySet<string>): string {
    const suffix = `-${slugifyId(harness) || "agent"}`;
    const stem = `${holderId.slice(0, MAX_ID_LENGTH - suffix.length)}${suffix}`;
    const taken = (id: string): boolean =>
      reservedIds.has(id) || this.db.query("SELECT 1 FROM participants WHERE id = ?1").get(id) !== null;
    if (!taken(stem)) return stem;
    for (let n = 2; ; n++) {
      const id = `${stem.slice(0, MAX_ID_LENGTH - `-${n}`.length)}-${n}`;
      if (!taken(id)) return id;
    }
  }

  private pickId(identity: AgentIdentity, reservedIds: ReadonlySet<string>): string {
    const taken = (id: string): boolean =>
      id === ALL_CONVERSATION_ID ||
      reservedIds.has(id) ||
      this.db.query<{ id: string }, [string]>("SELECT id FROM participants WHERE id = ?1").get(id) !== null ||
      this.renamedTo(id) !== undefined;
    const base = baseAgentId(identity) || "agent";
    if (!taken(base)) return base;
    const holder = this.db
      .query<ParticipantRow, [string]>("SELECT * FROM participants WHERE id = ?1 AND kind = 'agent'")
      .get(base);
    const holderIdentity: AgentIdentity | undefined =
      holder?.host == null
        ? undefined
        : holder.path !== null
          ? { host: holder.host, path: holder.path }
          : { host: holder.host, name: holder.name ?? "" };
    const qualified = qualifiedAgentId(
      base,
      canonicalAddress(identity),
      holderIdentity && canonicalAddress(holderIdentity)
    );
    if (qualified && !taken(qualified)) return qualified;
    const stem = qualified ?? base;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const id = `${stem.slice(0, MAX_ID_LENGTH - suffix.length)}${suffix}`;
      if (!taken(id)) return id;
    }
  }

  touchParticipant(id: string, now = Date.now()): void {
    this.db.query("UPDATE participants SET last_seen_at = ?2 WHERE id = ?1").run(id, now);
  }

  ackDelivered(id: string, seq: number): void {
    this.db
      .query("UPDATE participants SET delivered_seq = MAX(delivered_seq, ?2) WHERE id = ?1")
      .run(id, seq);
  }

  setSettings(id: string, settings: AgentSettings): void {
    this.db
      .query("UPDATE participants SET settings_json = ?2 WHERE id = ?1")
      .run(id, JSON.stringify(settings));
  }

  private membersOf(conversationId: string): MemberRow[] {
    return this.db
      .query<MemberRow, [string]>(
        "SELECT participant_id, notify, seen_at FROM conversation_members WHERE conversation_id = ?1 ORDER BY participant_id"
      )
      .all(conversationId);
  }

  private pinsOf(conversationId: string): string[] {
    return this.db
      .query<{ participant_id: string }, [string]>("SELECT participant_id FROM pins WHERE conversation_id = ?1 ORDER BY participant_id")
      .all(conversationId)
      .map((p) => p.participant_id);
  }

  private pinnedOf(conversationId: string): PinnedMessage[] {
    return this.db
      .query<{ seq: number; pinned_by: string; pinned_at: number }, [string]>(
        // Pins in the same millisecond keep the order they were made in (rowid).
        "SELECT seq, pinned_by, pinned_at FROM pinned_messages WHERE conversation_id = ?1 ORDER BY pinned_at, rowid"
      )
      .all(conversationId)
      .map((p) => ({ seq: p.seq, by: p.pinned_by, at: p.pinned_at }));
  }

  /** Pins (or unpins) message `seq` in its conversation; the message itself is never touched. */
  setMessagePinned(conversationId: string, seq: number, by: string, pinned: boolean, now = Date.now()): void {
    if (pinned) {
      this.db
        .query("INSERT OR IGNORE INTO pinned_messages (conversation_id, seq, pinned_by, pinned_at) VALUES (?1, ?2, ?3, ?4)")
        .run(conversationId, seq, by, now);
    } else {
      this.db.query("DELETE FROM pinned_messages WHERE conversation_id = ?1 AND seq = ?2").run(conversationId, seq);
    }
  }

  /**
   * The thread message `seq` is in (Can #17615), by the website's rule (ui/threads.ts): the first message of its reply
   * chain (quote.seq links), once a person has replied in that chain; null when it is in none.
   */
  threadRootOf(seq: number): number | null {
    const root = this.db
      .query<{ root: number | null }, [number]>(
        `WITH RECURSIVE up(seq, parent, conversation_id) AS (
           SELECT seq, reply_to_seq, conversation_id FROM messages WHERE seq = ?1
           UNION ALL
           SELECT m.seq, m.reply_to_seq, m.conversation_id FROM messages m JOIN up ON m.seq = up.parent
           WHERE m.seq < up.seq AND m.conversation_id = up.conversation_id
         )
         SELECT MIN(seq) AS root FROM up`
      )
      .get(seq)?.root;
    if (root === null || root === undefined) return null;
    const replied = this.db
      .query<{ one: number }, [number]>(
        `WITH RECURSIVE down(seq, conversation_id) AS (
           SELECT seq, conversation_id FROM messages WHERE seq = ?1
           UNION ALL
           SELECT m.seq, m.conversation_id FROM messages m JOIN down ON m.reply_to_seq = down.seq
           WHERE m.seq > down.seq AND m.conversation_id = down.conversation_id
         )
         SELECT 1 AS one FROM down JOIN messages m ON m.seq = down.seq WHERE m.seq != ?1 AND m.from_kind = 'human' LIMIT 1`
      )
      .get(root);
    return replied ? root : null;
  }

  /**
   * Whether delivering `message` to agent `to` asks it to title the message's thread (Can #17615): the thread's root
   * when the thread has no title and nobody was asked yet (this ask is recorded), or when this is the delivery that
   * asked, handed over again (a dropped session, held while offline); else undefined. The caller asks only on
   * deliveries that wake an agent connected now.
   */
  threadTitleAsk(message: Message, to: string): number | undefined {
    const root = this.threadRootOf(message.seq);
    if (root === null) return undefined;
    const row = this.db
      .query<{ title: string | null; asked_to: string | null; asked_seq: number | null }, [number]>(
        "SELECT title, asked_to, asked_seq FROM thread_titles WHERE root_seq = ?1"
      )
      .get(root);
    if (!row) {
      this.db
        .query("INSERT INTO thread_titles (root_seq, conversation_id, asked_to, asked_seq) VALUES (?1, ?2, ?3, ?4)")
        .run(root, message.conversationId, to, message.seq);
      return root;
    }
    return row.title === null && row.asked_to === to && row.asked_seq === message.seq ? root : undefined;
  }

  /** Titles thread `root` of `conversationId` (a later title replaces it). Callers check who may and that it is a thread. */
  setThreadTitle(conversationId: string, root: number, title: string, by: string, now = Date.now()): void {
    this.db
      .query(
        `INSERT INTO thread_titles (root_seq, conversation_id, title, set_by, set_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(root_seq) DO UPDATE SET title = excluded.title, set_by = excluded.set_by, set_at = excluded.set_at`
      )
      .run(root, conversationId, title, by, now);
  }

  /** `participantId`'s own bookmarks, newest first (Can #11065). */
  bookmarksOf(participantId: string): Bookmark[] {
    return this.db
      .query<{ seq: number; at: number }, [string]>("SELECT seq, at FROM bookmarks WHERE participant_id = ?1 ORDER BY at DESC, rowid DESC")
      .all(participantId);
  }

  /** Saves (or drops) message `seq` in `participantId`'s own bookmarks; the message itself is never touched. */
  setBookmark(participantId: string, seq: number, bookmarked: boolean, now = Date.now()): void {
    if (bookmarked) this.db.query("INSERT OR IGNORE INTO bookmarks (participant_id, seq, at) VALUES (?1, ?2, ?3)").run(participantId, seq, now);
    else this.db.query("DELETE FROM bookmarks WHERE participant_id = ?1 AND seq = ?2").run(participantId, seq);
  }

  /** `participantId`'s own tasks (Can #12197): open ones newest first, then done ones, latest done first. */
  ownTasksOf(participantId: string): OwnTask[] {
    return this.db
      .query<{ seq: number; at: number; done_at: number | null }, [string]>(
        "SELECT seq, at, done_at FROM own_tasks WHERE participant_id = ?1 ORDER BY done_at IS NOT NULL, COALESCE(done_at, at) DESC, rowid DESC"
      )
      .all(participantId)
      .map((r) => (r.done_at === null ? { seq: r.seq, at: r.at } : { seq: r.seq, at: r.at, doneAt: r.done_at }));
  }

  /** Takes message `seq` as one of `participantId`'s own tasks, marks it done or open again, or drops it. */
  setOwnTask(participantId: string, seq: number, taskState: "open" | "done" | "none", now = Date.now()): void {
    if (taskState === "none") {
      this.db.query("DELETE FROM own_tasks WHERE participant_id = ?1 AND seq = ?2").run(participantId, seq);
      return;
    }
    this.db.query("INSERT OR IGNORE INTO own_tasks (participant_id, seq, at) VALUES (?1, ?2, ?3)").run(participantId, seq, now);
    this.db
      .query("UPDATE own_tasks SET done_at = ?3 WHERE participant_id = ?1 AND seq = ?2")
      .run(participantId, seq, taskState === "done" ? now : null);
  }

  /** Keeps `model`'s verdict on message `seq` for `person` (Ümit #14881); false when it already had one (kept as it was). */
  addNeedsVerdict(person: string, seq: number, model: string, needs: boolean, p: number, at = Date.now()): boolean {
    return (
      this.db
        .query("INSERT OR IGNORE INTO needs_verdicts (person, seq, model, needs, p, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
        .run(person, seq, model, needs ? 1 : 0, p, at).changes > 0
    );
  }

  /**
   * Agents' messages since `since` (not deleted, not empty) not judged for `person` by every model yet (fewer verdicts
   * than the models that ever judged for them: one was down), newest first.
   */
  unjudgedAgentMessages(person: string, since: number, limit: number): Array<{ seq: number; conversationId: string; text: string }> {
    return this.db
      .query<{ seq: number; conversation_id: string; text: string }, [string, number, number]>(
        `SELECT m.seq, m.conversation_id, m.text FROM messages m
         WHERE m.created_at >= ?2 AND m.from_kind = 'agent' AND m.deleted_at IS NULL AND m.text != ''
           AND (SELECT COUNT(*) FROM needs_verdicts v WHERE v.person = ?1 AND v.seq = m.seq)
             < MAX(1, (SELECT COUNT(DISTINCT model) FROM needs_verdicts WHERE person = ?1))
         ORDER BY m.seq DESC LIMIT ?3`
      )
      .all(person, since, limit)
      .map((r) => ({ seq: r.seq, conversationId: r.conversation_id, text: r.text }));
  }

  /**
   * Judged messages awaiting human feedback: selected=true is "Waiting for your answer"; false supplies rejected
   * candidates so usefulness labels also catch model false negatives (Ümit #16206).
   */
  private needsMessages(
    person: string,
    since: number,
    limit: number,
    selected: boolean
  ): Array<{ seq: number; verdicts: Record<string, { needs: boolean; p: number }> }> {
    const seqs = this.db
      .query<{ seq: number }, [string, number, number]>(
        `SELECT DISTINCT m.seq FROM needs_verdicts v JOIN messages m ON m.seq = v.seq
         WHERE v.person = ?1 AND m.created_at >= ?2 AND m.deleted_at IS NULL
           AND ${selected ? "EXISTS" : "NOT EXISTS"}
               (SELECT 1 FROM needs_verdicts picked WHERE picked.person = ?1 AND picked.seq = m.seq AND picked.needs = 1)
           AND NOT EXISTS (SELECT 1 FROM needs_dismissed d WHERE d.person = ?1 AND d.seq = m.seq)
           AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.conversation_id = m.conversation_id AND r.seq > m.seq
                           AND r.from_id = ?1 AND r.deleted_at IS NULL)
         ORDER BY m.seq DESC LIMIT ?3`
      )
      .all(person, since, limit)
      .map((row) => row.seq);
    const verdicts = new Map(seqs.map((seq) => [seq, {} as Record<string, { needs: boolean; p: number }>]));
    const rows = this.db
      .query<{ seq: number; model: string; needs: number; p: number }, [string, number]>(
        "SELECT seq, model, needs, p FROM needs_verdicts WHERE person = ?1 AND seq >= ?2"
      )
      .all(person, seqs.at(-1) ?? Number.MAX_SAFE_INTEGER);
    for (const row of rows) {
      const values = verdicts.get(row.seq);
      if (values) values[row.model] = { needs: row.needs === 1, p: row.p };
    }
    return seqs.map((seq) => ({ seq, verdicts: verdicts.get(seq)! }));
  }

  openNeeds(person: string, since: number, limit: number): Array<{ seq: number; verdicts: Record<string, { needs: boolean; p: number }> }> {
    return this.needsMessages(person, since, limit, true);
  }

  needsCandidates(person: string, since: number, limit: number): Array<{ seq: number; verdicts: Record<string, { needs: boolean; p: number }> }> {
    return this.needsMessages(person, since, limit, false);
  }

  /** Whether a message before `beforeSeq` in `conversationId`, since `since`, was marked as needing `person`. */
  hasNeeds(person: string, conversationId: string, beforeSeq: number, since: number): boolean {
    return (
      this.db
        .query(
          `SELECT 1 FROM needs_verdicts v JOIN messages m ON m.seq = v.seq
           WHERE v.person = ?1 AND v.needs = 1 AND m.conversation_id = ?2 AND m.seq < ?3 AND m.created_at >= ?4 LIMIT 1`
        )
        .get(person, conversationId, beforeSeq, since) !== null
    );
  }

  /** Marks judged messages handled in one transaction; returns only newly marked sequence numbers. */
  dismissNeedsMany(person: string, seqs: readonly number[], at = Date.now()): number[] {
    const insert = this.db.query("INSERT OR IGNORE INTO needs_dismissed (person, seq, at) VALUES (?1, ?2, ?3)");
    return this.db.transaction(() => seqs.filter((seq) => insert.run(person, seq, at).changes > 0))();
  }

  dismissNeeds(person: string, seq: number, at = Date.now()): boolean {
    return this.dismissNeedsMany(person, [seq], at).length > 0;
  }

  private toConversation(row: ConversationRow, members: MemberRow[], pins: string[], pinned: PinnedMessage[] = [], lastFrom?: string): Conversation {
    const kind: ConversationKind = row.kind === "dm" || row.kind === "group" || row.kind === "project" ? row.kind : "all";
    const notify: Record<string, "mentions" | "none"> = {};
    for (const m of members) if (m.notify === "mentions" || m.notify === "none") notify[m.participant_id] = m.notify;
    const seen: Record<string, number> = {};
    for (const m of members) if (m.seen_at !== null) seen[m.participant_id] = m.seen_at;
    return {
      id: row.id,
      kind,
      members: members.map((m) => m.participant_id),
      addressed: members.map((m) => m.participant_id),
      ...(row.name !== null ? { name: row.name } : {}),
      ...(row.title ? { title: row.title } : {}),
      ...(row.topic !== null ? { topic: row.topic } : {}),
      ...(kind === "project" ? { visibility: toVisibility(row.visibility) } : {}),
      ...(row.room ? { room: true as const } : {}),
      ...(row.archived ? { archived: true as const } : {}),
      ...(row.archived === 2 ? { archivedIdle: true as const } : {}),
      ...(row.parent_id ? { parentId: row.parent_id } : {}),
      ...(row.parent_id && row.parent_name ? { parentName: row.parent_name } : {}),
      ...(Object.keys(notify).length > 0 ? { notify } : {}),
      ...(pins.length > 0 ? { pinnedBy: pins } : {}),
      ...(pinned.length > 0 ? { pinnedMessages: pinned } : {}),
      ...(Object.keys(seen).length > 0 ? { seen } : {}),
      ...(lastFrom ? { lastMessageFrom: lastFrom } : {}),
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
    };
  }

  /** The conversation `id`, or the one it was merged into (merges happened before projects; old ids still work). */
  getConversation(id: string): Conversation | null {
    const alias = this.db
      .query<{ new_id: string }, [string]>("SELECT new_id FROM conversation_aliases WHERE old_id = ?1")
      .get(id);
    const row = this.db
      .query<ConversationRow, [string]>(`SELECT c.*, ${PARENT_NAME} FROM conversations c WHERE c.id = ?1`)
      .get(alias?.new_id ?? id);
    if (!row) return null;
    const last = this.db
      .query<{ from_id: string }, [string]>("SELECT from_id FROM messages WHERE conversation_id = ?1 ORDER BY seq DESC LIMIT 1")
      .get(row.id);
    return this.toConversation(row, this.membersOf(row.id), this.pinsOf(row.id), this.pinnedOf(row.id), last?.from_id);
  }

  /** `participantId` (a member) has seen conversation `id` up to `at`; it never goes back. True when it moved on. */
  setSeen(id: string, participantId: string, at: number): boolean {
    return (
      this.db
        .query("UPDATE conversation_members SET seen_at = ?3 WHERE conversation_id = ?1 AND participant_id = ?2 AND COALESCE(seen_at, 0) < ?3")
        .run(id, participantId, at).changes > 0
    );
  }

  /** Every conversation: `all` first, then by lastMessageAt desc. Who may see which is the server's business. */
  listConversations(): Conversation[] {
    const rows = this.db
      .query<ConversationRow, []>(
        `SELECT c.*, ${PARENT_NAME} FROM conversations c
         ORDER BY (c.kind = 'all') DESC, c.last_message_at DESC, c.id`
      )
      .all();
    const members = new Map<string, MemberRow[]>();
    for (const m of this.db
      .query<MemberRow & { conversation_id: string }, []>(
        "SELECT conversation_id, participant_id, notify, seen_at FROM conversation_members ORDER BY participant_id"
      )
      .all()) {
      const list = members.get(m.conversation_id);
      if (list) list.push(m);
      else members.set(m.conversation_id, [m]);
    }
    const pins = new Map<string, string[]>();
    for (const p of this.db
      .query<{ conversation_id: string; participant_id: string }, []>("SELECT conversation_id, participant_id FROM pins ORDER BY participant_id")
      .all()) {
      pins.set(p.conversation_id, [...(pins.get(p.conversation_id) ?? []), p.participant_id]);
    }
    const pinned = new Map<string, PinnedMessage[]>();
    for (const p of this.db
      .query<{ conversation_id: string; seq: number; pinned_by: string; pinned_at: number }, []>(
        "SELECT conversation_id, seq, pinned_by, pinned_at FROM pinned_messages ORDER BY pinned_at, rowid"
      )
      .all()) {
      pinned.set(p.conversation_id, [...(pinned.get(p.conversation_id) ?? []), { seq: p.seq, by: p.pinned_by, at: p.pinned_at }]);
    }
    // Who wrote each conversation's newest message, in one pass.
    const lastFrom = new Map<string, string>();
    for (const r of this.db
      .query<{ conversation_id: string; from_id: string }, []>(
        "SELECT conversation_id, from_id FROM messages WHERE seq IN (SELECT MAX(seq) FROM messages GROUP BY conversation_id)"
      )
      .all()) {
      lastFrom.set(r.conversation_id, r.from_id);
    }
    return rows.map((row) =>
      this.toConversation(row, members.get(row.id) ?? [], pins.get(row.id) ?? [], pinned.get(row.id) ?? [], lastFrom.get(row.id))
    );
  }

  /**
   * The conversation of `kind` whose members are exactly `ids` (a DM or a group DM), without creating one: an
   * unarchived one first, then the most recently active.
   */
  findByMembers(kind: "dm" | "group", ids: readonly string[], parentId?: string): Conversation | null {
    const wanted = Array.from(new Set(ids));
    const row = this.db
      .query<{ id: string }, [string, string, number, string | null]>(
        `SELECT c.id FROM conversations c
         WHERE c.kind = ?1
           AND (?4 IS NULL OR c.parent_id = ?4)
           AND (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) = ?3
           AND (SELECT COUNT(*) FROM conversation_members m
                WHERE m.conversation_id = c.id AND m.participant_id IN (SELECT value FROM json_each(?2))) = ?3
         ORDER BY COALESCE(c.archived, 0), c.last_message_at DESC LIMIT 1`
      )
      .get(kind, JSON.stringify(wanted), wanted.length, parentId ?? null);
    return row ? this.getConversation(row.id) : null;
  }

  /** The DM of `a` and `b` (two different participants), created if there is none. */
  dmOf(a: string, b: string, now = Date.now()): Conversation {
    return this.findByMembers("dm", [a, b]) ?? this.createConversation("dm", [a, b], now);
  }

  /** The group DM with exactly `ids` (three or more, the writer included), created if there is none. */
  groupDmOf(ids: readonly string[], now = Date.now()): Conversation {
    return this.findByMembers("group", ids) ?? this.createConversation("group", ids, now);
  }

  /** The group DM of exactly `ids` under project `parentId` (two members too: DMs have no parent), made if missing. */
  groupUnder(parentId: string, ids: readonly string[], now = Date.now()): Conversation {
    const found = this.findByMembers("group", ids, parentId);
    if (found) return found;
    const made = this.createConversation("group", ids, now);
    this.setParent(made.id, parentId);
    return this.getConversation(made.id) as Conversation;
  }

  /** The project named `name` (archived or not), or null. A renamed agent's old name finds its project. */
  projectByName(name: string): Conversation | null {
    const find = (n: string) =>
      this.db.query<{ id: string }, [string]>("SELECT id FROM conversations WHERE kind = 'project' AND name = ?1").get(n);
    const renamed = this.renamedTo(name);
    const row = find(name) ?? (renamed ? find(renamed) : null);
    return row ? this.getConversation(row.id) : null;
  }

  /** A new open project `name` with `creator` as its only member. */
  createProject(name: string, creator: string, now = Date.now(), room = false): Conversation {
    const created = this.createConversation("project", [creator], now, { name, visibility: "open" });
    if (!room) return created;
    this.setRoom(created.id);
    return this.getConversation(created.id) as Conversation;
  }

  /** Makes a project a room ("#name" from now on), or a room a project again ("@@name"). */
  setRoom(conversationId: string, room = true): void {
    this.db.query("UPDATE conversations SET room = ?2 WHERE id = ?1 AND kind = 'project'").run(conversationId, room ? 1 : null);
  }

  private createConversation(
    kind: "dm" | "group" | "project",
    ids: readonly string[],
    now: number,
    project?: { name: string; visibility: ProjectVisibility }
  ): Conversation {
    return this.db.transaction((): Conversation => {
      const id = this.newConversationId();
      this.db
        .query(
          `INSERT INTO conversations (id, kind, addressed_json, name, visibility, created_at, last_message_at)
           VALUES (?1, ?2, '[]', ?3, ?4, ?5, ?5)`
        )
        .run(id, kind, project?.name ?? null, project?.visibility ?? null, now);
      for (const member of ids) this.addMember(id, member);
      return this.getConversation(id) as Conversation;
    })();
  }

  /** Adds a member (a no-op if it is one) and keeps `addressed_json` in step. */
  addMember(conversationId: string, participantId: string): void {
    this.db
      .query("INSERT OR IGNORE INTO conversation_members (conversation_id, participant_id) VALUES (?1, ?2)")
      .run(conversationId, participantId);
    this.syncAddressed(conversationId);
  }

  /** Removes a member; returns whether it was one. */
  removeMember(conversationId: string, participantId: string): boolean {
    const removed =
      this.db
        .query("DELETE FROM conversation_members WHERE conversation_id = ?1 AND participant_id = ?2")
        .run(conversationId, participantId).changes > 0;
    if (removed) this.syncAddressed(conversationId);
    return removed;
  }

  private syncAddressed(conversationId: string): void {
    this.db
      .query(
        `UPDATE conversations SET addressed_json = (
           SELECT COALESCE(json_group_array(participant_id), '[]') FROM
             (SELECT participant_id FROM conversation_members WHERE conversation_id = ?1 ORDER BY participant_id))
         WHERE id = ?1 AND kind != 'all'`
      )
      .run(conversationId);
  }

  setNotify(conversationId: string, participantId: string, level: NotifyLevel): boolean {
    return (
      this.db
        .query("UPDATE conversation_members SET notify = ?3 WHERE conversation_id = ?1 AND participant_id = ?2")
        .run(conversationId, participantId, level === "all" ? null : level).changes > 0
    );
  }

  /** Turns a group DM into a project, or changes a project's name, topic or visibility (the caller checks who may). */
  updateProject(
    conversationId: string,
    changes: { name?: string; topic?: string; visibility?: ProjectVisibility }
  ): void {
    this.db
      .query(
        `UPDATE conversations SET kind = 'project', name = COALESCE(?2, name), topic = COALESCE(?3, topic),
           visibility = COALESCE(?4, visibility, 'open') WHERE id = ?1 AND kind IN ('group', 'project')`
      )
      .run(conversationId, changes.name ?? null, changes.topic ?? null, changes.visibility ?? null);
  }

  /** Sets the name people read of a project or room; null clears it (#10623). The address stays. */
  setTitle(conversationId: string, title: string | null): void {
    this.db.query("UPDATE conversations SET title = ?2 WHERE id = ?1 AND kind = 'project'").run(conversationId, title);
  }

  setParent(conversationId: string, parentId: string | null): void {
    this.db.query("UPDATE conversations SET parent_id = ?2 WHERE id = ?1").run(conversationId, parentId);
  }

  /**
   * Deletes a project for good: its messages, their receipts, its members and old ids. What was under it becomes a
   * root. Quotes of its messages elsewhere stop showing (they are looked up when shown). Returns the messages deleted.
   */
  deleteProject(conversationId: string): number {
    return this.db.transaction(() => {
      const { n } = this.db.query("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1").get(conversationId) as { n: number };
      this.db.query("UPDATE conversations SET parent_id = NULL WHERE parent_id = ?1").run(conversationId);
      this.db.query("DELETE FROM receipts WHERE seq IN (SELECT seq FROM messages WHERE conversation_id = ?1)").run(conversationId);
      this.db.query("DELETE FROM bookmarks WHERE seq IN (SELECT seq FROM messages WHERE conversation_id = ?1)").run(conversationId);
      this.db.query("DELETE FROM own_tasks WHERE seq IN (SELECT seq FROM messages WHERE conversation_id = ?1)").run(conversationId);
      this.db.query("DELETE FROM needs_verdicts WHERE seq IN (SELECT seq FROM messages WHERE conversation_id = ?1)").run(conversationId);
      this.db.query("DELETE FROM needs_dismissed WHERE seq IN (SELECT seq FROM messages WHERE conversation_id = ?1)").run(conversationId);
      this.db.query("DELETE FROM message_forwards WHERE seq IN (SELECT seq FROM messages WHERE conversation_id = ?1)").run(conversationId);
      this.db.query("DELETE FROM messages WHERE conversation_id = ?1").run(conversationId);
      this.db.query("DELETE FROM conversation_members WHERE conversation_id = ?1").run(conversationId);
      this.db.query("DELETE FROM checklists WHERE conversation_id = ?1").run(conversationId);
      this.db.query("DELETE FROM pins WHERE conversation_id = ?1").run(conversationId);
      this.db.query("DELETE FROM pinned_messages WHERE conversation_id = ?1").run(conversationId);
      this.db.query("DELETE FROM thread_titles WHERE conversation_id = ?1").run(conversationId);
      this.db.query("DELETE FROM conversation_aliases WHERE new_id = ?1").run(conversationId);
      this.db.query("DELETE FROM conversations WHERE id = ?1 AND kind = 'project'").run(conversationId);
      return n;
    })();
  }

  /** Checklists stored as markdown only (items_json null): their items, with ids, owners and ticks (see the caller). */
  private migrateChecklistItems(): void {
    const rows = this.db
      .query<{ conversation_id: string; text: string; ticks_json: string; updated_at: number; updated_by: string; owner: string | null }, []>(
        "SELECT conversation_id, text, ticks_json, updated_at, updated_by, owner FROM checklists WHERE items_json IS NULL"
      )
      .all();
    for (const row of rows) {
      const ticks = JSON.parse(row.ticks_json) as Record<string, { by: string; at: number }>;
      const creator = row.owner ?? row.updated_by;
      const parsed = parseChecklistMarkdown(row.text);
      const items: ChecklistItem[] = parsed.items.map((line, i) => {
        const done = ticks[line.text] ?? (line.done ? { by: creator, at: row.updated_at } : undefined);
        return {
          id: checklistItemId(i + 1),
          ...(line.heading ? { heading: line.heading } : {}),
          text: line.text,
          owner: creator,
          ...(line.detail ? { detail: line.detail } : {}),
          ...(done ? { done } : {}),
        };
      });
      this.db
        .query("UPDATE checklists SET items_json = ?2, version = 1, pinned = 1, next_id = ?3, owner = ?4, title = ?5, intro = ?6 WHERE conversation_id = ?1")
        .run(row.conversation_id, JSON.stringify(items), items.length + 1, creator, parsed.title ?? null, parsed.intro ?? null);
    }
  }

  getChecklist(conversationId: string): StoredChecklist | null {
    const row = this.db
      .query<ChecklistRow, [string]>(
        "SELECT updated_at, updated_by, owner, assignees_json, items_json, version, pinned, next_id, title, intro FROM checklists WHERE conversation_id = ?1"
      )
      .get(conversationId);
    if (!row) return null;
    return {
      version: row.version ?? 1,
      pinned: row.pinned !== 0,
      ...(row.title ? { title: row.title } : {}),
      ...(row.intro ? { intro: row.intro } : {}),
      items: row.items_json ? (JSON.parse(row.items_json) as ChecklistItem[]) : [],
      creator: row.owner ?? row.updated_by,
      assignees: row.assignees_json ? (JSON.parse(row.assignees_json) as string[]) : [],
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      nextId: row.next_id ?? 1,
    };
  }

  /** Writes a conversation's checklist as given; its markdown and ticks columns are derived from the items. */
  saveChecklist(conversationId: string, list: StoredChecklist): void {
    this.db
      .query(
        `INSERT INTO checklists (conversation_id, text, ticks_json, updated_at, updated_by, owner, assignees_json, items_json, version, pinned, next_id, title, intro)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(conversation_id) DO UPDATE SET text = ?2, ticks_json = ?3, updated_at = ?4, updated_by = ?5, owner = ?6,
           assignees_json = ?7, items_json = ?8, version = ?9, pinned = ?10, next_id = ?11, title = ?12, intro = ?13`
      )
      .run(
        conversationId,
        checklistMarkdown(list),
        JSON.stringify(checklistTicks(list.items)),
        list.updatedAt,
        list.updatedBy,
        list.creator,
        JSON.stringify(list.assignees),
        JSON.stringify(list.items),
        list.version,
        list.pinned ? 1 : 0,
        list.nextId,
        list.title ?? null,
        list.intro ?? null
      );
  }

  /**
   * Files shared in `conversationId`, newest first, without voice messages (audio named "voice-…"); a forwarded copy's
   * files count as shared by its forwarder (Can #12470).
   */
  sharedFiles(conversationId: string, limit: number): SharedFile[] {
    const rows = this.db
      .query<{ seq: number; from_id: string; created_at: number; files_json: string; forwarded_json: string | null }, [string]>(
        `SELECT seq, from_id, created_at, files_json, forwarded_json FROM messages
         WHERE conversation_id = ?1 AND (files_json != '[]' OR forwarded_json IS NOT NULL) ORDER BY seq DESC`
      )
      .all(conversationId);
    const shared: SharedFile[] = [];
    for (const row of rows) {
      const forwarded = row.forwarded_json ? parseForwarded(row.forwarded_json).files : [];
      for (const file of [...parseFiles(row.files_json), ...forwarded]) {
        if (file.mimeType.startsWith("audio/") && file.name.startsWith("voice-")) continue;
        shared.push({ file, seq: row.seq, from: row.from_id, createdAt: row.created_at });
        if (shared.length >= limit) return shared;
      }
    }
    return shared;
  }

  /** Someone pins (or unpins) a conversation for themselves, a new one last among their tabs; may they is the caller's check. */
  setPinned(conversationId: string, participantId: string, pinned: boolean): void {
    if (pinned) {
      this.db
        .query(
          `INSERT OR IGNORE INTO pins (participant_id, conversation_id, created_at, position)
           VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(position), -1) + 1 FROM pins WHERE participant_id = ?1))`
        )
        .run(participantId, conversationId, Date.now());
    } else this.db.query("DELETE FROM pins WHERE participant_id = ?1 AND conversation_id = ?2").run(participantId, conversationId);
  }

  /** `participantId`'s tabs: the conversations they pinned, in their order (Can #11480). */
  tabsOf(participantId: string): string[] {
    return this.db
      .query<{ conversation_id: string }, [string]>(
        "SELECT conversation_id FROM pins WHERE participant_id = ?1 ORDER BY position IS NULL, position, created_at, rowid"
      )
      .all(participantId)
      .map((r) => r.conversation_id);
  }

  /** Puts `participantId`'s tabs in `order` (all of them, each once; the caller checks). */
  setTabOrder(participantId: string, order: string[]): void {
    const update = this.db.query("UPDATE pins SET position = ?3 WHERE participant_id = ?1 AND conversation_id = ?2");
    this.db.transaction(() => order.forEach((id, i) => update.run(participantId, id, i)))();
  }

  /**
   * Archives the projects and group DMs whose last message is older than `before` and that nobody pinned (archived =
   * 2: automatically; 1 is a person's archive). Returns their ids.
   */
  archiveIdle(before: number): string[] {
    return this.db
      .query<{ id: string }, [number]>(
        `UPDATE conversations SET archived = 2
         WHERE kind IN ('project', 'group') AND archived IS NULL AND last_message_at < ?1
           AND NOT EXISTS (SELECT 1 FROM pins p WHERE p.conversation_id = conversations.id)
         RETURNING id`
      )
      .all(before)
      .map((r) => r.id);
  }

  setArchived(conversationId: string, archived: boolean): void {
    this.db
      .query("UPDATE conversations SET archived = ?2 WHERE id = ?1 AND kind IN ('group', 'project')")
      .run(conversationId, archived ? 1 : null);
  }

  /**
   * The last `limit` messages of `conversationId` (before the next one is written) that `recipient` has no receipt
   * for and did not write, ascending; each gets an undelivered receipt for it, so they reach it as context.
   */
  addContextReceipts(conversationId: string, recipient: string, limit: number): Message[] {
    return this.db.transaction((): Message[] => {
      const rows = this.db
        .query<MessageRow, [string, string, number]>(
          `SELECT * FROM messages WHERE conversation_id = ?1 AND from_id != ?2
             AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.seq = messages.seq AND r.recipient = ?2)
           ORDER BY seq DESC LIMIT ?3`
        )
        .all(conversationId, recipient, limit)
        .reverse();
      const addReceipt = this.db.query("INSERT INTO receipts (seq, recipient, delivered_at, session) VALUES (?1, ?2, NULL, NULL)");
      for (const row of rows) addReceipt.run(row.seq, recipient);
      return this.withReceipts(rows);
    })();
  }

  insertMessage(input: NewMessage): Message {
    const id = `m_${crypto.randomUUID().replaceAll("-", "")}`;
    return this.db.transaction((): Message => {
      const result = this.db
        .query(
          `INSERT INTO messages (id, conversation_id, from_id, from_kind, text, files_json, created_at, reply_to_seq, verified, from_session, expires_at, wake_json, ext_json, forwarded_json, quote_text, system_source)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
        )
        .run(
          id,
          input.conversationId,
          input.from,
          input.fromKind,
          input.text,
          JSON.stringify(input.files),
          input.createdAt,
          input.replyToSeq ?? null,
          input.verified === undefined ? null : input.verified ? 1 : 0,
          input.fromSession ?? null,
          input.expiresAt,
          input.wake ? JSON.stringify(input.wake) : null,
          input.ext ? JSON.stringify(input.ext) : null,
          input.forwarded ? JSON.stringify(input.forwarded) : null,
          input.quoteText ?? null,
          input.systemSource ?? null
        );
      const seq = Number(result.lastInsertRowid);
      const addReceipt = this.db.query("INSERT INTO receipts (seq, recipient, delivered_at, session) VALUES (?1, ?2, NULL, ?3)");
      for (const recipient of input.recipients) addReceipt.run(seq, recipient, input.sessions?.get(recipient) ?? null);
      this.db
        .query("UPDATE conversations SET last_message_at = MAX(last_message_at, ?2) WHERE id = ?1")
        .run(input.conversationId, input.createdAt);
      const whole = input.replyToSeq === undefined ? undefined : this.quotesFor([input.replyToSeq]).get(input.replyToSeq);
      const quote = partOf(whole, input.quoteText ?? null);
      return {
        seq,
        id,
        conversationId: input.conversationId,
        from: input.from,
        fromKind: input.fromKind,
        text: input.text,
        files: input.files,
        createdAt: input.createdAt,
        receipts: input.recipients.map((to) => {
          const session = input.sessions?.get(to);
          return { to, ...(session === undefined ? {} : { session }), deliveredAt: null, seenAt: null };
        }),
        ...(quote ? { quote } : {}),
        ...(input.verified === undefined ? {} : { verified: input.verified }),
        ...(input.fromSession === undefined ? {} : { fromSession: input.fromSession }),
        ...(input.wake ? { wake: input.wake } : {}),
        ...(input.ext?.task?.data ? { task: input.ext.task.data as Task } : {}),
        ...(input.ext ? { ext: input.ext } : {}),
        ...(input.systemSource ? { systemSource: input.systemSource } : {}),
        ...(input.forwarded ? { forwarded: input.forwarded } : {}),
        expiresAt: input.expiresAt,
      };
    })();
  }

  /** Replaces one extension's annotation and returns the updated message. */
  setExtension(seq: number, name: string, annotation: MessageExtensions[string]): Message | null {
    this.db
      .query("UPDATE messages SET ext_json = json_set(COALESCE(ext_json, '{}'), ?2, json(?3)) WHERE seq = ?1")
      .run(seq, `$.${name}`, JSON.stringify(annotation));
    return this.getMessage(seq);
  }

  /** Messages carrying one extension's annotation, oldest first (startup reconciliation/migration). */
  extensionMessages(name: string): Message[] {
    const rows = this.db
      .query<MessageRow, [string]>("SELECT * FROM messages WHERE json_type(ext_json, ?1) = 'object' ORDER BY seq")
      .all(`$.${name}`);
    return this.withReceipts(rows);
  }

  /** Who wrote the latest message of `conversationId` not written by `notFrom` (a person's message answers it). */
  lastAuthorBesides(conversationId: string, notFrom: string): string | undefined {
    return this.db
      .query<{ author: string }, [string, string]>(
        "SELECT COALESCE(system_source, from_id) AS author FROM messages WHERE conversation_id = ?1 AND COALESCE(system_source, from_id) != ?2 ORDER BY seq DESC LIMIT 1"
      )
      .get(conversationId, notFrom)?.author;
  }

  /** Who wrote the latest agent message of `conversationId` not written by `notFrom`. */
  lastAgentAuthorBesides(conversationId: string, notFrom: string): string | undefined {
    return this.db
      .query<{ author: string }, [string, string]>(
        "SELECT COALESCE(system_source, from_id) AS author FROM messages WHERE conversation_id = ?1 AND COALESCE(system_source, from_id) != ?2 AND from_kind = 'agent' ORDER BY seq DESC LIMIT 1"
      )
      .get(conversationId, notFrom)?.author;
  }

  /** Quotes for the given message seqs (one query). */
  private quotesFor(seqs: number[]): Map<number, Quote> {
    const quotes = new Map<number, Quote>();
    if (seqs.length === 0) return quotes;
    const rows = this.db
      .query<{ seq: number; from_id: string; text: string; files_json: string }, [string]>(
        "SELECT seq, from_id, text, files_json FROM messages WHERE seq IN (SELECT value FROM json_each(?1))"
      )
      .all(JSON.stringify(seqs));
    for (const r of rows) {
      const text = r.text.length > QUOTE_TEXT_CHARS ? `${r.text.slice(0, QUOTE_TEXT_CHARS - 1)}…` : r.text;
      quotes.set(r.seq, { seq: r.seq, from: r.from_id, text, files: parseFiles(r.files_json).length });
    }
    return quotes;
  }

  /** Attaches each row's receipts (one query for the batch). */
  private withReceipts(rows: MessageRow[]): Message[] {
    if (rows.length === 0) return [];
    const bySeq = new Map<number, Receipt[]>();
    const receiptRows = this.db
      .query<ReceiptRow, [string]>(
        `SELECT seq, recipient, delivered_at, seen_at, session FROM receipts
         WHERE seq IN (SELECT value FROM json_each(?1)) ORDER BY recipient`
      )
      .all(JSON.stringify(rows.map((r) => r.seq)));
    const now = Date.now();
    const expiry = new Map(rows.map((r) => [r.seq, expiresAt(r)]));
    for (const r of receiptRows) {
      let list = bySeq.get(r.seq);
      if (!list) bySeq.set(r.seq, (list = []));
      const expired = r.delivered_at === null && (expiry.get(r.seq) ?? Infinity) <= now;
      list.push({
        to: r.recipient,
        ...(r.session === null ? {} : { session: r.session }),
        deliveredAt: r.delivered_at,
        seenAt: r.seen_at,
        ...(expired ? { expired } : {}),
      });
    }
    const quotes = this.quotesFor(
      Array.from(new Set(rows.map((r) => r.reply_to_seq).filter((s): s is number => s !== null)))
    );
    const forwards = new Map<number, MessageForward[]>();
    const forwardRows = this.db
      .query<{ seq: number; by_id: string; to_label: string; at: number }, [string]>(
        "SELECT seq, by_id, to_label, at FROM message_forwards WHERE seq IN (SELECT value FROM json_each(?1)) ORDER BY at, rowid"
      )
      .all(JSON.stringify(rows.map((r) => r.seq)));
    for (const f of forwardRows) {
      let list = forwards.get(f.seq);
      if (!list) forwards.set(f.seq, (list = []));
      list.push({ by: f.by_id, to: f.to_label, at: f.at });
    }
    const titles = new Map(
      this.db
        .query<{ root_seq: number; title: string }, [string]>(
          "SELECT root_seq, title FROM thread_titles WHERE title IS NOT NULL AND root_seq IN (SELECT value FROM json_each(?1))"
        )
        .all(JSON.stringify(rows.map((r) => r.seq)))
        .map((t): [number, string] => [t.root_seq, t.title])
    );
    return rows.map((row) =>
      toMessage(
        row,
        bySeq.get(row.seq) ?? [],
        partOf(row.reply_to_seq === null ? undefined : quotes.get(row.reply_to_seq), row.quote_text),
        forwards.get(row.seq),
        titles.get(row.seq)
      )
    );
  }

  /** `by` forwarded message `seq` to `to` ("@b", "#room"; Can #12470). Callers check who may. */
  addForward(seq: number, by: string, to: string, at = Date.now()): void {
    this.db.query("INSERT INTO message_forwards (seq, by_id, to_label, at) VALUES (?1, ?2, ?3, ?4)").run(seq, by, to, at);
  }

  getMessage(seq: number): Message | null {
    const row = this.db.query<MessageRow, [number]>("SELECT * FROM messages WHERE seq = ?1").get(seq);
    return row ? (this.withReceipts([row])[0] ?? null) : null;
  }

  /** Its writer changes message `seq`'s text (Ümit #10890). Callers check who may. */
  editMessage(seq: number, text: string, now = Date.now()): void {
    this.db.query("UPDATE messages SET text = ?2, edited_at = ?3 WHERE seq = ?1 AND deleted_at IS NULL").run(seq, text, now);
  }

  /**
   * Its writer deletes message `seq` (Ümit #10890): text and files go (a forwarded copy it carries too), the row stays
   * (replies and #numbers point to it). It is no longer handed to recipients that had not received it (their receipts
   * go, so no "expired" notice either), and it leaves the pinned list. The files themselves stay: another message (or a
   * forwarded copy) may carry the same one.
   */
  deleteMessage(seq: number, now = Date.now()): void {
    this.db.transaction(() => {
      this.db.query("UPDATE messages SET text = '', files_json = '[]', forwarded_json = NULL, deleted_at = ?2 WHERE seq = ?1").run(seq, now);
      this.db.query("DELETE FROM receipts WHERE seq = ?1 AND delivered_at IS NULL").run(seq);
      this.db.query("DELETE FROM pinned_messages WHERE seq = ?1").run(seq);
    })();
  }

  /**
   * Marks `recipient`'s receipt for `seq` delivered (`ack`) or seen (`seen`, which also implies delivered).
   * Returns the receipt when it changed, else null (unknown receipt or already in that state).
   */
  markReceipt(recipient: string, seq: number, state: "ack" | "seen", now = Date.now()): Receipt | null {
    const sql =
      state === "ack"
        ? "UPDATE receipts SET delivered_at = ?3 WHERE seq = ?1 AND recipient = ?2 AND delivered_at IS NULL"
        : `UPDATE receipts SET seen_at = ?3, delivered_at = COALESCE(delivered_at, ?3)
           WHERE seq = ?1 AND recipient = ?2 AND seen_at IS NULL`;
    if (this.db.query(sql).run(seq, recipient, now).changes === 0) return null;
    const row = this.db
      .query<ReceiptRow, [number, string]>("SELECT * FROM receipts WHERE seq = ?1 AND recipient = ?2")
      .get(seq, recipient);
    return row ? { to: row.recipient, deliveredAt: row.delivered_at, seenAt: row.seen_at } : null;
  }

  /** Ascending; the newest `limit` messages with `seq < beforeSeq` (or overall). */
  listMessages(conversationId: string, beforeSeq: number | null, limit: number): Message[] {
    const rows = this.db
      .query<MessageRow, [string, number, number]>(
        `SELECT * FROM messages WHERE conversation_id = ?1 AND seq < ?2
         ORDER BY seq DESC LIMIT ?3`
      )
      .all(conversationId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit);
    return this.withReceipts(rows.reverse());
  }

  /**
   * Messages sent to `agentId` (it has a receipt for them) with `seq > sinceSeq`.
   * Normal Inbox reads return the newest page; a prompt hook asks for the oldest unseen page so a backlog over the
   * page limit drains instead of stranding its older messages.
   */
  inboxFor(agentId: string, sinceSeq: number, limit: number, unseenOnly = false): Message[] {
    const rows = unseenOnly
      ? this.db
          .query<MessageRow, [string, number, number, number]>(
            `SELECT m.* FROM messages m JOIN receipts r ON r.seq = m.seq AND r.recipient = ?1
             WHERE m.seq > ?2 AND r.seen_at IS NULL
               AND (r.delivered_at IS NOT NULL OR COALESCE(m.expires_at, m.created_at + ${DEFAULT_HOLD_MS}) > ?4)
             ORDER BY m.seq ASC LIMIT ?3`
          )
          .all(agentId, sinceSeq, limit, Date.now())
      : this.db
          .query<MessageRow, [string, number, number]>(
            `SELECT m.* FROM messages m JOIN receipts r ON r.seq = m.seq AND r.recipient = ?1
             WHERE m.seq > ?2 ORDER BY m.seq DESC LIMIT ?3`
          )
          .all(agentId, sinceSeq, limit)
          .reverse();
    return this.withReceipts(rows);
  }

  /**
   * Ascending; the newest `limit` messages whose text contains `query` (case-insensitive; empty matches all),
   * optionally only from `sender`, and only in `conversationIds` unless that is null (everything).
   */
  searchMessages(query: string, sender: string | null, conversationIds: readonly string[] | null, limit: number): Message[] {
    const pattern = `%${query.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .query<MessageRow, [string, string | null, string | null, number]>(
        `SELECT * FROM messages
         WHERE lower(text) LIKE ?1 ESCAPE '\\'
           AND (?2 IS NULL OR from_id = ?2)
           AND (?3 IS NULL OR conversation_id IN (SELECT value FROM json_each(?3)))
         ORDER BY seq DESC LIMIT ?4`
      )
      .all(pattern, sender, conversationIds === null ? null : JSON.stringify(conversationIds), limit);
    return this.withReceipts(rows.reverse());
  }

  /** Ids of `@all` and of every conversation `participantId` is a member of. */
  conversationIdsOf(participantId: string): string[] {
    const ids = this.db
      .query<{ conversation_id: string }, [string]>("SELECT conversation_id FROM conversation_members WHERE participant_id = ?1")
      .all(participantId)
      .map((r) => r.conversation_id);
    return [ALL_CONVERSATION_ID, ...ids];
  }

  /**
   * Messages for `agentId` not written by it, ascending, newest `limit`: those with an undelivered receipt for it,
   * plus (for messages written before receipts existed) those after `afterSeq` in `all` or in groups whose
   * `addressed` contains it — agents become members only through `addressed`. Never a deleted one (Ümit #10890):
   * deleting drops its undelivered receipts, which would otherwise make it look like one from before receipts.
   */
  backlogFor(agentId: string, afterSeq: number, limit: number): Message[] {
    const rows = this.db
      .query<MessageRow, [number, string, string, number, number]>(
        `SELECT * FROM messages
         WHERE from_id != ?2 AND deleted_at IS NULL AND (
           seq IN (SELECT seq FROM receipts WHERE recipient = ?2 AND delivered_at IS NULL)
           AND COALESCE(expires_at, created_at + ${DEFAULT_HOLD_MS}) > ?5
           OR (seq > ?1
             AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.seq = messages.seq)
             AND (conversation_id = ?3 OR conversation_id IN (
               SELECT conversation_id FROM conversation_members WHERE participant_id = ?2))))
         ORDER BY seq DESC LIMIT ?4`
      )
      .all(afterSeq, agentId, ALL_CONVERSATION_ID, limit, Date.now());
    return this.withReceipts(rows.reverse());
  }

  /** Receipts whose message expired in (`after`, `upTo`] before reaching the recipient: who wrote it, and to whom. */
  expiredBetween(after: number, upTo: number): Array<{ seq: number; conversationId: string; from: string; to: string }> {
    return this.db
      .query<{ seq: number; conversation_id: string; from_id: string; recipient: string }, [number, number]>(
        `SELECT m.seq, m.conversation_id, m.from_id, r.recipient FROM receipts r JOIN messages m ON m.seq = r.seq
         WHERE r.delivered_at IS NULL AND COALESCE(m.expires_at, m.created_at + ${DEFAULT_HOLD_MS}) > ?1
           AND COALESCE(m.expires_at, m.created_at + ${DEFAULT_HOLD_MS}) <= ?2`
      )
      .all(after, upTo)
      .map((r) => ({ seq: r.seq, conversationId: r.conversation_id, from: r.from_id, to: r.recipient }));
  }

  insertFile(file: FileRef, uploadedBy: string, now = Date.now()): void {
    this.db
      .query(
        `INSERT INTO files (id, name, size, mime_type, sha256, uploaded_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .run(file.id, file.name, file.size, file.mimeType, file.sha256, uploadedBy, now);
  }

  getFile(id: string): FileRef | null {
    const row = this.db
      .query<FileRow, [string]>("SELECT id, name, size, mime_type, sha256 FROM files WHERE id = ?1")
      .get(id);
    return row
      ? { id: row.id, name: row.name, size: row.size, mimeType: row.mime_type, sha256: row.sha256 }
      : null;
  }
}
