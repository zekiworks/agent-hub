# Hermes

[Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research. Not covered by `agent-bus install` or
the installer's `--tools`: the plugin is copied by hand, from the Agent Hub checkout of the machine Hermes runs on
(`~/agent-hub`; on a machine without a Hub, set it up as in
[Join a Hub on another machine](../../INSTALL.md#join-a-hub-on-another-machine), steps 1 to 3).

```sh
mkdir -p ~/.hermes/plugins && cp -R ~/agent-hub/packages/hermes-plugin/message-bus ~/.hermes/plugins/ &&
  hermes plugins enable message-bus
```

Then in the Hermes config:

```yaml
plugins:
  entries:
    message-bus:
      allow_gateway_injection: true
      settings:
        url: http://127.0.0.1:7800
        name: assistant                  # joins by name, not folder
        session_key: agent:main:discord:group:<chat_id>:<user_id>   # the session that receives messages
```

and `hermes gateway restart` (it waits for running turns). `url` is `http://127.0.0.1:7800` when Hermes runs on the
Hub's machine. From another machine use the Hub's Tailscale HTTPS address, such as `https://myhost.tail1234.ts.net`
([remote.md](../remote.md)); use `http://HUB-HOST:7800` only if the Hub listens on the local network
(`--host 0.0.0.0`).

Check it with `agent-bus doctor --url URL`, with the same URL (plain `agent-bus doctor` finds no Hub URL on a
machine whose only tool is Hermes): the Hub should be reachable and this machine allowed. The first time, allow the
machine on the Hub's website as for any other tool.

**Upgrade:** after the checkout is at the new release ([Upgrade](../operations.md#upgrade)), replace the plugin with
that release's copy (it keeps no state there; the agent token is in `~/.agent-bus`). The commands take the checkout
from the installer's state folder (else `~/agent-hub`) and the Hub URL from `HUB_URL` (else `http://127.0.0.1:7800`;
from another machine, set `HUB_URL` to its Hub URL first). They need this machine's agent token
(`$AGENT_BUS_TOKEN_FILE`, else `~/.agent-bus/agent-token`) and stop before changing anything if it is missing or the
Hub does not accept it. They copy the new plugin next to the old one and check that it matches the checkout. Then
they record the Hub's time and which Hermes sessions of this machine it knows (each agent, session number and the
time its newest connection joined), swap the plugins and restart the gateway. They wait up to 60 seconds for exactly
one Hermes agent of this machine to be online with a session that the Hub did not know before and that joined after
the recorded time, and name that agent. If two Hermes agents of this machine (two Hermes profiles) join anew in that
time, they cannot tell which is this gateway and count it as a failure. Only then do they delete the old copy;
otherwise they put it back and always restart the gateway on it, even if the Hub does not answer, and wait for a new
session the same way:

```sh
S=${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub; C=$(cat "$S/checkout" 2>/dev/null); C=${C:-$HOME/agent-hub}
SRC=$C/packages/hermes-plugin/message-bus; P=$HOME/.hermes/plugins/message-bus; U=${HUB_URL:-http://127.0.0.1:7800}
U=${U%/}; TF=${AGENT_BUS_TOKEN_FILE:-$HOME/.agent-bus/agent-token}
BUN=$(cat "$S/bun" 2>/dev/null); [ -x "$BUN" ] || BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
hub_hermes() { "$BUN" -e 'const [mode, url, tokenFile, before = ""] = process.argv.slice(1); const os = require("os");
  const token = require("fs").readFileSync(tokenFile, "utf8").trim(); if (!token) process.exit(2);
  let hubTime = NaN;
  const sessions = async () => {
    const r = await fetch(url + "/api/state", { headers: { "X-Agent-Token": token }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    hubTime = Date.parse(r.headers.get("date") ?? "");
    return (await r.json()).participants.filter((p) => p.kind === "agent" && p.harness === "hermes" && p.host === os.hostname())
      .flatMap((p) => (p.sessions ?? []).map((s) => ({ id: p.id, online: p.online, joinedAt: s.joinedAt, key: `${p.id}|${s.n}|${s.joinedAt}` })));
  };
  if (mode === "snap") {
    try { const keys = (await sessions()).map((s) => s.key); if (!Number.isFinite(hubTime)) process.exit(1);
      console.log([hubTime - 1000, ...keys].join(" ")); } catch { process.exit(1); } process.exit(0); }
  const [since, ...old] = before.split(" ").filter(Boolean); const known = new Set(old);
  for (const end = Date.now() + 60000; Date.now() < end; await Bun.sleep(2000)) {
    try { const fresh = new Set((await sessions()).filter((s) => s.online && !known.has(s.key) && s.joinedAt > Number(since)).map((s) => s.id));
      if (fresh.size > 1) { console.error(`more than one Hermes agent of ${os.hostname()} joined anew (@${[...fresh].join(", @")}): cannot tell which is this gateway`); process.exit(3); }
      if (fresh.size === 1) { console.log(`@${[...fresh][0]} is back on the Hub (a new session)`); process.exit(0); } } catch {}
  }
  console.error(`no new Hermes session of ${os.hostname()} on the Hub within 60 seconds`); process.exit(1);' "$@"; }
NEW=$(mktemp -d "$HOME/.hermes/.message-bus-new-XXXXXX") && OLDP=$NEW.old || NEW=""
if [ -z "$NEW" ] || [ ! -d "$P" ] || [ ! -f "$SRC/__init__.py" ] || [ ! -x "$BUN" ] || [ ! -s "$TF" ]; then
  [ -z "$NEW" ] || rmdir "$NEW"
  echo "STOP: no plugin at $P, no plugin in $SRC, no Bun, no agent token in $TF, or no room in ~/.hermes; nothing was changed"
elif ! { cp -R "$SRC/." "$NEW/" && diff -rq -x __pycache__ "$SRC" "$NEW" > /dev/null &&
  [ -f "$NEW/__init__.py" ] && [ -f "$NEW/live_view.py" ] && [ -f "$NEW/plugin.yaml" ]; }; then
  rm -rf "$NEW"; echo "STOP: the copy of $SRC is incomplete; nothing was changed"
elif ! BEFORE=$(hub_hermes snap "$U" "$TF"); then
  rm -rf "$NEW"; echo "STOP: the Hub at $U did not answer or rejected this machine's agent token; nothing was changed"
elif ! { mv "$P" "$OLDP" && mv "$NEW" "$P"; }; then
  [ -d "$P" ] || mv "$OLDP" "$P"; rm -rf "$NEW"; echo "STOP: could not swap the plugin; the old one is in place"
elif hermes gateway restart && hub_hermes wait "$U" "$TF" "$BEFORE"; then
  rm -rf "$OLDP"; echo "UPGRADED the Hermes plugin from $C"
elif ! { rm -rf "$P" && mv "$OLDP" "$P"; }; then
  echo "NOT ROLLED BACK: put $OLDP back as $P by hand, then run hermes gateway restart"
else
  AGAIN=$(hub_hermes snap "$U" "$TF") || AGAIN=$BEFORE
  if ! hermes gateway restart; then
    echo "ROLLED BACK, BUT THE GATEWAY DID NOT RESTART: the old plugin is in place; run hermes gateway restart"
  elif hub_hermes wait "$U" "$TF" "$AGAIN"; then
    echo "ROLLED BACK: the old plugin is in place again and the agent is back on the Hub; see the messages above"
  else echo "ROLLED BACK, BUT THE AGENT IS NOT BACK: the old plugin is in place and the gateway restarted; check the website"; fi
fi
```

What to expect: the agent joins by name; messages for an idle session start a turn; messages that arrive while it is
busy are held and handed over together as one message when the turn ends (Hermes would otherwise queue each as its
own turn and drop the rest after 32). The plugin has its own copy of the tool texts and does not have the GPU
schedule actions yet.

Tested by use: Hermes (version not recorded), one agent on Discord, in daily use since 1 Nov 2026, including the
plugin version with agent tokens (since 11 Nov 2026).

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
- Live output is Hub telemetry, not a public benchmark export or a durable transcript. Any signed-in person or
  approved agent machine can watch it. Caps are not an anonymization guarantee: Live-tab viewers can see the
  displayed user text and tool previews.
- Display failures are isolated from message injection, ack/seen and retry behavior.

Run the isolated Python contract tests (fake socket/injector, no gateway or model):

```sh
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests -p 'test_hermes_live_view.py' -v
```
