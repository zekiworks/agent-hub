# Hermes

Not yet covered by `agent-bus install`: the plugin is copied by hand.

```sh
scp -r packages/hermes-plugin/message-bus HOST:~/.hermes/plugins/
ssh HOST 'hermes plugins enable message-bus'
```

Then in the Hermes config:

```yaml
plugins:
  entries:
    message-bus:
      allow_gateway_injection: true
      settings:
        url: http://BUS-HOST:7800
        name: assistant                  # joins by name, not folder
        session_key: agent:main:discord:group:<chat_id>:<user_id>   # the session that receives messages
```

and `hermes gateway restart` (it waits for running turns).

What to expect: the agent joins by name; messages for an idle session start a turn; messages that arrive while it is
busy are held and handed over together as one message when the turn ends (Hermes would otherwise queue each as its
own turn and drop the rest after 32). The plugin has its own copy of the tool texts and does not have the GPU
schedule actions yet.

Tested by use (one Hermes agent on Discord, since 1 Nov), including the version with agent tokens (11 Nov).

## Live View and status

The source plugin also contains `live_view.py`; copy the whole `message-bus` directory, not only `__init__.py`.
It consumes Hermes's public `pre_llm_call`, `post_llm_call`, `on_session_end`, `pre_tool_call`, `post_tool_call`,
`on_stream_delta`, `on_stream_end` and `on_interim_message` observers. Unsupported optional
hooks are skipped on older Hermes versions. No core patch, polling, new agent or model request is used for telemetry.

- Status reports follow observed main turns (from `pre_llm_call` through `on_session_end`), coalesced at 250 ms.
  They include the oldest running tool and its latest available intent. Overlapping turns remain busy until all end.
- A `watch: true` frame sends a replay, then changed activity upserts at 300 ms intervals. `watch: false` and
  disconnect fence pending frames; reconnect reports current status but waits for a fresh watch before activity.
- Replay keeps the last 60 user/assistant/tool entries. Visible text is capped at 20,000 characters, tool input
  at 600, tool output at its last 4,000 characters. These bounds match the shared client's display limits.
- Reasoning deltas are not exported as visible assistant text. Final-response fallback covers non-streaming clients
  and delayed stream observers. Interrupted turns close unfinished display entries without altering execution.
- Live output is private bus telemetry, not a public benchmark export or a durable transcript. Caps are not an
  anonymization guarantee: authorized Live-tab viewers can see the displayed user text and tool previews.
- Display failures are isolated from message injection, ack/seen and retry behavior. No deployed profile is changed
  by editing this checkout; install/reload and the throwaway-bus website acceptance are separate review steps.

Run the isolated Python contract tests (fake socket/injector, no gateway or model):

```sh
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests -p 'test_hermes_live_view.py' -v
```
