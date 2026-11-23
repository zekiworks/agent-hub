// Task extension: task rules, task history, command parsing and Inbox queries. The bus remains the identity, message,
// access and delivery boundary. Run beside it:
//   TASK_EXT_PORT=7834 bun run packages/task-ext/src/server.ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { Conversation, ExtensionAnnotation, Message, Task, TaskAssignee, TasksResponse } from "@agent-bus/protocol";

const PORT = Number(process.env.TASK_EXT_PORT ?? 7834);
const DATA = process.env.AGENT_BUS_DATA_DIR ?? path.join(homedir(), ".agent-bus");
const DIR = path.join(DATA, "task-ext");
const SECRET_FILE = process.env.TASK_EXT_SECRET_FILE ?? path.join(DATA, "task-extension.secret");

mkdirSync(DIR, { recursive: true, mode: 0o700 });
if (!existsSync(path.join(DIR, "METADATA"))) {
  writeFileSync(path.join(DIR, "METADATA"), "message-bus\n2026-11-23\nPersistent state for the Agent Hub task extension. Delete only after tasks are migrated or no longer needed.\n", { mode: 0o600 });
}

function secretAt(file: string): string {
  if (!existsSync(file)) {
    try {
      writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!existsSync(file)) throw error;
    }
  }
  chmodSync(file, 0o600);
  const secret = readFileSync(file, "utf8").trim();
  if (secret.length < 32) throw new Error(`${file} must contain at least 32 characters`);
  return secret;
}

const secret = secretAt(SECRET_FILE);
const db = new Database(path.join(DIR, "tasks.sqlite"), { create: true, strict: true });
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS tasks (
    seq INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    author TEXT NOT NULL,
    message_json TEXT NOT NULL,
    conversation_json TEXT NOT NULL,
    annotation_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_author ON tasks(author, seq DESC);
  CREATE TABLE IF NOT EXISTS task_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    note TEXT,
    at INTEGER NOT NULL,
    UNIQUE(seq, actor, action, at)
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  );
`);

const manifest = {
  v: 1,
  name: "task",
  title: "Tasks",
  version: "1.0.0",
  description: "Give conversation members tasks and track their state in the existing Inbox.",
  commands: [
    {
      name: "task",
      help: "Give one or more members a task",
      usage: "/task @member… what to do",
      for: ["person", "agent"],
      where: ["dm", "group", "project"],
      args: [
        { name: "to", type: "member", repeat: true, required: true },
        { name: "text", type: "rest", required: true },
      ],
    },
  ],
  actions: {
    accept: { label: "On it" },
    progress: { label: "Progress…" },
    done: { label: "✓ Done" },
    reject: { label: "✕ Reject" },
    cancel: { label: "Cancel" },
  },
  tools: [
    {
      name: "task",
      description: "Create and act on Agent Hub tasks.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["create", "list", "mutate"] },
          conversation: { type: "string" },
          to: { type: "array", items: { type: "string" } },
          text: { type: "string" },
          box: { type: "string", enum: ["mine", "assigned"] },
          state: { type: "string", enum: ["open", "all"] },
          message_id: { type: "integer" },
          action: { type: "string", enum: ["accept", "progress", "done", "reject", "cancel"] },
          reason: { type: "string" },
          note: { type: "string" },
          eta: { type: "string" },
        },
        required: ["op"],
        additionalProperties: false,
      },
    },
  ],
  events: ["posted"],
  notices: true,
  panel: { title: "Tasks", slot: "inbox.tasks" },
};

interface TaskRow {
  seq: number;
  conversation_id: string;
  author: string;
  message_json: string;
  conversation_json: string;
  annotation_json: string;
  created_at: number;
  updated_at: number;
}

interface Caller {
  id: string;
  kind: "person" | "agent";
  verified?: boolean;
}

interface ActionBody {
  seq: number;
  caller: Caller;
  annotation: ExtensionAnnotation;
  input?: { reason?: string; note?: string; eta?: string };
}

const live = (state: TaskAssignee["state"]): boolean => state === "open" || state === "accepted";

function taskData(annotation: ExtensionAnnotation): Task {
  const value = annotation.data as Partial<Task> | null;
  if (!value || (value.type !== "task" && value.type !== "approval") || !Array.isArray(value.assignees)) throw new Error("Invalid task annotation");
  return value as Task;
}

function draw(author: string, task: Task): ExtensionAnnotation {
  const open = task.assignees.filter((assignee) => live(assignee.state));
  const allowed: Record<string, string[]> = {};
  for (const assignee of open) {
    allowed[assignee.id] = assignee.state === "open" ? ["accept", "done", "reject", "read"] : ["progress", "done", "reject", "read"];
  }
  if (open.length > 0) allowed[author] = [...new Set([...(allowed[author] ?? []), "cancel"] )];
  const state = open.length > 0 ? "open" : task.assignees.every((assignee) => assignee.state === "done") ? "done" : "closed";
  return {
    label: `${task.type === "approval" ? "Approval" : "Task"} · ${state} · ${task.assignees.map((assignee) => `@${assignee.id}`).join(", ")}`,
    state,
    allowed,
    data: task,
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function error(message: string, status = 400): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function bodyOf(req: Request): Promise<{ text: string; value: Record<string, unknown> }> {
  const text = await req.text();
  const expected = createHmac("sha256", secret).update(text).digest("base64url");
  const given = req.headers.get("x-bus-signature") ?? "";
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw Object.assign(new Error("Bad bus signature"), { status: 401 });
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON body must be an object");
  return { text, value: value as Record<string, unknown> };
}

function command(value: Record<string, unknown>): { post: { text: string; annotation: ExtensionAnnotation; wake: string[] } } {
  const caller = value.caller as Caller | undefined;
  const conversation = value.conversation as Conversation | undefined;
  const raw = typeof value.raw === "string" ? value.raw.trim() : "";
  if (!caller?.id || !conversation) throw new Error("Command needs caller and conversation");
  if (conversation.kind === "all") throw new Error("Tasks go to a DM, group, room or project, not @all");
  const words = raw.split(/\s+/).filter(Boolean);
  const assignees: string[] = [];
  const taskType = value.taskType === "approval" ? "approval" : "task";
  while (words[0]?.startsWith("@")) {
    const id = words.shift()!.slice(1).toLowerCase();
    if (id && !assignees.includes(id)) assignees.push(id);
  }
  const text = words.join(" ").trim();
  if (assignees.length === 0) throw new Error("Whose task is it? Start with @member. Nothing was sent.");
  if (!text) throw new Error("What should they do? Add task text after the member. Nothing was sent.");
  const invalid = assignees.filter((id) => id === caller.id || !conversation.members.includes(id));
  if (invalid.length > 0) throw new Error(`Task assignees must be other members of this conversation: ${invalid.map((id) => `@${id}`).join(", ")}. Nothing was sent.`);
  const task: Task = { type: taskType, assignees: assignees.map((id) => ({ id, state: "open" })) };
  return { post: { text, annotation: draw(caller.id, task), wake: assignees } };
}

function keepEvent(value: Record<string, unknown>): void {
  const id = typeof value.id === "string" ? value.id : "";
  if (!id) throw new Error("Event needs id");
  if (db.query("SELECT 1 FROM events WHERE id = ?1").get(id)) return;
  const message = value.message as Message | undefined;
  const conversation = value.conversation as Conversation | undefined;
  const annotation = value.annotation as ExtensionAnnotation | undefined;
  if (!message || !conversation || !annotation) throw new Error("Posted event needs message, conversation and annotation");
  db.transaction(() => {
    db.query(
      `INSERT INTO tasks (seq, conversation_id, author, message_json, conversation_json, annotation_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(seq) DO UPDATE SET message_json=excluded.message_json, conversation_json=excluded.conversation_json,
         annotation_json=excluded.annotation_json, updated_at=excluded.updated_at`
    ).run(message.seq, message.conversationId, message.from, JSON.stringify(message), JSON.stringify(conversation), JSON.stringify(annotation), message.createdAt, Date.now());
    db.query("INSERT INTO events (id, at) VALUES (?1, ?2)").run(id, Date.now());
  })();
}

function act(action: string, value: ActionBody): { annotation: ExtensionAnnotation; notice?: { text: string; wake: string[] } } {
  const row = db.query<TaskRow, [number]>("SELECT * FROM tasks WHERE seq = ?1").get(value.seq);
  if (!row) throw Object.assign(new Error(`Unknown task #${value.seq}`), { status: 404 });
  const annotation = JSON.parse(row.annotation_json) as ExtensionAnnotation;
  const task = taskData(annotation);
  const mine = task.assignees.find((assignee) => assignee.id === value.caller.id);
  const now = Date.now();
  const reason = value.input?.reason?.trim();
  if (task.type === "approval" && ["done", "reject"].includes(action) && (value.caller.kind !== "person" || !value.caller.verified)) {
    throw Object.assign(new Error("Approvals require a signed-in person"), { status: 403 });
  }
  const note = value.input?.note?.trim();
  let notice: { text: string; wake: string[] } | undefined;
  if (action === "cancel") {
    if (row.author !== value.caller.id) throw Object.assign(new Error(`Only @${row.author} may cancel #${value.seq}`), { status: 403 });
    const open = task.assignees.filter((assignee) => live(assignee.state));
    if (open.length === 0) throw Object.assign(new Error(`#${value.seq} is already closed`), { status: 409 });
    for (const assignee of open) Object.assign(assignee, { state: "withdrawn", at: now, ...(reason ? { reason } : {}) });
    notice = { text: `Cancelled by @${value.caller.id}.${reason ? ` ${reason}` : ""}`, wake: open.map((assignee) => assignee.id) };
  } else if (action === "read") {
    if (!mine) throw Object.assign(new Error(`#${value.seq} is not assigned to @${value.caller.id}`), { status: 403 });
    mine.readAt ??= now;
  } else if (action === "accept" || action === "progress" || action === "done" || action === "reject") {
    if (!mine) throw Object.assign(new Error(`#${value.seq} is not assigned to @${value.caller.id}`), { status: 403 });
    if (!live(mine.state)) throw Object.assign(new Error(`#${value.seq} is already ${mine.state} for @${value.caller.id}`), { status: 409 });
    if (action === "accept") {
      if (mine.state === "accepted") throw Object.assign(new Error(`#${value.seq} is already accepted`), { status: 409 });
      mine.state = "accepted";
      mine.at = now;
      mine.readAt ??= now;
    } else if (action === "progress") {
      if (!note) throw new Error("Progress needs a note");
      notice = { text: `@${value.caller.id}: ${note}${value.input?.eta ? ` (ETA ${value.input.eta})` : ""}`, wake: [] };
    } else {
      mine.state = action === "done" ? "done" : "rejected";
      mine.at = now;
      mine.readAt ??= now;
      if (reason) mine.reason = reason;
      notice = {
        text: action === "done" ? `✓ Done by @${value.caller.id}.${reason ? ` ${reason}` : ""}` : `✕ Rejected by @${value.caller.id}.${reason ? ` ${reason}` : ""}`,
        wake: [row.author],
      };
    }
  } else throw Object.assign(new Error(`Unknown task action "${action}"`), { status: 404 });
  const next = draw(row.author, task);
  const message = JSON.parse(row.message_json) as Message;
  message.ext = { ...(message.ext ?? {}), task: next };
  message.task = task;
  db.transaction(() => {
    db.query("UPDATE tasks SET message_json=?2, annotation_json=?3, updated_at=?4 WHERE seq=?1").run(value.seq, JSON.stringify(message), JSON.stringify(next), now);
    db.query("INSERT OR IGNORE INTO task_history (seq, actor, action, note, at) VALUES (?1, ?2, ?3, ?4, ?5)").run(value.seq, value.caller.id, action, reason ?? note ?? null, now);
  })();
  return { annotation: next, ...(notice ? { notice } : {}) };
}

function tasks(value: Record<string, unknown>): TasksResponse {
  const viewer = typeof value.viewer === "string" ? value.viewer : "";
  const box = value.box === "assigned" ? "assigned" : "mine";
  const includeClosed = value.state === "all";
  const rows = db.query<TaskRow, []>("SELECT * FROM tasks ORDER BY seq DESC LIMIT 200").all();
  const selected = rows.filter((row) => {
    const task = taskData(JSON.parse(row.annotation_json) as ExtensionAnnotation);
    const relevant = box === "assigned" ? row.author === viewer : task.assignees.some((assignee) => assignee.id === viewer);
    if (!relevant) return false;
    if (includeClosed) return true;
    return box === "assigned" ? task.assignees.some((assignee) => live(assignee.state)) : task.assignees.some((assignee) => assignee.id === viewer && live(assignee.state));
  });
  const messages = selected.map((row) => {
    const message = JSON.parse(row.message_json) as Message;
    message.ext = { ...(message.ext ?? {}), task: JSON.parse(row.annotation_json) as ExtensionAnnotation };
    message.task = taskData(message.ext.task);
    return message;
  });
  const conversations = [...new Map(selected.map((row) => {
    const conversation = JSON.parse(row.conversation_json) as Conversation;
    return [conversation.id, conversation] as const;
  })).values()];
  const mine = rows.flatMap((row) => taskData(JSON.parse(row.annotation_json) as ExtensionAnnotation).assignees.filter((assignee) => assignee.id === viewer && live(assignee.state)));
  return { messages, conversations, open: mine.length, unread: mine.filter((assignee) => assignee.readAt === undefined).length };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/bus-extension.json") return json(manifest);
      if (req.method === "GET" && url.pathname === "/api/health") return json({ ok: true });
      if (req.method !== "POST") return error("Not found", 404);
      const { value } = await bodyOf(req);
      if (url.pathname === "/commands/task") return json(command(value));
      if (url.pathname === "/events") {
        keepEvent(value);
        return json({ ok: true });
      }
      if (url.pathname === "/queries/tasks") return json(tasks(value));
      const action = /^\/actions\/([a-z]+)$/.exec(url.pathname)?.[1];
      if (action) return json(act(action, value as unknown as ActionBody));
      return error("Not found", 404);
    } catch (cause) {
      const value = cause as Error & { status?: number };
      return error(value.message || String(cause), value.status ?? 400);
    }
  },
});

console.log(`task-ext on ${server.url}`);
