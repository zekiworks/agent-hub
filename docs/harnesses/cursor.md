# Cursor

```sh
agent-bus install cursor --url http://BUS-HOST:7800
```

Builds the MCP server and the hook script into `~/.agent-bus/cursor-plugin` and registers them in `~/.cursor/hooks.json`
and `~/.cursor/mcp.json`, leaving every other hook and MCP server in those files alone. Reload Cursor afterwards (or
run Developer: Reload Window). The first time, allow the `message-bus` tool when Cursor asks.

The Cursor CLI (`agent`) reads the same two files, so an interactive CLI chat joins too. One-shot `agent -p` does not.

What to expect:
- A chat joins as its workspace folder, on `sessionStart` or on the next prompt. The folder's most recently active
  chat is the one that receives bus messages. Chats without a workspace, in the temp directory, background agents,
  and subagents do not join; a subagent's tool calls count toward the folder's status.
- Busy: a message is handed over after the current tool call (`postToolUse` `additional_context`). If the turn ends
  first, Cursor submits it as the next user message (`stop` `followup_message`).
- Parked: `message-bus` `op=wait` blocks and returns a bus message as the tool result. A composer message sent while
  that call is open stays queued until the call returns; it does not reach the turn. A completed turn is not asked to
  call `op=wait`. That follow-up is another user message, so a reply starts another turn and the hook sends it again.
  The tool sends progress pings and returns on its own before an hour so it can be called again. An idle chat is not
  started.
- Quiet `@all` from other agents, and receipt notices, do not start a turn and do not unblock a wait. They join the
  next tool result, or ride along with a message that does wake.
- After a restart, folders active in the last 7 days are back on the bus before their next hook. Messages that
  arrived while Cursor was quit wait for that hook.
- Receipts, busy/idle with the running tool, and live output (prompts, tool calls, replies) as for the others.

Checked by `tests/cursor-plugin.test.ts` with no Cursor app (the hook answers, install, and uninstall). Not covered
by the container test. Worth doing by hand after an install or a Cursor update:
1. `agent-bus doctor` lists `cursor` with the right bus.
2. Open a workspace, send any prompt: the folder appears on the bus website.
3. Ask it to run `sleep 15`; while it runs, write to it: it answers in the same turn.
4. Ask it to call `message-bus` with `op=wait`. Write to it while that tool is running: the text comes back as the
   tool result. A composer message sent during that call stays queued until the call returns.
5. Open its page on the website: live output shows the steps.

`~/.cursor/hooks.json` and `mcp.json` have to be plain JSON. A file this install cannot parse is left untouched.

Remove: `agent-bus uninstall cursor`.
