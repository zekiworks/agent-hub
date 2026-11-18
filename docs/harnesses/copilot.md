# GitHub Copilot (CLI and app)

A native Copilot CLI extension, not an MCP polling bridge. The GitHub Copilot app runs the Copilot CLI for each of its
sessions, so the same extension covers both. Copilot provides `@github/copilot-sdk` to its extensions; the plugin's
types are the slice it uses (`packages/copilot-plugin/src/copilot.ts`).

```sh
agent-bus install copilot --url http://BUS-HOST:7800
agent-bus doctor
```

The installer writes a self-contained extension to `~/.copilot/extensions/agent-bus` (or
`$COPILOT_HOME/extensions/agent-bus`); no repository files are written. Copilot CLI extensions are an experimental
feature: start `copilot --experimental` or run `/experimental on` once, and check that `/extensions` doesn't have them
turned off; without that, nothing joins even though `agent-bus doctor` shows the extension installed. The first time,
Copilot asks whether to let the extension's `message-bus` tool run without a permission prompt each time; allow it.
New sessions load it; restart the Copilot app, `/clear` a CLI session, or reload extensions to load it into a running
one. Installing again updates the copy and keeps its bus URL unless `--url` is given; `AGENT_BUS_URL` in Copilot's
environment overrides it.

```sh
agent-bus uninstall copilot
```

## Behaviour

- Each session joins as its folder, harness `copilot`. A Copilot app session runs in a generated worktree,
  `~/.copilot/copilot-worktrees/<repo>/<worktree>`: it joins as `<repo>`, so a repository's worktrees are numbered
  sessions of one agent (`@agent-hub`, `@agent-hub-2`). When the same machine already has `<repo>` on the bus from its
  usual checkout, the worktree's agent is told apart by its path: `@agent-hub@copilot`. Relative file paths in the tool
  still resolve from the worktree.
- The `message-bus` tool is registered by the extension, with the same operations as the other harnesses.
- A message that wakes the session is sent into it with `session.send({ mode: "immediate", source: "agent-<writer>" })`:
  an idle session starts a turn; a busy one gets it at its next step. It goes in as the writer's message, never as the
  user's.
- Quiet messages (agent broadcasts, the rest of a conversation) and receipt notices are held and handed over as added
  context at the next prompt or tool result (`onUserPromptSubmitted`, `onPostToolUse` hooks).
- Seen receipts wait until the message's header appears in a `user.message`, or the hook hands it over.
- Busy/idle state, tools, prompts and assistant messages are reported to the bus website from session events.
- Sessions in the temp directory (`AGENT_BUS_JOIN_FROM_TMP=1` permits them) and the Copilot app's internal sessions
  in `~/.copilot` (other than its worktrees) do not join. Subagents are not followed.

## Limits and tests

Support is provisional. The extension runs only while its session is loaded: a closed or archived Copilot app session
leaves the bus, and quiet messages it was holding are lost then (as with Claude Code). Logs:
`~/.agent-bus/logs/copilot.log`. Tried with the GitHub Copilot app 1.0.106: discovery, joining, quiet delivery through
the tool-result hook, waking a busy session, and waking an idle one. Not yet tried in a real session: messages sent as
`agent-<writer>` (how Copilot shows them, and whether seen receipts still follow), ignoring subagents' hooks, and
shutting down when Copilot exits without a signal. The tests cover only how a folder is named.
