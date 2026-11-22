// The Status tab (server.ts): an agent's updates, newest first, each a pane. Markdown drawn with the website's own
// renderer (never as HTML); `/inline{#n}` puts the update's n-th attached image or Markdown file at that place.
import { renderMarkdown } from "../../server/ui/markdown";

interface FileInfo {
  id: string;
  name: string;
  mimeType: string;
}
interface Update {
  seq: number;
  at: number;
  text: string;
  files: FileInfo[];
  /** A NO_UPDATES answer (Can #14270): one small bar, the time of the update before it. */
  noUpdatesSince?: number;
}

const agent = new URLSearchParams(location.search).get("agent") ?? "";
const panes = document.getElementById("panes")!;
/** A plain message reference in an update: open it in the conversation, with ↩ beside it to reply there (Can #15044). */
const plain = (text: string): Node[] => {
  const out: Node[] = [];
  let last = 0;
  // Same boundary as message text's references (server/ui/text.ts): not a URL fragment, ##heading or part of a word.
  for (const match of text.matchAll(/(^|[^\w#&@])#([1-9]\d{0,6})(?![\w-])/g)) {
    const at = (match.index ?? 0) + (match[1]?.length ?? 0);
    if (at > last) out.push(document.createTextNode(text.slice(last, at)));
    const seq = Number(match[2]);
    const wrap = el("span", "message-ref");
    const open = el("a", "message-link", `#${seq}`);
    open.href = `#/m/${seq}`;
    open.title = `Open message #${seq}`;
    open.addEventListener("click", (event) => {
      event.preventDefault();
      messageAction("agent-bus:show-message", seq);
    });
    const reply = el("button", "message-reply", "↩");
    reply.type = "button";
    reply.title = `Reply to message #${seq}`;
    reply.setAttribute("aria-label", `Reply to message #${seq}`);
    reply.addEventListener("click", () => messageAction("agent-bus:reply-message", seq));
    wrap.append(open, reply);
    out.push(wrap);
    last = at + 1 + (match[2]?.length ?? 0);
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
};
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let actionTimer: number | undefined;

/**
 * Home and the outer website are deployed separately. An already-open website can have the old parent script while a
 * newly opened Home has these controls (Can #15049): require an acknowledgement instead of making that mismatch silent.
 */
function messageAction(type: "agent-bus:show-message" | "agent-bus:reply-message", seq: number): void {
  parent.postMessage({ type, seq }, "*");
  if (actionTimer !== undefined) clearTimeout(actionTimer);
  actionTimer = window.setTimeout(() => {
    let notice = document.getElementById("message-action-status");
    if (!notice) {
      notice = el("p", "action-status");
      notice.id = "message-action-status";
      notice.setAttribute("role", "status");
      panes.prepend(notice);
    }
    notice.textContent = "Reload the whole Agent Hub page once to use message links; Home is newer than the open page.";
  }, 500);
}

window.addEventListener("message", (event) => {
  const data = event.data as { type?: unknown } | null;
  if (event.source !== parent || data?.type !== "agent-bus:message-action-accepted") return;
  if (actionTimer !== undefined) clearTimeout(actionTimer);
  actionTimer = undefined;
  document.getElementById("message-action-status")?.remove();
});
const time = (at: number) => new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });

function attachment(file: FileInfo): HTMLElement {
  if (file.mimeType.startsWith("image/")) {
    const img = el("img", "inline-image");
    img.src = `file/${file.id}`;
    img.alt = file.name;
    img.loading = "lazy";
    return img;
  }
  const a = el("a", "file", `📎 ${file.name}`);
  a.href = `file/${file.id}`;
  a.target = "_blank";
  return a;
}

/** The update's text with `/inline{#n}` (or `/inline`) replaced by its n-th attachment; the rest listed below. */
function pane(u: Update): HTMLElement {
  const box = el("article", "pane");
  box.append(el("header", "when", time(u.at)));
  const body = el("div", "body");
  const used = new Set<number>();
  const parts = u.text.split(/(\/inline(?:\{#\d+\})?)/);
  let md = "";
  const flush = () => {
    if (md.trim()) body.append(...renderMarkdown(md, plain));
    md = "";
  };
  for (const part of parts) {
    const m = /^\/inline(?:\{#(\d+)\})?$/.exec(part);
    const file = m ? u.files[Number(m[1] ?? 1) - 1] : undefined;
    if (!m || !file) {
      md += part;
      continue;
    }
    flush();
    used.add(u.files.indexOf(file));
    body.append(attachment(file));
  }
  flush();
  box.append(body);
  const rest = u.files.filter((_, i) => !used.has(i));
  if (rest.length > 0) {
    const list = el("div", "files");
    list.append(...rest.map(attachment));
    box.append(list);
  }
  return box;
}

async function load(): Promise<void> {
  try {
    const res = await fetch(`updates.json?agent=${encodeURIComponent(agent)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { updates: Update[]; asked: number | null; every: number };
    const head = el("p", "note");
    head.textContent = data.asked
      ? `@${agent} is asked for an update every ${Math.round(data.every / 60000)} min; last asked ${time(data.asked)}.`
      : `@${agent} has not been asked yet; the first ask goes out at the top of the hour.`;
    const entry = (u: Update) => (u.noUpdatesSince === undefined ? pane(u) : el("p", "no-updates", `No updates since ${time(u.noUpdatesSince)}`));
    panes.replaceChildren(head, ...(data.updates.length === 0 ? [el("p", "note", "No updates yet.")] : data.updates.map(entry)));
  } catch (error) {
    panes.replaceChildren(el("p", "note", `Could not load the updates: ${error instanceof Error ? error.message : String(error)}`));
  }
}

void load();
setInterval(load, 30_000);
