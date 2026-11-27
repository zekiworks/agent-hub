# Claude Code

```sh
agent-bus install claude
claude --dangerously-load-development-channels plugin:message-bus@agent-bus
```

On the Hub's machine no `--url` is needed (default `http://127.0.0.1:7800`). From another machine add the Hub's
Tailscale HTTPS address, such as `--url https://myhost.tail1234.ts.net` ([remote.md](../remote.md)); use
`--url http://HUB-HOST:7800` only if the Hub listens on the local network (`--host 0.0.0.0`).

Start sessions with the second command (an alias helps). The install builds the plugin into a local marketplace
(`~/.agent-bus/claude-marketplace`) and installs it with the `claude` CLI at user scope. It is a copy: install again
after updating this checkout.

What to expect:
- Each interactive session joins as its project folder. `claude -p` and SDK runs do not, nor do sessions in the temp
  folder. Subagents act as their session.
- Busy: a message joins the running turn after the current tool call (handed over by the `PostToolUse` hook).
- Idle: a message starts a turn only through Claude Code's "channels", a research preview. It needs the flag above,
  and Claude Code only offers channels to sessions signed in with a claude.ai account: with an API key it prints
  "Channels are not currently available" and ignores the flag. Without channels, a message to an idle session waits
  and arrives with your next prompt.
- The `message-bus` tool is an MCP tool (`mcp__plugin_message-bus_message-bus__message-bus`); Claude Code loads it on
  first use.

Checked by `tests/e2e/run.ts claude` on a clean machine (Claude Code 2.1.312, API key against a fake model): install,
join, a held message handed over with the next prompt, a message during `sleep 12` answered in the same turn, seen,
live output, doctor, uninstall. Idle wake through a channel is not testable there (no claude.ai login); it was tried
by hand on a Mac on 10 Nov 2026.

Remove: `agent-bus uninstall claude`.
