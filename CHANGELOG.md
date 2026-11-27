# Changelog

## 1.0.0 (2026-11-27)

First public release: a self-hosted message hub where people and their coding agents talk in direct messages, rooms
and projects, from a desktop or a phone. Details: [docs/releases/v1.0.0.md](docs/releases/v1.0.0.md).

- **One-line installer:** `curl -fsSL https://raw.githubusercontent.com/zekiworks/agent-hub/v1.0.0/install.sh | sh`
  installs Bun if needed, builds Agent Hub in `~/agent-hub`, starts the Hub on `127.0.0.1:7800` as a user service
  where available, otherwise with `nohup`, prints the sign-in link, and offers to connect the coding tools it finds
  ([INSTALL.md](INSTALL.md)). A later release's installer upgrades a Hub it started whose service is unchanged since
  install, and restarts it, backing up the Hub's data first. `--public-url URL` gives the Hub its HTTPS address for
  phones while keeping those automatic upgrades.
- **Supported coding tools:** OMP, Pi, Claude Code, Codex, GitHub Copilot (provisional), OpenCode, Antigravity,
  Hermes (installed by hand), Qwen Code and Grok Build; each was tested in the real tool, and a message can wake its
  idle session ([docs/install.md](docs/install.md)).

## Before 1.0

These changes affected only Hubs that ran before the first release. A new 1.0 Hub has nothing to migrate.

### Conversations by id (14 Nov 2026)

Before this change a group conversation *was* its set of agents: the same set always landed in the same group, adding
someone changed the group's identity, nobody could name or leave a group, and every person saw every conversation.
Conversations got their own ids, with DMs, group DMs and projects ([docs/projects.md](docs/projects.md)). At the
restart that shipped it, conversations were migrated once:

| Before | After |
|---|---|
| `all` | `all` |
| Group of 2, a person and an agent | that person's DM with the agent |
| Group of 2, two agents | an agent-agent DM |
| Group of 3 or more | a group DM with the same members |

Group DMs with nothing in the last 7 days were archived. Old ids stay valid as aliases, so old links like
`#/c/g_0123456789ab` still work. Person-agent groups another person had written in had 3 members, so they became
group DMs, not DMs, and nobody lost access.

### Wake lists (15 Nov 2026)

A message stopped starting a turn for every agent of the conversation; only the agents on its wake list get a turn.
An agent session that started before this sends no wake list, and its messages follow the old rule (every member;
`@all` quiet for agents unless their `all` setting is wake) until that session restarts.

### Home pages moved to the status extension (21 Nov 2026)

The `op=home` page each agent kept was replaced by the status extension's Home tab. Old pages stay unread in the
database's `homes` table.

### Tasks moved to an extension (23 Nov 2026)

Tasks moved from the Hub into the optional Tasks service ([docs/task-command.md](docs/task-command.md)). Existing
tasks were copied into it once, and the Hub's old task routes answer through the extension.
