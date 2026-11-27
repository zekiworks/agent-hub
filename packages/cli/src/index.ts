import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import os, { homedir, hostname } from "node:os";
import path from "node:path";
import { AgentTokens, createBusServer, createInvite, renameAgent, type BusServerOptions } from "@agent-bus/server";
import { DEFAULT_BUS_PORT } from "@agent-bus/protocol";
import type { TrainSuggestionsOptions } from "../../complete-ext/finetune/train-suggestions";
import { runTicketed } from "./run";

const USAGE = `Usage: agent-bus serve [--host 0.0.0.0] [--port 7800] [--data-dir DIR [--existing-data]] --humans carol,uma
                       [--https-port 7843 --tls-cert FILE --tls-key FILE] [--gpudash URL] [--forget-offline-days 15]
                       [--rp-id HOST [--origin URL]…] [--public-url URL]… [--stt-url URL] [--tts-url URL] [--task-ext URL] [--ext NAME=URL[,launcher=LABEL|,box=complete|recipient|needs]]… [--bug-reports-to AGENT]
                       [--brand-name NAME [--brand-logo FILE] [--brand-icon FILE]]
       agent-bus invite HUMAN [--data-dir DIR] [--url http://localhost:7800]
       agent-bus agents [--data-dir DIR]
       agent-bus approve|deny CODE [--data-dir DIR]
       agent-bus reset-agent AGENT [--data-dir DIR]
       agent-bus rename-agent AGENT NEW-ID [--path FOLDER] [--data-dir DIR]
       agent-bus run [--bus URL] RESERVATION[,RESERVATION…] -- COMMAND [ARGS…]
       agent-bus install HARNESS [--url http://HUB:7800] [--dir DIR] [--build-only] [--force]
       agent-bus uninstall HARNESS [--dir DIR]
       agent-bus doctor [--url http://HUB:7800]
       agent-bus up [--url http://HUB:7800] [--session 0] [--since-days 7] [--dry-run]
       agent-bus train-suggestions [--data-dir DIR] [--people carol,uma] [--gpu N | --cpu] [--test-days 4] [--model-out FILE]
                               [--llama-cpp DIR] [--python FILE] [--max-gib N] [--install-weekly] [--smoke]

install / uninstall: put this machine's HARNESS on the Hub, or take it off. HARNESS is one of
  omp, pi           an extension file in ~/.omp/agent/extensions or ~/.pi/agent/extensions that loads this checkout
  claude            a plugin in a local marketplace (~/.agent-bus/claude-marketplace), installed with the claude CLI
  codex             a plugin in a local marketplace (~/.agent-bus/codex-marketplace), registered with the codex CLI
  copilot           a Copilot CLI extension (~/.copilot/extensions): Copilot CLI and app sessions
  opencode          an OpenCode V2 server plugin in ~/.config/opencode/plugins/agent-bus (respects XDG_CONFIG_HOME)
  antigravity       a plugin folder in ~/.gemini/config/plugins/message-bus
  qwen, grok        a harness-native stdio MCP bridge
  cli               this command, as ~/.local/bin/agent-bus
  --url defaults to the URL of the install being replaced, then $AGENT_BUS_URL, then http://127.0.0.1:7800.
  Installing again updates. --force replaces a file at the install path that agent-bus did not write (moved aside).
  codex only: --bind-current-transcript FILE (run inside a pre-1.5 chat to seed its reopen binding).
  grok only: --leader turns on Grok's leader mode, which it needs to wake for Hub messages; --no-leader leaves it as it
  is. Without either, the installer asks on a terminal, and leaves it as it is when there is none.

up: after a reboot, asks the Hub which agents ran on this machine (omp and pi, seen within --since-days) and opens a
  tmux window for each in its folder that resumes its last session (omp -c, pi -c), in session --session (created if
  missing). Agents that already have a window in their folder are left alone, so running it again adds only what is
  missing. --dry-run lists what it would do.

doctor: what is installed here, which Hub each install joins, whether it is reachable, which agents of this machine
  are on it, and the agent token.

train-suggestions: fine-tunes the typing-suggestion model (LFM3 1.7B) on this hub's own messages, on this machine;
  nothing leaves it. Only conversations all the hub's people (its humans, or --people) are in, and #all; never DMs.
  Trains on messages up to --test-days ago, then tests the candidate against the model at --model-out (default
  DATA-DIR/models/LFM3-1.7B-suggestions-BF16.gguf; the base model while there is none) on the people's messages of
  those days, through the production prompt, and puts it there only if it is better (the file before stays as
  *.previous.gguf). Prints the table and what to restart; it never stops or restarts a service itself.
  Needs uv (its Python env goes to DATA-DIR/suggest-training/venv, or --python FILE), llama.cpp (--llama-cpp DIR or
  $LLAMA_CPP) and a GPU with about 10 GB (--gpu N picks one; --cpu takes hours). Outputs: DATA-DIR/suggest-training/.
  --max-gib caps training's GPU memory on a shared GPU. --install-weekly: instead of a run, a weekly rerun with the
  same options (systemd user timer, launchd agent, or a cron line to add). --smoke: the export and 5 training steps on
  a sample, then stops.

serve:
  --host        Interface to bind (default 0.0.0.0)
  --port        Port to listen on (default 7800; 0 picks a free port)
  --data-dir    Data directory (default $AGENT_BUS_DATA_DIR or ~/.agent-bus)
  --existing-data  Only open an existing database there: if message-bus.sqlite is missing (an unmounted volume),
                stop instead of starting a new, empty Hub
  --humans      Comma-separated ids of the humans who use the website (required; or $BUS_HUMANS)
  --https-port  Also serve over TLS on this port (for browsers; agents keep the plain port)
  --tls-cert    PEM certificate for --https-port
  --tls-key     PEM private key for --https-port
  --gpudash     gpudash's URL (e.g. http://127.0.0.1:3420): the resource schedule reads what runs on each GPU
  --stt-url     Speech-to-text service (packages/stt, e.g. http://127.0.0.1:7810): voice messages get their text
  --task-ext    Task extension service (packages/task-ext, normally http://127.0.0.1:7834)
  --ext         A web page shown in the website's Workspace (repeatable), served at /ext/NAME/ to signed-in people only.
                NAME=URL: a tab of the project @@NAME and of agent NAME's DM (e.g. compactor=http://127.0.0.1:8899);
                NAME=URL,launcher=LABEL: a global item opened from the top bar (e.g. gpudash=http://127.0.0.1:3420,launcher=GPUs);
                NAME=URL,agents=LABEL: a tab LABEL on every agent's page, URL?agent=ID (e.g. status=http://127.0.0.1:7833,agents=Home);
  --tts-url     Text-to-speech server (llama-server with LFM3-Audio, e.g. http://127.0.0.1:9941): ▶ reads messages aloud
  --bug-reports-to  The agent that gets the website's crash reports and Tools → Report a problem, as direct messages
  --brand-name  The website's name instead of "Agent Hub" (e.g. "Team Hub"); --brand-logo: the header's mark and home-screen
                icon (an image file); --brand-icon: the browser tab's icon (a small PNG)
  --forget-offline-days  Forget agents offline this many days (default 15; 0 keeps them forever)
  --public-url  Another address the website is reachable at (e.g. https://bariton.tailnet.ts.net through tailscale
                serve); offered first for linking a device by QR code. Repeatable.
  --rp-id       The host name people open the website at (passkeys are bound to it); default localhost
  --origin      A website origin passkeys may be used from (repeat); default https://<rp-id>:<https port>
                and http://localhost:<port>
  Everyone reading or writing is identified: people sign in with a passkey, agents send their machine account's
  agent token, which a person allows once (website, or agent-bus approve).

invite: a one-time link (10 min) for HUMAN to create a passkey; needs the Hub's database, so only the Hub's host can.
  --url is where the person opens the website: default http://localhost:7800 (a plain install on this machine; passkeys
  work on localhost); a Hub served over https on a host name gives that, e.g. --url https://HOST:7843.

agents: the machine accounts' agent tokens, waiting or decided, with the agents that joined with them.
approve / deny: decide a waiting token by the code its agents show (or a token id from agents); deny also revokes
  an approved one. Both need the Hub's database, as does reset-agent.

reset-agent: unbind AGENT from its agent token (lost token file, agent moved to another machine); the next
  join claims it again. Needs the Hub's database.

rename-agent: give AGENT the id NEW-ID everywhere the Hub keeps it (messages, conversations, its project @@AGENT,
  checklists, bookings); @AGENT stays an alias that still reaches it. --path also moves where it lives, so the harness
  started in FOLDER joins as NEW-ID with its history (the old folder's session is then refused). Stop the Hub first.

run: start COMMAND on the GPUs of active reservations only (CUDA_VISIBLE_DEVICES), marked as theirs.
  --bus defaults to $AGENT_BUS_URL or http://127.0.0.1:${DEFAULT_BUS_PORT}.`;

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port "${value}"`);
  return port;
}

function parseServeArgs(args: string[]): BusServerOptions {
  const options: BusServerOptions = {};
  const tls: { port?: number; certFile?: string; keyFile?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--existing-data") {
      options.existingData = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    switch (flag) {
      case "--host":
        options.host = value;
        break;
      case "--port":
        options.port = parsePort(value);
        break;
      case "--https-port":
        tls.port = parsePort(value);
        break;
      case "--tls-cert":
        tls.certFile = value;
        break;
      case "--tls-key":
        tls.keyFile = value;
        break;
      case "--gpudash":
        options.gpudash = value;
        break;
      case "--stt-url":
        options.sttUrl = value;
        break;
      case "--tts-url":
        options.ttsUrl = value;
        break;
      case "--bug-reports-to":
        options.bugReportsTo = value.replace(/^@/, "").toLowerCase();
        break;
      case "--task-ext":
        options.taskExtension = value;
        break;
      case "--ext": {
        const eq = value.indexOf("=");
        const name = value.slice(0, eq);
        if (eq < 1 || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error(`--ext wants name=url[,launcher=Label|,box=complete|recipient|needs], got "${value}"`);
        // ",launcher=Label" makes it a global Workspace item with a top-bar launcher (#10211); ",box=ROLE" a service the
        // message box asks while a person types, not a Workspace page: "complete" (Can #12853), "recipient" (Ümit #13030);
        // or one the bus asks about agents' messages: "needs" (Ümit #14881, the Inbox's "Waiting for your answer").
        const [url = "", ...extras] = value.slice(eq + 1).split(",");
        const box = extras.find((extra) => extra.startsWith("box="))?.slice(4);
        if (box !== undefined) {
          if ((box !== "complete" && box !== "recipient" && box !== "needs") || extras.length > 1) {
            throw new Error(`--ext ${name}: box= takes complete, recipient or needs, and no other option`);
          }
          (options.boxes ??= {})[name] = { url, role: box };
          break;
        }
        (options.extensions ??= {})[name] = url;
        // ",agents=Label": a tab on every agent's page (its @@project and its DM), the frame told which agent with
        // ?agent=ID (Can #14261).
        for (const extra of extras) {
          const [key = "", label = ""] = extra.split(/=(.*)/s);
          if (!label) throw new Error(`--ext ${name}: "${extra}" wants a value (launcher=Label or agents=Label)`);
          if (key === "launcher") (options.launchers ??= {})[name] = label;
          else if (key === "agents") (options.agentTabs ??= {})[name] = label;
          else throw new Error(`--ext ${name}: unknown option "${extra}" (launcher=, agents= or box=)`);
        }
        break;
      }
      case "--brand-name":
        options.brand = { ...options.brand, name: value };
        break;
      case "--brand-logo":
      case "--brand-icon": {
        if (!existsSync(value)) throw new Error(`${flag}: no file "${value}"`);
        options.brand = { name: options.brand?.name ?? "Agent Hub", ...options.brand, [flag === "--brand-logo" ? "logo" : "icon"]: path.resolve(value) };
        break;
      }
      case "--public-url":
        (options.publicUrls ??= []).push(value.replace(/\/+$/, ""));
        break;
      case "--forget-offline-days": {
        const days = Number(value);
        if (!Number.isFinite(days) || days < 0) throw new Error("--forget-offline-days is a number of days, 0 to keep agents forever");
        options.forgetOfflineDays = days;
        break;
      }
      case "--data-dir":
        options.dataDir = value;
        break;
      case "--humans":
        options.humans = value.split(",");
        break;
      case "--rp-id":
        options.auth = { ...options.auth, rpId: value };
        break;
      case "--origin":
        options.auth = { ...options.auth, origins: [...(options.auth?.origins ?? []), value.replace(/\/+$/, "")] };
        break;
      default:
        throw new Error(`Unknown option "${flag}"`);
    }
  }
  const tlsGiven = [tls.port, tls.certFile, tls.keyFile].filter((v) => v !== undefined).length;
  if (tlsGiven > 0) {
    if (tls.port === undefined || tls.certFile === undefined || tls.keyFile === undefined) {
      throw new Error("--https-port, --tls-cert and --tls-key go together");
    }
    options.https = { port: tls.port, certFile: tls.certFile, keyFile: tls.keyFile };
  }
  return options;
}

async function runUpCommand(args: string[]): Promise<number> {
  const opts = { url: process.env.AGENT_BUS_URL || `http://127.0.0.1:${DEFAULT_BUS_PORT}`, session: "0", sinceDays: 7, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--url") opts.url = value().replace(/\/+$/, "");
    else if (arg === "--session") opts.session = value();
    else if (arg === "--since-days") {
      opts.sinceDays = Number(value());
      if (!Number.isFinite(opts.sinceDays) || opts.sinceDays <= 0) throw new Error("--since-days must be a number of days above 0");
    } else if (arg === "--dry-run") opts.dryRun = true;
    else throw new Error(`Unknown option ${arg}\n\n${USAGE}`);
  }
  return (await import("./up")).runUp(opts);
}

async function runTrainSuggestions(args: string[]): Promise<number> {
  const opts: TrainSuggestionsOptions = {
    dataDir: process.env.AGENT_BUS_DATA_DIR || path.join(homedir(), ".agent-bus"),
    cpu: false,
    testDays: 4,
    installWeekly: false,
    smoke: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--data-dir") opts.dataDir = value();
    else if (arg === "--people") {
      opts.people = value()
        .split(",")
        .map((p) => p.trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean);
    } else if (arg === "--gpu") opts.gpu = value();
    else if (arg === "--cpu") opts.cpu = true;
    else if (arg === "--test-days") {
      opts.testDays = Number(value());
      if (!Number.isFinite(opts.testDays) || opts.testDays <= 0) throw new Error("--test-days must be a number of days above 0");
    } else if (arg === "--model-out") opts.modelOut = value();
    else if (arg === "--llama-cpp") opts.llamaCpp = value();
    else if (arg === "--python") opts.python = value();
    else if (arg === "--max-gib") {
      opts.maxGib = Number(value());
      if (!Number.isFinite(opts.maxGib) || opts.maxGib <= 0) throw new Error("--max-gib must be a number above 0");
    } else if (arg === "--install-weekly") opts.installWeekly = true;
    else if (arg === "--smoke") opts.smoke = true;
    else throw new Error(`Unknown option ${arg}\n\n${USAGE}`);
  }
  if (opts.cpu && opts.gpu !== undefined) throw new Error("--gpu or --cpu, not both");
  if (opts.people?.length === 0) throw new Error("--people needs at least one id");
  // Loaded here, not at the top: only this command needs it.
  return (await import("../../complete-ext/finetune/train-suggestions")).trainSuggestions(opts);
}

/** Runs the CLI; resolves with the exit code, or never resolves while `serve` runs. */
export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === "agents" || command === "approve" || command === "deny") {
    try {
      return runTokens(command, rest);
    } catch (error) {
      console.error(`agent-bus ${command}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (command === "rename-agent") {
    try {
      return runRenameAgent(rest);
    } catch (error) {
      console.error(`agent-bus rename-agent: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (command === "reset-agent") {
    try {
      return runResetAgent(rest);
    } catch (error) {
      console.error(`agent-bus reset-agent: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (command === "invite") {
    try {
      return runInvite(rest);
    } catch (error) {
      console.error(`agent-bus invite: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (command === "run") {
    try {
      return await runTool(command, rest);
    } catch (error) {
      console.error(`agent-bus ${command}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (command === "install" || command === "uninstall" || command === "doctor") {
    try {
      return await runInstall(command, rest);
    } catch (error) {
      console.error(`agent-bus ${command}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (command === "up") {
    try {
      return await runUpCommand(rest);
    } catch (error) {
      console.error(`agent-bus up: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (command === "train-suggestions") {
    try {
      return await runTrainSuggestions(rest);
    } catch (error) {
      console.error(`agent-bus train-suggestions: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (command !== "serve") {
    console.error(`Unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }
  let options: BusServerOptions;
  try {
    options = parseServeArgs(rest);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 1;
  }

  let bus: ReturnType<typeof createBusServer>;
  try {
    bus = createBusServer(options);
  } catch (error) {
    console.error(`agent-bus serve: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.log(`agent-bus listening on ${bus.url}`);
  for (const lanUrl of bus.lanUrls) console.log(`  LAN: ${lanUrl}`);
  for (const httpsUrl of bus.httpsLanUrls ?? []) console.log(`  HTTPS: ${httpsUrl}`);
  console.log(`  data: ${bus.dataDir}`);

  const { promise, resolve } = Promise.withResolvers<number>();
  const shutdown = (): void => {
    void bus.stop().then(() => resolve(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return promise;
}

/** The bus's database (`--data-dir`, $AGENT_BUS_DATA_DIR, ~/.agent-bus), for the commands that only the host can run. */
function openBusDatabase(dataDir: string): Database {
  const dbPath = path.join(dataDir, "message-bus.sqlite");
  if (!existsSync(dbPath)) throw new Error(`No Hub database at ${dbPath}`);
  const db = new Database(dbPath, { strict: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

function runTokens(command: "agents" | "approve" | "deny", args: string[]): number {
  let dataDir = process.env.AGENT_BUS_DATA_DIR || path.join(homedir(), ".agent-bus");
  let ref: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--data-dir") dataDir = args[++i] ?? "";
    else if (arg.startsWith("--")) throw new Error(`Unknown option "${arg}"`);
    else ref = arg;
  }
  const db = openBusDatabase(dataDir);
  try {
    const tokens = new AgentTokens(db);
    if (command === "agents") {
      const list = tokens.list();
      if (list.length === 0) console.log("No agent tokens yet.");
      for (const t of list) {
        const when = new Date(t.lastUsedAt ?? t.requestedAt).toISOString().slice(0, 16).replace("T", " ");
        console.log(`${t.state.padEnd(8)} ${t.code}  ${t.id}  ${t.host ?? "?"}${t.addr ? ` (${t.addr})` : ""}  ${t.agents.join(", ")}  ${when}`);
      }
      return 0;
    }
    if (!ref) throw new Error(`Give the code the agent shows, e.g. agent-bus ${command} K7Q-2MX (agent-bus agents lists them)`);
    const hash = tokens.resolve(ref);
    if (!hash) throw new Error(`No agent token ${ref} (agent-bus agents lists them)`);
    tokens.decide(hash, command === "approve" ? "approved" : "denied", `${os.userInfo().username} on the host`);
    console.log(`${command === "approve" ? "Allowed" : "Denied"} ${ref}; the Hub applies it within a few seconds.`);
    return 0;
  } finally {
    db.close();
  }
}

function runRenameAgent(args: string[]): number {
  let dataDir = process.env.AGENT_BUS_DATA_DIR || path.join(homedir(), ".agent-bus");
  let folder: string | undefined;
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--data-dir") dataDir = args[++i] ?? "";
    else if (arg === "--path") folder = path.resolve(args[++i] ?? "");
    else if (arg.startsWith("--")) throw new Error(`Unknown option "${arg}"`);
    else ids.push(arg);
  }
  const [from, to] = ids;
  if (!from || !to || ids.length > 2) throw new Error("Give the agent and its new id, e.g. agent-bus rename-agent turkce jack");
  const db = openBusDatabase(dataDir);
  try {
    const r = renameAgent(db, from, to, folder);
    const oldId = from.replace(/^@+/, "").toLowerCase();
    const newId = to.replace(/^@+/, "").toLowerCase();
    console.log(
      `@${oldId} is now @${newId}: ${r.messages} messages, ${r.conversations} conversations${r.project ? `, project @@${r.project}` : ""}${folder ? `, lives in ${folder}` : ""}. @${oldId} stays an alias.`
    );
    if (r.siblings.length > 0) console.log(`Not renamed (other harnesses of its folder): ${r.siblings.map((id) => `@${id}`).join(", ")}`);
    console.log("Start the Hub again, then the agent's harness" + (folder ? ` in ${folder}.` : "."));
  } finally {
    db.close();
  }
  return 0;
}

function runResetAgent(args: string[]): number {
  let dataDir = process.env.AGENT_BUS_DATA_DIR || path.join(homedir(), ".agent-bus");
  let agent: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--data-dir") dataDir = args[++i] ?? "";
    else if (arg.startsWith("--")) throw new Error(`Unknown option "${arg}"`);
    else agent = arg.replace(/^@/, "").toLowerCase();
  }
  if (!agent) throw new Error("Give the agent's id, e.g. agent-bus reset-agent webapp");
  const db = openBusDatabase(dataDir);
  const changed = db.query("UPDATE participants SET token_hash = NULL WHERE id = ?1 AND kind = 'agent'").run(agent).changes;
  db.close();
  if (changed === 0) throw new Error(`No agent @${agent}`);
  console.log(`@${agent} is free: the next agent that joins as it binds it to its token.`);
  return 0;
}

function runInvite(args: string[]): number {
  let dataDir = process.env.AGENT_BUS_DATA_DIR || path.join(homedir(), ".agent-bus");
  // A plain install's website on this machine: passkeys work on localhost without https (a new user's first link).
  let url = `http://localhost:${DEFAULT_BUS_PORT}`;
  let human: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--data-dir") dataDir = args[++i] ?? "";
    else if (arg === "--url") url = (args[++i] ?? "").replace(/\/+$/, "");
    else if (arg.startsWith("--")) throw new Error(`Unknown option "${arg}"`);
    else human = arg.replace(/^@/, "").toLowerCase();
  }
  if (!human) throw new Error("Give the human's id, e.g. agent-bus invite can");
  const db = openBusDatabase(dataDir);
  const token = createInvite(db, human);
  db.close();
  console.log(`Open within 10 minutes, on the device that should hold ${human}'s passkey (works once):\n${url}/auth#invite=${token}`);
  return 0;
}

async function runTool(command: "run", args: string[]): Promise<number> {
  let bus = (process.env.AGENT_BUS_URL?.trim() || `http://127.0.0.1:${DEFAULT_BUS_PORT}`).replace(/\/+$/, "");
  const positional: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "--bus") bus = (args[++i] ?? "").replace(/\/+$/, "");
    else if (arg.startsWith("--")) throw new Error(`Unknown option "${arg}"`);
    else positional.push(arg);
  }
  if (!bus) throw new Error(`--bus needs a URL (${command})`);
  const ids = positional.flatMap((p) => p.split(",")).map((s) => s.trim()).filter(Boolean);
  return runTicketed(bus, ids, args.slice(i));
}

async function runInstall(command: "install" | "uninstall" | "doctor", args: string[]): Promise<number> {
  const opts: { url?: string; dir?: string; buildOnly?: boolean; force?: boolean; bindTranscript?: string; leader?: boolean } = {};
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const value = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--url") opts.url = value().replace(/\/+$/, "");
    else if (arg === "--dir") opts.dir = value();
    else if (arg === "--build-only" && command === "install") opts.buildOnly = true;
    else if (arg === "--force" && command === "install") opts.force = true;
    else if (arg === "--bind-current-transcript" && command === "install") opts.bindTranscript = value();
    else if ((arg === "--leader" || arg === "--no-leader") && command === "install") opts.leader = arg === "--leader";
    else if (arg.startsWith("--")) throw new Error(`Unknown option "${arg}"`);
    else if (name === undefined && command !== "doctor") name = arg;
    else throw new Error(`Unexpected argument "${arg}"`);
  }
  // Loaded here, not at the top: installers bundle plugin code, which `serve` never needs.
  if (command === "doctor") return (await import("./doctor")).runDoctor(opts.url);
  const { harness, HARNESSES } = await import("./harnesses");
  if (name === undefined) throw new Error(`Name the harness: ${HARNESSES.map((h) => h.name).join(", ")}`);
  if (opts.bindTranscript !== undefined && name !== "codex") throw new Error("--bind-current-transcript is for codex only");
  if (opts.leader !== undefined && name !== "grok") throw new Error(`${opts.leader ? "--leader" : "--no-leader"} is for grok only`);
  const target = harness(name);
  await (command === "install" ? target.install(opts) : target.uninstall(opts));
  return 0;
}
