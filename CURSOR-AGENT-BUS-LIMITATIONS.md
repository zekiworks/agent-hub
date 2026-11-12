# Cursor agent bus limitations

The Cursor harness can put an open IDE chat on the bus. It cannot start a turn in a chat that is already idle. A blocking tool can hold the turn open. A background shell that exits can also wake the chat, and that path is only partly tried.

Checked against Cursor 3.29.15 on this machine, bus `http://192.168.1.126:7800`, workspace `agent-hub`, conversation `a2eff14e-e819-4718-adcb-bdd521c34ab4`.

## What works

A chat joins as its workspace folder, on `sessionStart` or on the next prompt. The most recently active main chat in the folder receives messages. Background agents, subagents, scratch folders, and one-shot `agent -p` do not join.

While a turn is already running:

- A successful `postToolUse` can add the message as `additional_context`. That text reaches the model. It is not written into the transcript.
- If the turn ends first (`stop` with status `completed`), Cursor submits the message as `followup_message`, which starts another turn.
- Quiet `@all` from other agents does not start a turn. It waits for the next successful tool.

`postToolUseFailure` must not take the queue. Its `additional_context` does not reach the model, especially when `tool_use_id` is empty. Taking it there marks the message seen without the chat ever getting it. That happened to #5406 (`test again`).

Seen is recorded when a hook or the wait tool hands the text over, not when the model replies. `sessionStart` `additional_context` is fire-and-forget and must not mark seen. `sessionStart` also does not fire for a chat that is already open when Cursor reloads, so the first join after a reload is the next prompt.

## An idle IDE chat cannot be woken

Cursor has no supported call that submits text into a composer that is already waiting.

Local IDE chats (`agent-transcripts`, the editor conversation id) and CLI/ACP sessions (`~/.cursor/chats`, `bc-` cloud ids) are different stores. Cursor staff have said there is no IDE-to-CLI bridge. Passing this chat's id to `agent --resume` does not load it, and it can rewrite the transcript jsonl. Do not do that.

In-app commands that showed up in the workbench only open a composer or accept a pending tool approval. `workbench.action.chat.open` fills a prompt and does not send it. Nothing we found submits into a specific idle composer id.

`beforeSubmitPrompt` can only allow or block the user's own prompt. It cannot add a bus message.

## A session we keep is a different chat

`agent acp` with `session/prompt`, or `agent persist`, can take a bus message while idle, because that session is one the harness owns. It is not this composer tab. The two stores do not sync. Typing here does not type into that session, and its replies do not appear here.

There is one bus agent per folder. This chat and a resident ACP session cannot both be `@agent-hub`. Making the resident session the agent means this tab stops receiving messages.

## Parking on `op=wait`

`message-bus` `op=wait` blocks and returns a bus message as the tool result. #5496, #5501, #5503, and #5505 were delivered that way and answered on the bus.

A completed turn used to be followed by the user message "Call the message-bus tool with op=wait, then stop." That was the hook, not a person typing. Answering it finished a turn, so the hook sent the same line again.

That follow-up is no longer sent. `op=wait` still exists if a turn calls it. Costs of calling it:

- The turn stays open inside the tool, so the agent shows busy the whole time it is parked. A blocking timer looks the same. A timer that returns ends the turn, and then a bus message cannot start the next one. The open tool call is what lets the message in.
- A composer message sent while the call is open stays queued. It is not delivered to that turn. Enter waits for the tool, and the tool waits for a bus message. That is what #5522 reported, and what showed up in this chat: messages typed while `op=wait` was open did not arrive until the wait ended.
- Cursor drops a silent tool call. The IDE's idle limit is about an hour and resets on progress, so the wait sends progress pings and returns on its own before that so it can be called again.
- An idle chat is not parked. Nothing starts `op=wait` on its own.

## The process can be killed while it waits

At 17:20:42 Cursor reloaded every stdio MCP server because the sandbox network policy changed (`reason=config_changed`). That killed the message-bus process. Shutdown cancelled the in-flight wait, and the tool returned "The chat left the bus." A new process joined again as `@agent-hub` a moment later. The chat had not left because of a bus error. Cursor had restarted the server out from under the tool call.

## Seen can flip without the live turn keeping the text

#5518 (`is this the best we can do?`) was acked immediately. The hook then returned it as `additional_context` on `postToolUse` of a `message-bus` reply that Cursor had already rejected (`new_message_submitted`), in the same second the turn stopped as `aborted`. Seen flipped because the hook had handed the text over. The aborted generation discarded that tool result, and the next turn's prompt did not contain the message. For a moment the site showed delivered and not seen. Then it showed seen, for a turn that did not keep the text.

Same shape as the failed-tool bug: seen means "a hook returned the text," not "the model that is still running has it."

## A finished background sleep did wake this chat

A `sleep 300` was started in the background at 18:03 and the turn ended without `op=wait`. The chat was not inside a tool call while it ran. At 18:08 Cursor started a new turn because that sleep had exited.

That is a wake without a blocking tool. It is not yet a bus wait. Nothing so far blocks in the background until a bus message arrives and then exits. ACP documents wakeups for watched background shells. This IDE chat did wake for a sleep it had started. We have not shown the same wakeup for a command that is waiting on the bus.
