// A bus for tests where everyone is identified, as on a real bus: this test run's agent token (the shared client's
// `agentToken()`, in a temp file per run: tests/setup.ts) is approved, and the configured humans get sessions.
import { createBusServer, type BusServerHandle, type BusServerOptions } from "@agent-bus/server";
import { agentToken } from "../packages/client/src/connection";

/** The agent token every test client sends (raw sockets pass it as `token`); approved on buses from `startBus`. */
export const TEST_TOKEN = agentToken();

/** Sessions by human, per bus started with `startBus`. */
const sessions = new WeakMap<BusServerHandle, Map<string, string>>();

/** `createBusServer` with the test agent token approved and passkey-less sessions for `options.humans`. */
export function startBus(options: BusServerOptions): BusServerHandle {
  const bus = createBusServer(options);
  bus.approveAgentToken(TEST_TOKEN);
  sessions.set(bus, new Map((options.humans ?? []).map((human) => [human, bus.signIn(human)])));
  return bus;
}

/** A configured human's session on `bus`. */
export function sessionOf(bus: BusServerHandle, human: string): string {
  const session = sessions.get(bus)?.get(human);
  if (session === undefined) throw new Error(`No session for ${human}: not a human of this bus`);
  return session;
}

/**
 * Headers that identify a request as `as`: the session of a configured human, else (an agent, or nobody given) the
 * approved test agent token.
 */
export function identity(bus: BusServerHandle, as?: string): Record<string, string> {
  const session = as === undefined ? undefined : sessions.get(bus)?.get(as);
  return session !== undefined ? { Authorization: `Bearer ${session}` } : { "X-Agent-Token": TEST_TOKEN };
}

/** `fetch` of `bus.url + route` identified as `as` (see `identity`). */
export function busFetch(bus: BusServerHandle, route: string, init: RequestInit = {}, as?: string): Promise<Response> {
  return fetch(`${bus.url}${route}`, { ...init, headers: { ...identity(bus, as), ...(init.headers as Record<string, string> | undefined) } });
}

/** GET `route` as JSON, identified as `as` (a human's session), else by the test agent token. */
export async function getJson<T>(bus: BusServerHandle, route: string, as?: string): Promise<T> {
  return (await (await busFetch(bus, route, {}, as)).json()) as T;
}

/** POST `body` as JSON to `route`, identified as its `from` (a human's session, else the test agent token). */
export function postJson(bus: BusServerHandle, route: string, body: unknown): Promise<Response> {
  const from = typeof body === "object" && body !== null && "from" in body && typeof body.from === "string" ? body.from : undefined;
  return busFetch(bus, route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, from);
}

/** A viewer socket signed in at upgrade with a human's session (the first configured human by default). */
export function viewerSocket(bus: BusServerHandle, human?: string): WebSocket {
  const as = human ?? sessions.get(bus)?.keys().next().value;
  return new WebSocket(`${bus.url.replace(/^http/, "ws")}/ws/viewer`, { headers: identity(bus, as) } as never);
}

/** `/ws/agent?…` with the test agent token (unless `query` names its own `token`). */
export function agentSocketUrl(bus: BusServerHandle, query: Record<string, string>): string {
  return `${bus.url.replace(/^http/, "ws")}/ws/agent?${new URLSearchParams({ token: TEST_TOKEN, ...query })}`;
}
