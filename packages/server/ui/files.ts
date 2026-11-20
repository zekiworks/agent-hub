// Two right-pane extensions: File, the viewer for an opened attachment (markdown, plain text, images), and Shared,
// every file shared in the open conversation (GET /api/conversations/:id/files), newest first, with the selected
// one shown under the list.
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

/**
 * A view of `file`: a head (name, size, Download and the `extra` buttons) over its content, loaded now. Each view loads
 * into its own element, so one replaced before its file arrives is simply left behind.
 */
function fileView(file: FileRef, ...extra: HTMLElement[]): HTMLElement {
  const url = fileUrl(file.id);
  const download = h("a", "link-btn doc-download", "Download");
  download.href = url;
  download.download = file.name;
  download.title = "Download the file";
  const title = h("span", "doc-title", `${file.name} · ${formatBytes(file.size)}`);
  title.title = file.name;
  const content = h("div", "doc-body msg-text");
  // Reachable from the keyboard (Enter in the Shared list), so arrows then scroll the file.
  content.tabIndex = -1;
  const head = h("div", "doc-head");
  head.append(title, download, ...extra);
  const element = h("div", "doc-view");
  element.append(head, content);

  const kind = viewKind(file);
  if (!kind || file.size > MAX_VIEW_BYTES) {
    content.append(h("p", "doc-note", `Not shown here (${formatBytes(file.size)}${kind ? ", too large" : ""}); use Download.`));
    return element;
  }
  if (kind === "image") {
    const img = h("img", "doc-image");
    img.src = url;
    img.alt = file.name;
    content.append(img);
    return element;
  }
  content.append(h("p", "doc-note", "Loading…"));
  void (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      content.replaceChildren(...(kind === "markdown" ? renderMarkdown(text, mentionNodes) : [h("pre", "doc-text", text)]));
      content.scrollTop = 0;
    } catch (error) {
      content.replaceChildren(h("p", "doc-note", `Could not load ${file.name}: ${errorText(error)}`));
    }
  })();
  return element;
}

/** Opens `file` in the pane's File tab. */
export function openFile(file: FileRef): void {
  const close = h("button", "link-btn", "Close file");
  close.type = "button";
  close.addEventListener("click", () => {
    opened = undefined;
    refreshPane("file");
  });
  opened = { file, element: fileView(file, close) };
  openPane("file");
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

/** The file selected in each conversation's Shared list (its id), and the preview last built (kept: no reload on redraw). */
const chosen = new Map<string, string>();
let preview: { id: string; element: HTMLElement } | undefined;

function sharedRow(item: SharedFile, select: () => void): HTMLLIElement {
  const { file } = item;
  const kind = viewKind(file);
  const li = h("li", "shared-file");
  li.setAttribute("role", "option");
  const name = h("a", "shared-name", `${kind === "image" ? "🖼" : kind ? "📄" : "⬇"} ${file.name}`);
  name.href = fileUrl(file.id);
  name.download = file.name;
  name.tabIndex = -1;
  name.title = `Show ${file.name} below (Ctrl/⌘+click downloads)`;
  name.addEventListener("click", (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
  });
  const at = h("button", "link-btn shared-at", `#${item.seq}`);
  at.type = "button";
  at.tabIndex = -1;
  at.title = "Show the message that shared it";
  at.addEventListener("click", (event) => {
    event.stopPropagation();
    void hooks.showMessage(item.seq);
  });
  li.addEventListener("click", (event) => {
    if ((event.ctrlKey || event.metaKey || event.shiftKey) && (event.target as Element).closest("a")) return;
    select();
  });
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
    // A list with one selected file, shown below it; the list holds the keyboard: ↑ ↓ move, Home End go to the first and
    // last, Enter goes into the file (Can #13619, codex-ui #13620). Other keys and the file's own scrolling are untouched.
    const list = h("ul", "shared-list");
    list.tabIndex = 0;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Shared files: ↑ ↓ to move, Enter to read the file");
    const shown = h("div", "shared-preview");
    const conversationId = view.id;
    const rows = files.map((item, i) =>
      sharedRow(item, () => {
        select(i);
        // A click on a row's empty part gives the list the keyboard too (not every browser does that by itself).
        list.focus({ preventScroll: true });
      })
    );
    const select = (i: number) => {
      const item = files[i];
      if (!item) return;
      chosen.set(conversationId, item.file.id);
      rows.forEach((row, j) => {
        row.classList.toggle("selected", j === i);
        row.setAttribute("aria-selected", String(j === i));
      });
      list.setAttribute("aria-activedescendant", (rows[i]!.id = `shared-${item.file.id}`));
      if (preview?.id !== item.file.id) {
        // The message that shared it, reachable from the keyboard here (the rows' #n are not: the list holds the arrows;
        // codex-ui #13626).
        const source = h("button", "link-btn doc-download", `#${item.seq}`);
        source.type = "button";
        source.title = "Show the message that shared it";
        source.addEventListener("click", () => void hooks.showMessage(item.seq));
        preview = { id: item.file.id, element: fileView(item.file, source) };
      }
      shown.replaceChildren(preview.element);
      rows[i]!.scrollIntoView({ block: "nearest" });
    };
    list.addEventListener("keydown", (event) => {
      const at = Math.max(0, files.findIndex((f) => f.file.id === chosen.get(conversationId)));
      const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: files.length - 1 }[event.key];
      if (to !== undefined) {
        event.preventDefault();
        select(Math.min(files.length - 1, Math.max(0, to)));
      } else if (event.key === "Enter") {
        event.preventDefault();
        shown.querySelector<HTMLElement>(".doc-body")?.focus();
      }
    });
    list.append(...rows);
    const root = h("div", "shared-pane");
    root.append(list, shown);
    body.replaceChildren(root);
    const at = files.findIndex((f) => f.file.id === chosen.get(conversationId));
    select(at >= 0 ? at : 0);
  },
});
