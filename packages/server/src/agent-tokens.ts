// Which machine accounts may have agents on the bus. Every harness sends its account's agent token
// (~/.agent-bus/agent-token); the first time the hub sees one, it holds the connection and asks a person, like ssh's
// first connection to a host: allow it on the website, or `agent-bus approve <code>` on the bus's host. Allowed tokens
// join, read and write as their agents; denied or revoked ones are refused. The database holds only hashes.
import type { Database } from "bun:sqlite";
import { randomInt } from "node:crypto";
import type { AgentTokenInfo } from "@agent-bus/protocol";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_tokens (
  token_hash TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  host TEXT,
  addr TEXT,
  agents TEXT NOT NULL DEFAULT '[]',
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  last_used_at INTEGER
);
`;

interface TokenRow {
  token_hash: string;
  state: AgentTokenInfo["state"];
  code: string;
  host: string | null;
  addr: string | null;
  agents: string;
  requested_at: number;
  decided_at: number | null;
  decided_by: string | null;
  last_used_at: number | null;
}

/** Letters and digits that read unambiguously aloud and on a phone (no 0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function newCode(): string {
  const pick = (): string => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)] ?? "A";
  return `${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}`;
}

/** Hash prefix that names a token on the website and in the CLI. */
export const tokenId = (hash: string): string => hash.slice(0, 12);

function toInfo(row: TokenRow): AgentTokenInfo {
  return {
    id: tokenId(row.token_hash),
    state: row.state,
    code: row.code,
    host: row.host,
    addr: row.addr,
    agents: JSON.parse(row.agents) as string[],
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    lastUsedAt: row.last_used_at,
  };
}

export class AgentTokens {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA);
  }

  /**
   * Tokens agents already joined with before approval existed count as approved (they were bound to their ids by
   * first use; the people running the bus saw them join).
   */
  approveBound(now = Date.now()): void {
    const bound = this.db
      .query<{ token_hash: string; host: string | null; agents: string }, []>(
        `SELECT token_hash, MAX(host) AS host, json_group_array(id) AS agents FROM participants
         WHERE kind = 'agent' AND token_hash IS NOT NULL GROUP BY token_hash`
      )
      .all();
    for (const row of bound) {
      if (this.row(row.token_hash)) continue;
      this.db
        .query(
          `INSERT INTO agent_tokens (token_hash, state, code, host, agents, requested_at, decided_at, decided_by)
           VALUES (?1, 'approved', ?2, ?3, ?4, ?5, ?5, 'joined before approval existed')`
        )
        .run(row.token_hash, this.freeCode(), row.host, row.agents, now);
    }
  }

  private row(hash: string): TokenRow | null {
    return this.db.query<TokenRow, [string]>("SELECT * FROM agent_tokens WHERE token_hash = ?1").get(hash);
  }

  private freeCode(): string {
    for (;;) {
      const code = newCode();
      if (!this.db.query("SELECT 1 FROM agent_tokens WHERE code = ?1").get(code)) return code;
    }
  }

  state(hash: string): AgentTokenInfo["state"] | undefined {
    return this.row(hash)?.state;
  }

  /** The code a person approves the token by. */
  codeOf(hash: string): string | undefined {
    return this.row(hash)?.code;
  }

  isApproved(hash: string): boolean {
    return this.state(hash) === "approved";
  }

  /** Notes that an approved token was used (at most once a minute, to spare writes). */
  touch(hash: string, now = Date.now()): void {
    this.db.query("UPDATE agent_tokens SET last_used_at = ?2 WHERE token_hash = ?1 AND (last_used_at IS NULL OR last_used_at < ?2 - 60000)").run(hash, now);
  }

  /** Records a join attempt with a token that is not approved; returns its pending code (stable across retries). */
  request(hash: string, info: { host: string | null; addr: string | null; agent: string }, now = Date.now()): string {
    const existing = this.row(hash);
    if (existing) {
      const agents = JSON.parse(existing.agents) as string[];
      if (!agents.includes(info.agent)) agents.push(info.agent);
      this.db
        .query("UPDATE agent_tokens SET host = COALESCE(?2, host), addr = COALESCE(?3, addr), agents = ?4 WHERE token_hash = ?1")
        .run(hash, info.host, info.addr, JSON.stringify(agents.slice(-20)));
      return existing.code;
    }
    const code = this.freeCode();
    this.db
      .query("INSERT INTO agent_tokens (token_hash, state, code, host, addr, agents, requested_at) VALUES (?1, 'pending', ?2, ?3, ?4, ?5, ?6)")
      .run(hash, code, info.host, info.addr, JSON.stringify([info.agent]), now);
    return code;
  }

  /** Adds `agent` to an approved token's list (what joined with it), for the list people see. */
  noteAgent(hash: string, agent: string): void {
    const row = this.row(hash);
    if (!row) return;
    const agents = JSON.parse(row.agents) as string[];
    if (agents.includes(agent)) return;
    agents.push(agent);
    this.db.query("UPDATE agent_tokens SET agents = ?2 WHERE token_hash = ?1").run(hash, JSON.stringify(agents.slice(-20)));
  }

  list(): AgentTokenInfo[] {
    return this.db
      .query<TokenRow, []>("SELECT * FROM agent_tokens ORDER BY state = 'pending' DESC, requested_at DESC")
      .all()
      .map(toInfo);
  }

  /** The token hash `ref` names: a pending code (any case, dash optional) or a token id (hash prefix). */
  resolve(ref: string): string | undefined {
    const code = ref.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const byCode = code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : undefined;
    const rows = this.db.query<{ token_hash: string; code: string }, []>("SELECT token_hash, code FROM agent_tokens").all();
    const match = rows.filter((r) => r.code === byCode || (ref.trim().length >= 6 && r.token_hash.startsWith(ref.trim().toLowerCase())));
    return match.length === 1 ? match[0]?.token_hash : undefined;
  }

  /** Allows, denies or revokes (= denies an approved one) the token; returns false when there is none. */
  decide(hash: string, state: "approved" | "denied", by: string, now = Date.now()): boolean {
    return this.db.query("UPDATE agent_tokens SET state = ?2, decided_at = ?3, decided_by = ?4 WHERE token_hash = ?1").run(hash, state, now, by).changes > 0;
  }
}
