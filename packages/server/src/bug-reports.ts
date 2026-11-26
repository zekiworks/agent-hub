// POST /api/bug-reports: the website's crash reports and people's "Report a problem" (Ümit #17132, #17141). Each one is
// logged, and with `serve --bug-reports-to AGENT` it also goes to that agent as a direct message from the person, so the
// agent that maintains the Hub hears about every crash and bug without being asked.
import type { PostMessageResponse } from "@agent-bus/protocol";
import type { BusContext } from "./context";
import { HttpError, readJsonObject } from "./http";
import { postMessage } from "./messages";

const KINDS = { crash: "Crash", ended: "Page ended unexpectedly", freeze: "Page froze", report: "Problem report" } as const;
type Kind = keyof typeof KINDS;
const PER_HOUR = 20;
const recent = new Map<string, number[]>();

const clip = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

export async function postBugReport(ctx: BusContext, req: Request, human: string, agent: string | undefined): Promise<{ sent: boolean; seq?: number }> {
  const body = await readJsonObject(req);
  const kind = typeof body.kind === "string" && body.kind in KINDS ? (body.kind as Kind) : undefined;
  if (!kind) throw new HttpError(400, `kind must be one of ${Object.keys(KINDS).join(", ")}`);
  const text = clip(body.text, 2000).trim();
  if (!text) throw new HttpError(400, "text must say what happened");
  const now = Date.now();
  const times = (recent.get(human) ?? []).filter((at) => now - at < 3600_000);
  if (times.length >= PER_HOUR) throw new HttpError(429, "Too many reports from this person in the last hour");
  recent.set(human, [...times, now]);

  const details = [
    `view: ${clip(body.where, 300) || "?"}`,
    `device: ${clip(body.device, 300) || "?"}${body.standalone === true ? " (Home Screen app)" : ""}`,
    clip(body.stack, 4000),
  ].filter(Boolean).join("\n");
  console.error(`[bug-report] @${human} ${kind}: ${text}\n${details}`);
  if (!agent || !ctx.hub.knownParticipant(agent)) return { sent: false };

  const message = `🐞 ${KINDS[kind]} from the website\n\n${text}\n\n\`\`\`\n${details}\n\`\`\``;
  // The person's own message: the same sign-in, so it is checked and delivered like anything they write.
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const name of ["authorization", "cookie"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const forward = new Request(req.url, { method: "POST", headers, body: JSON.stringify({ from: human, to: `@${agent}`, text: message }) });
  const posted: PostMessageResponse = await postMessage(ctx, forward);
  return { sent: true, seq: posted.message.seq };
}
