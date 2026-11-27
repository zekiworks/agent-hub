# Adding a coding tool

A new coding tool (harness) joins Agent Hub through one adapter, one page and one row in the README table. Agent Hub
lists a tool only when it was tested in the real tool and a message can start a turn in its idle session.

## 1. Pick the integration

| The tool offers | Use | Example |
|---|---|---|
| A plugin or extension API with session events | A native package (`packages/<tool>-plugin`) | OMP, Codex, OpenCode |
| A stdio MCP server slot | An entry in the shared MCP adapter (`packages/universal-mcp`) | Qwen Code, Grok Build |

## 2. A stdio MCP tool, step by step

1. In `packages/universal-mcp/scripts/install.ts`, add the name to `UniversalAdapterName` and an entry to
   `DEFINITIONS`: its title, its command, and where its MCP config lives. JSON configs (`kind: "json"`) need only the
   file and the key holding the servers.
2. In `packages/cli/src/harnesses.ts`, add `universalHarness("<name>")` to `HARNESSES`, so `agent-bus install`,
   `uninstall` and `doctor` know it.
3. Wire the tool's idle-wake path in the bridge (`packages/universal-mcp/src/server.ts`, `deliver`): plain MCP cannot
   start a turn, so the bridge must use the tool's own way in (Qwen's peer socket and Grok's leader socket are the
   examples there). Without it the tool cannot be listed (section 3).
4. Run `bun run typecheck` and `bun test tests/universal-mcp.test.ts`.

How the installer restores the tool's config on uninstall: it keeps a snapshot of the exact file (JSON such as Qwen's
`settings.json`, or Grok's TOML). Uninstall writes those bytes back when nobody changed the file meanwhile, and
otherwise removes only Agent Hub's entries.

## 3. Answer the questions the README and the adapter page ask

1. **How it connects:** which config file the installer writes, and how uninstall restores it.
2. **A message to an open, idle session:** does it start a turn? Look for a way in from outside: Qwen gives its child
   processes a peer-messaging socket, Grok's leader mode a local socket, Codex a queue command. Without one the tool
   is not listed: a message would wait unanswered until someone next uses it.
3. **A message during a running turn:** when does the model see it? This goes on the adapter page; the README table
   has no column for it.
4. **Can the model reply?** Receiving a message and being able to call `message-bus` are different: check that the
   model itself, not only a subagent, can call the tool.
5. **What it was checked with:** the tool's exact version, how it was built or installed, and which model answered.

## 4. Test it in the real tool

An install that only writes config is not tested. Before the README row names a version:

- Install the tool from its official source, in an isolated `HOME`.
- Run a real model turn that calls `message-bus` (for example `op=write` to a person on a test Hub).
- Send a message to the agent and show that it reaches the model: during a turn, at the next turn, and by waking an
  idle session (required to be listed).
- Uninstall and compare the config file byte for byte with the copy taken before install.
- Install, change another setting in the tool's config, uninstall: your change must survive and Agent Hub's entries
  must be gone.
- Add tests to `tests/universal-mcp.test.ts` (or the package's own tests) for what the adapter writes and restores.

## 5. Write it down and let the installer find it

- A section on the adapter's page (`docs/harnesses/<tool>.md` or [universal-mcp.md](universal-mcp.md)) with the
  answers above and the limits you found.
- One row in the README's **Supported coding tools** table and one in the table of [docs/install.md](../install.md).
- The tool in `install.sh`: its name in `KNOWN_TOOLS`, and a case in `tool_found()` if `command -v <name>` does not
  find it.
- The tool's name in the tool lists of the README ("What you can do"), [INSTALL.md](../../INSTALL.md) ("For people"
  and "Join a Hub on another machine"), and the release notes.
