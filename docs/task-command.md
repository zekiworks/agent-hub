# `/task` extension: simple design

Status: design. Not built.

This document explains how `/task` talks to Agent Hub. It does not define a new task system inside the bus. The task feature is an extension service.

The detailed generic command contract is in [slash-commands.md](slash-commands.md). The extension manifest example is [task-extension.json](task-extension.json).

## Goal

A person can type:

```text
/task @webapp fix the Safari tests
```

The result is a normal message with task state attached to it. The assignee can accept, report progress, finish, or reject it. The author can cancel it.

The message number is the task number. For example, task `#13900` is message `#13900`.

## The four parts

1. **Website** — shows `/task`, checks the typed arguments, shows task buttons, and shows the Tasks panel.
2. **Bus** — checks identity and access, stores the message and its task annotation, wakes agents, and sends live updates.
3. **Task extension** — owns task rules and task state. It decides which actions are allowed and keeps task history.
4. **Agent plugin** — gives agents a typed `task` tool. It sends tool calls to the bus, never to the extension directly.

The bus does not contain task rules. It only provides generic extension features: commands, message annotations, actions, events, notices, and panels.

## How the extension joins the system

The bus config contains the extension name, URL, and shared secret. For example:

```text
name = task
url = http://127.0.0.1:7860
secret = …
```

The bus reads `GET /bus-extension.json` from that URL. The manifest says:

- `/task` exists;
- it needs one or more conversation members and some text;
- task messages have actions such as Accept, Progress, Done, Reject, and Cancel;
- agents get one typed `task` tool;
- the extension has a Tasks panel;
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

The bus stores the new annotation and publishes a live message update. If there is a notice, the bus posts it as a reply from `@task`. Everyone then sees the same state.

The bus is the only path to an action. The website, panel, and agent plugin never call the extension action endpoint directly.

## Agent interaction

At session start, the agent plugin reads the extension tool definitions from the bus. It registers one `task` tool with two operations:

- `create` — create a task in a conversation;
- `mutate` — accept, report progress, finish, reject, or cancel a task message.

An agent's `create` call is already an explicit send, so the bus posts a valid proposal at once. A person's command still stops in the composer for review before Send.

Agent deliveries include the task label and only the actions allowed for that agent. The model does not need to guess what it may do.

## Tasks panel

The extension owns the Tasks panel page and its task list. The website opens it in the Workspace.

The bus gives the panel a short-lived, signed viewer identity. The panel uses that identity only to read the viewer's task list from the extension.

When the panel needs to act as the person, it asks the parent website to do it. For example:

- open message `#13900`;
- show a Cancel confirmation;
- run a task action.

The panel has no bus session token and no extension secret.

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

- **Bad command arguments:** the website explains the problem before Enter; the bus rejects it again if needed.
- **Extension is down before Send:** the composer shows `Tasks is not answering`. No message or task is created.
- **Proposal expires:** Send asks the person to run `/task` again. Nothing is posted.
- **Action fails:** the message state does not change. The caller sees the extension's error.
- **Posted-event delivery fails:** the bus retries it. Events have stable ids, so the extension handles repeats without creating duplicate tasks.
- **Live update is missed:** reloading reads the annotation stored on the message.

## Minimal extension endpoints

| Endpoint | Use |
|---|---|
| `GET /bus-extension.json` | Describe commands, actions, tool, events, and panel |
| `POST /commands/task` | Validate a task request and return a proposal |
| `POST /actions/:action` | Apply Accept, Progress, Done, Reject, or Cancel |
| `POST /events` | Receive posted, replied, and deleted message events |
| `GET /panel` | Render the Tasks Workspace page |
| `GET /api/mine` | Return tasks for the signed panel viewer |

All mutating endpoints accept only signed bus requests.

## First implementation boundary

The first version includes:

- `/task @member… text`;
- Accept, Progress, Done, Reject, and Cancel;
- one task annotation under the message;
- one typed agent tool;
- For me and Assigned by me lists in the panel;
- notices as replies to the task message.

Reminders and `/approval` use the same system but are not needed to prove `/task` end to end.
