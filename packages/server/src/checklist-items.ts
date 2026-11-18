// A checklist's items and their markdown: the markdown is derived from the items for
// the writers and readers from before items had ids, and parsed when such a writer replaces the list (PUT) or when an
// old stored list is migrated (db.ts). No text is lost either way: the `# title`, the lines before the first item
// (`intro`) and the lines under an item (its `detail`) are kept.
import type { ChecklistItem } from "@agent-bus/protocol";

/** One item line of checklist markdown, with the heading above it and the lines under it. */
export interface MarkdownItem {
  heading?: string;
  text: string;
  done: boolean;
  detail?: string;
}

/** Checklist markdown, parsed. */
export interface ParsedChecklist {
  title?: string;
  intro?: string;
  items: MarkdownItem[];
}

/** Lines without the blank ones at either end and without their common indentation; undefined when none are left. */
function block(lines: string[]): string | undefined {
  while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
  if (lines.length === 0) return undefined;
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)?.[0].length ?? 0));
  return lines.map((l) => l.slice(Math.min(indent, /^\s*/.exec(l)?.[0].length ?? 0)).trimEnd()).join("\n");
}

/**
 * The parts of checklist markdown: a `# title` line before any item or `##` heading; the plain lines before the first
 * item (`intro`); `- [ ] …` / `- [x] …` items under `#…` headings, each with the plain lines under it (`detail`, until
 * the next item or heading).
 */
export function parseChecklistMarkdown(text: string): ParsedChecklist {
  const items: MarkdownItem[] = [];
  const intro: string[] = [];
  const details: string[][] = [];
  let title: string | undefined;
  let heading: string | undefined;
  let seenHeading = false;
  for (const line of text.split("\n")) {
    const top = /^#\s+(.+)$/.exec(line);
    if (top?.[1] && title === undefined && !seenHeading && items.length === 0) {
      title = top[1].trim();
      continue;
    }
    const sub = /^\s*#{1,6}\s+(.+)$/.exec(line);
    if (sub?.[1]) {
      heading = sub[1].trim();
      seenHeading = true;
      continue;
    }
    const item = /^\s*[-*] \[([ xX])\] (.+)$/.exec(line);
    if (item?.[2]) {
      items.push({ ...(heading ? { heading } : {}), text: item[2].trim(), done: item[1] !== " " });
      details.push([]);
      continue;
    }
    // A plain line: the detail of the item above it, else the intro.
    (details[details.length - 1] ?? intro).push(line);
  }
  items.forEach((item, i) => {
    const detail = block(details[i] ?? []);
    if (detail) item.detail = detail;
  });
  const introText = block(intro);
  return { ...(title ? { title } : {}), ...(introText ? { intro: introText } : {}), items };
}

/** The list as markdown: `# title`, the intro, then `## heading` before each run of items under it, `- [x] text` per item with its detail indented under it. */
export function checklistMarkdown(list: { title?: string; intro?: string; items: readonly ChecklistItem[] }): string {
  const lines: string[] = [];
  if (list.title) lines.push(`# ${list.title}`);
  if (list.intro) lines.push(...(lines.length > 0 ? [""] : []), list.intro);
  let heading: string | undefined;
  for (const item of list.items) {
    if (item.heading !== heading) {
      if (item.heading) lines.push(...(lines.length > 0 ? [""] : []), `## ${item.heading}`);
      heading = item.heading;
    }
    lines.push(`- [${item.done ? "x" : " "}] ${item.text}`);
    if (item.detail) lines.push(...item.detail.split("\n").map((l) => (l ? `  ${l}` : "")));
  }
  return lines.join("\n");
}

/** Item text → its done state, as the markdown's writers read ticks back. */
export function checklistTicks(items: readonly ChecklistItem[]): Record<string, { by: string; at: number }> {
  return Object.fromEntries(items.flatMap((item) => (item.done ? [[item.text, item.done]] : [])));
}

/** The id of a list's `n`th item ever made (ids are never reused). */
export function checklistItemId(n: number): string {
  return `i${n}`;
}
