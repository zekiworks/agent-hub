// agent-bus train-suggestions (Ümit #13510, #13512, #13513): fine-tunes a hub's typing-suggestion model (LFM3 1.7B with
// a LoRA) on its own messages, on its own machine, and puts the result at --model-out only if it suggests better than
// the model there now.
//
// 1. export.py: the conversations all the hub's people are members of, and #all (never DMs), up to --test-days ago.
// 2. train.py: a LoRA, merged into the base (LiquidAI/LFM3-1.7B, from Hugging Face on first use). On a GPU with
//    micro-batch 1 and checkpointing, about 9 GB; --cpu takes hours.
// 3. llama.cpp's convert_hf_to_gguf.py: a BF16 GGUF.
// 4. eval.ts: the candidate against the current model (the file at --model-out, or the base model when there is none
//    yet), each in its own llama-server, on the people's messages of the last --test-days days, through the
//    production prompt and cut-offs.
// 5. Better (more suggestions shown and right, and more paired cut points won than lost; weekly.sh's rule, Ümit
//    #13481): the candidate goes to --model-out, the file there before to <name>.previous.gguf. It never stops or
//    starts a service: llama-server reads its model at start, so this prints what to restart.
//
// Nothing leaves the machine: the data, the Python env (made with uv), the outputs (<data-dir>/suggest-training/<date>/).
// --smoke stops after the export and 5 training steps on a sample (24 windows of at most 256 tokens).
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

const HERE = import.meta.dir;
const REPO = path.resolve(HERE, "../../..");
/** Pinned to what the LFM3 loader (lfm3.py) was written for: the env bariton trains in. */
const REQUIREMENTS = [
  "torch==2.14.0",
  "transformers==5.17.0",
  "peft==0.22.0",
  "accelerate==1.16.0",
  "gguf==0.19.0",
  "safetensors==0.8.0",
  "tokenizers==0.23.2",
  "huggingface_hub==1.33.0",
  "numpy==2.5.3",
];
const PYTHON_VERSION = "3.12";
const SAMPLES = 3000;
/** --model-out's default, under the data directory's models/. */
export const MODEL_FILE = "LFM3-1.7B-suggestions-BF16.gguf";
/** The base model as a GGUF, made once in suggest-training/ when there is no model at --model-out to test against. */
const BASE_FILE = "LFM3-1.7B-BF16.gguf";
const UNIT = "agent-bus-train-suggestions";
const LAUNCHD_LABEL = "com.agent-hub.train-suggestions";

const LLAMA_CPP_HELP = `It needs llama.cpp (a recent checkout, which knows LFM3, with llama-server built): give --llama-cpp DIR or set
$LLAMA_CPP. To get one:
  git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
  cmake -S ~/llama.cpp -B ~/llama.cpp/build -DGGML_CUDA=ON     # without an NVIDIA GPU leave out -DGGML_CUDA=ON (Macs use Metal)
  cmake --build ~/llama.cpp/build --config Release -j --target llama-server
then --llama-cpp ~/llama.cpp.`;

export interface TrainSuggestionsOptions {
  dataDir: string;
  /** The people whose shared conversations train it; default: the hub's humans. */
  people?: string[];
  /** CUDA_VISIBLE_DEVICES for training and the test servers; default: what is visible already. */
  gpu?: string;
  cpu: boolean;
  testDays: number;
  modelOut?: string;
  installWeekly: boolean;
  smoke: boolean;
  /** A Python that has REQUIREMENTS; default: a venv made with uv in <data-dir>/suggest-training/venv. */
  python?: string;
  llamaCpp?: string;
  /** Caps training's GPU memory (an error rather than crowding others on a shared GPU). */
  maxGib?: number;
}

/** The hub's humans: whose shared conversations it trains on unless --people names them. */
export function peopleOf(db: Database): string[] {
  return db
    .query<{ id: string }, []>("SELECT id FROM participants WHERE kind = 'human' ORDER BY id")
    .all()
    .map((r) => r.id);
}

/** What eval.ts's summary.json holds that the decision reads. */
export interface EvalSummary {
  cuts: number;
  shownRight: { base: number; tuned: number };
  rightWins: number;
  rightLosses: number;
}

/** The candidate ("tuned") is better: more suggestions shown and right, and more paired cut points won than lost. */
export function isBetter(s: EvalSummary): boolean {
  return s.cuts > 0 && s.shownRight.tuned > s.shownRight.base && s.rightWins > s.rightLosses;
}

/** Where the file at `file` goes when a better one replaces it: X.gguf → X.previous.gguf. */
export function previousOf(file: string): string {
  return /\.gguf$/i.test(file) ? file.replace(/\.gguf$/i, ".previous.gguf") : `${file}.previous`;
}

export interface WeeklySchedule {
  files: Array<{ path: string; text: string }>;
  instructions: string;
}

const systemdArg = (arg: string) => `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
const shellArg = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The weekly rerun of `command` (Sundays 04:00): a systemd user timer on Linux with systemd, a launchd agent on macOS,
 * else a cron line to add by hand. Writes nothing itself and turns nothing on: the caller writes `files`, the person
 * runs what `instructions` say.
 */
export function weeklySchedule(platform: NodeJS.Platform, systemd: boolean, command: string[], env: { PATH: string; HOME: string; XDG_CONFIG_HOME?: string }, log: string): WeeklySchedule {
  const after = `It only replaces the model file; after a run whose log says "Better", restart the llama-server that serves it. Log: ${log}`;
  if (platform === "linux" && systemd) {
    const dir = path.join(env.XDG_CONFIG_HOME || path.join(env.HOME, ".config"), "systemd", "user");
    const service = [
      "[Unit]",
      "Description=Agent Hub: weekly training of the typing-suggestion model on this hub's shared conversations (agent-bus train-suggestions; replaces its --model-out only when better, restarts nothing)",
      "",
      "[Service]",
      "Type=oneshot",
      `Environment=${systemdArg(`PATH=${env.PATH}`)}`,
      `ExecStart=${command.map(systemdArg).join(" ")}`,
      `StandardOutput=append:${log}`,
      `StandardError=append:${log}`,
      "Nice=10",
      // On a CPU it takes hours.
      "TimeoutStartSec=24h",
      "",
    ].join("\n");
    const timer = ["[Unit]", "Description=Agent Hub: weekly training of the typing-suggestion model (Sundays 04:00)", "", "[Timer]", "OnCalendar=Sun *-*-* 04:00:00", "Persistent=true", "", "[Install]", "WantedBy=timers.target", ""].join("\n");
    return {
      files: [
        { path: path.join(dir, `${UNIT}.service`), text: service },
        { path: path.join(dir, `${UNIT}.timer`), text: timer },
      ],
      instructions: `Turn it on (this command did not):\n  systemctl --user daemon-reload && systemctl --user enable --now ${UNIT}.timer\nFor it to run while you are logged out: loginctl enable-linger $USER\n${after}`,
    };
  }
  if (platform === "darwin") {
    const plist = path.join(env.HOME, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(env.PATH)}</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
  <key>Nice</key><integer>10</integer>
</dict>
</plist>
`;
    return {
      files: [{ path: plist, text }],
      instructions: `Turn it on (this command did not):\n  launchctl bootstrap gui/$(id -u) ${shellArg(plist)}\n${after}`,
    };
  }
  // cron turns a bare % into a newline.
  const line = `0 4 * * 0 ${`PATH=${shellArg(env.PATH)} ${command.map(shellArg).join(" ")} >> ${shellArg(log)} 2>&1`.replace(/%/g, "\\%")}`;
  return { files: [], instructions: `Add this line with crontab -e (this command did not):\n${line}\n${after}` };
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");

function tail(file: string, lines = 20): string {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One run per data directory at a time; a lock left by a run that died is taken over. */
function lock(file: string): () => void {
  try {
    writeFileSync(file, String(process.pid), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(readFileSync(file, "utf8"));
    if (pid && pid !== process.pid && alive(pid)) throw new Error(`Another train-suggestions (pid ${pid}) is running (${file})`);
    writeFileSync(file, String(process.pid));
  }
  return () => rmSync(file, { force: true });
}

function llamaCppOf(dir: string | undefined): { convert: string; server: string } {
  if (!dir) throw new Error(LLAMA_CPP_HELP);
  const convert = path.join(dir, "convert_hf_to_gguf.py");
  const server = [path.join(dir, "build", "bin", "llama-server"), path.join(dir, "llama-server")].find((f) => existsSync(f));
  if (!existsSync(convert) || !server) throw new Error(`${dir} has no ${existsSync(convert) ? "llama-server (build/bin/llama-server)" : "convert_hf_to_gguf.py"}.\n${LLAMA_CPP_HELP}`);
  return { convert, server };
}

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => resolve(port));
  });
  return promise;
}

/** Runs it, or writes the weekly timer with --install-weekly. Resolves with the exit code. */
export async function trainSuggestions(options: TrainSuggestionsOptions): Promise<number> {
  const dataDir = path.resolve(options.dataDir);
  const dbPath = path.join(dataDir, "message-bus.sqlite");
  if (!existsSync(dbPath)) throw new Error(`No hub database at ${dbPath} (--data-dir)`);
  const modelOut = path.resolve(options.modelOut ?? path.join(dataDir, "models", MODEL_FILE));
  const llamaCppDir = options.llamaCpp ?? process.env.LLAMA_CPP;
  const root = path.join(dataDir, "suggest-training");
  mkdirSync(root, { recursive: true, mode: 0o700 });

  if (options.installWeekly) {
    llamaCppOf(llamaCppDir);
    const args = ["train-suggestions", "--data-dir", dataDir, "--model-out", modelOut, "--test-days", String(options.testDays)];
    if (options.people) args.push("--people", options.people.join(","));
    if (options.cpu) args.push("--cpu");
    if (options.gpu !== undefined) args.push("--gpu", options.gpu);
    if (options.python) args.push("--python", path.resolve(options.python));
    args.push("--llama-cpp", path.resolve(llamaCppDir!));
    if (options.maxGib !== undefined) args.push("--max-gib", String(options.maxGib));
    const agentBus = Bun.which("agent-bus");
    const command = agentBus ? [agentBus, ...args] : [process.execPath, "run", path.join(REPO, "packages", "cli", "src", "bin.ts"), ...args];
    const schedule = weeklySchedule(
      process.platform,
      existsSync("/run/systemd/system"),
      command,
      // This shell's PATH (uv, bun), without the node_modules/.bin entries `bun run` puts in front.
      { PATH: [...new Set((process.env.PATH ?? "/usr/bin:/bin").split(":").filter((p) => p && !p.endsWith("node_modules/.bin")))].join(":"), HOME: homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME },
      path.join(root, "weekly.log"),
    );
    for (const file of schedule.files) {
      mkdirSync(path.dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.text);
      console.log(`Wrote ${file.path}`);
    }
    console.log(schedule.instructions);
    return 0;
  }

  let people = options.people;
  if (!people) {
    const db = new Database(dbPath, { readonly: true });
    try {
      people = peopleOf(db);
    } finally {
      db.close();
    }
  }
  if (people.length === 0) throw new Error(`No humans in ${dbPath}; name them with --people`);
  const llama = options.smoke ? undefined : llamaCppOf(llamaCppDir);
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const work = path.join(root, date + (options.smoke ? "-smoke" : ""));
  mkdirSync(work, { recursive: true, mode: 0o700 });

  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
  // --cpu hides the GPUs from torch and from a CUDA build of llama-server alike.
  if (options.cpu) env.CUDA_VISIBLE_DEVICES = "";
  else if (options.gpu !== undefined) env.CUDA_VISIBLE_DEVICES = options.gpu;

  const children = new Set<ChildProcess>();
  const release = lock(path.join(root, "lock"));
  const stop = (signal: NodeJS.Signals) => {
    for (const child of children) child.kill("SIGTERM");
    release();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const say = (text: string) => console.log(`${new Date().toTimeString().slice(0, 5)} ${text}`);

  /** Starts `cmd` with its output in `log`; the promise settles when it ends, rejecting on a failure. */
  const start = (cmd: string, args: string[], log: string): { child: ChildProcess; done: Promise<void> } => {
    const fd = openSync(log, "w", 0o600);
    const child = spawn(cmd, args, { cwd: HERE, env, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    children.add(child);
    const { promise: done, resolve, reject } = Promise.withResolvers<void>();
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`${`${path.basename(cmd)} ${path.basename(args[0] ?? "")}`.trim()} failed (${signal ?? `exit ${code}`}); the end of ${log}:\n${tail(log)}`));
    });
    return { child, done };
  };
  const run = (cmd: string, args: string[], log: string) => start(cmd, args, log).done;

  try {
    let python = options.python;
    if (!python) {
      const uv = Bun.which("uv");
      if (!uv) throw new Error("It needs uv for its Python env: curl -LsSf https://astral.sh/uv/install.sh | sh (or give --python FILE)");
      const venv = path.join(root, "venv");
      python = path.join(venv, "bin", "python");
      if (!existsSync(python)) {
        say(`Making the Python env ${venv} (torch, transformers, peft, gguf: a few GB on the first run)`);
        await run(uv, ["venv", "--python", PYTHON_VERSION, venv], path.join(root, "venv.log"));
      }
      // Quick when everything is there already; --torch-backend auto picks the CUDA build the driver can run, or CPU.
      await run(uv, ["pip", "install", "--python", python, "--torch-backend", "auto", ...REQUIREMENTS], path.join(root, "pip.log"));
    }
    if (!options.cpu) {
      const check = Bun.spawnSync({ cmd: [python, "-c", "import sys, torch; sys.exit(0 if torch.cuda.is_available() else 3)"], env, stderr: "pipe" });
      if (check.exitCode !== 0) {
        throw new Error(
          check.exitCode === 3
            ? `No CUDA GPU is visible here${env.CUDA_VISIBLE_DEVICES !== undefined ? ` (CUDA_VISIBLE_DEVICES=${env.CUDA_VISIBLE_DEVICES})` : ""}: give --gpu N, or --cpu (it takes hours)`
            : `${python} cannot import torch:\n${check.stderr.toString().trim()}`,
        );
      }
    }

    const cutoff = new Date(Date.now() - options.testDays * 86_400_000).toISOString();
    say(`Exporting the conversations ${people.join(", ")} are all in, and #all (no DMs), up to ${cutoff}`);
    await run(python, ["export.py", "--db", dbPath, "--people", people.join(","), "--cutoff", cutoff, "--out", path.join(work, "data")], path.join(work, "export.log"));
    const stats = JSON.parse(readFileSync(path.join(work, "data", "stats.json"), "utf8")) as { messages: number; people_messages: number; conversations: number; tokens_train: number };
    say(`Exported ${stats.messages} messages (${stats.people_messages} of the people's) from ${stats.conversations} conversations, ${stats.tokens_train} tokens to train on`);

    say(`Training on the ${options.cpu ? "CPU (hours)" : "GPU"}; log: ${path.join(work, "train.log")}`);
    const trainArgs = ["train.py", "--data", path.join(work, "data"), "--out", work, "--people", people.join(","), "--device", options.cpu ? "cpu" : "cuda", "--micro-batch", "1", "--checkpointing"];
    if (options.maxGib !== undefined) trainArgs.push("--max-gib", String(options.maxGib));
    // 24 windows are 3 batches of 8 an epoch, so two epochs reach the 5 steps.
    if (options.smoke) trainArgs.push("--max-steps", "5", "--max-windows", "24", "--max-tokens", "256", "--no-merge");
    await run(python, trainArgs, path.join(work, "train.log"));
    const trained = JSON.parse(readFileSync(path.join(work, "train-log.json"), "utf8")) as { total_steps: number; train_seconds: number; heldout_before: { all: number }; heldout_after: { all: number } };
    say(`Trained: ${trained.total_steps} steps in ${trained.train_seconds} s, held-out loss ${trained.heldout_before.all.toFixed(3)} → ${trained.heldout_after.all.toFixed(3)}`);
    if (options.smoke) {
      say(`Smoke run: stopped after the export and ${trained.total_steps} training steps; nothing converted, tested or installed. Outputs: ${work}`);
      return 0;
    }
    if (!llama) throw new Error(LLAMA_CPP_HELP);

    const candidate = path.join(work, `LFM3-1.7B-suggestions-${date}-BF16.gguf`);
    say("Converting to GGUF");
    await run(python, [llama.convert, path.join(work, "merged"), "--outtype", "bf16", "--outfile", candidate], path.join(work, "convert.log"));
    rmSync(path.join(work, "merged"), { recursive: true, force: true }); // lora/ rebuilds it

    let current = modelOut;
    if (!existsSync(current)) {
      current = path.join(root, BASE_FILE);
      if (!existsSync(current)) {
        say(`No model at ${modelOut} yet: testing against the base model, converted once to ${current}`);
        const base = Bun.spawnSync({ cmd: [python, "lfm3.py"], cwd: HERE, env, stderr: "inherit" });
        if (base.exitCode !== 0) throw new Error("lfm3.py could not find or download the base model");
        await run(python, [llama.convert, base.stdout.toString().trim(), "--outtype", "bf16", "--outfile", current], path.join(root, "convert-base.log"));
      }
    }

    say(`Testing the candidate against ${current} on the people's messages since ${cutoff}`);
    const servers = [];
    for (const [label, model] of [["current", current], ["candidate", candidate]] as const) {
      const port = await freePort();
      const log = path.join(work, `server-${label}.log`);
      const args = ["-m", model, "--host", "127.0.0.1", "--port", String(port), "-ngl", options.cpu ? "0" : "99", "-c", "8192", "-np", "2", "--no-webui"];
      const server = start(llama.server, args, log);
      server.done.catch(() => {}); // it ends when killed below; one that exits early is noticed while waiting for it
      servers.push({ ...server, url: `http://127.0.0.1:${port}`, log });
    }
    try {
      for (const server of servers) {
        const until = Date.now() + (options.cpu ? 600_000 : 300_000);
        while (!(await fetch(`${server.url}/health`).then((r) => r.ok, () => false))) {
          if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error(`llama-server exited; the end of ${server.log}:\n${tail(server.log)}`);
          if (Date.now() > until) throw new Error(`llama-server on ${server.url} did not load its model in time (${server.log})`);
          await Bun.sleep(1000);
        }
      }
      const results = path.join(work, "results");
      const evalArgs = ["run", "eval.ts", servers[0]!.url, servers[1]!.url, "--db", dbPath, "--people", people.join(","), "--cutoff", cutoff, "--out", results, "--samples", String(SAMPLES), "--labels", "current,candidate"];
      await run(process.execPath, evalArgs, path.join(work, "eval.log"));
    } finally {
      for (const server of servers) server.child.kill("SIGTERM");
    }

    const summary = JSON.parse(readFileSync(path.join(work, "results", "summary.json"), "utf8")) as EvalSummary;
    console.log(`\n${readFileSync(path.join(work, "results", "table.md"), "utf8")}`);
    const verdict = `shown & right ${pct(summary.shownRight.tuned, summary.cuts)} (candidate) vs ${pct(summary.shownRight.base, summary.cuts)} (current), paired ${summary.rightWins} wins / ${summary.rightLosses} losses`;
    const better = isBetter(summary);
    let previous: string | undefined;
    if (better) {
      previous = installModel(candidate, modelOut);
      say(`Better: ${verdict}. Now at ${modelOut}${previous ? `; the one before is kept as ${previous}` : ""}.`);
      for (const line of restartHints(modelOut, previous)) console.log(line);
    } else {
      rmSync(candidate, { force: true }); // the adapter stays in lora/
      const kept = current === modelOut ? `Kept ${modelOut}` : `Nothing written to ${modelOut}`;
      say(
        summary.cuts === 0
          ? `Nothing to test on (no messages of ${people.join(", ")} since ${cutoff}). ${kept}.`
          : `Not better: ${verdict}. ${kept}; nothing to restart.`,
      );
    }
    writeFileSync(
      path.join(work, "result.json"),
      JSON.stringify({ date, people, cutoff, current, modelOut, installed: better, previous: previous ?? null, verdict, cuts: summary.cuts }, null, 2) + "\n",
    );
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    release();
  }
}

/**
 * Puts `candidate` at `modelOut`, the file there before (if any) moved to previousOf(modelOut), whose path it returns.
 * Next to the target first, then two renames: a running llama-server keeps the file it has open.
 */
export function installModel(candidate: string, modelOut: string): string | undefined {
  mkdirSync(path.dirname(modelOut), { recursive: true });
  const partial = `${modelOut}.partial`;
  try {
    renameSync(candidate, partial);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(candidate, partial);
    rmSync(candidate);
  }
  let previous: string | undefined;
  if (existsSync(modelOut)) renameSync(modelOut, (previous = previousOf(modelOut)));
  renameSync(partial, modelOut);
  return previous;
}

/** What to restart for the new file to be used: systemd user units whose command names it, or the general rule. */
function restartHints(modelOut: string, previous: string | undefined): string[] {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "systemd", "user");
  let units: string[] = [];
  try {
    units = readdirSync(dir).filter((f) => f.endsWith(".service") && readFileSync(path.join(dir, f), "utf8").includes(modelOut));
  } catch {
    // no systemd user units here
  }
  const lines = units.length
    ? [`Restart the model server to load it (this command did not): systemctl --user restart ${units.join(" ")}`]
    : [
        `llama-server reads its model only at start: restart the one that serves ${modelOut} (this command did not), or start one,`,
        `  llama-server -m ${shellArg(modelOut)} --port 9962, with packages/complete-ext/src/server.ts on COMPLETE_LLAMA_URL=http://127.0.0.1:9962 COMPLETE_HEAL=0`,
      ];
  if (previous) lines.push(`To switch back: mv ${shellArg(previous)} ${shellArg(modelOut)}, then restart it again.`);
  return lines;
}
