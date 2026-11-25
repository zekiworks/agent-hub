# MCP and shell harness adapters

Agent Hub has shared adapters for coding tools that expose a standard **stdio MCP** server slot but do not yet expose enough session APIs for a native plugin:

- Qwen Code: `agent-bus install qwen`
- Kimi Code CLI: `agent-bus install kimi`
- Grok Build: `agent-bus install grok`
- DeepSeek Harness: `agent-bus install deepseek`
- Muse Code: `agent-bus install muse`
- Mistral Vibe: `agent-bus install vibe`
- Devin CLI: `agent-bus install devin`

Pass `--url http://BUS:7800` when the bus is on another machine. Installing again updates the adapter without changing unrelated MCP servers. `agent-bus uninstall HARNESS` removes only entries and files marked as Agent Hub-owned. JSON adapters snapshot the exact pre-install configuration: uninstall restores those bytes when the file was otherwise untouched; if it changed meanwhile, uninstall removes only the managed entry and keeps the new settings.

The installer writes each harness's native user configuration:

| Harness | Configuration |
|---|---|
| Qwen Code | `~/.qwen/settings.json` → `mcpServers.agent-hub` and an owned `hooks.UserPromptSubmit` entry |
| Kimi Code CLI | `~/.kimi-code/mcp.json` (`$KIMI_CODE_HOME`) → `mcpServers.agent-hub` |
| Grok Build | owned `[mcp_servers.agent-hub]` block in `~/.grok/config.toml` (`$GROK_HOME`); a plugin under `~/.grok/plugins` would start disabled |
| DeepSeek Harness | owned block in `~/.dsh/cordis.patch.yml` using `@deepseek-ai/dsh-mcp-client` |
| Muse Code | user settings `mcp_servers.agent-hub` |
| Mistral Vibe | owned `[[mcp_servers]]` block in `~/.vibe/config.toml` |
| Devin CLI | `~/.config/devin/mcp_config.json` → `mcpServers.agent-hub` |

The MCP process joins from the harness's working directory and exposes the typed `message-bus` tool. For generic MCP adapters, a delivery is kept unacknowledged until the model next calls that tool; the MCP client also receives a standard logging notification naming the waiting message. This preserves delivery across a crashed or closed session.

Qwen Code also installs an owned `UserPromptSubmit` command hook. Immediately before every model call, the hook reads unseen Agent Hub Inbox messages, writes them to hook stdout for Qwen to inject into model context, then marks them seen. The model does not have to remember to call Inbox or run a timer. Reinstall replaces only Agent Hub's hook; uninstall restores an otherwise untouched settings file byte for byte.

**Qwen idle wake:** a message that wakes the agent starts a turn in the running Qwen TUI, also when it sits idle. Qwen gives every process it starts its cross-session messaging socket and a child token (`QWEN_CODE_MESSAGING_SOCKET`, `QWEN_CODE_MESSAGING_TOKEN`); the MCP bridge sends the delivery there with `@qwen-code/sdk/peer`, and Qwen runs it as soon as the session is idle, with no controller token and no per-message review. This needs a Qwen Code with cross-session messaging (verified with 0.28.4) and `agents.crossSessionMessaging` not turned off; `--bare`, `--safe-mode` and an `agents.crossSessionInbound` of `hold` or `refuse` prevent it. The 1.0 previews (verified with 1.0.0-preview.2) do not give their processes a socket, so there the message waits for the next turn's hook.

**Grok idle wake:** in leader mode (`[cli] use_leader = true` in `~/.grok/config.toml`, or `grok --leader`) one leader process owns every Grok session and spawns its MCP servers. The bridge, a child of that leader with `GROK_SESSION_ID`, sends a waking delivery to `~/.grok/leader.sock` as `x.ai/interject`: an idle session starts a turn at once and the TUI shows it live; a busy one takes it into the running turn. The installer does not turn leader mode on. Standalone Grok has no external entry point and no hook that adds model context, so there messages arrive with the next `message-bus` call. Grok asks once before the model's first `message-bus` call, as for any MCP tool. Verified with Grok Build 1.0.45 built from source (`xai-org/grok-build` `2bdd1d6`).

**MCP limitation:** generic MCP cannot start an idle model turn. The other MCP adapters receive messages at their next `message-bus` call. Native adapters such as OMP, Codex, Claude Code, and OpenCode provide wake and live output through their own session APIs.

## mini-SWE-agent

mini-SWE-agent is shell-only and has no MCP client. Install its polling subclass and launch it through the provided wrapper:

```bash
agent-bus install mini-swe-agent --url http://BUS:7800
agent-bus-mini -t "the coding task"
```

`agent-bus-mini` loads `AgentHubAgent`, which checks the Inbox immediately before each model call and injects new deliveries as explicitly marked developer context. The agent can write or reply through the installed `agent-hub-message '{"op":"…"}'` shell command. A batch that has exited cannot be woken; messages wait for its next run.

## Verification

```bash
agent-bus doctor
```

The adapter should be listed as installed with its bus URL. In the harness, inspect MCP tools and call `message-bus` with `{"op":"projects"}`. The result ends with the assigned stable address, for example `(you are @webapp-qwen)`.
