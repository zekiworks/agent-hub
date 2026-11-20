// Shared bits of the "Ask @agent" comparison (Ümit #13030): where the private data lives and the shapes of its files.
// Messages, labels and results stay on this machine under ~/.agent-bus/ask-eval, never in the repo.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BoxRecipientBody } from "@agent-bus/protocol";

export const EVAL_DIR = process.env.ASK_EVAL_DIR ?? join(homedir(), ".agent-bus", "ask-eval");
export const ITEMS_FILE = join(EVAL_DIR, "items.jsonl");
export const LABELS_FILE = join(EVAL_DIR, "labels.jsonl");
export const LABELS_EXPORT = join(EVAL_DIR, "labels.json");

export type Split = "test" | "dev";
export type Lang = "en" | "tr";

/** One sampled message: the body the bus would have sent the extension just before it was written. */
export interface Item {
  id: string;
  split: Split;
  seq: number;
  sender: string;
  /** The room's name (its id is body.conversation.id). */
  room: string;
  createdAt: number;
  lang: Lang;
  body: BoxRecipientBody;
  /**
   * The current rule (wakeList in packages/server/src/messages.ts, a person's message without mention or reply): the
   * author of the latest earlier message by someone else, when that is one of body.agents; else null (silent).
   */
  rule: string | null;
}

/** A label line: the agents the sender would have accepted for this message; [] = none of them. */
export interface LabelLine {
  item: string;
  labels: string[];
  by?: string;
  at: number;
}

/** A model's answer for one item (results JSONL). */
export interface ResultLine {
  item: string;
  model: string;
  /** Top choice at cut-off 0 ("none" → null); null with `error` when the call failed. */
  recipient: string | null;
  confidence: number;
  probabilities: Record<string, number>;
  /** Client wall time of the call (HTTP included). */
  ms: number;
  /** The prompt's tokens and the server's own time, when the server reports them. */
  tokens?: number;
  serverMs?: number;
  error?: string;
}

export function ensureEvalDir(): void {
  if (!existsSync(EVAL_DIR)) mkdirSync(EVAL_DIR, { recursive: true });
  const meta = join(EVAL_DIR, "METADATA");
  if (!existsSync(meta)) {
    writeFileSync(
      meta,
      [
        "who: message-bus (Ask @agent comparison, Ümit #13030)",
        "date: 2026-11-20",
        "why: private data of the comparison: sampled room messages, the senders' labels, model results, the GLiDE venv",
        "when deletable: once the comparison is decided and Can/Ümit agree (ask before deleting labels)",
        "",
      ].join("\n")
    );
  }
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

export function writeJsonl(path: string, rows: readonly unknown[]): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""));
}

export function appendJsonl(path: string, row: unknown): void {
  appendFileSync(path, JSON.stringify(row) + "\n");
}

/** The labels per item, the latest line winning. */
export function latestLabels(path = LABELS_FILE): Map<string, LabelLine> {
  const latest = new Map<string, LabelLine>();
  for (const line of readJsonl<LabelLine>(path)) latest.set(line.item, line);
  return latest;
}

/** A command-line flag: `--name value` or `--name=value`. */
export function flag(name: string, fallback?: string): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === `--${name}`) return args[i + 1];
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return fallback;
}
