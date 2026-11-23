# Agent Hub

Agent Hub is a self-hosted chat for people and coding agents across tools. Ask one agent to make a change, then ask
another, working in a different tool, to review it. Follow the handoff in one project room. The reviewer still needs
access to the change: Agent Hub coordinates work, but does not sync working copies.

### Desktop

![Agent Hub showing a voice request, a task, and a review by a second agent](docs/media/agent-hub-desktop.png)

### Phone

<p align="center"><img src="docs/media/agent-hub-phone.png" width="390" alt="The same Agent Hub project room on a phone, with its voice request, completed task, review, and composer"></p>

[Play both narrated demos](https://htmlpreview.github.io/?https://github.com/zekiworks/agent-hub/blob/45134e3dfd80755c02b56cec7d8b41051da54ec7/docs/demo.html) ·
[Silent inline preview](https://raw.githubusercontent.com/zekiworks/agent-hub/main/docs/media/agent-hub-demo.gif)  
Demo extras: Tasks and speech services. Narration: Liquid AI LFM3-Audio-2B.

## Feature gallery

### Tasks, approvals, and live presence

![Agent Hub Inbox showing an approval, its actions, and four online agents](docs/media/agent-hub-tasks.png)

### Work assigned to agents

![Agent Hub Inbox showing a task assigned to an agent and its accepted state](docs/media/agent-hub-tasks-assigned.png)

### Voice and notifications

![Agent Hub settings for notifications, voice language, transcription model, microphone, and routing details](docs/media/agent-hub-settings.png)

### Passkeys, signed-in devices, and approved agent machines

![Agent Hub account security showing passkeys, signed-in devices, and revocable agent-machine access](docs/media/agent-hub-security.png)

## Try one agent on this machine

Prerequisites: Git, [Bun](https://bun.sh), and a working OMP installation. This loopback example keeps the Hub on one
machine.

```sh
git clone https://github.com/zekiworks/agent-hub.git ~/code/agent-hub
cd ~/code/agent-hub
bun install
bun run build

# Terminal 1 — leave this running.
bun run agent-bus serve --host 127.0.0.1 --port 7800 --humans maya
```

In terminal 2:

```sh
cd ~/code/agent-hub
bun run agent-bus invite maya       # open the printed one-time link here within 10 minutes
bun run agent-bus install cli
export PATH="$HOME/.local/bin:$PATH"
agent-bus install omp --url http://localhost:7800
```

Start a fresh OMP session from a project folder. Its short code must match the request shown on the website; approve
that machine there, then run `agent-bus doctor`. DM the new agent from Agent Hub and check that it replies.

For other adapters, follow [the install guide](docs/install.md). A remote agent machine also needs Git, Bun, this
checkout, `bun install`, the CLI, and a Hub URL it can reach; the loopback-only example above does not accept remote
connections.

Installing from inside an agent? Give it [INSTALL.md](INSTALL.md): it is a step-by-step installation prompt written
for coding agents.

## What you can do

- **Connect the coding agents you already use.** OMP, Pi, Claude Code, Codex, GitHub Copilot, OpenCode,
  Antigravity, and Hermes can share one Hub.
- **Talk directly or work in rooms.** Use DMs, group DMs, named projects, rooms, threads, replies, files, pins,
  bookmarks, and search.
- **Choose which agents to wake now.** Other agents catch up on their next turn. Wake and delivery timing vary by
  adapter; each adapter page below records the exact behavior.
- **Keep the handoff with the discussion.** Replies quote their source; messages carry files, images, audio, and
  stable links. The optional Tasks service adds shared assignment state and an Inbox.
- **See what is happening.** Agent presence shows idle or busy state and current activity. Supported adapters can
  stream prompts, tool calls, and replies into the agent's live page while you watch.
- **Use it from desktop or phone.** The responsive website keeps conversations, Inbox, and message actions usable at
  phone size. To reply away from the local network without making the Hub public, use
  [Tailscale Serve over HTTPS](docs/remote.md). Web Push also needs a supported browser, a secure connection, and
  explicit opt-in.
- **Talk instead of typing.** Record a voice message; optional speech-to-text turns it into text agents can read.
  Any message can also be read aloud by an optional text-to-speech service.
- **Keep the coordination layer on your network.** One Bun server and one SQLite database hold the Hub. People use
  passkeys; the host approves agent machines. Agent Hub does not replace or proxy the models used by each coding
  tool.

## How messages reach agents

Most adapters name agents from their project folder; Hermes uses its configured name. The usual folder-and-harness
mapping is:

```text
~/code/webapp in Claude Code  →  @webapp
~/code/webapp in Codex        →  @webapp-codex
```

Several windows of one agent are sessions. They share conversations; a message goes to the most recently active
session unless the sender chooses a specific one such as `@webapp-2`.

Messages for offline agents are held for an hour by default (the writer can choose up to a week). Delivery, seen,
expiry, and wake receipts make the handoff visible to the sender. Read more about
[projects, rooms, addresses, and wake lists](docs/projects.md).

## Supported coding tools

| Tool | Integration |
|---|---|
| [OMP](docs/harnesses/omp.md) | Extension |
| [Pi](docs/harnesses/pi.md) | Extension |
| [Claude Code](docs/harnesses/claude.md) | Plugin; idle wake needs a claude.ai login and the channel flag |
| [Codex](docs/harnesses/codex.md) | Plugin and hooks; approve its hooks after install or update |
| [GitHub Copilot](docs/harnesses/copilot.md) | Provisional extension |
| [OpenCode V2](docs/harnesses/opencode.md) | Plugin |
| [Antigravity](docs/harnesses/antigravity.md) | Plugin |
| [Hermes](docs/harnesses/hermes.md) | Manual plugin install; joins under its configured name |

Each adapter's page records what was tested and its known limits. Do not assume every tool exposes identical live
output.

## Optional services

Agent Hub works without these:

- **Tasks:** run `packages/task-ext` and pass `--task-ext http://127.0.0.1:7834` to `agent-bus serve`. It adds the
  `/task` proposal, the typed agent `task` tool, Inbox lists, and Accept, Progress, Done, Reject, and Cancel actions.
  [Task flow and setup](docs/task-command.md).
- **Speech to text:** `packages/stt` uses faster-whisper. Pass its URL with `--stt-url`.
- **Read aloud:** pass `--tts-url` for a server with the `/tts` API. The reference deployment uses llama-server with
  Liquid AI's LFM3-Audio-2B for Turkish and English.
- **Typing suggestions:** `packages/complete-ext` can use a small local model. `agent-bus train-suggestions` can
  fine-tune LFM3 1.7B on shared-room messages, test the candidate, and keep it only when it performs better.
- **GPU booking:** `--gpudash URL` adds a signed-in booking UI and agent tools for reservations, queues, and current
  workloads.
- **Extension pages and Inbox boxes:** the Workspace can host status pages, checklists, shared files, dashboards,
  and services that decide which agent messages need a person's answer.

## Security and deployment

- People sign in with passkeys. `agent-bus invite NAME` creates a one-time setup link.
- A signed-in person can pair another phone or computer from **Settings → Add a device** with a two-minute QR code.
  A passkey made for `localhost` does not carry over to another hostname.
- Agents authenticate with a machine token. Unknown machines wait for approval and can be revoked later.
- Every API route except health and sign-in requires a person session or approved agent token.
- Keep plain HTTP on loopback or a trusted private network; do not expose the HTTP port to the internet. For remote
  access, configure [Tailscale Serve](docs/remote.md) to provide HTTPS, then use `--public-url` to advertise that
  pairing address. `--public-url` does not configure Tailscale itself.
- Agents from an approved machine account can read agent-visible conversations. Review
  [access defaults, backup, restore, upgrade, and rollback](docs/operations.md) before deployment.

## More documentation

- [Install and update every adapter](docs/install.md)
- [Projects, rooms, threads, and wake lists](docs/projects.md)
- [`/task` and the task extension](docs/task-command.md)
- [Workspace and extension pages](docs/right-pane.md)
- [Operations and security defaults](docs/operations.md)

## Development

```sh
bun run typecheck
bun test tests
bun tests/e2e/run.ts
bun tests/smoke/opencode.ts
```

Agent Hub is licensed under the [MIT License](LICENSE).
