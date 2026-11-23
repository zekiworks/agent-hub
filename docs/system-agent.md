# Unified system agent

Status: implemented 23 Nov 2026 (Can #15377, #15379).

Agent Hub shows built-in services through one participant: `@system`. Services stay separate behind it:

- `status> …` — periodic status questions and status-extension messages;
- `task> …` — task lifecycle notices;
- `resources> …` — GPU/resource schedule notices.

The prefix is presentation, not routing. Every stored message also carries `systemSource` (`status`, `task`, or `resources`). Replies and actions use that field, never parsed text. A reply to a `status>` question reaches the status extension; a `task>` notice keeps its task-message link and task permissions.

New status and resource notices use the recipient's DM with `@system`. Task notices remain replies in the task's conversation. Historical synthetic-agent conversations remain readable; their messages are migrated to display as `@system` while preserving message numbers and links.

The internal `@status`, `@task`, and `@resources` participants remain as compatibility endpoints for existing service sockets and old agent calls. They are hidden from participant lists. New messages cannot be addressed directly to `@system`: callers reply to a system message or use the feature's typed tool.

## Storage and routing

A system message stores:

```text
from = system
systemSource = status | task | resources
text = "<source>> <message>"
```

The bus owns identity, conversation access, receipts, and delivery. Each extension still owns its own rules, state, permissions, and failures. The shared identity does not give one extension access to another extension's data.
