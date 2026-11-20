// "Ask @agent" in use (Ümit #13224): counts the bus's record of the add-on, box-reports.jsonl in its data folder (one
// line per message a person sent in a room with the add-on on; never the text).
//   bun packages/ask-ext/eval/usage.ts [--file ~/.agent-bus/box-reports.jsonl] [--since 2026-11-20]
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { flag, readJsonl } from "./common";

interface ReportLine {
  at: string;
  box: string;
  person: string;
  conversationId: string;
  outcome: "taken" | "ignored" | "named-other" | "named" | "quiet" | "reply";
  recipient?: string;
  confidence?: number;
  ms?: number;
  failed?: true;
}

const OUTCOMES = ["taken", "ignored", "named-other", "named", "quiet", "reply"] as const;

export function usageReport(lines: readonly ReportLine[]): string {
  if (lines.length === 0) return "No messages sent with Ask @agent on yet.";
  const out: string[] = [];
  const people = [...new Set(lines.map((l) => l.person))].sort();
  out.push(`${lines.length} messages sent with Ask @agent on, ${lines[0]!.at.slice(0, 16)} … ${lines.at(-1)!.at.slice(0, 16)} UTC`, "");
  out.push(`| who | ${OUTCOMES.join(" | ")} | offered | taken of offered |`, `|${"---|".repeat(OUTCOMES.length + 3)}`);
  for (const who of [...people, "all"]) {
    const mine = who === "all" ? lines : lines.filter((l) => l.person === who);
    const n = (o: string) => mine.filter((l) => l.outcome === o).length;
    const offered = n("taken") + n("ignored") + n("named-other");
    const share = offered ? `${Math.round((100 * n("taken")) / offered)}%` : "–";
    out.push(`| ${who} | ${OUTCOMES.map(n).join(" | ")} | ${offered} | ${share} |`);
  }
  const ms = lines.map((l) => l.ms).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
  const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
  out.push("");
  if (ms.length > 0) out.push(`Answer time in the page: median ${at(0.5)} ms, p90 ${at(0.9)} ms (${ms.length} answers).`);
  const failed = lines.filter((l) => l.failed).length;
  out.push(`Asking failed before ${failed} of ${lines.length} messages.`);
  out.push(
    "",
    "taken: sent with the offered agent · ignored: offered, sent naming nobody · named-other: offered, someone else named · " +
      "named: nothing offered, someone named · quiet: nothing offered, nobody named · reply: a Reply or checklist answer"
  );
  return out.join("\n");
}

if (import.meta.main) {
  const file = flag("file") ?? join(homedir(), ".agent-bus", "box-reports.jsonl");
  const since = flag("since") ?? "";
  const lines = existsSync(file) ? readJsonl<ReportLine>(file).filter((l) => l.at >= since) : [];
  console.log(usageReport(lines));
}
