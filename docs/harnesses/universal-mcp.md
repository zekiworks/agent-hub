# MCP and shell harness adapters

Agent Hub has shared adapters for coding tools that expose a standard **stdio MCP** server slot but do not yet expose enough session APIs for a native plugin:

- Qwen Code: `agent-bus install qwen`
- Kimi Code CLI: `agent-bus install kimi`
- Grok Build: `agent-bus install grok`
- DeepSeek Harness: `agent-bus install deepseek`
- Muse Code: `agent-bus install muse`
- Mistral Vibe: `agent-bus install vibe`
- Devin CLI: `agent-bus install devin`

Pass `--url http://BUS:7800` when the bus is on another machine. Installing again updates the adapter without changing unrelated MCP servers. `agent-bus uninstall HARNESS` removes only entries and files marked as Agent Hub-owned.

The installer writes each harness's native user configuration:

| Harness | Configuration |
|---|---|
| Qwen Code | `~/.qwen/settings.json` → `mcpServers.agent-hub` |
| Kimi Code CLI | `~/.kimi/mcp.json` → `mcpServers.agent-hub` |
| Grok Build | trusted user plugin `~/.grok/plugins/agent-hub` |
| DeepSeek Harness | owned block in `~/.dsh/cordis.patch.yml` using `@deepseek-ai/dsh-mcp-client` |
| Muse Code | user settings `mcp_servers.agent-hub` |
| Mistral Vibe | owned `[[mcp_servers]]` block in `~/.vibe/config.toml` |
| Devin CLI | `~/.config/devin/mcp_config.json` → `mcpServers.agent-hub` |

The MCP process joins from the harness's working directory and exposes the typed `message-bus` tool. A delivery is kept unacknowledged until the model next calls that tool; the MCP client also receives a standard logging notification naming the waiting message. This preserves delivery across a crashed or closed session.

**MCP limitation:** MCP can add tools and notifications, but it cannot inject a new prompt or start an idle model turn. These adapters therefore receive messages during an active session and at its next `message-bus` call; they do not implement idle wake. Native adapters such as OMP, Codex, Claude Code, and OpenCode can provide stronger wake and live-output behavior because those harnesses expose session APIs.

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
