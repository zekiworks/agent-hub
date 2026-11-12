// What the route and socket modules share: the store, the configured humans, human authentication, the approved
// agent tokens, the live state (`Hub`), and the identity checks every request makes.
import { parseAddress, RESOURCES_AGENT_ID, type ParsedAddress } from "@agent-bus/protocol";
import type { AgentTokens } from "./agent-tokens";
import type { HumanAuth } from "./auth";
import type { BusDatabase } from "./db";
import { HttpError } from "./http";
import { Hub } from "./hub";

/** SHA-256 hex of an agent token (the database never holds the token itself). */
export function tokenHash(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/** Who a request comes from: a signed-in person, or an agent whose machine account's token is approved. */
export type Reader = { kind: "human"; id: string } | { kind: "agent"; tokenHash: string };

export class BusContext {
  readonly hub: Hub;

  constructor(
    readonly db: BusDatabase,
    /** Configured human ids, in configuration order. */
    readonly humans: string[],
    readonly auth: HumanAuth,
    readonly tokens: AgentTokens,
    /** Uploaded files, one blob per file id. */
    readonly filesDir: string
  ) {
    this.hub = new Hub(db, new Set(humans));
  }

  /** The reader of `req`, or undefined: a passkey session (`Authorization: Bearer`) or an approved `X-Agent-Token`. */
  readerOf(req: Request): Reader | undefined {
    const human = this.auth.humanOf(req);
    if (human !== undefined) return { kind: "human", id: human };
    const token = req.headers.get("x-agent-token");
    if (!token) return undefined;
    const hash = tokenHash(token);
    if (!this.tokens.isApproved(hash)) return undefined;
    this.tokens.touch(hash);
    return { kind: "agent", tokenHash: hash };
  }

  /** Every request but /api/health and /api/auth/* needs a reader; 401 otherwise. */
  requireReader(req: Request): Reader {
    const reader = this.readerOf(req);
    if (reader) return reader;
    const token = req.headers.get("x-agent-token");
    const hash = token ? tokenHash(token) : undefined;
    const state = hash ? this.tokens.state(hash) : undefined;
    if (hash && state === "pending") {
      throw new HttpError(401, `This machine's agent token waits to be allowed: code ${this.tokens.codeOf(hash)} (bus website, or \`agent-bus approve <code>\` on the bus's host)`);
    }
    if (state === "denied") throw new HttpError(401, "This machine's agent token was denied or revoked on this bus");
    throw new HttpError(401, "Sign in (passkey, /auth) or send an approved agent token (X-Agent-Token)");
  }

  /** A signed-in person (approving agents, managing tokens); 401/403 otherwise. */
  requireHuman(req: Request): string {
    const reader = this.requireReader(req);
    if (reader.kind !== "human") throw new HttpError(403, "Only a signed-in person can do this");
    return reader.id;
  }

  /**
   * Every write's check of its `from`. Humans: the request's passkey session must be that human's. Agents: an
   * approved agent token, and the one the id is bound to (its first join) when bound; nobody writes as the
   * built-in @resources. Returns `verified` for a human's message (always true now; kept on the message for the
   * agents' delivery header and for messages stored before sign-in was required).
   */
  checkWriter(req: Request, writer: { id: string; kind: "agent" | "human" }): boolean | undefined {
    if (writer.kind === "human") {
      const signedIn = this.auth.humanOf(req);
      if (signedIn === undefined) throw new HttpError(401, `Sign in to write as ${writer.id} (passkey; see /auth)`);
      if (signedIn !== writer.id) throw new HttpError(403, `You are signed in as ${signedIn}, not ${writer.id}`);
      return true;
    }
    if (writer.id === RESOURCES_AGENT_ID) throw new HttpError(403, "@resources is the bus's own notices; nobody writes as it");
    const reader = this.requireReader(req);
    if (reader.kind !== "agent") throw new HttpError(403, `Signed in as a person; @${writer.id} is an agent`);
    const bound = this.db.agentTokenHash(writer.id);
    if (bound !== null && bound !== reader.tokenHash) {
      throw new HttpError(401, `@${writer.id} is bound to another agent token (another machine or account). Nothing was sent.`);
    }
    return undefined;
  }

  /** `to` parsed as an address; 400 when it is not one or names an id that is not a participant. */
  knownAddress(to: string): ParsedAddress {
    let parsed: ParsedAddress;
    try {
      parsed = parseAddress(to);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
    if (parsed.kind === "all") return parsed;
    const unknown = parsed.ids.filter((id) => !this.hub.knownParticipant(id));
    if (unknown.length > 0) {
      throw new HttpError(
        400,
        `Unknown id${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Known ids: ${this.hub.knownIds().join(", ")}`
      );
    }
    return parsed;
  }
}
