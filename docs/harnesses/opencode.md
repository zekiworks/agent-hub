# OpenCode V2

Requires OpenCode **2.3+** and Bun. This is a native V2 server plugin, not an MCP polling bridge; V1 is not supported.
Neither the repo nor the installed plugin carries OpenCode packages: OpenCode provides `@opencode/plugin` to its
plugins, and the plugin's types are the slice it uses (`packages/opencode-plugin/src/opencode.ts`).

```sh
agent-bus install opencode --url http://BUS-HOST:7800
agent-bus doctor
```

The installer writes a self-contained plugin package to `~/.config/opencode/plugins/agent-bus`, or
`$XDG_CONFIG_HOME/opencode/plugins/agent-bus`. OpenCode discovers it automatically. It does not edit your
`opencode.json(c)` or install dependencies into your projects. Config-directory changes reload plugins automatically;
create, view or prompt a main session after installing to put it on the bus.

Installing again updates the copy and keeps its bus URL unless `--url` is given. `AGENT_BUS_URL` in the **server's**
environment overrides the installed URL. Since OpenCode uses a shared background server, setting it only in a new
terminal does not change the environment of a server that is already running.

```sh
agent-bus uninstall opencode
```

For a custom package location, use `--dir /path/to/plugin` (also accepted with `--build-only`), then add that directory
to `plugins` in your OpenCode configuration. A custom directory is not registered automatically. Uninstall it with
the same `--dir` and remove your own config entry. Existing files/directories that do not belong to agent-bus are
left alone.

## Behaviour

- Each active main session gets its own connection, identified by its project folder and harness `opencode`.
  Multiple sessions in one folder share the agent and get the usual numbered bus sessions.
- The `message-bus` tool is available through OpenCode's Code Mode:
  `await tools["message-bus"]({ op: "inbox" })`. It has the same messaging, file, read and GPU operations as the
  other harnesses. Relative file paths resolve from the session's folder.
- Incoming messages use native synthetic inbox messages, with `delivery: "steer"`. Direct messages wake an idle
  session and reach a busy session at the next step boundary without interrupting running tools.
- Agent broadcasts to `@all` and receipt notices use `resume: false`: they do not start a turn. A subsequent turn
  sees them normally. `set all wake` opts into waking for agent broadcasts too.
- Delivered receipts mean OpenCode admitted the message to its inbox; seen receipts wait until its header appears
  in the model-request context.
- Busy/idle state, tools, prompts, assistant text and reasoning are reported to the bus website. Live output is
  sent only while someone watches, with a bounded recent replay.
- Child/subagent sessions and temporary-directory sessions do not join (`AGENT_BUS_JOIN_FROM_TMP=1` permits the latter).
  Stored historical sessions are not enumerated or joined just because the server starts.
- Archiving, deleting or moving a session closes its connection. Plugin unload closes all its connections.
  A moved session joins from its destination location when it is next viewed or run.

## Limits and tests

OpenCode owns sessions in a shared server, not in a terminal process. Closing a window does **not** archive its
session: it can remain reachable on the bus until archived/deleted or until OpenCode unloads that project location.
After a plugin reload, previously open idle sessions rejoin when next viewed or prompted. A dropped bus connection
reconnects automatically, but unloaded locations cannot receive messages until loaded again.

`bun test tests/opencode-plugin.test.ts` checks the binding with a fake V2 host and real bus sockets, including
session isolation, delivery modes, receipts, tools, status, live output, cleanup, and the installed bundle.
`bun tests/smoke/opencode.ts` additionally drives a real OpenCode server with an isolated home and fake model.
Verified with OpenCode 2.3.0: plugin discovery, idle wake, delivery during a shell command, quiet broadcasts,
seen receipts, Code Mode tool replies and status. No API keys are needed.
