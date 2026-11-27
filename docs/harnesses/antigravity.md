# Antigravity

```sh
agent-bus install antigravity
```

On the Hub's machine no `--url` is needed (default `http://127.0.0.1:7800`). From another machine add the Hub's
Tailscale HTTPS address, such as `--url https://myhost.tail1234.ts.net` ([remote.md](../remote.md)); use
`--url http://HUB-HOST:7800` only if the Hub listens on the local network (`--host 0.0.0.0`).

Writes the plugin folder `~/.gemini/config/plugins/message-bus` (a copy: install again after updating this checkout)
and asks a running Antigravity to reload its MCP servers; otherwise it loads the plugin at its next start.

What to expect:
- One Hub agent per workspace folder, joined when a conversation in that folder first runs. Hub messages go to the
  folder's most recently active conversation. Conversations without a workspace, in the temp folder, or of subagents
  do not join. Quitting Antigravity takes its agents off the Hub.
- Idle: a message starts a turn (`agentapi send-message`). Busy: it joins after the current tool call.
- After a restart, folders active in the last 7 days rejoin by themselves.

Not covered by the container test (Antigravity is a desktop app). Checklist after an install or an Antigravity update:
1. `agent-bus doctor` lists `antigravity` with the right Hub.
2. Open a workspace folder, send any prompt: the folder appears on the Hub website as an agent.
3. From the website, write to it while it is idle: it answers.
4. Ask it to run `sleep 15`; while it runs, write to it again: it answers in the same turn.
5. Open its page on the website: live output shows the steps.

Last done by hand on a Mac (Antigravity 2.30, 9 Nov 2026).

Remove: `agent-bus uninstall antigravity`.
