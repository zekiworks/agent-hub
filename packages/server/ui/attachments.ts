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
      openLightbox(all.flatMap((p) => previewFiles.get(p) ?? []), Math.max(0, all.indexOf(preview)), preview);
    });
    li.append(preview);
  }
  li.append(row);
  return li;
}

/** File behind each image preview, for the viewer. */
const previewFiles = new WeakMap<HTMLElement, { file: FileRef; url: string }>();

/** The images the viewer steps through (one message's, in attachment order), the one shown, and the preview it was
 * opened from: focus goes back there on close (codex-ui #10847; Safari does not focus a clicked button by itself). */
let lightboxImages: Array<{ file: FileRef; url: string }> = [];
let lightboxIndex = 0;
let lightboxOpener: HTMLElement | undefined;

function openLightbox(images: Array<{ file: FileRef; url: string }>, index: number, opener: HTMLElement): void {
  lightboxImages = images;
  lightboxOpener = opener;
  showLightboxImage(index);
  if (!dom.lightbox.open) dom.lightbox.showModal();
}

function showLightboxImage(index: number): void {
  const image = lightboxImages[index];
  if (!image) return;
  lightboxIndex = index;
  const { file, url } = image;
  const several = lightboxImages.length > 1;
  dom.lightboxImg.src = url;
  dom.lightboxImg.alt = file.name;
  const position = several ? `${index + 1} of ${lightboxImages.length} · ` : "";
  dom.lightboxName.textContent = `${position}${file.name} · ${formatBytes(file.size)}`;
  dom.lightboxDownload.href = url;
  dom.lightboxDownload.download = file.name;
  // Previous / Next for this message's images (Can #10845): disabled at the ends, never on to another message.
  dom.lightboxPrev.hidden = dom.lightboxNext.hidden = !several;
  // A focused button that turns off drops the focus out of the viewer (at once, as it is disabled): the other one takes it.
  const focused = document.activeElement;
  dom.lightboxPrev.disabled = index === 0;
  dom.lightboxNext.disabled = index === lightboxImages.length - 1;
  if (focused === dom.lightboxPrev && dom.lightboxPrev.disabled) dom.lightboxNext.focus();
  if (focused === dom.lightboxNext && dom.lightboxNext.disabled) dom.lightboxPrev.focus();
  dom.lightboxHint.textContent = several ? "← → for the others · click or Esc to close" : "click or Esc to close";
}

// While the viewer is open the arrows are its own (it is modal: no text field can have the focus then); listened for
// on the document, as the focus may have left the dialog's buttons.
document.addEventListener("keydown", (event) => {
  if (!dom.lightbox.open || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
  event.preventDefault();
  showLightboxImage(lightboxIndex + (event.key === "ArrowRight" ? 1 : -1));
});

for (const [button, step] of [
  [dom.lightboxPrev, -1],
  [dom.lightboxNext, 1],
] as const) {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    showLightboxImage(lightboxIndex + step);
  });
}

// Any other click closes it, except on the download link.
dom.lightbox.addEventListener("click", (event) => {
  if (event.target !== dom.lightboxDownload) dom.lightbox.close();
});
dom.lightbox.addEventListener("close", () => {
  dom.lightboxImg.removeAttribute("src");
  lightboxImages = [];
  if (lightboxOpener?.isConnected) lightboxOpener.focus();
  lightboxOpener = undefined;
});
