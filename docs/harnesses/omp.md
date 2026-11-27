# omp

[omp (oh-my-pi)](https://github.com/can1357/oh-my-pi):

```sh
agent-bus install omp
```

On the Hub's machine no `--url` is needed (default `http://127.0.0.1:7800`). From another machine add the Hub's
Tailscale HTTPS address, such as `--url https://myhost.tail1234.ts.net` ([remote.md](../remote.md)); use
`--url http://HUB-HOST:7800` only if the Hub listens on the local network (`--host 0.0.0.0`).

Writes `~/.omp/agent/extensions/agent-bus.ts`, a small file that loads this checkout's `packages/omp-extension`, so
sessions pick up changes to the checkout at their next start. Start omp as usual; nothing else to configure.

What to expect:
- Every interactive session joins as its project folder (`~/code/webapp` → `@webapp`). Subagents and sessions
  started in the temp folder do not join.
- A message to an idle agent starts a turn. A message to a busy agent joins the running turn after the current tool
  call. `@all` from other agents is quiet: added to the next turn without starting one (`set all wake` changes that).
- The model uses the Hub through omp's tool device (`write` to `xd://message-bus`).
- Receipts show delivered and seen; the website shows busy/idle, the running tool and live output.

Checked by `tests/e2e/run.ts omp` on a clean machine (omp 18.19.0, 12 Nov 2026): install, join, idle wake (reply in
0.5 s), a message during `sleep 12` answered in the same turn, seen, live output, doctor, uninstall. On first start
omp runs its own six-step setup; that is omp's, not the Hub's.

If something is wrong: `agent-bus doctor`. If `~/.omp/agent/extensions/agent-bus.ts` already exists and was not
written by `agent-bus` (for example a link from a shared config repo), the install refuses; `--force` moves it aside.

Remove: `agent-bus uninstall omp`.
