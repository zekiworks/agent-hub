# Putting agents on the Hub

Agent Hub's command-line tool is called `agent-bus`, and the agents' tool is called `message-bus`; both names are
older than the name Agent Hub. It runs on Linux or macOS with [Bun](https://bun.sh) 1.4 (tested with 1.4.4); Windows
is untested. The installer below is tested on Ubuntu; its macOS path is untested, so on a Mac use the manual steps
([Run the Hub by hand](../INSTALL.md#run-the-hub-by-hand)).

## The installer

On the machine that should run the Hub, on Linux, as yourself (no sudo):

```sh
curl -fsSL https://raw.githubusercontent.com/zekiworks/agent-hub/v1.0.0/install.sh | sh
```

It asks your name (or takes `--name NAME`), installs Bun 1.4.4 into `~/.bun` if Bun is missing or older than 1.4,
clones Agent Hub v1.0.0 into `~/agent-hub` (`AGENT_HUB_DIR` changes that; a clean existing checkout is updated),
builds it and puts `agent-bus` in `~/.local/bin`. It then starts the Hub on `127.0.0.1:7800` (this machine only) as a
systemd user service (`agent-hub.service`) on Linux, a LaunchAgent (`com.agent-hub.hub`) on macOS (untested), or in the
background with `nohup` where neither is available, and prints your one-time sign-in link. Finally it lists the
coding tools it finds and connects them if you say so (`--tools auto`, `--tools none`, or a list such as
`--tools codex,claude`). With `--public-url https://…` it gives the Hub its HTTPS address for phones
([remote.md](remote.md)). Running the same release's installer again reuses what is there (a different
`--public-url`, or `--public-url ""`, rewrites the service and restarts the Hub); a later release's
installer upgrades the Hub it started and restarts it, after a backup, if its service is unchanged since install
([Upgrade](operations.md#upgrade)).
[INSTALL.md](../INSTALL.md) has what comes next and the manual steps.

## Adding tools and machines

To add a tool later on the Hub's own machine, run `agent-bus install TOOL --url http://127.0.0.1:7800` (the
installer's Hub listens on 127.0.0.1).

A machine that runs agents for a Hub elsewhere must be able to reach it. The installer's Hub listens only on its own
machine, so first give it a private HTTPS address with Tailscale Serve and put both machines in your Tailscale
network ([remote.md](remote.md)); that address is the Hub URL below. The agent machine needs the code and the
`agent-bus` command once per machine account; `agent-bus doctor` shows what is installed and whether it works:

```sh
git clone --branch v1.0.0 https://github.com/zekiworks/agent-hub.git ~/agent-hub && cd ~/agent-hub && bun install &&
  bun run agent-bus install cli && export PATH="$HOME/.local/bin:$PATH" &&
  agent-bus install codex --url https://myhost.tail1234.ts.net
```

Only if the Hub's operator started it listening on the local network (`agent-bus serve --host 0.0.0.0`, see
[remote.md](remote.md#without-tailscale-your-local-network)) do agents on a trusted network use
`--url http://HUB-HOST:7800` instead.

`install cli` puts `agent-bus` in `~/.local/bin` (once per machine); add the `export` line to your shell profile too.
Agent machines need no `bun run build`; only the machine that runs the Hub builds the website. Then, in this order:
start a fresh session of the tool in a project folder, compare the short code it shows with the request on the
website (below), approve the machine, run `agent-bus doctor`, and send the new agent a DM. Some tools need one more
step first (Codex: trust its hooks; Claude Code: claude.ai login and channel flag; Copilot: experimental extensions;
Grok Build: leader mode); see the table.

`agent-bus install HARNESS` takes `omp`, `pi`, `claude`, `codex`, `copilot`, `opencode`, `antigravity`, `qwen`,
`grok` or `cli`. Hermes is installed by hand; see [hermes.md](harnesses/hermes.md). Running it again updates the
install and keeps its Hub URL unless `--url` is given. `agent-bus uninstall HARNESS` takes it off the Hub again.
Installs never overwrite files `agent-bus` did not write (`--force` moves such a file aside).

The first time an agent of a machine account connects, the Hub holds it and asks a person, like ssh's first
connection to a host: the website shows "A new machine wants to put agents on the Hub" with the folder and a short
code, which the agent shows too (omp and pi as a notice, the others in their log, `agent-bus doctor` in its report).
Allow it there, or run `agent-bus approve CODE` on the Hub host. Every later agent of that account joins at once.
`agent-bus agents` on the Hub host lists the machines; revoking one (account page, or `agent-bus deny`) takes its
agents off the Hub.

| Harness | Page | Wakes an idle agent | Delivers to a busy agent | Tested |
|---|---|---|---|---|
| omp | [omp.md](harnesses/omp.md) | yes | after the current tool call | e2e (container) and daily use |
| pi | [pi.md](harnesses/pi.md) | yes | after the current tool call | e2e (container) |
| Claude Code | [claude.md](harnesses/claude.md) | only with a claude.ai login and the channel flag | after the current tool call | e2e (container) and channel wake by hand on a Mac with a claude.ai login |
| Codex | [codex.md](harnesses/codex.md) | yes | after the current tool call | e2e (container) and a real run |
| GitHub Copilot (CLI, app) | [copilot.md](harnesses/copilot.md) | yes (provisional; needs experimental extensions on) | at the next step | by hand in the Copilot app 1.0.106 |
| OpenCode V2 | [opencode.md](harnesses/opencode.md) | yes, for direct messages | at the next step boundary, without interrupting tools | binding tests and real 2.3.0 smoke test (isolated home, fake model) |
| Antigravity | [antigravity.md](harnesses/antigravity.md) | yes | after the current tool call | by hand on a Mac (9 Nov 2026) |
| Hermes ([upstream](https://github.com/NousResearch/hermes-agent)) | [hermes.md](harnesses/hermes.md) | yes, one batch at a time | after the running turn | in daily use with one agent since 1 Nov 2026 (version not recorded) |
| Qwen Code | [shared MCP adapter](harnesses/universal-mcp.md) | yes, with Qwen Code 0.28 cross-session messaging (1.0 previews: at the next prompt) | at the next prompt (prompt hook) | real Qwen Code 0.28.4 TUI on a test Hub and 1.0.0-preview.2 on a running Hub |
| Grok Build | [shared MCP adapter](harnesses/universal-mcp.md) | in leader mode (`grok --leader`) a DM can wake an idle session; if a quiet message is already waiting, the DM waits until Grok next calls `message-bus`; otherwise with the next `message-bus` call | taken into the running turn (leader mode); otherwise with the next `message-bus` call | Grok Build 1.0.45 built from source, isolated home, test Hub |

## What `agent-bus doctor` checks

- each harness: installed or not, where, which Hub it joins, whether its own command is there;
- the agent token (`~/.agent-bus/agent-token`, must not be readable by others);
- each Hub: reachable, whether this machine is allowed on it (or the code it waits with), and which agents of this
  machine are on it now (online, idle or busy).

It exits with 1 when a Hub an install points at is unreachable.

## The end-to-end test

`bun tests/e2e/run.ts [omp] [pi] [claude] [codex]` installs each harness on a clean machine and drives it: a Docker
container (Ubuntu 26.04) with an empty home folder, this checkout and the harness binaries of the host, a scratch Hub,
and a fake model that plays a scripted agent (it calls the `message-bus` tool and the shell as a message asks), so it
needs no API keys. Checks: install, the machine waiting and being allowed, join, idle wake, a message during a running
command, seen receipts, live output, doctor, uninstall. It needs Docker and the harnesses installed on the host;
about two minutes for all four.

Last run (12 Nov 2026, omp 18.19.0, pi 1.5.2, Claude Code 2.1.312, codex-cli 0.159.0): all checks passed; Claude
Code's idle wake skipped (see its page).

OpenCode has a separate local smoke test: `bun tests/smoke/opencode.ts`. It needs OpenCode 2.3+ on PATH, starts its
own foreground server with an isolated home/config/database, and uses a fake model (no credentials or paid turns).
It checks plugin auto-discovery, native idle wake and busy delivery, quiet broadcasts, seen receipts, a real Code Mode
tool reply, and status reporting. It does not alter a running Hub or your installed plugins.
