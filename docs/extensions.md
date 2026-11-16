# Extensions: services with tools and an optional Workspace page (proposal)

Status: proposal, 16 Nov 2026, for Can (#10174: "generic tool support with an optional UI extension; no agent per
extension") and Ümit; nothing here is built. Stages 1 and 3 have their own cards (#10193, #10194); this document is
the contract for stages 2 and 4, which come after them.

An extension is a service the bus knows by name. It may offer:

- a **page** for people, opened in the Workspace by a launcher (stage 1);
- **notes** for agents: a few lines telling them what it offers (stage 2);
- **tools** agents call through their message-bus tool, and actions people take on the website (stage 4).

No agent account belongs to an extension. Who maintains its code is an operational matter, not part of the contract.

## The manifest

The bus's config lists only `name` and `url` (and may override the launcher label). Everything else the service
describes itself, at `GET <url>/bus-extension.json`, read when the bus starts and every 10 minutes:

```json
{
  "name": "gpus",
  "title": "GPUs",
  "page": "/",
  "agents": "Shared GPUs on bariton and the Sparks. Book one before a GPU job: op=ext name=gpus action=reserve.",
  "tools": [
    {
      "action": "reserve",
      "description": "Book a GPU (or part of one) for a while.",
      "params": {
        "resource": { "type": "string", "description": "\"bariton GPU 2\", a uuid prefix or an id", "required": true },
        "hours": { "type": "number", "description": "at most 48", "required": true },
        "purpose": { "type": "string", "required": true }
      },
      "for": ["agent", "person"]
    }
  ]
}
```

`params` uses only `string`, `number`, `boolean` and `enum`, so every harness can show it. `for` says who may call it.

## Stage 2: notes for agents

The model must see the notes without asking, but tool descriptions are fixed when a harness loads: omp and pi
register the tool at startup, before the agent joins; MCP harnesses (Claude Code, Codex) list tools when the session
starts. So:

1. **The tool description gains one fixed sentence:** "This bus may have extensions (GPUs and others): `op=ext`
   without `name` lists them, their notes and their actions." Every harness, no dynamic text needed.
2. **Where a harness builds its description after reaching the bus** (the MCP plugins can fetch `GET /api/state`
   before answering the tool list), the notes are added to the description itself.
3. **Elsewhere (omp, pi, Hermes)** the notes reach the model with the agent's first delivery of a session, as one
   extra line under the message ("Extensions here: …; op=ext lists their actions"). It costs no turn and no message.

## Stage 4: tools

### Agents

`op=ext name=<extension> action=<action>` plus the action's params, through the existing tool. `op=ext` alone lists
extensions, `op=ext name=gpus` lists that one's actions with their params.

The bus checks the extension and action exist and that `for` includes agents, then calls

```
POST <url>/actions/<action>
X-Bus-Caller: <participant id>       X-Bus-Caller-Kind: agent | person
X-Bus-Signature: <HMAC-SHA256 of the body with the extension's secret>
{ ...params }
```

and returns the answer's `text` as the tool result (`data` is kept for the website). 30 s timeout; the service's
error message passes through. The service trusts the caller id only with a valid signature; the secret lives in the
bus's config and the service's, never in a page.

### People

Actions with `for: ["person"]` are offered on the website. A person's action always goes through a confirm dialog the
website draws from the manifest (the action's description and the filled params), then the same call with
`X-Bus-Caller-Kind: person`. The extension's page can ask for one (`agent-bus:action`, like stage 3's form opening)
but never perform one: the page has no credentials and learns only who is looking.

### Notices from an extension

An extension may write messages as itself (`@gpus`), a built-in participant like `@resources` today: it posts with
its secret, the bus's wake rules apply, and replies to it are forwarded to `POST <url>/replies`. This is how "your
hold ends in 30 min" reaches an agent.

## GPU booking as the first extension

The schedule (packages/server/src/resources.ts, about 800 lines: holds, queue, expiry, reclaim, idle checks,
`@resources` notices) and the GPU ops of the agents' tool move behind this contract:

- **In-process first.** The schedule stays in the bus process as a built-in extension module that implements the same
  contract (manifest, actions, notices) without the HTTP hop; it can move to its own service later without changing
  callers.
- **Agents:** `op=reserve` and friends become `op=ext name=gpus action=reserve`. Old sessions keep the old ops until
  they restart; the old ops are then removed, as with wake lists.
- **People:** the GPUs dialog moves into gpudash's page (its buttons ask the website for the confirm dialog).
- **A hub without GPUs:** no `gpus` entry, so no launcher, no notes, no GPU actions.

## Order and size

| Stage | What | Size |
|---|---|---|
| 1 | config entries, launcher, read-only page (#10193) | small–moderate |
| 3 | page buttons open the hub's existing forms (#10194) | small |
| 2 | notes for agents | moderate (bus + 7 harness plugins) |
| 4 | tools, person actions, notices; GPU booking moved | large |

Stage 4 changes every agent's GPU commands; it should start only after 1–3 have been used for a while.
