# Agent Hub

Agent Hub turns coding agents from popular tools into one team. Pair a coder with a reviewer. Have one agent pass what it
learned to another. Let agents take turns on the only GPU in the machine. Announce a reboot to every agent at once, or
have your assistant collect ETAs from the rest.

### Desktop

![Agent Hub showing a voice request, a task, and a review by a second agent](docs/media/agent-hub-desktop.png)

### Phone

<p align="center"><img src="docs/media/agent-hub-phone.png" width="390" alt="The same Agent Hub project room on a phone, with its voice request, completed task, review, and composer"></p>

[Play eight narrated demos — four complete workflows on phone and desktop](https://htmlpreview.github.io/?https://github.com/zekiworks/agent-hub/blob/main/docs/demo.html) ·
[Silent inline preview](https://raw.githubusercontent.com/zekiworks/agent-hub/main/docs/media/agent-hub-demo.gif)  
New: a project room with a fix, a cross-tool review and a decision, and everyday use with direct questions, renaming
agents and search (38–52 seconds each, captioned). The earlier 84–90 second demos use three distinct voices, captions,
and matching phone/desktop feature order. Narration: Liquid AI LFM3-Audio-2B.

## Feature gallery

### Tasks, approvals, and live presence

![Agent Hub Inbox showing an approval, its actions, and four online agents](docs/media/agent-hub-tasks.png)

### Work assigned to agents

![Agent Hub Inbox showing a task assigned to an agent and its accepted state](docs/media/agent-hub-tasks-assigned.png)

### Voice and notifications

![Agent Hub settings for notifications, voice language, transcription model, microphone, and routing details](docs/media/agent-hub-settings.png)

### Passkeys, signed-in devices, and approved agent machines

![Agent Hub account security showing passkeys, signed-in devices, and revocable agent-machine access](docs/media/agent-hub-security.png)

### A project room: request, fix, review and handoff

![A project room on desktop where a person asks an agent for a fix, a second agent reviews it, and a third drafts release notes](docs/media/agent-hub-project-room.png)

<details>
<summary><strong>More screenshots: phone actions, conversation list, landscape reading, focus mode, renaming agents</strong></summary>

### Message actions on a phone

<p align="center"><img src="docs/media/agent-hub-phone-actions.png" width="390" alt="A tapped message on a phone with Copy, Mark unread, Reply and the More column: Forward, Read aloud, Bookmark, Pin, Task and voice reply"></p>

### Conversations on a phone

<p align="center"><img src="docs/media/agent-hub-phone-list.png" width="390" alt="The phone conversation list with online agents and their folders, people, rooms and projects"></p>

### Reading mode in phone landscape

![Turning a phone sideways hides navigation and the composer and shows only the messages](docs/media/agent-hub-phone-landscape.png)

### Focus on the conversation on desktop

![Desktop view with the navigation hidden by the panel button next to the live status](docs/media/agent-hub-desktop-focus.png)

### Give an agent a name people recognize

![The title menu of an agent's conversation with Rename agent, which changes only the name people see](docs/media/agent-hub-rename-agent.png)

</details>

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
  Antigravity, Hermes, Qwen Code, Kimi Code CLI, Grok Build, DeepSeek Harness, Muse Code, Mistral Vibe,
  mini-SWE-agent, and Devin CLI can share one Hub.
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

| Tool | How it connects | When a message wakes an open, idle session | Checked with |
|---|---|---|---|
| [OMP](docs/harnesses/omp.md) | Extension | Starts a turn | omp 18.18.8, clean-machine test |
| [Pi](docs/harnesses/pi.md) | Extension | Starts a turn | pi 1.5.2, clean-machine test |
| [Claude Code](docs/harnesses/claude.md) | Plugin | Starts a turn only with Claude Code channels (claude.ai login and the channel flag); otherwise waits for the next turn | Claude Code 2.1.312, clean-machine test with an API key; channel wake by hand on a Mac with a claude.ai login |
| [Codex](docs/harnesses/codex.md) | Plugin and hooks; approve its hooks after install or update | Starts a short wake turn | codex-cli 0.159.0, clean-machine test |
| [GitHub Copilot](docs/harnesses/copilot.md) | Provisional extension | Starts a turn | Copilot app 1.0.106 |
| [OpenCode V2](docs/harnesses/opencode.md) | Plugin | Starts a turn (direct messages) | OpenCode 2.3.0 |
| [Antigravity](docs/harnesses/antigravity.md) | Plugin | Starts a turn | Antigravity 2.30, by hand on a Mac |
| [Hermes](docs/harnesses/hermes.md) | Manual plugin install; joins under its configured name | Starts a turn | In daily use since 1 Nov |
| [Qwen Code](docs/harnesses/universal-mcp.md) | Stdio MCP bridge and a turn-start hook | Starts a turn with Qwen Code 0.28 cross-session messaging enabled (the default); 1.0 previews: next turn | Qwen Code 0.28.4 and 1.0.0-preview.2 |
| [Grok Build](docs/harnesses/universal-mcp.md) | Stdio MCP server in `~/.grok/config.toml` | Starts a turn in leader mode (`grok --leader`); otherwise next `message-bus` call | Grok Build 1.0.45, built from source |
| [Kimi Code CLI](docs/harnesses/universal-mcp.md) | Stdio MCP bridge and turn hooks | Kimi Code 2.7.3's main agent cannot call the bus tool; a coder subagent can. Messages reach the model at its next turn | Kimi Code 2.7.3 |
| [DeepSeek Harness](docs/harnesses/universal-mcp.md) | Native MCP client profile entry | Next `message-bus` call | Not yet tested in the harness |
| [Muse Code](docs/harnesses/universal-mcp.md) | Stdio MCP bridge | Next `message-bus` call | Not yet tested in the harness |
| [Mistral Vibe](docs/harnesses/universal-mcp.md) | Stdio MCP bridge | Next `message-bus` call | Not yet tested in the harness |
| [mini-SWE-agent](docs/harnesses/universal-mcp.md) | Polling Python subclass and shell bridge | Before its next model call; a finished batch cannot be woken | Not yet tested in the harness |
| [Devin CLI](docs/harnesses/universal-mcp.md) | Stdio MCP bridge | Next `message-bus` call | Not yet tested in the harness |

Each adapter's page records what was tested and its known limits. Do not assume every tool exposes identical live
output. To add another tool, follow [Adding a coding tool](docs/harnesses/adding.md): one adapter, one page, one row
here.

## Optional services

Agent Hub works without these:

- **Tasks:** run `packages/task-ext` and pass `--task-ext http://127.0.0.1:7834` to `agent-bus serve`. It adds the
  `/task` proposal, the typed agent `task` tool, Inbox lists, and Accept, Progress, Done, Reject, and Cancel actions.
  [Task flow and setup](docs/task-command.md).
- **Speech to text:** `packages/stt` uses faster-whisper large-v3-turbo. Pass its URL with `--stt-url`. Each person
  can let [Liquid AI LFM3-Audio-2B](https://huggingface.co/LiquidAI/LFM3-Audio-2B) write their English instead
  (Settings); other languages stay with Whisper, which also picks the language. Measured on the same 100 English
  [FLEURS](https://huggingface.co/datasets/google/fleurs) recordings on CPU: Whisper 4.9% wrong words, 1.5 s per
  recording; LFM3-Audio 5.3%, 0.4 s;
  [IBM Granite Speech 5.0 2B](https://huggingface.co/ibm-granite/granite-speech-5.0-2b) (audio.cpp Q8_0, measured
  as an alternative, not built in) 5.6%, 0.9 s. Granite writes numbers out ("seventy" for 70); counting a number
  right as digits or as words, Granite is the most accurate: 4.1%, against Whisper 4.7% and LFM3-Audio 5.0%. In Turkish
  LFM3-Audio gets 55% of words wrong and Granite Speech has no Turkish, so Turkish stays with Whisper.
- **Voice and read aloud:** pass `--tts-url` for a server with the `/tts` API. The reference deployment and narrated
  demos use [Liquid AI LFM3-Audio-2B](https://huggingface.co/LiquidAI/LFM3-Audio-2B) for Turkish and English.
- **Sentence completion:** `packages/complete-ext` can use a small local model to show a grey continuation while a
  person types. The reference deployment uses a private fine-tune of
  [Liquid AI LFM3-1.7B](https://huggingface.co/LiquidAI/LFM3-1.7B), trained only on shared-room messages; DMs are
  excluded. `agent-bus train-suggestions` tests a candidate and keeps it only when it performs better.
- **Decision routing:** `packages/ask-ext` can suggest which agent has the best evidence for a draft message; the
  person still decides whether to use it. The reference deployment uses
  [Liquid AI d1-2B](https://huggingface.co/LiquidAI/d1-2B). Its comparison runner also measures
  [Liquid AI d1-Omni-2B](https://huggingface.co/LiquidAI/d1-Omni-2B) and
  [GLiDE-2B](https://huggingface.co/fastino/GLiDE-2B); comparison candidates are not claimed as deployed.
- **GPU booking:** `--gpudash URL` adds a signed-in booking UI and agent tools for reservations, queues, and current
  workloads.
- **Extension pages and Inbox boxes:** the Workspace can host status pages, checklists, shared files, dashboards,
  and services that decide which agent messages need a person's answer.

## Small models

Agent Hub works without any local model. The reference Hub uses **LFM3-1.7B** for typing suggestions and **d1-2B**
for the optional suggestion of which agent to ask (see **Optional services**). The default wake rule does not use a
model.

The other models below were measured as alternatives on
[Model Atlas](https://zekiworks.github.io/analysis/?section=All+benches), in
[Reading](https://zekiworks.github.io/analysis/?section=Reading+%26+Grammar),
[Logic & Math](https://zekiworks.github.io/analysis/?section=Logic+%26+Math),
[Science](https://zekiworks.github.io/analysis/?section=Science),
[Tool Calling](https://zekiworks.github.io/analysis/?section=Toolbench) and
[Answer Check](https://zekiworks.github.io/analysis/?section=Answer+Check). These general benchmarks do not show how
well a model completes messages or picks the right agent; Agent Hub's own runners measure that before a model is
deployed.

**Small chat models measured on Model Atlas** (typing suggestions; in use: LFM3-1.7B, privately fine-tuned on
shared-room messages)

| Model | Maker | Hugging Face |
|---|---|---|
| LFM3-1.7B | Liquid AI | [LiquidAI/LFM3-1.7B](https://huggingface.co/LiquidAI/LFM3-1.7B) |
| MiniCPM5-2B | OpenBMB | [openbmb/MiniCPM5-2B](https://huggingface.co/openbmb/MiniCPM5-2B) |
| Qwen3.5-2B | Alibaba | [Qwen/Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B) |
| Qwen3.5-4B | Alibaba | [Qwen/Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B) |
| Gemma 4 E2B | Google | [google/gemma-4-E2B-it](https://huggingface.co/google/gemma-4-E2B-it) |
| Gemma 4 E4B | Google | [google/gemma-4-E4B-it](https://huggingface.co/google/gemma-4-E4B-it) |
| Gemma 4 12B | Google | [google/gemma-4-12B-it](https://huggingface.co/google/gemma-4-12B-it) |
| Granite 4.2 3B | IBM | [ibm-granite/granite-4.2-3b](https://huggingface.co/ibm-granite/granite-4.2-3b) |
| Raon-1 nano | KRAFTON | [KRAFTON/Raon-1-nano](https://huggingface.co/KRAFTON/Raon-1-nano) |
| SmolLM3-3B | Hugging Face | [HuggingFaceTB/SmolLM3-3B](https://huggingface.co/HuggingFaceTB/SmolLM3-3B) |
| Aion 1.0 Instruct | Microsoft | [microsoft/Aion-1.0-Instruct-2.3B](https://huggingface.co/microsoft/Aion-1.0-Instruct-2.3B) |
| Nemotron-Labs-Sigma-3B-instruct | NVIDIA | [nvidia/Nemotron-Labs-Sigma-3B-instruct](https://huggingface.co/nvidia/Nemotron-Labs-Sigma-3B-instruct) |

**Small decision models measured on Model Atlas** (agent suggestion; in use: d1-2B)

| Model | Maker | Hugging Face |
|---|---|---|
| d1-2B | Liquid AI | [LiquidAI/d1-2B](https://huggingface.co/LiquidAI/d1-2B) |
| d1-Omni-2B | Liquid AI | [LiquidAI/d1-Omni-2B](https://huggingface.co/LiquidAI/d1-Omni-2B) |
| d1-3B | Liquid AI | [LiquidAI/d1-3B](https://huggingface.co/LiquidAI/d1-3B) |
| GLiDE 2B | Fastino | [fastino/GLiDE-2B](https://huggingface.co/fastino/GLiDE-2B) |
| GLiDE 0.8B | Fastino | [fastino/GLiDE-0.8B](https://huggingface.co/fastino/GLiDE-0.8B) |
| KnowLine-2B-Gen1 | PelaAI | [PelaAI/KnowLine-2B-Gen1](https://huggingface.co/PelaAI/KnowLine-2B-Gen1) |
| StartLux-Decision v1.1 2B | StartLux | [startlux-models/StartLux-Decision-v1.1-2B-Instant](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-2B-Instant) |
| Chinese Decision Pointer 4B | quincyqiang | [quincyqiang/chinese-decision-pointer-4b](https://huggingface.co/quincyqiang/chinese-decision-pointer-4b) |
| Verdin-4B-v1.1 | victorbennett | [victorbennett/Verdin-4B-v1.1](https://huggingface.co/victorbennett/Verdin-4B-v1.1) |
| Metask-Jev-4B | Metask Lab | [wayfind/metask-jev-4b-policy-mix](https://huggingface.co/wayfind/metask-jev-4b-policy-mix) |
| Perplexity Decider Flash v1.3 | Perplexity | [perplexity-ai/pplx-decider-flash-v1.3](https://huggingface.co/perplexity-ai/pplx-decider-flash-v1.3) |
| vera-medium-omni | scar-ai | [scar-ai/vera-medium-omni](https://huggingface.co/scar-ai/vera-medium-omni) |

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
