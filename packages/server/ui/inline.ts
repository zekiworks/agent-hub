// `/inline{#n}` in a message's text (Can #14170): the message's n-th attachment shown at that place. An image there at
// its own size, or shrunk to the column when larger, and not opened in the image viewer; a Markdown file rendered in a
// bounded, scrolling section. `/inline` alone is `/inline{#1}`. Inlined files leave the list of attachments under the
// message; anything else, or a number with no attachment, stays as written.
import type { FileRef } from "@agent-bus/protocol";
import { fileUrl } from "./api";
import { errorText } from "./format";
import { h } from "./html";
import { renderMarkdown } from "./markdown";
import { viewKind } from "./files";
import { mentionNodes } from "./text";

const INLINE = /\/inline(?:\{#(\d+)\})?/g;
/** Where an attachment goes, while the text is rendered: private-use marks no markdown, mention or #n link touches. */
const MARK = /\uE000(\d+)\uE001/g;

function inlineKind(file: FileRef): "image" | "markdown" | undefined {
  const kind = viewKind(file);
  return kind === "image" || kind === "markdown" ? kind : undefined;
}

/** The attachments `text` inlines (1-based numbers that exist and can be shown inline). */
export function inlinedFiles(text: string, files: FileRef[]): Set<FileRef> {
  const out = new Set<FileRef>();
  for (const m of text.matchAll(INLINE)) {
    const file = files[Number(m[1] ?? 1) - 1];
    if (file && inlineKind(file)) out.add(file);
  }
  return out;
}

/** `text` with each `/inline{#n}` that names a showable attachment turned into a mark (`placeInlined` puts it in). */
export function markInlined(text: string, files: FileRef[]): string {
  return text.replace(INLINE, (all, n?: string) => {
    const file = files[Number(n ?? 1) - 1];
    return file && inlineKind(file) ? `\uE000${n ?? 1}\uE001` : all;
  });
}

function inlined(file: FileRef): HTMLElement {
  if (inlineKind(file) === "image") {
    const img = h("img", "msg-inline-image");
    img.src = fileUrl(file.id);
    img.alt = file.name;
    img.loading = "lazy";
    return img;
  }
  const doc = h("div", "msg-inline-doc msg-text");
  doc.setAttribute("aria-label", file.name);
  doc.append(h("p", "doc-note", "Loading…"));
  void fetch(fileUrl(file.id)).then(
    async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      doc.replaceChildren(...renderMarkdown(await res.text(), mentionNodes));
    },
    (error) => doc.replaceChildren(h("p", "doc-note", `Could not load ${file.name}: ${errorText(error)}`))
  );
  return doc;
}

/** Puts the attachments in place of the marks `markInlined` left in `body`, the rendered text. */
export function placeInlined(body: HTMLElement, files: FileRef[]): void {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.includes("\uE000")) found.push(n as Text);
  for (const node of found) {
    const parts: Node[] = [];
    let last = 0;
    for (const m of node.data.matchAll(MARK)) {
      const file = files[Number(m[1]) - 1];
      parts.push(document.createTextNode(node.data.slice(last, m.index)), file ? inlined(file) : document.createTextNode(m[0]));
      last = (m.index ?? 0) + m[0].length;
    }
    parts.push(document.createTextNode(node.data.slice(last)));
    const block = node.parentElement;
    node.replaceWith(...parts.filter((p) => !(p instanceof Text) || p.data !== ""));
    // A paragraph that held only the mark becomes the attachment itself (a section is no paragraph's content).
    if (block && block !== body && block.parentElement === body && !block.textContent?.trim()) block.replaceWith(...block.childNodes);
  }
}
