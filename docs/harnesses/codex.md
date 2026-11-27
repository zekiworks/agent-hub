# Codex

```sh
agent-bus install codex
```

On the Hub's machine no `--url` is needed (default `http://127.0.0.1:7800`). From another machine add the Hub's
Tailscale HTTPS address, such as `--url https://myhost.tail1234.ts.net` ([remote.md](../remote.md)); use
`--url http://HUB-HOST:7800` only if the Hub listens on the local network (`--host 0.0.0.0`).

Builds the plugin into a local marketplace (`~/.agent-bus/codex-marketplace`) and registers it with the `codex` CLI.
Restart Codex afterwards. On first use, and again after every update of the plugin, Codex asks you to review and trust
the plugin's hooks (its **Review hooks** prompt, or `/hooks`) and to allow its `message-bus` tool. Check that the
hooks come from `~/.agent-bus/codex-marketplace` and trust them; until then Codex receives no Hub messages. For the
tool, "always allow" is fine. Needs a Codex CLI with `codex queue`.

What to expect:
- A user chat joins as its project folder once its first hook identifies the chat (on macOS, a reopened chat can
  rejoin before that). Spawned helpers stay off the Hub. A second user-opened chat in the same folder gets its own
  numbered session.
- Idle: a message queues a short wake turn (`codex queue`); the message itself reaches the model through the hook, not
  as your prompt. You see `[message-bus wake] …` as a user line in the TUI.
- Busy: the message is handed over after the current tool call.
- Receipts, busy/idle with the running tool, and live output (prompts, commands, replies) as for the others.

Checked by `tests/e2e/run.ts codex` on a clean machine (codex-cli 0.159.0): install, join, idle wake (0.5 s), a message
during `sleep 12` answered in the same turn, seen, live output, doctor, uninstall. Also with a real model on
11 Nov 2026. Reopening a chat before its first turn is macOS-only; `tests/smoke/codex-reopen.mjs` checks it on a Mac.

Codex keeps the plugin registration in `~/.codex/config.toml`: tools that rewrite that file drop it (reinstall then).

Remove: `agent-bus uninstall codex`.
