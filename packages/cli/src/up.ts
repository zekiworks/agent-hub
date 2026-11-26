// `agent-bus up`: after a reboot, brings this machine's agents back in tmux, the way Can did it by hand: ask the bus
// which agents ran here, then for each one a window in its folder that resumes its last session (`omp -c`, `pi -c`,
// `codex resume --last`).
// Each window is a login shell with the command typed in, so the shell stays when the command exits.
import { existsSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import type { Participant, StateResponse } from "@agent-bus/protocol";
import { agentToken } from "../../client/src/connection";

/**
 * How each harness resumes the previous session of a folder. Others are listed as skipped.
 * `codex resume --last` picks the newest session of the current folder (it filters by cwd unless `--all`).
 */
const RESUME: Record<string, string> = { omp: "omp -c", pi: "pi -c", codex: "codex resume --last" };

export interface UpOptions {
  url: string;
  session: string;
  /** Agents last seen longer ago than this are left out (folders tried once, test agents). */
  sinceDays: number;
  dryRun: boolean;
}

/** A tmux window already there: its name and the folder its pane is in. */
export interface ExistingWindow {
  name: string;
  path: string;
}

export interface UpPlan {
  start: Array<{ id: string; path: string; command: string }>;
  skipped: Array<{ id: string; why: string }>;
}

/** A host name as a machine: without its domain, lowercase (as the bus compares them). */
function machine(host: string): string {
  return host.split(".")[0]?.toLowerCase() ?? "";
}

function samePath(a: string, b: string, real: (p: string) => string): boolean {
  return a === b || real(a) === real(b);
}

/**
 * Which agents of `host` get a window: those whose harness can resume, whose folder exists, seen within `sinceDays`,
 * and without a window in their folder already. Sorted by id, so windows come up in the same order every time.
 */
export function planUp(
  participants: readonly Participant[],
  windows: readonly ExistingWindow[],
  opts: { host: string; now: number; sinceDays: number; exists?: (p: string) => boolean; real?: (p: string) => string }
): UpPlan {
  const exists = opts.exists ?? existsSync;
  const real = opts.real ?? ((p: string) => (existsSync(p) ? realpathSync(p) : p));
  const plan: UpPlan = { start: [], skipped: [] };
  const mine = participants
    .filter((p) => p.kind === "agent" && p.host && machine(p.host) === machine(opts.host))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const agent of mine) {
    const command = agent.harness ? RESUME[agent.harness] : undefined;
    if (!agent.path) plan.skipped.push({ id: agent.id, why: "no folder" });
    else if (!command) plan.skipped.push({ id: agent.id, why: `${agent.harness ?? "unknown"} harness: start it yourself` });
    else if (opts.now - agent.lastSeenAt > opts.sinceDays * 86_400_000) {
      plan.skipped.push({ id: agent.id, why: `last seen ${Math.floor((opts.now - agent.lastSeenAt) / 86_400_000)} days ago` });
    } else if (!exists(agent.path)) plan.skipped.push({ id: agent.id, why: `${agent.path} is missing` });
    else if (windows.some((w) => samePath(w.path, agent.path as string, real))) {
      plan.skipped.push({ id: agent.id, why: "already has a window in its folder" });
    } else plan.start.push({ id: agent.id, path: agent.path, command });
  }
  return plan;
}

function tmux(args: string[]): { ok: boolean; out: string } {
  const res = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: res.exitCode === 0, out: `${res.stdout.toString()}${res.stderr.toString()}`.trim() };
}

function existingWindows(session: string): ExistingWindow[] | null {
  const res = tmux(["list-windows", "-t", session, "-F", "#{window_name}\t#{pane_current_path}"]);
  if (!res.ok) return null; // no such session (or no tmux server)
  return res.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", path = ""] = line.split("\t");
      return { name, path };
    });
}

export async function runUp(opts: UpOptions): Promise<number> {
  let state: StateResponse;
  try {
    const res = await fetch(`${opts.url}/api/state`, { headers: { "X-Agent-Token": agentToken() }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state = (await res.json()) as StateResponse;
  } catch (error) {
    console.error(
      `agent-bus up: the Hub at ${opts.url} is not reachable (${error instanceof Error ? error.message : String(error)}). ` +
        "Is it running? systemctl --user status agent-bus"
    );
    return 1;
  }
  const windows = existingWindows(opts.session);
  const plan = planUp(state.participants, windows ?? [], { host: hostname(), now: Date.now(), sinceDays: opts.sinceDays });
  for (const s of plan.skipped) console.log(`skip  ${s.id}: ${s.why}`);
  for (const s of plan.start) console.log(`${opts.dryRun ? "would start" : "start"}  ${s.id}: ${s.path} → ${s.command}`);
  if (opts.dryRun || plan.start.length === 0) {
    if (plan.start.length === 0) console.log("Nothing to start.");
    return 0;
  }
  let created = windows !== null;
  for (const s of plan.start) {
    // -P -F prints the new window's id, so the command goes to exactly that window whatever its name.
    const res = created
      ? tmux(["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `${opts.session}:`, "-n", s.id, "-c", s.path])
      : tmux(["new-session", "-d", "-P", "-F", "#{window_id}", "-s", opts.session, "-n", s.id, "-c", s.path]);
    if (!res.ok) {
      console.error(`agent-bus up: tmux could not open a window for ${s.id}: ${res.out}`);
      return 1;
    }
    created = true;
    tmux(["send-keys", "-t", res.out, s.command, "Enter"]);
  }
  console.log(`Attach with: tmux attach -t ${opts.session}`);
  return 0;
}
