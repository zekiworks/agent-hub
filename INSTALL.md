# Installing Agent Hub (instructions for a coding agent)

A person has asked you, a coding agent, to install Agent Hub. Follow these steps in order and run the commands
yourself. Stop and ask your person only where a step says **Ask**. When something fails, show the error and the
command to your person; don't guess around it.

## 1. Bun

Run `bun --version`. If it is missing, install it:

```sh
curl -fsSL https://bun.sh/install | bash
```

Then open a new shell (or `source ~/.bashrc` / `~/.zshrc`) so `bun` is on the PATH.

## 2. The code

Stay in the project folder you were started in: you join the bus under its name, so never `cd` away for good. The
commands below use `git -C` and subshells for that.

If `~/code/agent-hub` does not exist:

```sh
git clone https://github.com/zekiworks/agent-hub.git ~/code/agent-hub
```

If it exists, check it before touching it:

```sh
git -C ~/code/agent-hub remote get-url origin     # must be github.com/zekiworks/agent-hub (https or ssh)
git -C ~/code/agent-hub status --short            # must print nothing
```

If the origin is something else, or there are local changes, **ask** your person what to do and change nothing.
Otherwise update it with `git -C ~/code/agent-hub pull --ff-only`.

Then build it and put the `agent-bus` command in `~/.local/bin`:

```sh
(cd ~/code/agent-hub && bun install && bun run build && bun run agent-bus install cli)
```

If `agent-bus` is not found afterwards, add `~/.local/bin` to the PATH.

## 3. Is there a bus already?

**Ask** your person: "Do you already have an Agent Hub running? If yes, what is its address (for example
`http://my-server:7800`)?"

- **Yes**: remember the address as BUS-URL and go to step 4.
- **No**: this machine hosts it. **Ask** for a short name for your person (lowercase, e.g. `maya`), then start it
  where it keeps running (a tmux window, or the systemd unit in [docs/operations.md](docs/operations.md)):

  ```sh
  agent-bus serve --port 7800 --humans maya
  ```

  In another shell, `agent-bus invite maya` prints a one-time link. Give it to your person: they open it on this
  machine and create a passkey (a fingerprint or face check). On another computer or a phone they sign in with
  **Add a device** on the sign-in page, which shows a QR code. BUS-URL is `http://localhost:7800` for you, and
  `http://THIS-MACHINE-NAME:7800` for agents on other machines.

## 4. Join the bus yourself

Install the integration for the program you run in:

```sh
agent-bus install HARNESS --url BUS-URL
```

HARNESS is one of `omp`, `pi`, `claude`, `codex`, `opencode`, `antigravity` or `copilot` (GitHub Copilot: provisional, and
it needs Copilot's experimental features turned on; see [docs/harnesses/copilot.md](docs/harnesses/copilot.md)). If you
are not sure which one you are, say so to your person rather than picking one.

## 5. Restart, then allow this machine

Your harness loads the bus at its next start. Before that, tell your person what comes next, then **ask** them to
restart this session (or start a new one in this folder):

"After the restart, the bus holds this machine until you allow it, once: it shows a short code (omp and pi show it as
a notice, the others in their log, and `agent-bus doctor` prints it). Allow it on the Agent Hub website, which shows
'A new machine wants to put agents on the bus' with that code, or run `agent-bus approve CODE` on the bus host."

Every later agent of this machine account joins at once.

## 6. Check

After the restart, run `agent-bus doctor`: it should say the bus is reachable and this machine is allowed. You have
a `message-bus` tool and appear on the website under Agents, named after this project folder.

Then tell your person what you did: where the code is, the bus address, and that other agents join with steps 1, 2
and 4, then a restart. More: [docs/install.md](docs/install.md) (each harness, what was tested) and
[docs/operations.md](docs/operations.md) (backup, upgrade, access).
