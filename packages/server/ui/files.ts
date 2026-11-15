// Two right-pane extensions: File, the viewer for an opened attachment (markdown, plain text, images), and Shared,
// every file shared in the open conversation (GET /api/conversations/:id/files), newest first.
import { formatBytes, type FileRef, type Message, type SharedFile, type SharedFilesResponse } from "@agent-bus/protocol";
import { api, fileUrl } from "./api";
import { errorText, relativeTime } from "./format";
import { hooks } from "./hooks";
import { h } from "./html";
import { renderMarkdown } from "./markdown";
import { openPane, refreshPane, registerExtension } from "./pane";
import { mentionNodes } from "./text";

/** Larger files are offered as a download only. */
const MAX_VIEW_BYTES = 2 * 1024 * 1024;

type ViewKind = "markdown" | "text" | "image";

/** How the viewer shows `file`, or undefined if it only downloads. */
export function viewKind(file: FileRef): ViewKind | undefined {
  if (file.mimeType === "text/markdown" || /\.(md|markdown)$/i.test(file.name)) return "markdown";
  if (file.mimeType.startsWith("image/")) return "image";
  if (file.mimeType.startsWith("text/") || file.mimeType === "application/json" || /\.(txt|log|json|jsonl|csv|tsv|ya?ml|toml)$/i.test(file.name)) {
    return "text";
  }
  return undefined;
}

// ---- File: the viewer ----

/** The file open in the viewer, and its content element (kept, so switching tabs keeps its scroll position). */
let opened: { file: FileRef; element: HTMLElement } | undefined;
let request = 0;

/** Opens `file` in the pane's File tab. */
export function openFile(file: FileRef): void {
  const url = fileUrl(file.id);
  const mine = ++request;
  const download = h("a", "link-btn doc-download", "Download");
  download.href = url;
  download.download = file.name;
  download.title = "Download the file";
  const close = h("button", "link-btn", "Close file");
  close.type = "button";
  close.addEventListener("click", () => {
    request++;
    opened = undefined;
    refreshPane("file");
  });
  const title = h("span", "doc-title", `${file.name} · ${formatBytes(file.size)}`);
  title.title = file.name;
  const content = h("div", "doc-body msg-text");
  const head = h("div", "doc-head");
  head.append(title, download, close);
  const element = h("div", "doc-view");
  element.append(head, content);
  opened = { file, element };
  openPane("file");

  const kind = viewKind(file);
  if (!kind || file.size > MAX_VIEW_BYTES) {
    content.append(h("p", "doc-note", `Not shown here (${formatBytes(file.size)}${kind ? ", too large" : ""}); use Download.`));
    return;
  }
  if (kind === "image") {
    const img = h("img", "doc-image");
    img.src = url;
    img.alt = file.name;
    content.append(img);
    return;
  }
  content.append(h("p", "doc-note", "Loading…"));
  void (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (mine !== request) return;
      content.replaceChildren(...(kind === "markdown" ? renderMarkdown(text, mentionNodes) : [h("pre", "doc-text", text)]));
      content.scrollTop = 0;
    } catch (error) {
      if (mine !== request) return;
      content.replaceChildren(h("p", "doc-note", `Could not load ${file.name}: ${errorText(error)}`));
    }
  })();
}

registerExtension({
  id: "file",
  order: 10,
  title: () => "File",
  applies: () => opened !== undefined,
  render: (body) => {
    if (opened && opened.element.parentElement !== body) body.replaceChildren(opened.element);
  },
});

// ---- Shared: the files of the open conversation ----

/** Lists per conversation (no entry: not asked yet; neither files nor error: loading, as request `load`). */
const lists = new Map<string, { load: number; files?: SharedFile[]; error?: string }>();
let loads = 0;

/** A message with files arrived in `conversationId`: its list is fetched again when shown. */
export function sharedFilesChanged(conversationId: string): void {
  lists.delete(conversationId);
  refreshPane("shared");
}

/**
 * Messages of `conversationId` were loaded: if one shares a file newer than the list (it came in with the page's first
 * load, not over the live connection), the list is fetched again.
 */
export function sharedFilesLoaded(conversationId: string, messages: readonly Message[]): void {
  const files = lists.get(conversationId)?.files;
  if (!files) return;
  const newest = files[0]?.seq ?? 0;
  const shared = (m: Message) => m.files.some((f) => !(f.mimeType.startsWith("audio/") && f.name.startsWith("voice-")));
  if (messages.some((m) => m.seq > newest && shared(m))) sharedFilesChanged(conversationId);
}

async function load(conversationId: string): Promise<void> {
  const mine = ++loads;
  lists.set(conversationId, { load: mine });
  let result: { files?: SharedFile[]; error?: string };
  try {
    result = { files: (await api<SharedFilesResponse>(`/api/conversations/${encodeURIComponent(conversationId)}/files`)).files };
  } catch (error) {
    result = { error: errorText(error) };
  }
  // A newer load (a file arrived meanwhile) wins, whichever answer comes back first.
  if (lists.get(conversationId)?.load !== mine) return;
  lists.set(conversationId, { load: mine, ...result });
  refreshPane("shared");
}

function sharedRow(item: SharedFile): HTMLLIElement {
  const { file } = item;
  const kind = viewKind(file);
  const li = h("li", "shared-file");
  const name = h("a", "shared-name", `${kind === "image" ? "🖼" : kind ? "📄" : "⬇"} ${file.name}`);
  name.href = fileUrl(file.id);
  name.download = file.name;
  name.title = kind ? `Open ${file.name} here (Ctrl/⌘+click downloads)` : `Download ${file.name}`;
  if (kind) {
    name.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      openFile(file);
    });
  }
  const at = h("button", "link-btn shared-at", `#${item.seq}`);
  at.type = "button";
  at.title = "Show the message that shared it";
  at.addEventListener("click", () => void hooks.showMessage(item.seq));
  li.append(name, h("span", "shared-meta", `${formatBytes(file.size)} · @${item.from} · ${relativeTime(item.createdAt)} · `), at);
  return li;
}

registerExtension({
  id: "shared",
  order: 20,
  title: () => "Shared",
  applies: (view) => view.kind === "conversation",
  render: (body, view) => {
    if (view.kind !== "conversation") return;
    const entry = lists.get(view.id);
    if (!entry) void load(view.id);
    if (!entry || (!entry.files && !entry.error)) {
      body.replaceChildren(h("p", "doc-note pane-pad", "Loading…"));
      return;
    }
    if (entry.error) {
      body.replaceChildren(h("p", "doc-note pane-pad", `Could not load the files: ${entry.error}`));
      return;
    }
    const files = entry.files ?? [];
    if (files.length === 0) {
      body.replaceChildren(h("p", "doc-note pane-pad", "No files shared here yet."));
      return;
    }
    const list = h("ul", "shared-list");
    list.append(...files.map(sharedRow));
    body.replaceChildren(list);
  },
});
