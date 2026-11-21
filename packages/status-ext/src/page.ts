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
}

const agent = new URLSearchParams(location.search).get("agent") ?? "";
const panes = document.getElementById("panes")!;
const plain = (text: string): Node[] => [document.createTextNode(text)];
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
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
    panes.replaceChildren(head, ...(data.updates.length === 0 ? [el("p", "note", "No updates yet.")] : data.updates.map(pane)));
  } catch (error) {
    panes.replaceChildren(el("p", "note", `Could not load the updates: ${error instanceof Error ? error.message : String(error)}`));
  }
}

void load();
setInterval(load, 30_000);
