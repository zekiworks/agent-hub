# MCP harness adapters: Qwen Code and Grok Build

Agent Hub has a shared adapter for coding tools that expose a standard **stdio MCP** server slot but no native plugin API:

- Qwen Code: `agent-bus install qwen` (tested with real Qwen Code 0.28.4 and 1.0.0-preview.2)
- Grok Build: `agent-bus install grok` (tested with Grok Build 1.0.45 built from source)

Only tools that were tested and whose idle session a message can wake are supported (Can #17468). Kimi Code CLI, DeepSeek Harness, Muse Code, Mistral Vibe, mini-SWE-agent and Devin CLI had adapters until 26 Nov 2026; they were removed because they were untested or a message could not start a turn in them (see git history).

Pass `--url http://BUS:7800` when the bus is on another machine. Installing again updates the adapter without changing unrelated MCP servers. `agent-bus uninstall HARNESS` removes only entries and files marked as Agent Hub-owned. The installer snapshots the exact pre-install configuration: uninstall restores those bytes when the file was otherwise untouched; if it changed meanwhile, uninstall removes only the managed entry and keeps the new settings.

The installer writes each harness's native user configuration:

| Harness | Configuration |
|---|---|
| Qwen Code | `~/.qwen/settings.json` → `mcpServers.agent-hub` and an owned `hooks.UserPromptSubmit` entry |
| Grok Build | owned `[mcp_servers.agent-hub]` block in `~/.grok/config.toml` (`$GROK_HOME`); a plugin under `~/.grok/plugins` would start disabled |

The MCP process joins from the harness's working directory and exposes the typed `message-bus` tool. A delivery that does not wake the session is kept unacknowledged until the model next calls that tool (Qwen: until its turn hook injects it); the MCP client also receives a standard logging notification naming the waiting message. This preserves delivery across a crashed or closed session.

Qwen Code also installs an owned `UserPromptSubmit` command hook. Immediately before every model call, the hook reads unseen Agent Hub Inbox messages, writes them to hook stdout for Qwen to inject into model context, then marks them seen. The model does not have to remember to call Inbox or run a timer. Reinstall replaces only Agent Hub's hook; uninstall restores an otherwise untouched settings file byte for byte.

**Qwen idle wake:** a message that wakes the agent starts a turn in the running Qwen TUI, also when it sits idle. Qwen gives every process it starts its cross-session messaging socket and a child token (`QWEN_CODE_MESSAGING_SOCKET`, `QWEN_CODE_MESSAGING_TOKEN`); the MCP bridge sends the delivery there with `@qwen-code/sdk/peer`, and Qwen runs it as soon as the session is idle, with no controller token and no per-message review. This needs a Qwen Code with cross-session messaging (verified with 0.28.4) and `agents.crossSessionMessaging` not turned off; `--bare`, `--safe-mode` and an `agents.crossSessionInbound` of `hold` or `refuse` prevent it. The 1.0 previews (verified with 1.0.0-preview.2) do not give their processes a socket, so there the message waits for the next turn's hook.

**Grok idle wake:** in leader mode (`[cli] use_leader = true` in `~/.grok/config.toml`, or `grok --leader`) one leader process owns every Grok session and spawns its MCP servers. The bridge, a child of that leader with `GROK_SESSION_ID`, sends a waking delivery to `~/.grok/leader.sock` as `x.ai/interject`: an idle session starts a turn at once and the TUI shows it live; a busy one takes it into the running turn. The installer does not turn leader mode on. Standalone Grok has no external entry point and no hook that adds model context, so there messages arrive with the next `message-bus` call. Grok asks once before the model's first `message-bus` call, as for any MCP tool. Verified with Grok Build 1.0.45 built from source (`xai-org/grok-build` `2bdd1d6`).

**MCP limitation:** plain MCP cannot start an idle model turn; both adapters wake through the tool's own mechanism above. Without it (Qwen 1.0 previews, Grok outside leader mode) messages wait for the next turn or `message-bus` call. Native adapters such as OMP, Codex, Claude Code, and OpenCode provide wake and live output through their own session APIs.

## Verification

```bash
agent-bus doctor
```

The adapter should be listed as installed with its bus URL. In the harness, inspect MCP tools and call `message-bus` with `{"op":"projects"}`. The result ends with the assigned stable address, for example `(you are @webapp-qwen)`.
