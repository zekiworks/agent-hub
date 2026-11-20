// The labelling page of the "Ask @agent" comparison (Ümit #13030): one sampled room message at a time, as the room
// showed it just before; its sender picks every agent they would have been fine to ask, "none", or "can't judge".
//
//   bun packages/ask-ext/eval/label-server.ts [--port 7840]
//   agent-bus serve … --ext asklabel=http://127.0.0.1:7840     (a Workspace page)
//
// The bus's extension proxy forwards GET and HEAD only, under /ext/asklabel/<key>/, and does not pass redirects on;
// its frame allows scripts but no forms. So: relative URLs only, saving is a GET (`save?item=m123&labels=a,b`,
// `labels=none`, or `cannotJudge=1`) that answers with the next item's page, and the toggles are a few lines of script.
// Labels are appended to ~/.agent-bus/ask-eval/labels.jsonl (the latest line per item wins); `labels.json` exports them.
import { statSync, writeFileSync } from "node:fs";
import { ITEMS_FILE, LABELS_EXPORT, LABELS_FILE, appendJsonl, ensureEvalDir, flag, latestLabels, readJsonl, type Item } from "./common";

const PORT = Number(flag("port", "7840"));
/** Earlier messages shown open; the rest of the body's (up to 20) sit under "older". */
const SHOWN = 8;
const LONG = 700;

let cache: { mtime: number; items: Item[] } | undefined;

/** The sampled items (re-read when dataset.ts rewrites the file), in the order they were written. */
function items(): Item[] {
  const mtime = statSync(ITEMS_FILE).mtimeMs;
  if (cache?.mtime !== mtime) cache = { mtime, items: readJsonl<Item>(ITEMS_FILE).sort((a, b) => a.seq - b.seq) };
  return cache.items;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function when(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", { timeZone: "Europe/Istanbul", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** A message's text: escaped, long ones folded after LONG characters. */
function textHtml(text: string): string {
  if (text.length <= LONG) return `<div class="t">${escapeHtml(text)}</div>`;
  return `<div class="t">${escapeHtml(text.slice(0, LONG))}<details><summary>… ${text.length - LONG} more characters</summary>${escapeHtml(text.slice(LONG))}</details></div>`;
}

function messageHtml(m: Item["body"]["messages"][number]): string {
  const reply = m.replyTo !== undefined ? ` <span class="dim">↩ #${m.replyTo}</span>` : "";
  return `<li class="${m.fromKind}"><div class="h"><b>${escapeHtml(m.from)}</b> <span class="dim">${m.fromKind === "agent" ? "agent" : "person"} · ${when(m.createdAt)} · #${m.seq}</span>${reply}</div>${textHtml(m.text)}</li>`;
}

/** Query string of a page link: the sender filter carried along. */
function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) q.set(key, value);
  return `./?${q.toString()}`;
}

function page(item: Item | undefined, list: Item[], sender: string | undefined, note = ""): string {
  const labels = latestLabels();
  const done = list.filter((i) => labels.has(i.id)).length;
  const filters = ["can", "umit", undefined]
    .map((s) => `<a class="${s === sender ? "on" : ""}" href="${query({ sender: s })}">${s ?? "all"}</a>`)
    .join(" ");
  const head = `<header><div>${filters}</div><div class="dim">${done} of ${list.length} labelled · <a href="labels.json" target="_blank">labels.json</a></div></header>`;
  if (!item) {
    return shell(`${head}<p>${list.length === 0 ? "No messages for this filter." : "All labelled. Thank you."}</p>${note}`);
  }
  const index = list.indexOf(item);
  const prev = list[index - 1];
  const next = list[index + 1];
  const msgs = item.body.messages;
  const older = msgs.slice(0, Math.max(0, msgs.length - SHOWN));
  const recent = msgs.slice(-SHOWN);
  const line = labels.get(item.id);
  const chosen = new Set(line === undefined || line.cannotJudge ? [] : line.labels.length === 0 ? ["none"] : line.labels);
  const toggles = [
    ...item.body.agents.map((id) => `<button type="button" class="tog" data-id="${escapeHtml(id)}" aria-pressed="${chosen.has(id)}">@${escapeHtml(id)}</button>`),
    `<button type="button" class="tog none special" data-id="none" aria-pressed="${chosen.has("none")}">none</button>`,
    // Not an agent id (it may not collide with one): its own kind of answer.
    `<button type="button" class="tog none special" data-cannot="1" aria-pressed="${line?.cannotJudge === true}">can’t judge</button>`,
  ].join("");
  const checklist =
    item.body.checklist.length === 0
      ? ""
      : `<details><summary>Checklist then (${item.body.checklist.length} steps)</summary><ul class="ck">${item.body.checklist
          .map((s) => `<li>${s.done ? "☑" : "☐"} ${s.heading ? `<span class="dim">${escapeHtml(s.heading)}:</span> ` : ""}${escapeHtml(s.text)}${s.owner ? ` <span class="dim">(${escapeHtml(s.owner)})</span>` : ""}</li>`)
          .join("")}</ul></details>`;
  const room = item.body.conversation;
  return shell(`${head}
<p class="how">Label as you would have <b>then</b>: use only what the room showed before this message (below), not what happened after. Tap every agent you would have been fine to ask; <b>none</b> if the box should have offered no one; <b>can’t judge</b> if you cannot tell from what is shown.</p>
<div class="meta"><b>#${escapeHtml(room.name ?? room.id)}</b>${room.title ? ` · ${escapeHtml(room.title)}` : ""} <span class="dim">· item ${index + 1} of ${list.length} · ${escapeHtml(item.id)}</span></div>
${older.length > 0 ? `<details class="older"><summary>${older.length} older messages</summary><ol class="msgs">${older.map(messageHtml).join("")}</ol></details>` : ""}
<ol class="msgs">${recent.map(messageHtml).join("")}</ol>
${checklist}
<div class="draft"><div class="h"><b>${escapeHtml(item.sender)}</b> <span class="dim">wrote · ${when(item.createdAt)} · #${item.seq}</span></div><strong>${escapeHtml(item.body.draft.text)}</strong></div>
<p class="q">Whom should the box have offered (“Ask @…”)?</p>
<div class="togs">${toggles}</div>
${note}
<nav>
  ${prev ? `<a class="btn" href="${query({ item: prev.id, sender })}">← Back</a>` : `<span></span>`}
  <a class="btn primary" id="save" href="#">Save &amp; next</a>
  ${next ? `<a class="btn" href="${query({ item: next.id, sender })}">Skip →</a>` : `<span></span>`}
</nav>
<script>
const toggles = [...document.querySelectorAll(".tog")];
for (const t of toggles) t.addEventListener("click", () => {
  const on = t.getAttribute("aria-pressed") !== "true";
  t.setAttribute("aria-pressed", String(on));
  // "none" and "can't judge" each go alone: they exclude the agents and each other, and an agent excludes both.
  if (on) for (const o of toggles) if (o !== t && (o.classList.contains("special") || t.classList.contains("special"))) o.setAttribute("aria-pressed", "false");
});
document.getElementById("save").addEventListener("click", (e) => {
  e.preventDefault();
  const pressed = toggles.filter((t) => t.getAttribute("aria-pressed") === "true");
  if (pressed.length === 0) { alert("Tap an agent, none, or can’t judge."); return; }
  const q = new URLSearchParams({ item: ${JSON.stringify(item.id)} });
  if (pressed.some((t) => t.dataset.cannot)) q.set("cannotJudge", "1");
  else q.set("labels", pressed.map((t) => t.dataset.id).join(","));
  ${sender ? `q.set("sender", ${JSON.stringify(sender)});` : ""}
  location.href = "save?" + q.toString();
});
</script>`);
}

function shell(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Ask @agent labels</title><style>
:root { --bg:#fff; --fg:#1d1f23; --dim:#6b7078; --line:#dde0e4; --card:#f5f6f8; --agent:#eef4ff; --acc:#2563eb; --on:#2563eb; --onfg:#fff; }
@media (prefers-color-scheme: dark) { :root { --bg:#16181c; --fg:#e6e8eb; --dim:#9aa1aa; --line:#30343a; --card:#1f2228; --agent:#1c2636; --acc:#7aa7ff; --on:#3b6fe0; --onfg:#fff; } }
* { box-sizing: border-box; }
body { margin:0 auto; max-width:640px; padding:12px 12px 96px; background:var(--bg); color:var(--fg); font:16px/1.45 system-ui, -apple-system, sans-serif; }
a { color:var(--acc); }
header { display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
header a { margin-right:6px; } header a.on { font-weight:700; text-decoration:none; color:var(--fg); }
.dim { color:var(--dim); font-size:13px; }
.how { font-size:14px; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin:0 0 10px; }
.meta { margin:6px 0; }
ol.msgs { list-style:none; padding:0; margin:6px 0; }
ol.msgs li { border:1px solid var(--line); border-radius:8px; padding:6px 9px; margin:6px 0; background:var(--card); }
ol.msgs li.agent { background:var(--agent); }
.t { white-space:pre-wrap; overflow-wrap:anywhere; font-size:15px; }
details > summary { cursor:pointer; color:var(--dim); font-size:14px; padding:4px 0; }
ul.ck { padding-left:4px; list-style:none; font-size:14px; }
.draft { border:2px solid var(--acc); border-radius:8px; padding:8px 10px; margin:12px 0; }
.draft strong { display:block; white-space:pre-wrap; overflow-wrap:anywhere; font-size:17px; }
.q { margin:10px 0 6px; font-weight:600; }
.togs { display:flex; flex-wrap:wrap; gap:8px; }
.tog { font:inherit; min-height:44px; padding:8px 14px; border-radius:22px; border:1px solid var(--line); background:var(--card); color:var(--fg); }
.tog[aria-pressed="true"] { background:var(--on); color:var(--onfg); border-color:var(--on); }
.tog.none { font-style:italic; }
nav { position:fixed; left:0; right:0; bottom:0; display:flex; justify-content:space-between; gap:8px; padding:10px 12px; background:var(--bg); border-top:1px solid var(--line); max-width:640px; margin:0 auto; }
.btn { display:inline-flex; align-items:center; min-height:44px; padding:0 14px; border-radius:8px; border:1px solid var(--line); text-decoration:none; color:var(--fg); }
.btn.primary { background:var(--acc); color:#fff; border-color:var(--acc); font-weight:600; }
.saved { color:#16a34a; font-size:14px; } .err { color:#dc2626; font-size:14px; }
</style></head><body>${body}</body></html>`;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** The items of a sender (all without a filter). */
function listFor(sender: string | undefined): Item[] {
  return sender ? items().filter((i) => i.sender === sender) : items();
}

/** The first unlabelled item after `from` (wrapping round), else undefined. */
function nextUnlabelled(list: Item[], from: Item | undefined): Item | undefined {
  const labels = latestLabels();
  const start = from ? list.indexOf(from) + 1 : 0;
  return [...list.slice(start), ...list.slice(0, start)].find((i) => !labels.has(i.id));
}

/** labels.json: the latest labels per item, also written next to labels.jsonl. */
function exportLabels(): Response {
  const latest = latestLabels();
  const out = {
    exportedAt: new Date().toISOString(),
    count: latest.size,
    labels: Object.fromEntries([...latest].map(([id, l]) => [id, { labels: l.labels, ...(l.cannotJudge ? { cannotJudge: true } : {}), by: l.by, at: l.at }])),
  };
  const text = JSON.stringify(out, null, 2) + "\n";
  writeFileSync(LABELS_EXPORT, text);
  return new Response(text, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export function handle(req: Request): Response {
  const url = new URL(req.url);
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("GET only", { status: 405 });
  const sender = url.searchParams.get("sender") || undefined;
  const list = listFor(sender);
  const byId = (id: string | null) => (id ? items().find((i) => i.id === id) : undefined);
  if (url.pathname === "/labels.json") return exportLabels();
  if (url.pathname === "/save") {
    const item = byId(url.searchParams.get("item"));
    if (!item) return html(page(undefined, list, sender, `<p class="err">Unknown item.</p>`), 404);
    const raw = (url.searchParams.get("labels") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const cannotJudge = url.searchParams.get("cannotJudge") === "1";
    const none = raw.includes("none");
    const unknown = raw.filter((id) => id !== "none" && !item.body.agents.includes(id));
    if ((raw.length === 0 && !cannotJudge) || unknown.length > 0 || (none && raw.length > 1) || (cannotJudge && raw.length > 0)) {
      const why =
        raw.length === 0 && !cannotJudge
          ? "nothing picked"
          : unknown.length > 0
            ? `not an agent of this room: ${unknown.join(", ")}`
            : cannotJudge
              ? "can’t judge goes alone"
              : "none goes alone";
      return html(page(item, list, sender, `<p class="err">Not saved: ${escapeHtml(why)}.</p>`), 400);
    }
    const by = sender ? { by: sender } : {};
    if (req.method === "GET") {
      appendJsonl(LABELS_FILE, cannotJudge ? { item: item.id, labels: [], cannotJudge: true, ...by, at: Date.now() } : { item: item.id, labels: none ? [] : raw, ...by, at: Date.now() });
    }
    const answer = cannotJudge ? "can’t judge" : none ? "none" : raw.map((id) => `@${escapeHtml(id)}`).join(", ");
    const saved = `<p class="saved">Saved ${escapeHtml(item.id)}: ${answer}.</p>`;
    // Next: the first unlabelled one after it; when all are labelled (a second pass), simply the next one.
    return html(page(nextUnlabelled(list, item) ?? list[list.indexOf(item) + 1], list, sender, saved));
  }
  if (url.pathname === "/") {
    const asked = byId(url.searchParams.get("item"));
    if (url.searchParams.get("item") && !asked) return html(page(undefined, list, sender, `<p class="err">Unknown item.</p>`), 404);
    return html(page(asked ?? nextUnlabelled(list, undefined), list, sender));
  }
  return new Response("Not found", { status: 404 });
}

if (import.meta.main) {
  ensureEvalDir();
  items();
  Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: handle });
  console.log(`labelling page on http://127.0.0.1:${PORT}/ (${items().length} items, labels in ${LABELS_FILE})`);
}
