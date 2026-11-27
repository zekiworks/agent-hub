# MCP harness adapters: Qwen Code and Grok Build

Agent Hub has a shared adapter for coding tools that expose a standard **stdio MCP** server slot but no native plugin API:

- Qwen Code: `agent-bus install qwen` (tested with real Qwen Code 0.28.4 and 1.0.0-preview.2)
- Grok Build: `agent-bus install grok` (tested with Grok Build 1.0.45 built from source)

Only tools that were tested and whose idle session a message can wake are supported. Earlier experimental adapters that did not meet that bar were removed before v1.0.0 (see git history).

On the Hub's machine no `--url` is needed (default `http://127.0.0.1:7800`). From another machine pass the Hub's Tailscale HTTPS address, such as `--url https://myhost.tail1234.ts.net` ([remote.md](../remote.md)); use `--url http://HUB-HOST:7800` only if the Hub listens on the local network (`--host 0.0.0.0`). Installing again updates the adapter without changing unrelated MCP servers. `agent-bus uninstall HARNESS` removes only entries and files marked as Agent Hub-owned. The installer snapshots the exact pre-install configuration: uninstall restores those bytes when the file was otherwise untouched; if it changed meanwhile, uninstall removes only the managed entry and keeps the new settings.

The installer writes each harness's native user configuration:

| Harness | Configuration |
|---|---|
| Qwen Code | `~/.qwen/settings.json` → `mcpServers.agent-hub` and an owned `hooks.UserPromptSubmit` entry |
| Grok Build | owned `[mcp_servers.agent-hub]` block in `~/.grok/config.toml` (`$GROK_HOME`); a plugin under `~/.grok/plugins` would start disabled |

The MCP process joins from the harness's working directory and exposes the typed `message-bus` tool. For Grok, a delivery that does not wake the session is kept unacknowledged until the model next calls that tool; the MCP client also receives a standard logging notification naming the waiting message. This preserves delivery across a crashed or closed session.

For Qwen, the bridge acknowledges each WebSocket delivery at once; the message stays unseen on the Hub. `agent-bus install qwen` also installs an owned `UserPromptSubmit` command hook. At the next prompt, the hook reads unseen Agent Hub Inbox messages, writes them to hook stdout for Qwen to inject into model context, then marks them seen. So a busy Qwen session sees a quiet message at its next prompt, not during the running turn. The model does not have to remember to call Inbox or run a timer. Reinstall replaces only Agent Hub's hook; uninstall restores an otherwise untouched settings file byte for byte. A message that wakes the agent is handled separately, below.

**Qwen idle wake:** a message that wakes the agent starts a turn in the running Qwen TUI, also when it sits idle. Qwen gives every process it starts its cross-session messaging socket and a child token (`QWEN_CODE_MESSAGING_SOCKET`, `QWEN_CODE_MESSAGING_TOKEN`); the MCP bridge sends the delivery there with `@qwen-code/sdk/peer`, and Qwen runs it as soon as the session is idle, with no controller token and no per-message review. This needs a Qwen Code with cross-session messaging (verified with 0.28.4) and `agents.crossSessionMessaging` not turned off; `--bare`, `--safe-mode` and an `agents.crossSessionInbound` of `hold` or `refuse` prevent it. The 1.0 previews (verified with 1.0.0-preview.2) do not give their processes a socket, so there the message waits for the next turn's hook.

**Grok idle wake:** in leader mode (`[cli] use_leader = true` in `~/.grok/config.toml`, or `grok --leader`) one leader process owns every Grok session and spawns its MCP servers. The bridge, a child of that leader with `GROK_SESSION_ID`, sends a waking delivery to `~/.grok/leader.sock` as `x.ai/interject`: an idle session starts a turn at once and the TUI shows it live; a busy one takes it into the running turn. In leader mode, a DM can wake an idle session. If a quiet message is already waiting, the DM waits until Grok next calls `message-bus`. Because leader mode changes every Grok session on the machine, `agent-bus install grok` asks on the terminal before it sets `use_leader = true` (in your `[cli]` table, or in a new `[cli]` table it adds at the end of the file, outside its MCP block; both lines are marked `# agent-bus:grok leader`); `--leader` sets it without asking, `--no-leader` leaves it as it is, and with no terminal and no flag it leaves it as it is and prints how to turn it on. Install reads the setting as the file has it now, so a value you changed is yours. Uninstall takes the setting back only if the installer made it and it is still `true`, and removes a `[cli]` table it added only if you put nothing else in it; `agent-bus doctor` notes "no idle wake: leader mode off". Standalone Grok has no external entry point and no hook that adds model context, so there messages arrive with the next `message-bus` call. Grok asks once before the model's first `message-bus` call, as for any MCP tool. Verified with Grok Build 1.0.45 built from source (`xai-org/grok-build` `2bdd1d6`).

**MCP limitation:** plain MCP cannot start an idle model turn; both adapters wake through the tool's own mechanism above. Without it (Qwen 1.0 previews, Grok outside leader mode) messages wait for the next turn or `message-bus` call. The bridge reports no busy/idle state and no Live output: Qwen Code and Grok Build agents show only as online. Native adapters such as OMP, Codex, Claude Code, and OpenCode provide wake and live output through their own session APIs.

**Grok by hand:** before writing `~/.grok/config.toml`, the installer parses the result with Bun's TOML parser and changes nothing if that fails. Bun's parser may reject a file Grok reads; then add the block yourself, with the full paths of `bun` (`command -v bun`) and of your Agent Hub checkout:

```toml
[mcp_servers.agent-hub]
command = "/home/YOU/.bun/bin/bun"
args = ["/home/YOU/agent-hub/packages/universal-mcp/src/server.ts", "--harness", "grok", "--url", "http://127.0.0.1:7800"]
```

Use your Hub's URL. Agent Hub owns only a block between `# agent-bus:grok begin` and `# agent-bus:grok end` lines; written as above, without those lines, the entry is yours: `agent-bus install grok` refuses to replace it, and `agent-bus uninstall grok` leaves it, and `agent-bus doctor` does not list it as installed. To check it, start Grok in a project folder, look for the `message-bus` tool among its MCP tools, and call it with `{"op":"projects"}`: the result ends with the agent's address, for example `(you are @webapp-grok)`. For idle wake, also set `use_leader = true` under `[cli]`, or start Grok as `grok --leader`.

## Verification

For an adapter installed with `agent-bus install qwen` or `agent-bus install grok`:

```bash
agent-bus doctor
```

The adapter should be listed as installed with its Hub URL. Then, in the harness, inspect MCP tools and call `message-bus` with `{"op":"projects"}`. The result ends with the assigned stable address, for example `(you are @webapp-qwen)`. A Grok entry added by hand is checked only this second way (above).
