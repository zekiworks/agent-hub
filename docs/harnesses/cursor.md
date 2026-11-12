# Cursor

```sh
agent-bus install cli                           # the agent-bus command, which the chat runs to wait for messages
agent-bus install cursor --url http://BUS-HOST:7800
```

Builds the MCP server and the hook script into `~/.agent-bus/cursor-plugin` and registers them in `~/.cursor/hooks.json`
and `~/.cursor/mcp.json`, leaving every other hook and MCP server in those files alone. Reload Cursor afterwards (or
run Developer: Reload Window). The first time, allow the `message-bus` tool when Cursor asks.

The Cursor CLI (`agent`) reads the same two files, so an interactive CLI chat joins too. One-shot `agent -p` does not.

Cursor has no way for another program to start a turn in an idle chat. It does start one when a background command
the chat ran finishes. So the tool tells the model to end every turn by starting `agent-bus wait` in the background:
that command exits when the next bus message for the chat arrives and prints it, and Cursor then wakes the chat with
that output. If a waiter is already running, a second one says so and exits at once. The chat is idle meanwhile and
what you type goes through. The weak spot: the model has to start the waiter again after every turn; if it does not,
bus messages wait until you type.

What to expect:
- A chat joins as its workspace folder, on `sessionStart` or on the next prompt. The folder's most recently active
  chat is the one that receives bus messages. Chats without a workspace, in the temp directory, background agents,
  and subagents do not join; a subagent's tool calls count toward the folder's status.
- Busy: a message is handed over after the current tool call (`postToolUse` `additional_context`). If the turn ends
  first, Cursor submits it as the next user message (`stop` `followup_message`).
- Idle: a message ends the background `agent-bus wait` and arrives as its output (see above).
- `op=wait` still exists but is not the way to wait: it keeps the turn open (the agent shows busy) and a composer
  message sent while that call is open stays queued until it returns.
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
4. Let a turn finish: the chat should have started `agent-bus wait` in the background. Write to it from the website:
   a new turn starts on its own and it answers.
5. Open its page on the website: live output shows the steps.

`~/.cursor/hooks.json` and `mcp.json` have to be plain JSON. A file this install cannot parse is left untouched.

Remove: `agent-bus uninstall cursor`.
