import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  ALL_CONVERSATION_ID,
  DEFAULT_BUS_PORT,
  PROTOCOL_VERSION,
  slugifyId,
  type HealthResponse,
  type PushKeyResponse,
  type StateResponse,
} from "@agent-bus/protocol";
import { AgentTokens } from "./agent-tokens";
import { forgetOfflineAgents, handleAgentTokens, postSetting, socketHandlers } from "./agents";
import { HumanAuth } from "./auth";
import { handleAuth } from "./auth-routes";
import { BusContext, tokenHash } from "./context";
import { canSee, handleConversationRoute, mayRead, type Reader } from "./conversations";
import { BusDatabase } from "./db";
import { getFile, MAX_FILE_BYTES, postFile, transcribeFile } from "./files";
import { CORS_HEADERS, errorResponse, HttpError, json, nonEmptyParam, readJsonObject } from "./http";
import type { SocketData } from "./hub";
import { resolveLanAddresses } from "./lan";
import { editChecklist, getChecklist, pinChecklist, putChecklist, tickChecklist } from "./checklists";
import { changeMessage, forwardMessage, getMessageReceipts, getMessages, getSharedFiles, MAX_RECEIPT_WAIT_MS, postBookmark, postMessage, postOwnTask, postTabs } from "./messages";
import { getHistory, getInbox, getSearch } from "./reading";
import { ScheduleService } from "./schedule-routes";
import { forwardExtension } from "./extensions";
import { getBoxUsage, postBox, postBoxReport, type BoxExtension } from "./boxes";
import { postCommand } from "./commands";
import { getTasks, taskAction } from "./tasks";
import { postSpeech } from "./speech";
import { WebPush } from "./push";
import { postAttention } from "./attention";
import { type Brand, Website } from "./website";

export interface BusServerOptions {
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  dataDir?: string;
  humans?: string[];
  /**
   * Also serve everything over TLS on a second port (browsers need https for notifications). Agents keep
   * using the plain port. The files are read at startup; a renewed certificate takes effect on restart.
   */
  https?: { port: number; certFile: string; keyFile: string };
  /**
   * gpudash's base URL (e.g. http://127.0.0.1:3420): every 30 s the resource schedule reads its
   * GET /api/observations to see what runs on each GPU (and so registers the GPUs). Without it the schedule
   * still books, but cannot see use: no idle flags, no unclaimed-use warnings, and no GPUs until registered.
   */
  gpudash?: string;
  /** The speech-to-text service (packages/stt, e.g. http://127.0.0.1:7810) that turns voice messages into text. */
  sttUrl?: string;
  /** A text-to-speech server (llama-server with LFM3-Audio, e.g. http://127.0.0.1:9941) that reads messages aloud. */
  ttsUrl?: string;
  /** Pages shown in the website's Workspace: name → local URL (`--ext gpudash=http://127.0.0.1:3420`). */
  extensions?: Record<string, string>;
  /** Which of them are global, opened by a top-bar launcher: name → its label (`--ext gpudash=…,launcher=GPUs`). */
  launchers?: Record<string, string>;
  /** Which of them are a tab on every agent's page: name → its label (`--ext status=…,agents=Home`; Can #14261). */
  agentTabs?: Record<string, string>;
  /** Slash commands: command → the extension (of `extensions`) that answers it (`--ext status=…,commands=status-update`). */
  commands?: Record<string, string>;
  /** Services the message box asks, not Workspace pages (`--ext complete=URL,box=complete`; Can #12853). */
  boxes?: Record<string, BoxExtension>;
  /** This bus's name and pictures on the website (`--brand-name "Team Hub" --brand-logo FILE --brand-icon FILE`). */
  brand?: Brand;
  /** Agents offline for this many days are forgotten (participant record and their pending receipts). 0: never. Default 15. */
  forgetOfflineDays?: number;
  /** Projects and group DMs quiet this many days, pinned by nobody, are archived (Can, 15 Nov). 0: never. Default 3. */
  archiveIdleDays?: number;
  /**
   * Other addresses the website is reachable at (e.g. https://host.tailnet.ts.net through `tailscale serve`); offered
   * first when a person adds a device by QR code.
   */
  publicUrls?: string[];
  /**
   * Passkeys for the people on the bus (every reader and writer is signed in). `rpId` is the host name the website
   * is opened at (passkeys are bound to it; default localhost); `origins` defaults to https://<rpId>:<https port>
   * and http://localhost:<port>.
   */
  auth?: { rpId?: string; origins?: string[] };
  /** Tests only: Web Push subscriptions may point at any http(s) address, not only the browsers' push services. */
  pushAnyEndpoint?: boolean;
}

export interface BusServerHandle {
  url: string;
  port: number;
  lanUrls: string[];
  /** Set when `https` was given. */
  httpsPort?: number;
  httpsLanUrls?: string[];
  dataDir: string;
  dbPath: string;
  stop(): Promise<void>;
  /**
   * In-process only (tests, programs embedding the server; both hold the database anyway): a passkey-less session
   * for `human`, and approving an agent token without asking a person.
   */
  signIn(human: string): string;
  approveAgentToken(token: string): void;
}

const DEFAULT_HOST = "0.0.0.0";
/** How often the bus looks for messages that expired before reaching an offline agent. */
const EXPIRY_CHECK_MS = 5_000;
function resolveHumans(option: string[] | undefined): string[] {
  const raw = option ?? process.env.BUS_HUMANS?.split(",");
  if (!raw) throw new Error("Name the humans who use the website: --humans carol,uma (or BUS_HUMANS)");
  const out: string[] = [];
  for (const entry of raw) {
    const id = slugifyId(entry);
    if (id && id !== ALL_CONVERSATION_ID && !out.includes(id)) out.push(id);
  }
  if (out.length === 0) throw new Error(`No valid human ids in ${JSON.stringify(raw)}`);
  return out;
}

export function createBusServer(options: BusServerOptions = {}): BusServerHandle {
  const host = options.host ?? DEFAULT_HOST;
  const dataDir = path.resolve(
    options.dataDir ?? process.env.AGENT_BUS_DATA_DIR ?? path.join(homedir(), ".agent-bus")
  );
  const filesDir = path.join(dataDir, "files");
  const dbPath = path.join(dataDir, "message-bus.sqlite");
  // Messages, files, session and token hashes are the account's alone: the directory is 700 and what the bus writes
  // there 600, on a fresh install and fixed on an existing one (launch check, 16 Nov: other local users could read
  // the database).
  process.umask(0o077);
  mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  for (const p of [dataDir, filesDir]) chmodSync(p, 0o700);
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) chmodSync(dbPath + suffix, 0o600);
  const humans = resolveHumans(options.humans);
  const db = new BusDatabase(dbPath, humans);
  // The ports are known once the servers listen; the passkey origins follow them.
  let boundPort = 0;
  let boundHttpsPort: number | undefined;
  const rpId = options.auth?.rpId ?? "localhost";
  const auth = new HumanAuth(db.db, {
    rpId,
    humans,
    origins: () =>
      options.auth?.origins ?? [...(boundHttpsPort ? [`https://${rpId}:${boundHttpsPort}`] : []), `http://localhost:${boundPort}`],
  });
  const tokens = new AgentTokens(db.db);
  tokens.approveBound();
  const ctx = new BusContext(db, humans, auth, tokens, filesDir);
  // Notifications to people's devices while Agent Hub is closed (Ümit #13927, #13934).
  const push = new WebPush(db.db, path.join(dataDir, "push-vapid.json"), {
    subject: options.publicUrls?.[0] ?? "mailto:agent-hub@localhost",
    anyEndpoint: options.pushAnyEndpoint,
  });
  ctx.hub.onMessage = (message, conversation) => push.notify(message, conversation, (id) => ctx.hub.isHuman(id));
  // Nobody is connected yet: apply the logoff rule to everyone (also cleans up after a crash).
  for (const agent of db.listAgents()) db.removeIfIdle(agent.id);
  const startedAt = Date.now();

  /** Agents offline for `forgetOfflineDays` days are forgotten (0: never). Checked at start and every hour. */
  const forgetOfflineDays = options.forgetOfflineDays ?? 15;
  forgetOfflineAgents(ctx, forgetOfflineDays);
  const forgetTimer = setInterval(() => forgetOfflineAgents(ctx, forgetOfflineDays), 3600_000);

  /** Quiet, unpinned projects and group DMs are archived: checked at start and every hour. */
  const archiveIdleDays = options.archiveIdleDays ?? 3;
  const archiveIdle = (): void => {
    if (archiveIdleDays <= 0) return;
    if (db.archiveIdle(Date.now() - archiveIdleDays * 86_400_000).length > 0) ctx.hub.conversationsChanged();
  };
  archiveIdle();
  const archiveTimer = setInterval(archiveIdle, 3600_000);

  const schedule = new ScheduleService(ctx, options.gpudash);
  const website = new Website(options.brand);
  const sockets = socketHandlers(ctx);
  // Decisions made on the host (`agent-bus approve`, `deny`) reach the waiting and connected agents within seconds.
  const settleTimer = setInterval(() => sockets.settleAll(), 2000);
  // Messages held for offline agents expire: their writers and the website are told within EXPIRY_CHECK_MS.
  let expiryCheckedAt = Date.now();
  const expiryTimer = setInterval(() => {
    const now = Date.now();
    ctx.hub.announceExpired(db.expiredBetween(expiryCheckedAt, now));
    expiryCheckedAt = now;
  }, EXPIRY_CHECK_MS);
  let lanUrls: string[] = [];

  const handleApi = async (req: Request, url: URL): Promise<Response> => {
    const { pathname } = url;
    const method = req.method;
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (method === "GET" && pathname === "/api/health") {
      const health: HealthResponse = {
        ok: true,
        version: PROTOCOL_VERSION,
        uptimeMs: Date.now() - startedAt,
        lanUrls,
      };
      return json(health);
    }
    if (pathname.startsWith("/api/auth/")) return handleAuth(auth, { rpId, httpsPort: boundHttpsPort, publicUrls: options.publicUrls ?? [] }, req, url);
    // File links on the website carry a key instead of the session header (an <img> cannot send one).
    const fileMatch = /^\/api\/files\/([^/]+)$/.exec(pathname);
    const fileKey = url.searchParams.get("k");
    if (method === "GET" && fileMatch?.[1] && fileKey && auth.checkFileKey(fileKey)) return getFile(ctx, decodeURIComponent(fileMatch[1]));
    const reader = ctx.requireReader(req);
    // People read as themselves; an agent token reads what agents may (see canRead), or as one of its agents (`as`).
    let viewer: Reader =
      reader.kind === "human" ? { id: reader.id, kind: "human" } : { id: "", kind: "agent", all: true, tokenHash: reader.tokenHash };
    const as = url.searchParams.get("as");
    if (reader.kind === "agent" && as) {
      const agent = ctx.hub.knownParticipant(as.trim().toLowerCase());
      if (!agent || agent.kind !== "agent") throw new HttpError(400, `Unknown agent "${as}"`);
      ctx.checkWriter(req, agent);
      viewer = { id: agent.id, kind: "agent" };
    }
    if (pathname.startsWith("/api/agent-tokens")) return handleAgentTokens(ctx, sockets, req, url);
    if (method === "GET" && pathname === "/api/state") {
      const conversations = db
        .listConversations()
        .filter((c) => mayRead(ctx, c, viewer) || canSee(ctx, c, viewer))
        // A preview (a discoverable project the viewer is not in) shows name, topic and members, not what is pinned
        // there: pins are for those who read it (Can #11054: everyone's Pinned list is built from this).
        .map((c) => (mayRead(ctx, c, viewer) ? c : { ...c, preview: true as const, pinnedMessages: undefined }));
      const state: StateResponse = {
        participants: ctx.hub.listParticipants(),
        conversations,
        humans,
        ...(options.extensions && Object.keys(options.extensions).length > 0 ? { extensions: Object.keys(options.extensions) } : {}),
        ...(options.launchers && Object.keys(options.launchers).length > 0 ? { launchers: options.launchers } : {}),
        ...(options.agentTabs && Object.keys(options.agentTabs).length > 0 ? { agentTabs: options.agentTabs } : {}),
        ...(options.commands && Object.keys(options.commands).length > 0 ? { commands: Object.keys(options.commands) } : {}),
        ...(options.boxes && Object.keys(options.boxes).length > 0
          ? { boxes: Object.fromEntries(Object.entries(options.boxes).map(([name, box]) => [name, box.role])) }
          : {}),
        ...(options.gpudash ? { gpuBooking: true as const } : {}),
        // A person's own bookmarks (Can #11065), tasks (Can #12197) and tabs (Can #11480): theirs alone, in their own state.
        ...(viewer.kind === "human" ? { bookmarks: db.bookmarksOf(viewer.id), ownTasks: db.ownTasksOf(viewer.id), tabs: db.tabsOf(viewer.id) } : {}),
      };
      return json(state);
    }
    if (method === "GET" && pathname === "/api/inbox") return json(getInbox(ctx, req, url));
    if (method === "GET" && pathname === "/api/history") return json(getHistory(ctx, req, url));
    if (method === "GET" && pathname === "/api/search") return json(getSearch(ctx, req, url));
    if (method === "GET" && pathname === "/api/stats") {
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 7));
      return json(db.stats(Date.now() - days * 86_400_000, days));
    }
    if (method === "GET" && pathname === "/api/tasks") return json(getTasks(ctx, req, url, viewer.kind === "human" ? viewer.id : undefined));
    const taskMatch = /^\/api\/tasks\/(\d+)\/(accept|done|reject|withdraw|read)$/.exec(pathname);
    if (method === "POST" && taskMatch?.[1] && taskMatch[2]) return json(await taskAction(ctx, req, Number(taskMatch[1]), taskMatch[2]));
    const checklistMatch = /^\/api\/conversations\/([^/]+)\/checklist(?:\/(tick|edit|pin))?$/.exec(pathname);
    if (checklistMatch?.[1]) {
      const id = decodeURIComponent(checklistMatch[1]);
      const action = checklistMatch[2];
      if (!action && method === "GET") return json(getChecklist(ctx, id, viewer));
      if (!action && method === "PUT") return json(await putChecklist(ctx, req, id));
      if (action === "tick" && method === "POST") return json(await tickChecklist(ctx, req, id));
      if (action === "edit" && method === "POST") return json(await editChecklist(ctx, req, id));
      if (action === "pin" && method === "POST") return json(await pinChecklist(ctx, req, id));
    }
    const sharedMatch = /^\/api\/conversations\/([^/]+)\/files$/.exec(pathname);
    if (method === "GET" && sharedMatch?.[1]) return json(getSharedFiles(ctx, decodeURIComponent(sharedMatch[1]), viewer));
    const messagesMatch = /^\/api\/conversations\/([^/]+)\/messages$/.exec(pathname);
    if (method === "GET" && messagesMatch?.[1]) {
      return json(getMessages(ctx, decodeURIComponent(messagesMatch[1]), url, viewer));
    }
    const conversationAction = /^\/api\/conversations\/([^/]+)\/([a-z]+)$/.exec(pathname);
    if (method === "POST" && conversationAction?.[1] && conversationAction[2]) {
      const answer = await handleConversationRoute(ctx, req, decodeURIComponent(conversationAction[1]), conversationAction[2]);
      if (answer) return json(answer);
    }
    if (method === "POST" && pathname === "/api/messages") return json(await postMessage(ctx, req));
    if (method === "POST" && pathname === "/api/bookmarks") return json(await postBookmark(ctx, req));
    if (method === "POST" && pathname === "/api/own-tasks") return json(await postOwnTask(ctx, req));
    if (method === "POST" && pathname === "/api/tabs") return json(await postTabs(ctx, req));
    const messageMatch = /^\/api\/messages\/(\d+)$/.exec(pathname);
    if (method === "GET" && messageMatch?.[1]) return json(await getMessageReceipts(ctx, Number(messageMatch[1]), url, viewer));
    // The writer edits or deletes one of its messages (Ümit #10890).
    const changeMatch = /^\/api\/messages\/(\d+)\/(edit|delete)$/.exec(pathname);
    if (method === "POST" && changeMatch?.[1] && changeMatch[2]) {
      return json(await changeMessage(ctx, req, Number(changeMatch[1]), changeMatch[2] === "edit" ? "edit" : "delete"));
    }
    // Someone who may read a message shows it to someone else (Can #12470).
    const forwardMatch = /^\/api\/messages\/(\d+)\/forward$/.exec(pathname);
    if (method === "POST" && forwardMatch?.[1]) return json(await forwardMessage(ctx, req, Number(forwardMatch[1])));
    if (method === "POST" && pathname === "/api/files") return json(await postFile(ctx, req, url));
    if (method === "GET" && fileMatch?.[1]) return getFile(ctx, decodeURIComponent(fileMatch[1]));
    const transcriptMatch = /^\/api\/files\/([^/]+)\/transcript$/.exec(pathname);
    if (method === "POST" && transcriptMatch?.[1]) return json(await transcribeFile(ctx, decodeURIComponent(transcriptMatch[1]), options.sttUrl, viewer.kind === "human" ? viewer.id : undefined));
    if (method === "POST" && pathname === "/api/speech") return await postSpeech(req, options.ttsUrl);
    const boxMatch = /^\/api\/box\/([a-z0-9][a-z0-9_-]*)$/.exec(pathname);
    if (method === "POST" && boxMatch?.[1]) return json(await postBox(ctx, req, boxMatch[1], options.boxes ?? {}, viewer.kind === "human" ? viewer.id : undefined));
    const commandMatch = /^\/api\/commands\/([a-z][a-z0-9-]*)$/.exec(pathname);
    if (method === "POST" && commandMatch?.[1]) {
      const person = viewer.kind === "human" ? viewer.id : undefined;
      return json(await postCommand(ctx, req, commandMatch[1], options.commands ?? {}, options.extensions ?? {}, person));
    }
    const boxReportMatch = /^\/api\/box\/([a-z0-9][a-z0-9_-]*)\/(report|usage)$/.exec(pathname);
    if (boxReportMatch?.[1]) {
      const person = viewer.kind === "human" ? viewer.id : undefined;
      const file = path.join(dataDir, "box-reports.jsonl");
      if (method === "POST" && boxReportMatch[2] === "report") return json(await postBoxReport(ctx, req, boxReportMatch[1], options.boxes ?? {}, person, file));
      if (method === "GET" && boxReportMatch[2] === "usage") return json(getBoxUsage(boxReportMatch[1], options.boxes ?? {}, person, file));
    }
    if (method === "POST" && pathname === "/api/settings") return json(await postSetting(ctx, req));
    if (method === "POST" && pathname === "/api/attention") {
      const person = viewer.kind === "human" ? viewer.id : undefined;
      return json(await postAttention(ctx, req, person, path.join(dataDir, "attention.jsonl"), path.join(dataDir, "attention-people.txt")));
    }
    if (pathname.startsWith("/api/push/")) {
      if (viewer.kind !== "human") throw new HttpError(403, "Only a signed-in person's device takes notifications");
      if (method === "GET" && pathname === "/api/push/key") return json({ publicKey: push.publicKey } satisfies PushKeyResponse);
      if (method === "POST" && pathname === "/api/push/subscribe") {
        push.subscribe(viewer.id, await readJsonObject(req));
        return json({ ok: true });
      }
      if (method === "POST" && pathname === "/api/push/unsubscribe") {
        push.unsubscribe(viewer.id, (await readJsonObject(req)).endpoint);
        return json({ ok: true });
      }
      if (method === "POST" && pathname === "/api/push/test") {
        return json({ ok: true, status: await push.test(viewer.id, (await readJsonObject(req)).endpoint) });
      }
    }
    return (await schedule.handle(req, url)) ?? json({ error: `No route for ${method} ${pathname}` }, 404);
  };

  const listen = (listenPort: number, tls?: { cert: Bun.BunFile; key: Bun.BunFile }): Bun.Server<SocketData> =>
    Bun.serve<SocketData>({
      hostname: host,
      port: listenPort,
      tls,
      // Uploads are streamed and capped at MAX_FILE_BYTES in postFile; leave headroom for the cap check.
      maxRequestBodySize: MAX_FILE_BYTES + 1024 * 1024,
      // Bun closes requests idle for 10 s by default, which would cut GET /api/messages/:seq?waitMs= short.
      idleTimeout: MAX_RECEIPT_WAIT_MS / 1000 + 10,
      async fetch(req, srv) {
        const url = new URL(req.url);
        const { pathname } = url;
        if (pathname === "/ws/agent") {
          const token = nonEmptyParam(url, "token");
          const data: SocketData = {
            kind: "agent",
            host: nonEmptyParam(url, "host"),
            path: nonEmptyParam(url, "path"),
            name: nonEmptyParam(url, "name"),
            harness: nonEmptyParam(url, "harness"),
            tokenHash: token ? tokenHash(token) : null,
            addr: srv.requestIP(req)?.address ?? null,
            // One key per window or task, kept across reconnects; harnesses that send none get one per connection.
            sessionKey: nonEmptyParam(url, "session") ?? `connection:${crypto.randomUUID()}`,
            sessionNo: 0,
            activeAt: 0,
            inflight: new Set(),
            id: "",
          };
          if (srv.upgrade(req, { data })) return undefined;
          return json({ error: "Expected a WebSocket upgrade" }, 400);
        }
        if (pathname === "/ws/viewer") {
          // Scripts may sign in with headers here; browsers cannot, and send an `auth` frame first.
          const reader = ctx.readerOf(req);
          const viewer: SocketData = { kind: "viewer", signedIn: reader !== undefined, ...(reader?.kind === "human" ? { human: reader.id } : {}) };
          if (srv.upgrade(req, { data: viewer })) return undefined;
          return json({ error: "Expected a WebSocket upgrade" }, 400);
        }
        if (pathname.startsWith("/ext/")) {
          const forwarded = await forwardExtension(req, url, options.extensions ?? {}, auth);
          if (forwarded) return forwarded;
        }
        if (pathname.startsWith("/api/")) {
          try {
            return await handleApi(req, url);
          } catch (error) {
            const res = errorResponse(error);
            // Sign-in failures are invisible otherwise (they happen on someone's phone): the journal keeps why.
            if (pathname.startsWith("/api/auth/")) {
              const why = error instanceof Error ? error.message : String(error);
              console.warn(`sign-in: ${req.method} ${pathname} → ${res.status} ${why} (${srv.requestIP(req)?.address ?? "?"}, ${req.headers.get("user-agent") ?? "?"})`);
            }
            return res;
          }
        }
        const page = req.method === "GET" ? website.serve(pathname, req.headers) : undefined;
        return page ?? new Response("Not found", { status: 404 });
      },
      websocket: sockets.handlers,
    });

  const server = listen(options.port ?? DEFAULT_BUS_PORT);
  const port = server.port;
  if (port === undefined) throw new Error("Server did not bind a port");
  boundPort = port;
  const lan = resolveLanAddresses(port, host);
  lanUrls = lan.lanUrls;

  let secure: Bun.Server<SocketData> | undefined;
  if (options.https) {
    const { certFile, keyFile } = options.https;
    for (const file of [certFile, keyFile]) {
      if (!existsSync(file)) throw new Error(`TLS file not found: ${file}`);
    }
    secure = listen(options.https.port, { cert: Bun.file(certFile), key: Bun.file(keyFile) });
  }
  const httpsPort = secure?.port;
  boundHttpsPort = httpsPort;

  let stopped = false;
  return {
    url: lan.localUrl,
    port,
    lanUrls,
    httpsPort,
    httpsLanUrls:
      httpsPort === undefined
        ? undefined
        : resolveLanAddresses(httpsPort, host).lanUrls.map((u) => u.replace(/^http:/, "https:")),
    dataDir,
    dbPath,
    async stop() {
      if (stopped) return;
      stopped = true;
      ctx.hub.stop();
      schedule.stop();
      clearInterval(forgetTimer);
      clearInterval(archiveTimer);
      clearInterval(settleTimer);
      clearInterval(expiryTimer);
      await Promise.all([server.stop(true), secure?.stop(true)]);
      ctx.hub.dropSockets();
      db.close();
    },
    signIn: (human) => auth.signIn(human, "in-process"),
    approveAgentToken(token) {
      const hash = tokenHash(token);
      tokens.request(hash, { host: null, addr: null, agent: "(approved in-process)" });
      tokens.decide(hash, "approved", "in-process");
      sockets.settle(hash);
    },
  };
}
