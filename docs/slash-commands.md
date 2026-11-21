# Slash-command extensions, with /task as the first (design)

Status: design, 21 Nov 2026, for Can (#13857: "/task is an extension, activated with the slash command; it declares
the arguments it needs, /task $ID string; it needs a task panel and to extend the chat entries with cancel and an
annotation that this is a task"). Nothing here is built. It extends the extension contract of
[extensions.md](extensions.md) (manifest, signed calls, notices) with three things: **commands**, **message
annotations** and **panels**. With those, tasks leave the bus core and become an ordinary extension.

## What an extension can do

| Piece | What the person sees | Who renders it | Who decides |
|---|---|---|---|
| Command | `/task` in the box's `/` menu, its arguments checked as typed | the website, from the manifest | the extension, on Enter |
| Annotation | "Task · open · @webapp" under a message, with buttons (Accept, Done, Cancel) | the website, from data the bus stores | the extension, on each button |
| Panel | a "Tasks" tab in the Workspace: my open tasks, assigned by me | the extension's own page (`--ext` frame) | the extension |
| Notices | "Task #13900 done by @webapp" as a reply under the task | the bus, as a message from `@task` | the extension |

The bus never knows what a task is. It knows commands, annotations on messages, panels and who may do what; the
extension knows the rest and keeps its own state.

## The manifest (`GET <url>/bus-extension.json`)

```json
{
  "name": "task",
  "title": "Tasks",
  "commands": [
    {
      "name": "task",
      "help": "Give a member a task: /task @webapp fix the two Safari tests",
      "args": [
        { "name": "to", "type": "member", "repeat": true, "required": true },
        { "name": "text", "type": "rest", "required": true }
      ],
      "for": ["person", "agent"],
      "where": ["dm", "group", "project"]
    }
  ],
  "annotations": {
    "actions": {
      "accept": { "label": "On it", "for": "annotation.assignees" },
      "done": { "label": "✓ Done", "for": "annotation.assignees" },
      "reject": { "label": "✕ Reject", "for": "annotation.assignees", "ask": "Why not? (optional)" },
      "cancel": { "label": "Cancel", "for": "message.author", "confirm": "Cancel this task?" }
    }
  },
  "panel": { "title": "Tasks", "scope": "global", "page": "/panel" }
}
```

- **Argument types** the website and the agents' tool understand and check before anything is sent:
  - `member`: a participant of this conversation (completed from the @ menu; `repeat` allows several);
  - `participant`: anyone on the bus;
  - `message`: `#13900`, readable by the caller;
  - `string` / `number` / `enum` (with `values`);
  - `rest`: everything after the last argument.

  Can's `/task $ID string` is `[member, rest]`. An `$ID` that is a message (`/cancel #13900`) is `message`.
- `for` and `where` limit who may use it and in which kind of conversation. The bus enforces both.

## The flow, end to end

```mermaid
sequenceDiagram
  participant P as Person (website)
  participant B as Bus
  participant E as Extension (task)
  participant A as @webapp
  P->>P: types "/task @webapp fix the Safari tests"; menu + args checked from the manifest
  P->>B: Enter: POST /api/ext/task/command {conversationId, command, args}
  B->>E: POST <url>/commands/task (signed; caller, conversation, args, latest messages)
  E-->>B: {post: {text, annotation:{state:"open", assignees:["webapp"]}, wake:["webapp"]}}
  B-->>P: the proposed message, shown in the box as a task card
  P->>B: Send: POST /api/messages {…, ext:{task: proposalId}}
  B->>B: stores the message with message.ext.task = annotation; wakes @webapp
  B->>E: POST <url>/events {type:"posted", seq, annotation}
  B->>A: delivery "#13900 task for you: fix the Safari tests" (+ its actions)
  A->>B: op=ext name=task action=done message_id=13900
  B->>E: POST <url>/actions/done {seq, caller:"webapp"} (signed)
  E-->>B: {annotation:{state:"done"}, notice:"Done by @webapp"}
  B->>P: message #13900 redrawn "Task · done ✓"; notice posted as @task under it
```

1. **Typing.** `/` at the start of an empty box opens the command menu (built-in plus every extension's). After a
   command, the box shows its argument hints and marks a wrong argument at once (unknown member, missing text). This
   is all the website's work, from the manifest.
2. **Enter = ask the extension.** The bus checks `for` and `where` and calls `POST <url>/commands/<name>` signed, as in
   extensions.md: caller id and kind, the conversation (id, kind, members), the parsed args, and its latest messages
   (as box extensions get them). Nothing is posted yet.
3. **The answer is one of:**
   - `post`: a message for the box, with its annotation and the agents it should wake. The box shows it as a card;
     the person edits the text and presses Send. A page or extension never sends on its own (the rule since 15 Nov).
   - `fill`: text into the box, nothing else.
   - `note`: shown only to the caller ("No task: @webapp is not in this room").
   - `open`: a Workspace tab of the extension (its panel, maybe at a path).
4. **Send.** `POST /api/messages` carries the proposal's id. The bus checks it was issued for this person, this
   conversation and this text's command, then stores the message with `message.ext.task` = the annotation. It applies
   the proposal's `wake` list (members only, as agents' wake lists), and tells the extension (`events`, `posted`).
   Proposals live for 10 minutes and are used once.
5. **Annotations on the message.** Every reader's page draws `message.ext.<name>` under the message: a badge line
   (`label`, `state`, names) and the buttons from the manifest's `annotations.actions` that this reader may use.
   `for` names who: the message's author, the annotation's assignees, any member. Agents get the same in their
   delivery ("Task #13900 for you: …; op=ext name=task action=accept|done|reject").
6. **Buttons and agent actions.** `POST /api/ext/task/actions/<action> {seq, input?}` from the website, or
   `op=ext name=task action=done message_id=13900` from an agent. The bus checks the action exists and the caller is
   in its `for`. It calls the extension signed, and stores the returned annotation on the message. Then it publishes
   the change (every open page redraws it) and posts the returned `notice`, if any, as `@task`, a reply to the
   message, with `wake` as the extension asks.
7. **The panel.** `--ext task=URL` makes the Tasks tab (global: one per person, like Inbox).
   - The page is the extension's own, framed as today. It reads the extension's state through the extension's own
     API, with the caller id the bus puts in the frame URL (signed, the gpudash key way).
   - It asks the website for anything that acts as the person (`agent-bus:compose`, `agent-bus:action` → the confirm
     dialog). It never acts itself.

## What the bus adds (all generic, none of it about tasks)

| Piece | Where | Notes |
|---|---|---|
| `commands` in the manifest, `/api/state` lists them | extensions.ts, protocol | read with the manifest, every 10 min |
| `POST /api/ext/:name/command` → `post`/`fill`/`note`/`open` | new route | proposal ids, 10 min, single use |
| `message.ext` (JSON per extension, ≤ 4 KB), set only by that extension | db column `ext_json`, Message type | changes publish like edits |
| `POST /api/ext/:name/actions/:action` with `seq` | extensions.md stage 4 route | `for` checked against the annotation |
| events to the extension (`posted`, `deleted`, `replied`) | one webhook | retried, so a down extension catches up |
| `@<name>` notices as replies | built-in participant per extension | wake rules as agents' |
| `/` menu, argument hints, annotation line and buttons | website | drawn from data, nothing per extension |
| typed tools for agents: one per command and per annotation action, plus generic `op=command` | harness plugins, client tool | args checked on the bus the same way |

## Tasks as the first extension

- **Service:** `packages/task-ext`, a small Bun service with its own SQLite file (tasks, assignees, states, history),
  started like `complete-ext`.
- **Commands:** `/task @a @b text`, `/approval @can text`. Approval decisions keep needing a passkey-signed person,
  so the bus passes `verified` with the caller.
- **Annotation:** `{type, state per assignee, assignees, by}`; actions accept, done, reject (reason), cancel (author;
  Can's "cancel").
- **Panel:** "Tasks": For me / Assigned by me, open first, each linking to its message.
- **Agents:** a delivery carries "N open tasks: op=ext name=task action=list" the way the bus does today, but from the
  extension: it answers `events` with a per-agent count the bus adds to deliveries. Or there's no reminder at all if
  we drop it (#13584).
- **Moving today's tasks:** the bus's tasks (39 tasks, 49 approvals, 12 open) are copied into the extension once, and
  `message.task` becomes `message.ext.task`. The old routes (`/api/tasks`, op=accept/done/…) answer through the
  extension until no harness uses them, then go. The ✉ Inbox becomes the Tasks panel.
- **What stays in the bus:** nothing about tasks. The approval's passkey check is the bus's `verified` flag, which
  any extension can require.

## Agents: typed tools (Can #13860)

Agents get each command as a tool call with typed arguments, not as text to type:

- **Schemas:** the manifest's args map onto a tool's JSON schema. `/task` becomes `task {to: string[], text: string,
  conversation?: string}`; each annotation action becomes `task_done {message_id}`, `task_reject {message_id,
  reason?}`, and so on, offered only to agents in the action's `for`.
- **Running a call:** the bus runs it as a person's Enter, and a `post` answer is sent at once (the call is the
  agent's send). `note` comes back as the tool result; `fill` and `open` are not offered to agents.
- **When tools are listed:** harnesses fix their tool list when a session starts (omp and pi at startup; the MCP
  plugins for Claude Code and Codex when the session opens). Each plugin fetches the bus's commands then and
  registers one typed tool per command and action. A command added later appears at the agent's next session; until
  then the message-bus tool's generic `op=command name=… args={…}` reaches it, and `op=command` without a name lists
  the schemas.
- **Arguments the schema can't pin:** a type like "a member of this room" changes per conversation, so it is a string
  with a description in the schema. The bus checks it on every call and returns a clear error ("@xyz is not in this
  room"), as it does for wake lists.

## A task's life, through every part (Can #13862)

Ümit gives @webapp a task in #launch; @webapp does it; Ümit sees it done. Every hop, in order:

**0. Startup**
- **task-ext:** starts. It opens `task.sqlite`, with three tables:
  - `tasks(seq, conversation_id, by, text, created_at, cancelled_at)`;
  - `assignees(seq, who, state, reason, at)`;
  - `history(seq, who, action, at)`.
  It serves `GET /bus-extension.json`, `POST /commands/task`, `POST /actions/:action`, `POST /events` and `GET /panel`.
  Every POST checks the bus's HMAC header with the shared secret from its env.
- **Bus:** reads the manifest (at start, then every 10 min) and adds `task` to `/api/state` (`commands`, `panels`,
  `annotationActions`).
- **omp plugin on @webapp's machine:** at session start, `GET /api/state` (agent token). It registers the tools
  `task`, `task_accept`, `task_done`, `task_reject` from the manifest's schemas, next to `message-bus`.

**1. Ümit types** `/task @webapp fix the two Safari tests` in #launch.
- **Website (`ui/commands.ts`, new):** at `/` it shows the command menu from `state.commands`. Once `task` is picked,
  it parses the args against `[member+, rest]`:
  - `@webapp` is checked against #launch's members (green);
  - the rest becomes `text`.
  A wrong member is marked at once, and Enter stays disabled until the args are valid.

**2. Enter**
- **Website → bus:** `POST /api/ext/task/command {conversationId, command:"task", args:{to:["webapp"], text}}`.
- **Bus:** checks Ümit's session, that she may read #launch, `for` (person ✓) and `where` (project ✓). It re-checks
  `to` against the members, then calls the extension with header `X-Bus-Signature`:
  `POST <task-ext>/commands/task {v:1, caller:{id:"umit", kind:"person", verified:true},
  conversation:{id, kind, members}, args, messages:[latest 20]}`.
- **task-ext:** writes nothing yet. It answers with a proposal:
  `{post:{text:"@webapp fix the two Safari tests", annotation:{type:"task", by:"umit",
  assignees:[{id:"webapp", state:"open"}]}, wake:["webapp"]}}`.
- **Bus:** keeps the proposal under an id (10 min, Ümit only, #launch only) and returns `{proposal:{id, text,
  annotation}}`.
- **Website:** shows the text in the box with a card above it ("Task for @webapp · Send gives it"). Ümit may still
  edit the text, or press Esc to drop it.

**3. Send**
- **Website → bus:** `POST /api/messages {conversationId, text, proposal:id}`.
- **Bus:**
  - checks the proposal (its owner, its conversation, still valid, unused) and uses it up;
  - stores the message with `ext_json = {"task": annotation}` and `wake = ["webapp"]`;
  - publishes it: every reader's page draws the line "Task · open · @webapp", and Ümit's page also shows Cancel;
  - then calls `POST <task-ext>/events {type:"posted", seq:13900, conversationId, by:"umit", annotation, text}`.
- **task-ext:** inserts the task row and the assignee row (`open`), plus a history row `created`. This is the moment
  the task exists.

**4. @webapp is woken**
- **Bus → @webapp's plugin:** the delivery of #13900 carries the annotation, along with the action list the bus
  computed from the manifest's `for` (webapp is an assignee: accept, done, reject).
- **Plugin:** shows the model "Task #13900 for you from @umit: fix the two Safari tests. Tools: task_accept,
  task_done, task_reject (message_id 13900)." The tools were registered at step 0, so no reload is needed.

**5. @webapp accepts**
- **Model → plugin:** `task_accept {message_id:13900}`.
- **Plugin → bus:** `POST /api/ext/task/actions/accept {seq:13900}` (agent token).
- **Bus:** checks that webapp is in the action's `for` (it is in `annotation.assignees`), then calls `POST <task-ext>/actions/accept {seq, caller:{id:"webapp", kind:"agent"}}`, signed.
- **task-ext:** sets the assignee to `accepted` and logs history. It answers `{annotation:{…, assignees:[{id:"webapp",
  state:"accepted"}]}}`, with no notice and no wake (accepting wakes nobody, as today).
- **Bus:** stores the new `ext_json` and publishes `messageChanged`. Ümit's page redraws: "Task · @webapp is on it".

**6. @webapp finishes**
- **Model → plugin → bus → task-ext:** `task_done {message_id:13900}`, by the same path.
- **task-ext:** sets `done` and answers `{annotation (done), notice:{text:"Done by @webapp.", wake:[]}}`.
- **Bus:** stores the annotation, publishes the change, and posts the notice as `@task`, a reply to #13900. It wakes
  nobody (Ümit is a person; her page marks it unread, as any reply).
- **Ümit's page:** the line under #13900 says "Task · done ✓ · @webapp", and the Tasks panel moves it to "done".

**Other endings**
- **Rejected:** `task_reject {message_id, reason}`. The notice is "Rejected by @webapp: not today", and it wakes the
  assigner if the assigner is an agent.
- **Cancelled:** Ümit's Cancel button → `POST /api/ext/task/actions/cancel` (`for` = the message's author) → a confirm
  dialog drawn from the manifest's `confirm` → the extension sets `cancelled_at` → the notice "Cancelled by @umit."
  wakes @webapp (the assignee must stop).
- **Message deleted:** the bus sends `events {type:"deleted", seq}`. task-ext cancels the task, and the line goes with
  the message.
- **The extension is down when Ümit presses Enter:** the bus answers the command with "Tasks is not answering", and
  nothing is sent.
- **The extension is down at a later step:** events are queued and retried, so the task row appears once it is back.
  Actions return an error to the caller and change nothing.

**Reminders (if kept)**
- **task-ext:** answers each `events` call with `{open:{webapp:1}}`.
- **Bus:** keeps that small map and adds "(1 open task: task_done …)" to webapp's deliveries until the count drops.

**The panel**
- **Website:** Ümit opens Tasks in the Workspace. The website frames `<task-ext>/panel?who=umit&sig=…`, a link
  signed by the bus, valid for a day.
- **Panel page:** reads `GET /api/mine?who=umit&sig=…` from task-ext itself and lists For me / Assigned by me.
  - A click on a task asks the website to open #13900 (`agent-bus:open`).
  - Its Cancel asks the website for the confirm dialog (`agent-bus:action`). The page never calls the action itself.

## Order and size

| Step | What | Size |
|---|---|---|
| 1 | manifest `commands`, `/` menu and argument checks in the box, `command` route with `fill`/`note`/`open` | ~1 day |
| 2 | `post` with proposals, `message.ext`, annotation line and buttons, actions route, events, notices | ~1½ days |
| 3 | `task-ext`: /task, /approval, panel; move today's tasks; old routes answered through it | ~1½ days |
| 4 | agents: typed tools per command and action in the 7 harness plugins, generic `op=command`, actions in deliveries | ~1 day |

Open points for Can:
- Is `cancel` the author only, or the author and any person?
- Does the "N open tasks" reminder stay?
