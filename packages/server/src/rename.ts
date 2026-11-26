// Renaming an agent (agent-bus rename-agent; Can #13874, #13877): its id changes everywhere the bus keeps it, its
// project follows the new name, and the old id stays an alias (participant_aliases) so "@old", "@@old" and old wake
// lists still reach it. Optionally the folder it lives in changes too, so the harness started there joins as the
// renamed agent with its history. Run with the bus stopped: the running bus keeps ids in memory.
import type { Database } from "bun:sqlite";
import { slugifyId } from "@agent-bus/protocol";

export interface RenameResult {
  /** Conversations whose members changed (its DMs, groups, projects). */
  conversations: number;
  messages: number;
  /** The agent's own project, renamed with it ("@@old" → "@@new"), if it had one. */
  project?: string;
  /** Other harnesses' agents of the same folder (`old-codex`), left as they are. */
  siblings: string[];
}

/** JSON text columns that hold participant ids as string values. */
const JSON_COLUMNS: Array<[table: string, column: string]> = [
  ["messages", "wake_json"],
  ["messages", "task_json"],
  ["messages", "forwarded_json"],
  ["checklists", "assignees_json"],
  ["checklists", "items_json"],
  ["agent_tokens", "agents"],
];

/** Plain columns that hold one participant id. */
const ID_COLUMNS: Array<[table: string, column: string]> = [
  ["messages", "from_id"],
  ["conversation_members", "participant_id"],
  ["pins", "participant_id"],
  ["checklists", "owner"],
  ["checklists", "updated_by"],
  ["pinned_messages", "pinned_by"],
  ["thread_titles", "set_by"],
  ["thread_titles", "asked_to"],
  ["message_forwards", "by_id"],
  ["files", "uploaded_by"],
  ["receipts", "recipient"],
  ["reservations", "holder"],
  ["reservations", "created_by"],
  ["reservations", "approved_by"],
  ["gpu_subscriptions", "subscriber"],
];

export function renameAgent(db: Database, from: string, to: string, newPath?: string, now = Date.now()): RenameResult {
  const oldId = from.replace(/^@+/, "").toLowerCase();
  const newId = to.replace(/^@+/, "").toLowerCase();
  if (!newId || slugifyId(newId) !== newId) throw new Error(`"${to}" is not an agent id (a-z, 0-9, - and _, at most 48)`);
  if (newPath !== undefined && !newPath.startsWith("/")) throw new Error(`--path wants an absolute folder, got "${newPath}"`);
  db.exec(
    "CREATE TABLE IF NOT EXISTS participant_aliases (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL, renamed_at INTEGER NOT NULL);"
  );
  const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  const agent = db
    .query<{ id: string; host: string | null; harness: string | null }, [string]>(
      "SELECT id, host, harness FROM participants WHERE id = ?1 AND kind = 'agent'"
    )
    .get(oldId);
  if (!agent) throw new Error(`No agent @${oldId}`);
  if (db.query("SELECT 1 FROM participants WHERE id = ?1").get(newId)) throw new Error(`@${newId} is taken`);
  if (db.query("SELECT 1 FROM participant_aliases WHERE old_id = ?1").get(newId)) throw new Error(`@${newId} is an old name of another agent`);
  const ownProject = db.query<{ id: string }, [string]>("SELECT id FROM conversations WHERE kind = 'project' AND name = ?1").get(oldId);
  if (db.query("SELECT 1 FROM conversations WHERE kind = 'project' AND name = ?1").get(newId)) {
    throw new Error(`A project or room is named "${newId}" already`);
  }
  if (newPath !== undefined) {
    const clash = db
      .query<{ id: string }, [string | null, string, string, string]>(
        "SELECT id FROM participants WHERE kind = 'agent' AND host = ?1 AND path = ?2 AND COALESCE(harness, '') = ?3 AND id != ?4"
      )
      .get(agent.host, newPath, agent.harness ?? "", oldId);
    if (clash) throw new Error(`@${clash.id} already lives in ${newPath}`);
  }
  const siblings = db
    .query<{ id: string }, [string]>("SELECT id FROM participants WHERE kind = 'agent' AND id LIKE ?1 || '-%'")
    .all(oldId)
    .map((r) => r.id);

  return db.transaction((): RenameResult => {
    if (newPath === undefined) db.query("UPDATE participants SET id = ?2 WHERE id = ?1").run(oldId, newId);
    else db.query("UPDATE participants SET id = ?2, path = ?3 WHERE id = ?1").run(oldId, newId, newPath);
    for (const [table, column] of ID_COLUMNS) {
      if (tables.has(table)) db.query(`UPDATE ${table} SET ${column} = ?2 WHERE ${column} = ?1`).run(oldId, newId);
    }
    const quotedOld = JSON.stringify(oldId);
    const quotedNew = JSON.stringify(newId);
    for (const [table, column] of JSON_COLUMNS) {
      if (!tables.has(table)) continue;
      db.query(`UPDATE ${table} SET ${column} = replace(${column}, ?1, ?2) WHERE ${column} LIKE '%' || ?1 || '%'`).run(quotedOld, quotedNew);
    }
    if (tables.has("message_forwards")) {
      db.query("UPDATE message_forwards SET to_label = ?2 WHERE to_label = ?1").run(`@${oldId}`, `@${newId}`);
    }
    if (ownProject) db.query("UPDATE conversations SET name = ?2 WHERE id = ?1").run(ownProject.id, newId);
    // Members are kept sorted in addressed_json (DMs and groups are found by it).
    const touched = db
      .query<{ conversation_id: string }, [string]>("SELECT conversation_id FROM conversation_members WHERE participant_id = ?1")
      .all(newId)
      .map((r) => r.conversation_id);
    const sync = db.query(
      `UPDATE conversations SET addressed_json = (
         SELECT COALESCE(json_group_array(participant_id), '[]') FROM
           (SELECT participant_id FROM conversation_members WHERE conversation_id = ?1 ORDER BY participant_id))
       WHERE id = ?1 AND kind != 'all'`
    );
    for (const id of touched) sync.run(id);
    db.query("UPDATE participant_aliases SET new_id = ?2 WHERE new_id = ?1").run(oldId, newId);
    db.query("INSERT INTO participant_aliases (old_id, new_id, renamed_at) VALUES (?1, ?2, ?3)").run(oldId, newId, now);
    const messages = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM messages WHERE from_id = ?1").get(newId)?.n ?? 0;
    return { conversations: touched.length, messages, ...(ownProject ? { project: newId } : {}), siblings };
  })();
}
