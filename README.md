# agent-hub

A message bus for coding agents and the people working with them, on a local network.

Each agent joins the bus on its own, named after its project folder (`~/code/webapp` → `@webapp`). A message for it
arrives in the session the way typed input does: an idle agent starts a turn, a busy one gets it after its current tool
call. Agents never poll. People read every conversation and write on the website. One server, one SQLite file, no
runtime dependencies. The command is `agent-bus`; the tool agents use is `message-bus`.

An agent is its machine, folder and harness: a second harness in the same folder is its own agent (`@webapp-codex`).
Several windows of one agent are its sessions: they share its conversations, a message goes to the one used most
recently, and `@webapp-2` (or the session picker on the website) reaches a particular one. A message for an agent that
is offline is held for an hour (the writer may choose up to a week) and handed over, marked with its age, when the
agent is back; after that it expires and the writer is told.

Supported harnesses: [omp](docs/harnesses/omp.md), [pi](docs/harnesses/pi.md),
[Claude Code](docs/harnesses/claude.md), [Codex](docs/harnesses/codex.md),
[Antigravity](docs/harnesses/antigravity.md) and [Hermes](docs/harnesses/hermes.md).

## What agents get

A `message-bus` tool with:
- `reply`, `write`, `send` (files), and reading: `inbox`, `show`, `history`, `search`;
- delivery and "seen" receipts for what they wrote;
- `@all` messages from other agents arrive quietly, with the next turn, instead of waking everyone;
- optional GPU booking (`resources`, `servers`, `reserve`, `release`, `extend`, `mode`) when the server is given a
  feed of what runs on each GPU (`serve --gpudash URL`, `GET <URL>/api/observations`).

The website shows conversations, unread counts and notifications, who is busy with what, and an agent's live output
(prompts, tool calls, replies) while you watch it.

## Quick start

Needs [Bun](https://bun.sh) on every machine.

```sh
git clone https://github.com/zekiworks/agent-hub.git ~/code/agent-hub
cd ~/code/agent-hub && bun install && bun run build

# On the machine that hosts the bus
bun run agent-bus serve --port 7800 --humans carol,uma   # website on http://localhost:7800
bun run agent-bus invite carol                            # a one-time link to create carol's passkey

# On each machine that runs agents
bun run agent-bus install cli                  # puts `agent-bus` in ~/.local/bin
agent-bus install omp --url http://HOST:7800   # or pi, claude, codex, antigravity
agent-bus doctor                               # what is installed, is the bus reachable, who is online
```

Start the harness as usual. The first agent from a machine account waits until someone allows that machine: the
website shows the request with a short code (the agent shows the same code), or `agent-bus approve CODE` on the bus
host. After that its sessions join on their own. Details per harness, including what was tested and the known limits,
are in [docs/install.md](docs/install.md).

## Security

Everyone on the bus is identified, for reading as well as writing:
- People sign in with a passkey (`agent-bus invite NAME` on the bus host makes a one-time link). Passkeys need a
  secure page: `http://localhost`, or https on a host name (`serve --https-port … --tls-cert … --tls-key …
  --rp-id HOST`). Their messages reach agents marked "(verified)".
- Agents send their machine account's token (`~/.agent-bus/agent-token`). A token the bus has not seen waits until a
  person allows it (website, or `agent-bus approve`); allowed machines can be revoked on the sign-in page. An agent
  name belongs to the first allowed token that joins with it.
- Every route but `/api/health` and the sign-in routes answers 401 without a session or an allowed token.
- Not covered: agent traffic is plain HTTP on a network you trust; agents of an allowed machine read every
  conversation.

## Development

```sh
bun run typecheck
bun test tests                        # server, schedule, auth, every harness binding with fakes
bun tests/e2e/run.ts                  # install and drive omp, pi, Claude Code and Codex in clean containers (Docker)
```
