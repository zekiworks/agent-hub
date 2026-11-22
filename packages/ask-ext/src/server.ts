// The "Ask @agent" box extension (Ümit #13030): while a person types in a room without naming anyone, the bus
// (`serve --ext ask=http://127.0.0.1:7832,box=recipient`) posts a BoxRecipientBody to /recipient; this answers the one
// agent to offer ("Ask @webapp") or null, from one question to a System One decision model (src/decide.ts).
// The same service answers the bus's "needs" box (`--ext needs=http://127.0.0.1:7832,box=needs`, Ümit #14881): POST
// /needs with a BoxNeedsBody asks d1-2B and GLiDE-2B whether an agent's message needs the person (src/needs.ts).
//
//   ASK_PORT=7832 ASK_DECIDE_URL=http://127.0.0.1:9963 ASK_GLIDE_URL=http://127.0.0.1:9966 ASK_MIN_CONFIDENCE=0.5 \
//     bun run packages/ask-ext/src/server.ts
//
// The models: LiquidAI d1-2B (BF16, or Q8_0 on a CPU without BF16) in llama-server, port 9963 (scripts/setup.sh), and
// fastino GLiDE-2B on the CPU, port 9966 (agent-bus-needs-glide.service). GLiDE answers the same API and can stand in
// for d1 through ASK_DECIDE_URL.
import type { BoxRecipientBody, BoxRecipientResponse } from "@agent-bus/protocol";
import { decisionRequest, isRecord, readDecision } from "./decide";
import { isNeedsBody, needsVerdicts, type NeedsModel } from "./needs";

/** How long a suggestion may take: past it the box stays quiet (the person has typed on anyway). */
const TIMEOUT_MS = 3000;

export interface AskConfig {
  /** The System One server's base URL (d1-2B). */
  decideUrl: string;
  /** GLiDE-2B's System One server, asked beside d1 by /needs. */
  glideUrl: string;
  /** Below this probability of its choice, the model's agent is not offered. */
  minConfidence: number;
}

/** The models /needs asks, by the names their verdicts carry. */
export function needsModels(config: AskConfig): NeedsModel[] {
  return [
    { name: "d1", url: config.decideUrl },
    { name: "glide", url: config.glideUrl },
  ];
}

/** The body's shape as far as this extension reads it (the bus sends the full BoxRecipientBody). */
export function isRecipientBody(value: unknown): value is BoxRecipientBody {
  return (
    isRecord(value) &&
    value.v === 1 &&
    value.kind === "recipient" &&
    typeof value.me === "string" &&
    isRecord(value.conversation) &&
    typeof value.conversation.id === "string" &&
    Array.isArray(value.messages) &&
    Array.isArray(value.checklist) &&
    Array.isArray(value.agents) &&
    value.agents.every((a) => typeof a === "string") &&
    isRecord(value.draft) &&
    typeof value.draft.text === "string"
  );
}

/** The agent to offer for a draft: one call to the model, or none when there is nothing to choose between. */
export async function recipientOf(body: BoxRecipientBody, config: AskConfig, signal: AbortSignal): Promise<BoxRecipientResponse> {
  const agents = [...new Set(body.agents)].filter((a) => a !== body.me);
  if (agents.length < 2 || body.draft.text.trim() === "") return { recipient: null };
  const room = { ...body, agents };
  const res = await fetch(`${config.decideUrl.replace(/\/+$/, "")}/v1/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(decisionRequest(room)),
    signal,
  });
  if (!res.ok) throw new Error(`the model answered HTTP ${res.status}`);
  const decision = readDecision(await res.json(), room, config.minConfidence);
  return decision.recipient === null ? { recipient: null } : { recipient: decision.recipient, confidence: decision.confidence };
}

async function handleRecipient(req: Request, config: AskConfig): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "the body is not JSON" }, { status: 400 });
  }
  if (!isRecipientBody(body)) return Response.json({ error: "not a recipient body (v 1, kind recipient)" }, { status: 400 });
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    return Response.json(await recipientOf(body, config, AbortSignal.any([req.signal, timeout])));
  } catch (error) {
    // Too slow, or the bus gave up on the request: no suggestion.
    if (timeout.aborted || req.signal.aborted) return Response.json({ recipient: null } satisfies BoxRecipientResponse);
    console.error(`ask: ${error instanceof Error ? error.message : String(error)}`);
    return Response.json({ error: "the model is not answering" }, { status: 502 });
  }
}

/** POST /needs: every model's verdict on an agent's message for a person; a model that fails gives its error. */
export async function handleNeeds(req: Request, models: NeedsModel[]): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "the body is not JSON" }, { status: 400 });
  }
  if (!isNeedsBody(body)) return Response.json({ error: "not a needs body (v 1, kind needs)" }, { status: 400 });
  const answer = await needsVerdicts(body, models, req.signal);
  for (const [model, verdict] of Object.entries(answer.verdicts)) {
    if ("error" in verdict) console.error(`needs: ${model} on #${body.message.seq}: ${verdict.error}`);
  }
  return Response.json(answer);
}

if (import.meta.main) {
  const port = Number(process.env.ASK_PORT ?? 7832);
  const config: AskConfig = {
    decideUrl: process.env.ASK_DECIDE_URL ?? "http://127.0.0.1:9963",
    glideUrl: process.env.ASK_GLIDE_URL ?? "http://127.0.0.1:9966",
    minConfidence: Number(process.env.ASK_MIN_CONFIDENCE ?? 0.5),
  };
  const models = needsModels(config);
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    // GLiDE on the CPU may queue behind other requests: /needs waits up to a minute per model.
    idleTimeout: 120,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/health") {
        return Response.json({ ok: true, decideUrl: config.decideUrl, glideUrl: config.glideUrl, minConfidence: config.minConfidence });
      }
      if (req.method === "POST" && path === "/recipient") return handleRecipient(req, config);
      if (req.method === "POST" && path === "/needs") return handleNeeds(req, models);
      return new Response("POST /recipient, POST /needs, GET /health", { status: 404 });
    },
  });
  console.log(`ask extension on http://127.0.0.1:${port}, model at ${config.decideUrl}, cut-off ${config.minConfidence}`);
}
