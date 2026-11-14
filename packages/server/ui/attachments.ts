// Attachments of a message: download links, image previews with a viewer, markdown and text files in the right pane.
import { formatBytes, type FileRef } from "@agent-bus/protocol";
import { fileUrl } from "./api";
import { dom, scrollToBottom } from "./dom";
import { h } from "./html";
import { openFile, viewKind } from "./files";

export function renderFile(file: FileRef): HTMLLIElement {
  const url = fileUrl(file.id);
  const li = h("li", "msg-file");
  // Voice messages (and other audio): a player, not a file to download.
  if (file.mimeType.startsWith("audio/")) {
    li.classList.add("msg-audio");
    const audio = h("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = url;
    audio.title = file.name;
    li.append(audio);
    return li;
  }
  const row = h("span", "file-row");
  const link = h("a", "file-link");
  link.href = url;
  link.download = file.name;
  link.title = `${file.mimeType}\nsha256 ${file.sha256}`;
  // Markdown and plain text open in the right pane's File tab (images have their own viewer below).
  const kind = viewKind(file);
  if (kind === "markdown" || kind === "text") {
    link.title = `Open ${file.name} on the right (Ctrl/⌘+click downloads)\nsha256 ${file.sha256}`;
    link.append(h("span", "file-icon", "📄"), h("span", "file-name", file.name));
    link.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      openFile(file);
    });
  } else {
    link.append(h("span", "file-icon", "⬇"), h("span", "file-name", file.name));
  }
  row.append(link, h("span", "file-size", formatBytes(file.size)));
  if (file.mimeType.startsWith("image/")) {
    li.classList.add("msg-image");
    const preview = h("button", "image-preview");
    preview.type = "button";
    preview.title = "Click to view full size";
    const img = h("img");
    img.src = url;
    img.alt = file.name;
    img.loading = "lazy";
    // Keep the view pinned to the bottom when a preview loading late makes the list taller.
    img.addEventListener("load", () => {
      const s = dom.messageScroll;
      if (s.scrollHeight - s.scrollTop - s.clientHeight < img.offsetHeight + 80) scrollToBottom();
    });
    // Formats the browser cannot show (e.g. HEIC) stay a plain download.
    img.addEventListener("error", () => {
      preview.remove();
      li.classList.remove("msg-image");
    });
    preview.append(img);
    previewFiles.set(preview, { file, url });
    // The viewer steps through this message's images (those still previewed: unrenderable ones are gone).
    preview.addEventListener("click", () => {
      const all = [...(preview.closest(".msg")?.querySelectorAll<HTMLElement>(".image-preview") ?? [preview])];
      openLightbox(all.flatMap((p) => previewFiles.get(p) ?? []), Math.max(0, all.indexOf(preview)));
    });
    li.append(preview);
  }
  li.append(row);
  return li;
}

/** File behind each image preview, for the viewer. */
const previewFiles = new WeakMap<HTMLElement, { file: FileRef; url: string }>();

/** The images the viewer steps through with ← and → (one message's), and the one shown. */
let lightboxImages: Array<{ file: FileRef; url: string }> = [];
let lightboxIndex = 0;

function openLightbox(images: Array<{ file: FileRef; url: string }>, index: number): void {
  lightboxImages = images;
  showLightboxImage(index);
  if (!dom.lightbox.open) dom.lightbox.showModal();
}

function showLightboxImage(index: number): void {
  const image = lightboxImages[index];
  if (!image) return;
  lightboxIndex = index;
  const { file, url } = image;
  dom.lightboxImg.src = url;
  dom.lightboxImg.alt = file.name;
  const position = lightboxImages.length > 1 ? `${index + 1} / ${lightboxImages.length} · ` : "";
  dom.lightboxName.textContent = `${position}${file.name} · ${formatBytes(file.size)}`;
  dom.lightboxDownload.href = url;
  dom.lightboxDownload.download = file.name;
  dom.lightboxHint.textContent = lightboxImages.length > 1 ? "← → for the others · click or Esc to close" : "click or Esc to close";
}

dom.lightbox.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    showLightboxImage(lightboxIndex + (event.key === "ArrowRight" ? 1 : -1));
  }
});

// Any click closes it, except on the download link.
dom.lightbox.addEventListener("click", (event) => {
  if (event.target !== dom.lightboxDownload) dom.lightbox.close();
});
dom.lightbox.addEventListener("close", () => {
  dom.lightboxImg.removeAttribute("src");
  lightboxImages = [];
});
