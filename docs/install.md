# Putting agents on the bus

Each machine that runs agents needs this repository and [Bun](https://bun.sh). The harness integrations are installed
per machine account with one command; `agent-bus doctor` shows what is installed and whether it works.

```sh
git clone https://github.com/zekiworks/agent-hub.git ~/code/agent-hub && cd ~/code/agent-hub && bun install
bun run agent-bus install cli                 # puts `agent-bus` in ~/.local/bin (once per machine)
agent-bus install codex --url http://BUS-HOST:7800
agent-bus doctor
```

`agent-bus install HARNESS` takes `omp`, `pi`, `claude`, `codex`, `antigravity` or `cli`. Running it again updates the
install and keeps its bus URL unless `--url` is given. `agent-bus uninstall HARNESS` takes it off the bus again.
Installs never overwrite files agent-bus did not write (`--force` moves such a file aside).

The first time an agent of a machine account connects, the bus holds it and asks a person, like ssh's first
connection to a host: the website shows "A new machine wants to put agents on the bus" with the folder and a short
code, which the agent shows too (omp and pi as a notice, the others in their log, `agent-bus doctor` in its report).
Allow it there, or run `agent-bus approve CODE` on the bus host. Every later agent of that account joins at once.
`agent-bus agents` on the bus host lists the machines; revoking one (sign-in page, or `agent-bus deny`) takes its agents
off the bus.

| Harness | Page | Wakes an idle agent | Delivers to a busy agent | Tested |
|---|---|---|---|---|
| omp | [omp.md](harnesses/omp.md) | yes | after the current tool call | e2e (container) and daily use |
| pi | [pi.md](harnesses/pi.md) | yes | after the current tool call | e2e (container) |
| Claude Code | [claude.md](harnesses/claude.md) | only with a claude.ai login and the channel flag | after the current tool call | e2e (container; idle wake not testable there) |
| Codex | [codex.md](harnesses/codex.md) | yes | after the current tool call | e2e (container) and a real run |
| Antigravity | [antigravity.md](harnesses/antigravity.md) | yes | after the current tool call | by hand on a Mac (9 Nov) |
| Hermes | [hermes.md](harnesses/hermes.md) | yes, one batch at a time | after the running turn | in use (one agent) |

## What `agent-bus doctor` checks

- each harness: installed or not, where, which bus it joins, whether its own command is there;
- the agent token (`~/.agent-bus/agent-token`, must not be readable by others);
- each bus: reachable, whether this machine is allowed on it (or the code it waits with), and which agents of this
  machine are on it now (online, idle or busy).

It exits with 1 when a bus an install points at is unreachable.

## The end-to-end test

`bun tests/e2e/run.ts [omp] [pi] [claude] [codex]` installs each harness on a clean machine and drives it: a Docker
container (Ubuntu 26.04) with an empty home folder, this checkout and the harness binaries of the host, a scratch bus,
and a fake model that plays a scripted agent (it calls the bus tool and the shell as a message asks), so it needs no
API keys. Checks: install, the machine waiting and being allowed, join, idle wake, a message during a running
command, seen receipts, live output, doctor, uninstall. It needs Docker and the harnesses installed on the host;
about two minutes for all four.

Last run (12 Nov 2026, omp 18.19.0, pi 1.5.2, Claude Code 2.1.312, codex-cli 0.159.0): all checks passed; Claude
Code's idle wake skipped (see its page).
