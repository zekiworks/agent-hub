// Routing (#/c/<id>, #/to/<a,b>): the address names the open view.
import { ALL_CONVERSATION_ID } from "@agent-bus/protocol";
import { sortedUnique } from "./format";
import { hooks } from "./hooks";
import type { View } from "./state";

export function viewHash(view: View): string {
  if (view.kind === "conversation") return `#/c/${encodeURIComponent(view.id)}`;
  return view.project !== undefined ? `#/p/${encodeURIComponent(view.project)}` : `#/to/${view.to.join(",")}`;
}

export function parseHash(): View {
  const hash = location.hash;
  const conv = /^#\/c\/(.+?)(?:\/t\/\d+)?$/.exec(hash);
  if (conv?.[1]) return { kind: "conversation", id: decodeURIComponent(conv[1]) };
  const project = /^#\/p\/(.+)$/.exec(hash);
  if (project?.[1]) return { kind: "draft", to: [], project: decodeURIComponent(project[1]) };
  const draft = /^#\/to\/(.+)$/.exec(hash);
  if (draft?.[1]) {
    const to = sortedUnique(decodeURIComponent(draft[1]).split(",").map((s) => s.trim()).filter(Boolean));
    if (to.length > 0) return { kind: "draft", to };
  }
  return { kind: "conversation", id: ALL_CONVERSATION_ID };
}

/** A thread's root in the address (#/c/<room>/t/<n>; threads.ts), or undefined. */
export function parseThread(): number | undefined {
  const n = Number(/^#\/c\/.+\/t\/(\d+)$/.exec(location.hash)?.[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** The address of thread `root` of conversation `id`. */
export function threadHash(id: string, root: number): string {
  return `#/c/${encodeURIComponent(id)}/t/${root}`;
}

export function navigate(view: View): void {
  const hash = viewHash(view);
  if (location.hash === hash) hooks.applyView(view);
  else location.hash = hash;
}
