# `/task` extension: shipped interaction

Status: implemented 23 Nov 2026.

This document explains the shipped `/task` path through Agent Hub. The generic bridge is in
`packages/server/src/extension-runtime.ts`; task rules and persistence are in `packages/task-ext/src/server.ts`.
The detailed generic command contract remains in [slash-commands.md](slash-commands.md).

## Goal

A person can type:

```text
/task @webapp fix the Safari tests
```

The result is a normal message with task state attached to it. The assignee can accept, report progress, finish, or reject it. The author can cancel it.

The message number is the task number. For example, task `#13900` is message `#13900`.

## The four parts

1. **Website** — shows `/task`, checks the typed arguments, shows task buttons, and keeps tasks in the existing Inbox.
2. **Bus** — checks identity and access, stores the message and its task annotation, wakes agents, and sends live updates.
3. **Task extension** — owns task rules and task state. It decides which actions are allowed and keeps task history.
4. **Agent plugin** — gives agents a typed `task` tool. It sends tool calls to the bus, never to the extension directly.

The bus does not contain task rules. It only provides generic extension features: commands, message annotations, actions, events, notices, and panels.

## How the extension joins the system

The bus is started with the extension URL:

```text
agent-bus serve … --task-ext http://127.0.0.1:7834
```

Both processes read `<data-dir>/task-extension.secret`. The bus creates that file with mode `0600` when needed. It
fetches `GET /bus-extension.json`; the secret is never sent to a browser or agent.

The bus reads `GET /bus-extension.json` from that URL. The manifest says:

- `/task` exists;
- it needs one or more conversation members and some text;
- task messages have actions such as Accept, Progress, Done, Reject, and Cancel;
- agents get one typed `task` tool;
- the extension supplies the task section inside the existing Inbox;
- the extension wants message events.

The bus sends the safe parts of this manifest to the website and agent plugins. The secret never goes to a browser or an agent.

## Creating a task

```mermaid
sequenceDiagram
  participant P as Person
  participant W as Website
  participant B as Bus
  participant T as Task extension
  participant A as Assignee agent

  P->>W: /task @webapp fix the Safari tests
  W->>B: Run task command
  B->>T: Signed command request
  T-->>B: Proposed message + task annotation + wake list
  B-->>W: Show proposal in composer
  P->>W: Send
  W->>B: Post message with proposal id
  B->>B: Store message and annotation
  B->>T: Message-posted event
  B->>A: Deliver task and wake agent
```

### 1. The website parses the command

Typing `/` at the start of the composer opens the command menu. The website reads the command shape from the manifest.

For `/task @webapp fix the Safari tests`, it checks:

- `@webapp` exists;
- `@webapp` is a member of this conversation;
- the task text is not empty.

This gives quick feedback. The bus checks the same facts again because browser checks are not security checks.

### 2. The bus calls the extension

On Enter, the website sends the command and parsed arguments to the bus. Nothing is posted yet.

The bus checks the caller, conversation access, command name, and arguments. It then sends a signed request to the task extension:

```text
POST /commands/task
caller: umit
conversation: #launch and its members
to: [webapp]
text: fix the Safari tests
```

The extension verifies the bus signature. It returns a proposal containing:

- message text;
- task annotation, such as `open` and `@webapp`;
- actions allowed for each participant;
- agents to wake when the message is sent.

The extension does not write the task to its database yet. The person may still cancel or edit the composer.

### 3. The person sends the proposal

The website shows the proposed task in the composer. Send posts the message with a short-lived proposal id.

The bus checks that the proposal belongs to this person and conversation and has not expired or been used. It then:

1. stores the normal message;
2. stores the extension annotation on that message;
3. publishes the message to open pages;
4. wakes the assignee if it is an agent;
5. sends a `posted` event to the task extension.

The task extension creates its task and history rows when it receives the `posted` event. This prevents a task from existing when the person never pressed Send.

## Acting on a task

A person uses buttons under the message. An agent uses the typed `task` tool. Both paths meet at the bus.

For example, an agent finishes task `#13900`:

```text
task { op: "mutate", message_id: 13900, action: "done" }
```

The bus:

1. finds message `#13900`;
2. checks that it carries a task annotation;
3. checks that this caller is allowed to use `done`;
4. sends a signed action request to the extension.

The extension updates its database and returns:

- the new annotation, such as `done`;
- an optional notice, such as `Done by @webapp`;
- an optional wake list.

The bus stores the new annotation and publishes a live message update. If there is a notice, the bus posts it as a `task> …` reply from the shared `@system` identity. Everyone then sees the same state. See [system-agent.md](system-agent.md).

The bus is the only path to an action. The website, panel, and agent plugin never call the extension action endpoint directly.

## Agent API and compatibility

Every supported harness registers the extension-native tool:

```text
task { op: "create", conversation: "@webapp", to: ["webapp"], text: "fix Safari" }
task { op: "list", box: "mine", state: "open" }
task { op: "mutate", message_id: 13900, action: "progress", note: "reproduced", eta: "today" }
task { op: "mutate", message_id: 13900, action: "done", reason: "fixed" }
```

The older task operations inside `message-bus` remain as a compatibility mapping during harness upgrades:
`write|reply|send task="task"`, `tasks`, and `accept|done|reject|withdraw`. They call the same extension state through
`GET /api/tasks` and `POST /api/tasks/:seq/:action`; there is no second task store.

## Agent interaction

At session start, the agent plugin reads the extension tool definitions from the bus. It registers one `task` tool with two operations:

- `create` — create a task in a conversation;
- `mutate` — accept, report progress, finish, reject, or cancel a task message.

An agent's `create` call is already an explicit send, so the bus posts a valid proposal at once. A person's command still stops in the composer for review before Send.

Agent deliveries include the task label and only the actions allowed for that agent. The model does not need to guess what it may do.

## Existing Inbox

Human tasks already live in the **✉ Inbox**. This design keeps that surface. It does not add a Tasks button or a
second Workspace tab.

The website keeps the Inbox shell and its other built-in sections, such as **Waiting for your answer** and personal
**Task for me** items. The task extension's manifest places its panel in the `inbox.tasks` slot. The website mounts
that page where the current **For me** and **Assigned by me** task lists appear.

The bus gives the task page a short-lived, signed viewer identity. The page uses it only to read that person's task
list from the extension. It reports its open and unread counts to the parent website, which keeps the existing Inbox
badge: red for unread and yellow for open.

When the task page needs to act as the person, it asks the parent website to open the message, show a confirmation,
or run a task action. The page has no bus session token and no extension secret.

## Data ownership

| Data | Owner | Reason |
|---|---|---|
| Message text, author, conversation, files | Bus | It is a normal chat message |
| Small task annotation shown with the message | Bus copy, supplied by extension | Pages and agent deliveries need it without calling the extension |
| Task rules, assignee state, history, reminders | Task extension | These are task-specific rules |
| Identity, membership, read access, passkey verification | Bus | The bus is the security boundary |

The extension's database is the source of truth for task behavior. The annotation stored with the message is the latest display state.

## Security rules

- Every browser and agent request goes to the bus first.
- The bus checks the caller can read the conversation and use the requested action.
- Bus-to-extension requests are signed with HMAC.
- The extension rejects requests with a bad or missing signature.
- Secrets stay only in the bus and extension processes.
- A proposal is tied to one caller and conversation, expires after 10 minutes, and can be used once.
- The extension returns allowed actions for each participant. The bus enforces them; hiding a button is not enough.
- Approval actions, if added, require the bus's passkey-verified person flag.

## Failure behavior

- **Bad command arguments:** the extension explains the problem on Enter; no proposal or message is created.
- **Extension is down before Enter:** the composer shows that Tasks is not answering; no proposal or message is created.
- **Proposal expires:** Send asks the person to run `/task` again. Nothing is posted.
- **Extension stops after a proposal:** Send stores the message and annotation. The bus retries the idempotent `posted`
  event until the extension catches up.
- **Action fails:** the message state does not change. The caller sees the extension's error.
- **Live update is missed:** reloading reads the annotation stored on the message.

## Implemented extension endpoints

| Endpoint | Use |
|---|---|
| `GET /bus-extension.json` | Describe `/task`, its actions, agent tool, event, and Inbox slot |
| `POST /commands/task` | Validate a task request and return a proposal |
| `POST /actions/:action` | Apply Accept, Progress, Done, Reject, Read, or Cancel |
| `POST /events` | Receive idempotent posted-message events |
| `POST /queries/tasks` | Return For me / Assigned by me tasks and open/unread counts to the bus |

All extension endpoints except the public manifest require a signed bus request. The existing Inbox renders the bus's
task response; it receives no bus session token or extension secret.


## First implementation

The shipped version includes:

- `/task @member… text`;
- Accept, Progress, Done, Reject, Read, and Cancel;
- one task annotation under the message;
- the typed `task` tool in OMP, Pi, Claude, Codex, OpenCode, Copilot, Antigravity, and Hermes;
- For me and Assigned by me lists in the existing Inbox;
- notices as replies to the task message;
- one-time migration of existing built-in task rows into extension annotations.

Legacy approvals remain actionable during migration. A new `/approval` command and reminders are separate scope.
