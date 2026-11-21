// The status extension (Can #14261): every hour one message to every online agent asking for an update since its last
// one (it wakes nobody: agents read it at their next turn), and each agent's replies shown on the Home tab of its page
// in the Workspace, newest first, as panes. One timer for the whole extension.
//
//   STATUS_PORT=7833 BUS_URL=http://127.0.0.1:7800 bun run packages/status-ext/src/server.ts
//   agent-bus serve … --ext 'status=http://127.0.0.1:7833,agents=Home'
//
// On the bus it is the agent @status (it joins by name with this machine's agent token); its DMs with each agent hold
// the asks and the updates. It keeps them in <data dir>/status/status.sqlite. It listens on 127.0.0.1 only: the bus
// forwards the Home page to signed-in people (GET only).
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Message, PostMessageResponse, StateResponse } from "@agent-bus/protocol";

const PORT = Number(process.env.STATUS_PORT ?? 7833);
const BUS = (process.env.BUS_URL ?? "http://127.0.0.1:7800").replace(/\/+$/, "");
const DATA = process.env.AGENT_BUS_DATA_DIR ?? path.join(homedir(), ".agent-bus");
const TOKEN = readFileSync(process.env.AGENT_BUS_TOKEN_FILE ?? path.join(DATA, "agent-token"), "utf8").trim();
const EVERY_MS = Number(process.env.STATUS_EVERY_MS ?? 3_600_000);
const ID = "status";

mkdirSync(path.join(DATA, "status"), { recursive: true, mode: 0o700 });
if (!existsSync(path.join(DATA, "status", "METADATA"))) {
  const note = `message-bus (status extension, packages/status-ext), ${new Date().toISOString().slice(0, 10)}: agents' status updates for their Home tab (Can #14261). Delete with the extension.\n`;
  writeFileSync(path.join(DATA, "status", "METADATA"), note, { mode: 0o600 });
}
const db = new Database(path.join(DATA, "status", "status.sqlite"), { create: true, strict: true });
db.exec(`
  CREATE TABLE IF NOT EXISTS asks (seq INTEGER PRIMARY KEY, agent TEXT NOT NULL, at INTEGER NOT NULL, woke INTEGER NOT NULL, answered INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY, agent TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL, files TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS updates_agent ON updates(agent, seq);
`);
// A NO_UPDATES bar (Can #14270): the time of the agent's update before it (or of the bar itself when there was none).
if (!db.query("SELECT 1 FROM pragma_table_info('updates') WHERE name = 'no_updates_since'").get()) {
  db.exec("ALTER TABLE updates ADD COLUMN no_updates_since INTEGER");
}
// When a person first saw it on the Home tab (Can #14339: an agent is not asked again while its last update is unseen).
if (!db.query("SELECT 1 FROM pragma_table_info('updates') WHERE name = 'seen_at'").get()) {
  db.exec("ALTER TABLE updates ADD COLUMN seen_at INTEGER");
}

const headers = { "Content-Type": "application/json", "X-Agent-Token": TOKEN };

async function bus<T>(route: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BUS}${route}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** The agents to ask: every agent connected to the bus now, but this one. */
async function agents(): Promise<string[]> {
  const s = await bus<StateResponse>(`/api/state?as=${ID}`);
  return s.participants.filter((p) => p.kind === "agent" && p.id !== ID && p.id !== "resources" && p.online).map((p) => p.id);
}

function lastUpdate(agent: string): number | undefined {
  return db
    .query<{ at: number }, [string]>("SELECT at FROM updates WHERE agent = ?1 AND no_updates_since IS NULL ORDER BY seq DESC LIMIT 1")
    .get(agent)?.at;
}

const when = (at: number) => new Date(at).toLocaleString("en-GB", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" });

/** One ask to `agent`; it wakes nobody. */
async function ask(agent: string): Promise<void> {
  const last = lastUpdate(agent);
  const text =
    `Status update, please: what changed since ${last ? `your last update (${when(last)})` : "you started"}? ` +
    "Reply to this message (op=reply) with it, newest first. It shows on your Home tab in Agent Hub, as a pane people " +
    "read rather than a chat message: present numbers in a table, include links, and put a graph in by attaching the " +
    "image and writing /inline{#1} where it goes. Nothing changed since then? Reply with just NO_UPDATES. " +
    "(This wakes nobody: answer at your next turn.)";
  const res = await bus<PostMessageResponse>("/api/messages", {
    method: "POST",
    body: JSON.stringify({ from: ID, to: `@${agent}`, text, wake: [], holdHours: 2 }),
  });
  db.query("INSERT OR REPLACE INTO asks (seq, agent, at, woke) VALUES (?1, ?2, ?3, 0)").run(res.message.seq, agent, Date.now());
}

/** How long an unanswered ask stands before the agent is asked again: asks do not pile up in an idle agent's inbox. */
const UNANSWERED_MS = 24 * 3_600_000;

/**
 * The hourly round, the one timer: one ask to each online agent, except one whose latest update nobody has seen yet on
 * its Home tab (Can #14339: no new update while the last one is unread) and one whose last ask is unanswered and less
 * than a day old.
 */
async function round(): Promise<void> {
  try {
    const now = Date.now();
    const due = (await agents()).filter((agent) => {
      const last = db.query<{ at: number; answered: number }, [string]>("SELECT at, answered FROM asks WHERE agent = ?1 ORDER BY seq DESC LIMIT 1").get(agent);
      if (last && last.answered === 0 && now - last.at < UNANSWERED_MS) return false;
      const update = db
        .query<{ seen_at: number | null }, [string]>("SELECT seen_at FROM updates WHERE agent = ?1 AND no_updates_since IS NULL ORDER BY seq DESC LIMIT 1")
        .get(agent);
      return !update || update.seen_at !== null;
    });
    for (const agent of due) await ask(agent).catch((e) => console.error(`ask @${agent}: ${e}`));
    console.log(`${new Date().toISOString()} asked ${due.length} agents`);
  } catch (error) {
    console.error(`round: ${error}`);
  }
}

function schedule(): void {
  const wait = EVERY_MS - (Date.now() % EVERY_MS);
  setTimeout(() => {
    void round();
    schedule();
  }, wait);
}

/** NO_UPDATES, and "No change." and the like (Can #14270). */
const NO_UPDATES = /^\W*(no_updates|no (change|changes|update|updates|news))\W*$/i;

/**
 * An agent's message to @status (a reply to an ask, or one it wrote itself): an update for its tab. NO_UPDATES
 * becomes one small "No updates since <its last update>" bar, written once: further NO_UPDATES after it add nothing and
 * change nothing, until a real update comes (Can #14270).
 */
function keep(message: Message): void {
  if (message.fromKind !== "agent" || message.from === ID || message.deletedAt) return;
  db.query("UPDATE asks SET answered = 1 WHERE agent = ?1").run(message.from);
  let since: number | null = null;
  if (NO_UPDATES.test(message.text) && message.files.length === 0) {
    const latest = db
      .query<{ at: number; no_updates_since: number | null }, [string]>("SELECT at, no_updates_since FROM updates WHERE agent = ?1 ORDER BY seq DESC LIMIT 1")
      .get(message.from);
    if (latest && latest.no_updates_since !== null) return;
    since = latest?.at ?? message.createdAt;
  }
  db.query("INSERT OR IGNORE INTO updates (seq, agent, at, text, files, no_updates_since) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(
    message.seq,
    message.from,
    message.createdAt,
    since === null ? message.text : "",
    JSON.stringify(message.files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType }))),
    since
  );
}

/** On the bus as @status: deliveries are agents' updates; each is acknowledged. */
function connect(): void {
  const ws = new WebSocket(`${BUS.replace(/^http/, "ws")}/ws/agent?${new URLSearchParams({ token: TOKEN, host: "bariton", name: ID })}`);
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as { type: string; message?: Message };
    if (frame.type !== "deliver" || !frame.message) return;
    keep(frame.message);
    ws.send(JSON.stringify({ type: "ack", seq: frame.message.seq }));
  });
  ws.addEventListener("close", () => setTimeout(connect, 5000));
  ws.addEventListener("error", () => ws.close());
}

// The page: the agent's updates newest first, each a pane; drawn with the website's own Markdown renderer.
const pageScript = await (async () => {
  const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "page.ts")], target: "browser", format: "esm" });
  if (!built.success || !built.outputs[0]) throw new Error(built.logs.map((l) => l.message).join("; "));
  return await built.outputs[0].text();
})();

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Status</title><link rel="stylesheet" href="page.css"></head><body><main id="panes"><p class="note">Loading…</p></main>
<script type="module" src="page.js"></script></body></html>`;
const CSS = readFileSync(path.join(import.meta.dir, "page.css"), "utf8");

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const agent = url.searchParams.get("agent")?.toLowerCase() ?? "";
    if (url.pathname === "/health") return Response.json({ ok: true, every: EVERY_MS });
    if (url.pathname === "/") return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (url.pathname === "/page.js") return new Response(pageScript, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
    if (url.pathname === "/page.css") return new Response(CSS, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/updates.json") {
      const rows = db
        .query<{ seq: number; at: number; text: string; files: string; no_updates_since: number | null }, [string]>(
          "SELECT seq, at, text, files, no_updates_since FROM updates WHERE agent = ?1 ORDER BY seq DESC LIMIT 100"
        )
        .all(agent)
        .map(({ no_updates_since, ...r }) => ({ ...r, files: JSON.parse(r.files), ...(no_updates_since === null ? {} : { noUpdatesSince: no_updates_since }) }));
      const asked = db.query<{ at: number }, [string]>("SELECT at FROM asks WHERE agent = ?1 ORDER BY seq DESC LIMIT 1").get(agent)?.at;
      return Response.json({ agent, updates: rows, asked: asked ?? null, every: EVERY_MS });
    }
    // An update's file (a graph), fetched from the bus with this extension's token.
    const file = /^\/file\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
    if (file) {
      const res = await fetch(`${BUS}/api/files/${file}?as=${ID}`, { headers: { "X-Agent-Token": TOKEN } });
      return new Response(res.body, { status: res.status, headers: { "Content-Type": res.headers.get("content-type") ?? "application/octet-stream" } });
    }
    // The Home tab showed this agent's updates up to `seq` to a person (page.ts: on screen, page in front).
    if (url.pathname === "/seen") {
      const seq = Number(url.searchParams.get("seq"));
      if (Number.isSafeInteger(seq)) db.query("UPDATE updates SET seen_at = ?3 WHERE agent = ?1 AND seq <= ?2 AND seen_at IS NULL").run(agent, seq, Date.now());
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  },
});

connect();
schedule();
console.log(`status-ext on http://127.0.0.1:${PORT}, asking every ${EVERY_MS / 60000} min`);
