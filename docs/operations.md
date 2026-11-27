# Running the Hub: backup, restore, upgrade, rollback, access

For whoever runs `agent-bus serve`.

## What the Hub keeps

Everything is in its data directory (`--data-dir`, else `$AGENT_BUS_DATA_DIR`, else `~/.agent-bus`):

| Path | What |
|---|---|
| `message-bus.sqlite` (+ `-wal`, `-shm` while running) | messages, receipts, conversations, members, checklists, people's passkeys and sessions, agents' token hashes, GPU bookings |
| `files/` | every attachment and voice message, by file id |
| `task-ext/tasks.sqlite`, `task-extension.secret` | with the optional Tasks service: its task database and the secret it shares with the Hub |
| `status/status.sqlite` | with the optional status extension: the agents' Home updates |
| `push-vapid.json` | the Hub's Web Push signing key (made once; a new one would silence every subscribed phone until it turns notifications on again) |
| `attention-people.txt` | the people (one id per line) whose doings with agents' messages are noted, and whom a `box=needs` extension judges agents' messages for (the Inbox's "Waiting for your answer"); nobody unless listed |
| `attention.jsonl` | those notes: per agent message, seen (how long), tapped, replied, forwarded, marked read, opened from a notification or banner; never the text. The answer key for teaching a small model what needs whom |
| `finetune/needs-you/live-verdicts.jsonl` | with a `box=needs` extension: each model's verdict on each agent message for a listed person (seq, person, model, needs, p, at) and each "Not needed"; never the text. The verdicts are also in the database (`needs_verdicts`) |
| `box-reports.jsonl` | with an "Ask @agent" box: whether each suggestion was taken; never the text |

Nothing else on the Hub host holds state. The directory is the account's alone: the Hub makes it `700` and what it
writes `600` at every start. Agent machines keep their own `~/.agent-bus/agent-token` (`600`); all agents of one
machine account share that token. It is not part of a Hub backup. When agents also run on the Hub host, the same
directory holds their files (`agent-token`, `received/`, `sessions.json`, …); the steps below leave those alone.

## Backup

Stop the Hub first, then the optional services that keep state (Tasks, status), so the databases and files are
copied at the same point in time; a copy taken while they run can show a task as done in the room and as open in the
Inbox. Stop a Hub the installer started like this (stop Tasks and status the way you started them):

- **systemd user service (Linux):** `systemctl --user stop agent-hub.service`
- **LaunchAgent (macOS; the installer's macOS path is untested):** `launchctl bootout gui/$(id -u)/com.agent-hub.hub`
- **nohup** (the installer found no systemd user session; its state is in `~/.local/state/agent-hub`, or
  `$XDG_STATE_HOME/agent-hub`). The commands find every Hub process running from the checkout the installer saved,
  whether or not `hub.pid` names it, and signal those. On Linux a Hub process is one whose executable
  (`/proc/<pid>/exe`) is `bun`, whose arguments are exactly `run`, `packages/cli/src/bin.ts`, `serve` (then its
  options), and whose working directory is physically the checkout. On macOS (untested) the commands can only check
  `ps -o args=` for `bun run packages/cli/src/bin.ts serve` and the working directory from `lsof`, as a best effort.
  Within 30 seconds, they print `HUB STOPPED` only when none of them is left and port 7800 refuses connections; a port
  that accepts connections but does not answer still counts as taken:

  ```sh
  S=${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub; C=$(cat "$S/checkout" 2>/dev/null)
  CP=""; [ -n "$C" ] && CP=$(cd -P "$C" 2>/dev/null && pwd)
  hubpids() { for p in $(pgrep -f 'packages/cli/src/bin.ts' 2>/dev/null); do
    if [ -r "/proc/$p/cmdline" ]; then
      case "$(readlink "/proc/$p/exe" 2>/dev/null)" in */bun) ;; *) continue ;; esac
      [ "$(tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null | sed -n '2,4p' | tr '\n' ' ')" = "run packages/cli/src/bin.ts serve " ] || continue
      cw=$(cd -P "/proc/$p/cwd" 2>/dev/null && pwd)
    else
      case "$(ps -o args= -p "$p" 2>/dev/null)" in *"bun run packages/cli/src/bin.ts serve"*) ;; *) continue ;; esac
      cw=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    fi
    if [ -n "$CP" ] && [ "$cw" = "$CP" ]; then echo "$p"; fi; done; }
  refused() { curl -s --max-time 2 -o /dev/null http://127.0.0.1:7800/; [ "$?" -eq 7 ]; }
  if [ -z "$CP" ]; then echo "STOP: $S/checkout does not name the Hub's checkout; stop the Hub yourself"; else
  for p in $(hubpids); do kill "$p"; done
  end=$(($(date +%s) + 30)); STOPPED=no
  while [ "$(date +%s)" -lt "$end" ]; do
    if [ -z "$(hubpids)" ] && refused; then STOPPED=yes; break; fi; sleep 1
  done
  if [ "$STOPPED" = yes ]; then echo "HUB STOPPED"
  else echo "STILL RUNNING: a Hub process or another program still uses port 7800; stop it before copying or moving data"; fi
  fi
  ```

  Go on only after `HUB STOPPED`. On `STILL RUNNING`, find the process that uses port 7800 (or the Hub process from
  the checkout) and stop it first.

A Hub you started yourself: stop it the way you started it.

Then set `D`, the Hub's data directory, once. The commands below keep a `D` you set yourself; otherwise they take the
directory the installer saved (`data-dir` in its state directory), else `$AGENT_BUS_DATA_DIR`, else
`~/.agent-bus`. A saved `data-dir` that is empty or holds only spaces stops them with `NO DATA DIRECTORY`. An
`AGENT_BUS_DATA_DIR` that is set but empty means the directory the Hub was started from; then set `D` to that
directory yourself. If you changed the installer's service by hand, set `D` to the `--data-dir` in its effective start
command first (`systemctl --user cat agent-hub.service`, or the LaunchAgent's plist). The commands print `D` as an
absolute path: check that it is the Hub you mean. Backup and Restore use this same `D`, and the check defined below,
so run them all in the same terminal.

```sh
S=${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub
if [ -z "${D:-}" ]; then
  if [ -e "$S/data-dir" ]; then D=$(cat "$S/data-dir" 2>/dev/null); case "$D" in *[![:space:]]*) ;; *) D="" ;; esac
  elif [ "${AGENT_BUS_DATA_DIR+set}" = set ] && [ -z "$AGENT_BUS_DATA_DIR" ]; then D=""
  else D=${AGENT_BUS_DATA_DIR:-$HOME/.agent-bus}; fi
fi
if [ -n "$D" ] && D=$(cd -P "$D" 2>/dev/null && pwd); then echo "Data directory: $D"
else D=""; echo "NO DATA DIRECTORY: set D to the Hub's data directory, then run this again"; fi
```

Then define the check that Backup and Restore share. The same block defines the guarded delete that Restore uses
for its staging directories. `hub_check_backup` checks a backup directory `B` by unpacking it into an empty directory:
`items.txt` and the archive's listing first, then each database. `hub_rm_staging` is described under
[Restore](#restore).

```sh
hub_check_backup() {
  hcb_b=$1; hcb_t=$2; hcb_l="$2/.items.txt"; hcb_s=${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub
  hcb_bun=$(cat "$hcb_s/bun" 2>/dev/null); [ -x "$hcb_bun" ] || hcb_bun=$(command -v bun || echo "$HOME/.bun/bin/bun")
  if ! { [ -d "$hcb_t" ] && [ -r "$hcb_b/items.txt" ] && awk 'NF' "$hcb_b/items.txt" > "$hcb_l" &&
    grep -qx 'message-bus.sqlite' "$hcb_l"; }; then echo "items.txt is missing or does not name message-bus.sqlite"; return 1; fi
  (
    ok=1
    while IFS= read -r i; do
      case "$i" in
        message-bus.sqlite|message-bus.sqlite-wal|message-bus.sqlite-shm|files|push-vapid.json|task-ext) ;;
        task-extension.secret|status|attention-people.txt|attention.jsonl|box-reports.jsonl|finetune/needs-you) ;;
        *) echo "unknown entry in items.txt: $i"; ok=0 ;;
      esac
      [ "$(grep -cxF -- "$i" "$hcb_l")" = 1 ] || { echo "listed more than once in items.txt: $i"; ok=0; }
    done < "$hcb_l"
    [ "$ok" = 1 ]
  ) && tar -tf "$hcb_b/hub.tar" > "$hcb_t/.listing" &&
    tar -tvf "$hcb_b/hub.tar" | awk '{ t = substr($0, 1, 1) } t != "-" && t != "d" { print "not a file or directory in the archive: " $0; bad = 1 } END { exit bad }' &&
    awk 'NR == FNR { if (NF) it[$0] = 1; next }
      { abs = ($0 ~ /^\//); up = 0; n = ""; c = split($0, p, "/")
        for (k = 1; k <= c; k++) { if (p[k] == "" || p[k] == ".") continue; if (p[k] == "..") up = 1; n = (n == "" ? p[k] : n "/" p[k]) }
        if (abs || up) { print "unsafe path in the archive: " $0; bad = 1; next }
        if (n == "") next
        if (seen[n]++) { print "in the archive twice: " n; bad = 1; next }
        ok = (n in it); if (!ok) for (i in it) if (index(n, i "/") == 1) { ok = 1; break }
        if (!ok) { print "in the archive but not in items.txt: " n; bad = 1 }
        for (i in it) if (n == i || index(n, i "/") == 1) found[i] = 1 }
      END { for (i in it) if (!(i in found)) { print "missing from the archive: " i; bad = 1 }; exit bad }' "$hcb_l" "$hcb_t/.listing" &&
    tar -C "$hcb_t" -xf "$hcb_b/hub.tar" && [ -f "$hcb_t/message-bus.sqlite" ] && (
    ok=1
    for db in message-bus.sqlite task-ext/tasks.sqlite status/status.sqlite; do
      case "$db" in
        message-bus.sqlite) want="messages participants" ;;
        task-ext/tasks.sqlite) want="tasks task_history events" ;;
        *) want="asks updates" ;;
      esac
      if [ -e "$hcb_t/$db" ]; then
        K=$(mktemp -d) && cp -p "$hcb_t/$db" "$K/db" || { echo "could not copy $db for checking"; ok=0; continue; }
        for x in -wal -shm; do if [ -e "$hcb_t/$db$x" ]; then cp -p "$hcb_t/$db$x" "$K/db$x" || ok=0; fi; done
        r=$("$hcb_bun" -e 'const { Database } = require("bun:sqlite"); const [file, want] = process.argv.slice(-2);
          try { const d = new Database(file);
            const have = new Set(d.query("SELECT name FROM sqlite_master WHERE type = ?").all("table").map((row) => row.name));
            if (d.query("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]).join(" ") !== "ok") console.log("damaged");
            else if (!want.split(" ").every((t) => have.has(t))) console.log("missing its tables");
            else console.log("ok"); } catch { console.log("damaged"); }' "$K/db" "$want" 2>/dev/null)
        [ "$r" = ok ] || { echo "${r:-could not check (is Bun at $hcb_bun?)}: $db"; ok=0; }
        rm -rf "$K"
      fi
    done
    [ "$ok" = 1 ]
  )
}
hub_rm_staging() {
  hrs_x=$1; while :; do case "$hrs_x" in */) hrs_x=${hrs_x%/} ;; *) break ;; esac; done
  hrs_d=""; case "${D:-}" in /*) hrs_d=$(cd -P "$D" 2>/dev/null && pwd) ;; esac
  hrs_b=${hrs_x##*/}; hrs_p=""; [ -z "$hrs_d" ] || hrs_p=$(cd -P "${hrs_x%/*}" 2>/dev/null && pwd)
  if [ -z "$hrs_d" ]; then echo "D is not set to an existing absolute directory; nothing was deleted"; return 1; fi
  if [ "$hrs_p" != "$hrs_d" ] || case "$hrs_b" in .restore-?????? | .replaced-??????) false ;; *) true ;; esac; then
    echo "$hrs_x is not a staging directory directly inside $hrs_d; nothing was deleted"; return 1
  fi
  if [ -L "$hrs_x" ] || [ ! -d "$hrs_x" ]; then echo "$hrs_x does not exist or is a link; nothing was deleted"; return 1; fi
  hrs_x=$hrs_d/$hrs_b
  hrs_m=$(findmnt -ln -o TARGET 2>/dev/null) || hrs_m=$(mount 2>/dev/null | sed -n 's/^.* on \(.*\) (.*$/\1/p')
  if [ -z "$hrs_m" ]; then echo "the list of mounts could not be read; nothing was deleted"; return 1; fi
  hrs_in=$(printf '%s\n' "$hrs_m" | while IFS= read -r m; do case "$m" in "$hrs_x" | "$hrs_x"/*) echo "$m" ;; esac; done)
  if [ -n "$hrs_in" ]; then echo "mounted at or inside $hrs_x: $hrs_in; unmount it first; nothing was deleted"; return 1; fi
  if rm --version > /dev/null 2>&1; then rm -rf --one-file-system -- "$hrs_x"; else rm -rf -- "$hrs_x"; fi
  if [ -e "$hrs_x" ] || [ -L "$hrs_x" ]; then echo "$hrs_x is still there; see the messages above"; return 1; fi
  echo "deleted $hrs_x"
}
echo "hub_check_backup and hub_rm_staging defined"
```

What it checks:
- `items.txt` is copied as a clean list (blank lines dropped). It must name the main database and hold only known
  Hub items, none twice.
- Every archive member must be a regular file or a directory (no links, no devices).
- Every member path is put in a standard form (repeated `/` and `.` parts removed) and must not be absolute or
  contain `..`. No path may appear twice, nothing may lie outside the items in `items.txt`, and every item in
  `items.txt` must be in the archive.
- Only then is the archive unpacked. Each database must pass `PRAGMA integrity_check` (exactly `ok`) and have its
  tables: `message-bus.sqlite` `messages` and `participants`, `task-ext/tasks.sqlite` `tasks`, `task_history` and
  `events`, `status/status.sqlite` `asks` and `updates` (an empty file passes the integrity check).

The installer checks a backup by the same rules. The checks use Bun's built-in SQLite (the Bun the installer saved,
else the one on your PATH), so no `sqlite3` program is needed. They run on a throwaway copy of each database with its
`-wal` and `-shm` files, so the unpacked files stay exactly as they were.

Then take the backup:

```sh
B=~/agent-bus-backup-$(date +%Y%m%d-%H%M%S); BC=""
if [ -z "${D:-}" ]; then echo "BACKUP FAILED: set D first (above)"
elif [ ! -f "$D/message-bus.sqlite" ]; then echo "BACKUP FAILED: no message-bus.sqlite in $D; check D"
elif IN=$(for i in message-bus.sqlite message-bus.sqlite-wal message-bus.sqlite-shm files push-vapid.json task-ext \
  task-extension.secret status attention-people.txt attention.jsonl box-reports.jsonl finetune/needs-you; do
  o=$(LC_ALL=C ls -d -- "$D/$i" 2>&1) || case "$o" in *"No such file"*) ;; *) echo "$i" ;; esac; done | head -n 1)
  [ -n "$IN" ]; then echo "BACKUP FAILED: $D/$IN cannot be read (a folder above it without access?)"
elif LN=$(cd "$D" || { echo "(cannot enter $D)"; exit; }
  for i in message-bus.sqlite message-bus.sqlite-wal message-bus.sqlite-shm files push-vapid.json \
  task-ext task-extension.secret status attention-people.txt attention.jsonl box-reports.jsonl finetune/needs-you; do
  j=$i; while :; do [ ! -L "$j" ] || { echo "$j is a link"; exit; }; case "$j" in */*) j=${j%/*} ;; *) break ;; esac; done
  if [ -e "$i" ]; then
    f=$(find "$i" -type l -print 2>&1) || { echo "$i could not be read to the end"; exit; }
    [ -z "$f" ] || { echo "$(printf '%s\n' "$f" | sed -n 1p) is a link"; exit; }
  fi; done); [ -n "$LN" ]; then
  echo "BACKUP FAILED: $D/$LN; copy what a link points to into $D (or fix the access), or back it up yourself"
elif ! mkdir -m 700 "$B"; then echo "BACKUP FAILED: could not create $B"
elif ! { for i in message-bus.sqlite message-bus.sqlite-wal message-bus.sqlite-shm files push-vapid.json task-ext \
  task-extension.secret status attention-people.txt attention.jsonl box-reports.jsonl finetune/needs-you; do
  if [ -e "$D/$i" ]; then printf '%s\n' "$i"; fi
done > "$B/items.txt"; }; then echo "BACKUP FAILED: could not write $B/items.txt"
elif ! tar -C "$D" -cf "$B/hub.tar" -T "$B/items.txt"; then echo "BACKUP FAILED: could not write $B/hub.tar"
elif ! command -v hub_check_backup > /dev/null 2>&1; then echo "BACKUP FAILED: define hub_check_backup first (above)"
elif BC=$(mktemp -d "$B.check-XXXXXX") && hub_check_backup "$B" "$BC"; then rm -rf "$BC"; echo "Backup written to $B"
else [ -z "$BC" ] || rm -rf "$BC"; echo "BACKUP FAILED: the archive in $B did not pass the restore check (see above)"; fi
```

It prints `Backup written` only when the data directory has the main database, no Hub item, or folder it sits in
inside `D` (such as `finetune`), is or contains a link (a
restore accepts only plain files and directories), and the finished archive passes `hub_check_backup`, the same
check Restore runs (it unpacks into a temporary `….check-…` directory next to the backup and deletes it). If it
prints `BACKUP FAILED`, do not upgrade: fix the cause (usually `D`) and run it again. After `Backup written`, how to go
on depends on why you took the backup:

- **A backup on its own:** start the Tasks and status services again, then the Hub (see [Start the Hub](#start-the-hub)).
  Agents reconnect by themselves, usually within a minute.
- **Before a manual upgrade:** leave everything stopped and continue with [Upgrade](#upgrade).

The commands work in bash and zsh. `items.txt` lists what the archive must contain. The archive leaves out the agent
files of the Hub host (`agent-token`, `received/`, `sessions.json`). Take a backup before every upgrade. For scale: a
Hub in daily use for a month had a 13 MB database and 420 MB of files.

## Restore

Run both steps in the same terminal as the blocks that set `D` and define `hub_check_backup` ([Backup](#backup)): they
use `D` and that check, and the second step uses `B`, `T` and `L` from the first.

1. Unpack the backup into a private staging directory inside the data directory (`D/.restore-…`, which no Hub item
   is named like) and check it. Nothing in the Hub changes yet. Set `B` to the backup to restore.

   ```sh
   B=~/agent-bus-backup-YYYYMMDD-HHMMSS; READY=no; T=""
   [ -n "${D:-}" ] && [ -d "$D" ] && T=$(mktemp -d "$D/.restore-XXXXXX"); L="$T/.items.txt"
   if [ -z "$T" ]; then echo "STOP: set D first (Backup); nothing was changed"
   elif ! command -v hub_check_backup > /dev/null 2>&1 || ! command -v hub_rm_staging > /dev/null 2>&1; then
     echo "STOP: define hub_check_backup and hub_rm_staging first (Backup); nothing was changed"
   elif hub_check_backup "$B" "$T"; then READY=yes; echo READY
   else echo "STOP: this backup or its items.txt is not complete; nothing was changed"; fi
   ```

   Go on only if it prints `READY`. The check is the one described under [Backup](#backup); nothing is unpacked
   until `items.txt` and the archive's listing pass it.
2. Stop the Hub as in [Backup](#backup) (for nohup, go on only after `HUB STOPPED`), then the Tasks and status
   services. Then move the current items aside and put the backup in their place, using the list checked in step 1.
   The commands run only once per `READY`: they refuse to run unless step 1 just printed `READY`, and check again that
   the staged list and database are still there. They refuse, before moving anything, if any Hub item cannot be read
   (for example under a folder without access: only "No such file" counts as missing), if a current Hub item, or a
   folder it sits in inside `D` (such as `finetune`), is or contains a link anywhere inside it (even one that points
   nowhere), or if a folder inside an item cannot be read to the end, or if any item, any folder it sits in, anything
   mounted inside an item, or a staged copy is on another disk or mount than `D` (the same device number and the same
   mount point from `findmnt`, or `df` on macOS; the list of mounts from `findmnt`, or `mount` on macOS; for example
   `finetune/needs-you` mounted separately, even as a bind mount of the same disk). If the disk, the mounts or any path
   cannot be read, they refuse too. Every move
   is a rename done with Bun's `fs.renameSync`, which fails instead of copying when the two places are on different
   disks; plain `mv` would copy and delete. Before
   the first move they write the list of current items to `.inventory` in a second private directory inside the data
   directory, `D/.replaced-…`, and check it. They check that every restored item, and the
   main database, is in place before they delete the staging directory. If any move fails, they take the restored
   items back out, move every item in `.inventory` back (never onto a path that is still taken), and check each one.
   If that does not fully work, they delete nothing and print where each item is.

   ```sh
   S=${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub
   BUN=$(cat "$S/bun" 2>/dev/null); [ -x "$BUN" ] || BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
   rn() { "$BUN" -e 'const [a, b] = process.argv.slice(1); try { require("fs").renameSync(a, b) }
     catch (e) { console.error(`could not move ${a} to ${b}: ${e.code}`); process.exit(1) }' "$1" "$2"; }
   if [ "$READY" != yes ]; then echo "STOP: run step 1 first; nothing was changed"; else
   READY=no
   if ! { [ -s "$L" ] && grep -qx 'message-bus.sqlite' "$L" && [ -f "$T/message-bus.sqlite" ] &&
     ( while IFS= read -r i; do [ -e "$T/$i" ] || exit 1; done < "$L" ); }; then
     echo "STOP: the staged backup from step 1 is gone or incomplete; nothing was changed. Run step 1 again."
   elif [ ! -x "$BUN" ]; then echo "STOP: Bun is needed for the moves and was not found at $BUN; nothing was changed"
   elif IN=$(for i in message-bus.sqlite message-bus.sqlite-wal message-bus.sqlite-shm files push-vapid.json task-ext \
       task-extension.secret status attention-people.txt attention.jsonl box-reports.jsonl finetune/needs-you; do
       o=$(LC_ALL=C ls -d -- "$D/$i" 2>&1) || case "$o" in *"No such file"*) ;; *) echo "$i" ;; esac; done | head -n 1)
     [ -n "$IN" ]; then echo "STOP: $D/$IN cannot be read (a folder above it without access?); nothing was changed"
   elif LN=$(cd "$D" || { echo "(cannot enter $D)"; exit; }
       for i in message-bus.sqlite message-bus.sqlite-wal message-bus.sqlite-shm files push-vapid.json \
       task-ext task-extension.secret status attention-people.txt attention.jsonl box-reports.jsonl finetune/needs-you; do
       j=$i; while :; do [ ! -L "$j" ] || { echo "$j is a link"; exit; }; case "$j" in */*) j=${j%/*} ;; *) break ;; esac; done
       if [ -e "$i" ]; then
         f=$(find "$i" -type l -print 2>&1) || { echo "$i could not be read to the end"; exit; }
         [ -z "$f" ] || { echo "$(printf '%s\n' "$f" | sed -n 1p) is a link"; exit; }
       fi; done); [ -n "$LN" ]; then
     echo "STOP: $D/$LN; put what a link points to in its place (or delete a link that points nowhere, or fix the access) first; nothing was changed"
   elif XD=$(dv() { stat -c %d "$1" 2>/dev/null || stat -f %d "$1" 2>/dev/null; }
       mp() { findmnt -n -o TARGET --target "$1" 2>/dev/null || df -P "$1" 2>/dev/null | awk 'NR == 2 { print $6 }'; }
       d0=$(dv "$D"); m0=$(mp "$D")
       if [ -z "$d0" ] || [ -z "$m0" ]; then echo "$D (its disk could not be read)"; exit; fi
       same() { v=$(dv "$1"); w=$(mp "$1"); [ -n "$v" ] && [ "$v" = "$d0" ] && [ -n "$w" ] && [ "$w" = "$m0" ]; }
       for i in message-bus.sqlite message-bus.sqlite-wal message-bus.sqlite-shm files push-vapid.json task-ext \
         task-extension.secret status attention-people.txt attention.jsonl box-reports.jsonl finetune/needs-you; do
         j=$i; while :; do if [ -e "$D/$j" ] && ! same "$D/$j"; then echo "$D/$j"; fi
           case "$j" in */*) j=${j%/*} ;; *) break ;; esac; done
       done
       ML=$(findmnt -ln -o TARGET 2>/dev/null) || ML=$(mount 2>/dev/null | sed -n 's/^.* on \(.*\) (.*$/\1/p')
       if [ -z "$ML" ]; then echo "(the list of mounts could not be read)"; exit; fi
       printf '%s\n' "$ML" | while IFS= read -r m; do
         for i in message-bus.sqlite message-bus.sqlite-wal message-bus.sqlite-shm files push-vapid.json task-ext \
           task-extension.secret status attention-people.txt attention.jsonl box-reports.jsonl finetune/needs-you; do
           case "$m" in "$D/$i" | "$D/$i"/*) echo "$m (a mount)" ;; esac
         done
         case "$m" in "$T" | "$T"/*) echo "$m (a mount)" ;; esac
       done
       while IFS= read -r i; do same "$T/$i" || echo "$T/$i"; done < "$L"); [ -n "$XD" ]; then
     echo "STOP: on another disk than $D (a move would copy, not rename): $XD; nothing was changed"
   elif ! OLD=$(mktemp -d "$D/.replaced-XXXXXX"); then
     echo "STOP: could not create a directory inside $D; nothing was changed"
   elif ! { for i in message-bus.sqlite message-bus.sqlite-wal message-bus.sqlite-shm files push-vapid.json task-ext \
       task-extension.secret status attention-people.txt attention.jsonl box-reports.jsonl finetune/needs-you; do
       if [ -e "$D/$i" ]; then printf '%s\n' "$i"; fi
     done > "$OLD/.inventory" &&
     ( for i in message-bus.sqlite message-bus.sqlite-wal message-bus.sqlite-shm files push-vapid.json task-ext \
       task-extension.secret status attention-people.txt attention.jsonl box-reports.jsonl finetune/needs-you; do
       if [ -e "$D/$i" ]; then grep -qxF -- "$i" "$OLD/.inventory" || exit 1; fi
     done ) &&
     ( while IFS= read -r i; do [ -e "$D/$i" ] || exit 1; done < "$OLD/.inventory" ); }; then
     echo "STOP: could not record the current items in $OLD; nothing was changed"
   else
   ok=yes; placing=no
   while IFS= read -r i; do
     if [ "$ok" = yes ]; then mkdir -p "$OLD/$(dirname "$i")" && rn "$D/$i" "$OLD/$i" || ok=no; fi
   done < "$OLD/.inventory" || ok=no
   if [ "$ok" = yes ]; then
     placing=yes
     while IFS= read -r i; do
       if [ "$ok" = yes ]; then mkdir -p "$D/$(dirname "$i")" && rn "$T/$i" "$D/$i" || ok=no; fi
     done < "$L" || ok=no
   fi
   if [ "$ok" = yes ]; then
     while IFS= read -r i; do [ -e "$D/$i" ] || { ok=no; echo "not in place: $i"; }; done < "$L" || ok=no
     [ -f "$D/message-bus.sqlite" ] || { ok=no; echo "not in place: message-bus.sqlite"; }
   fi
   if [ "$ok" = yes ]; then
     if R=$(hub_rm_staging "$T"); then echo "RESTORED. The replaced items are in $OLD"
     else echo "RESTORED; staging not removed: $R. The replaced items are in $OLD"; fi
   else
     back=yes
     if [ "$placing" = yes ]; then
       while IFS= read -r i; do
         if [ -e "$D/$i" ] && [ ! -e "$T/$i" ]; then
           mkdir -p "$T/$(dirname "$i")" && rn "$D/$i" "$T/$i" || { back=no; echo "could not take out: $i"; }
         fi
       done < "$L" || back=no
     fi
     while IFS= read -r i; do
       if [ -e "$OLD/$i" ] && [ ! -e "$D/$i" ]; then mkdir -p "$D/$(dirname "$i")" && rn "$OLD/$i" "$D/$i"; fi
       if [ ! -e "$D/$i" ] || [ -e "$OLD/$i" ]; then back=no; fi
     done < "$OLD/.inventory" || back=no
     while IFS= read -r i; do
       if ! grep -qxF -- "$i" "$OLD/.inventory" && [ -e "$D/$i" ]; then back=no; fi
     done < "$L" || back=no
     if [ "$back" = yes ]; then echo "STOPPED: a move failed; everything was put back as it was"
     else
       echo "ROLLBACK INCOMPLETE: nothing was deleted. Live directory $D, originals $OLD, backup copy $T:"
       for i in message-bus.sqlite message-bus.sqlite-wal message-bus.sqlite-shm files push-vapid.json task-ext \
         task-extension.secret status attention-people.txt attention.jsonl box-reports.jsonl finetune/needs-you; do
         if grep -qxF -- "$i" "$OLD/.inventory"; then k="original"; elif grep -qxF -- "$i" "$L"; then k="backup only"
         else continue; fi
         w=""; [ -e "$D/$i" ] && w="$w live"; [ -e "$OLD/$i" ] && w="$w originals"; [ -e "$T/$i" ] && w="$w backup-copy"
         echo "  $i ($k):${w:- missing}"
       done
     fi
   fi
   fi
   fi
   ```

3. How to go on:
   - **After `RESTORED`, for a restore on its own:** start the Tasks and status services first, then the Hub
     ([Start the Hub](#start-the-hub)): at start the Hub reads the Tasks manifest and replays pending task events.
   - **After `RESTORED`, after a failed upgrade** (the installer points here): keep the Hub, Tasks and status
     stopped; started now, the failed release would open the restored database. Then either run the go-back command
     the installer printed (it checks out the release that ran before, builds it and starts the Hub; if you run Tasks,
     start it afterwards and restart the Hub once more, as in [Upgrade](#upgrade)), or go back by hand: select and
     build the release that ran before as in [Rollback](#rollback), then start Tasks and status, then the Hub
     ([Start the Hub](#start-the-hub)).
   - **After `STOP: on another disk … (a mount)`:** something is mounted inside a Hub item or inside the staging
     directory. Delete nothing by hand: unmount it first (or put that data on the data directory's own disk), then
     delete the staging directory with the commands below, which check the mounts again, and start over at step 1.
   - **After any other `STOPPED` or `STOP`:** to try again, delete the `D/.restore-…` directory with the commands
     below and start over at step 1; step 2 does not run twice on one `READY`.
   - **After `ROLLBACK INCOMPLETE`:** keep the Hub, Tasks and status stopped and delete nothing. The list marks each
     item `original` (in `.inventory`: it belongs in the data directory) or `backup only` (it came only from the
     backup: it must not stay in the data directory), and says where it is now: `live` (the data directory),
     `originals` (the `D/.replaced-…` directory) or `backup-copy` (the `D/.restore-…` directory). By
     hand, move every `backup only` item and every restored copy that sits in the place of an original out of the
     data directory into the `D/.restore-…` directory, then move every `original` item from the
     `D/.replaced-…` directory back into the data directory. Then check, in the same terminal, that the data
     directory holds exactly the original items:

     ```sh
     MATCH=yes
     for i in message-bus.sqlite message-bus.sqlite-wal message-bus.sqlite-shm files push-vapid.json task-ext \
       task-extension.secret status attention-people.txt attention.jsonl box-reports.jsonl finetune/needs-you; do
       if grep -qxF -- "$i" "$OLD/.inventory"; then
         if [ ! -e "$D/$i" ] || [ -e "$OLD/$i" ]; then MATCH=no; echo "original not back: $i"; fi
       elif [ -e "$D/$i" ]; then MATCH=no; echo "not an original, still in the data directory: $i"; fi
     done
     if [ "$MATCH" = yes ]; then echo "DATA DIRECTORY AS BEFORE"; fi
     ```

     Only after `DATA DIRECTORY AS BEFORE` start the Hub as before, or start the restore over at step 1.

   After `RESTORED` the commands have removed the staging `D/.restore-…` directory (if they print `RESTORED; staging
   not removed: …`, the restore itself worked; remove it as below once the cause is fixed). Delete `D/.replaced-…`
   once the restored Hub works, also as below. Neither is a Hub item, so a backup taken meanwhile leaves them out.

   To delete a staging directory (`D/.restore-…` or `D/.replaced-…`), run `hub_rm_staging` (defined with
   `hub_check_backup` under [Backup](#backup)) on it. It accepts only a real directory (not a link) named `.restore-`
   or `.replaced-` plus six characters whose physical parent is exactly the physical `D`. It reads the list of mounts
   again and deletes nothing if it cannot be read or if anything is mounted at or inside it. Where `rm` knows
   `--one-file-system` (Linux), it never crosses into another file system either. It says `deleted` only if the
   directory is gone afterwards. The restore uses the same function for its own staging directory.

   ```sh
   hub_rm_staging "$D/.restore-XXXXXX"
   ```

This replaces only the Hub's own items; agent files on the same host stay in place. People stay signed in (sessions
are in the database, valid 30 days); agents reconnect by themselves; phones stay subscribed when `push-vapid.json` was
restored. Messages written after the backup are gone. To check: open a task you accepted before the backup and see the
same state in its room and in the Inbox, and send a DM to an agent.

## Upgrade

**A Hub the installer started:** tell the agents first (a short `@all` message), stop the Tasks and status services
if you run them, then run the installer of the newer release, with the same name:

```sh
curl -fsSL https://raw.githubusercontent.com/zekiworks/agent-hub/vX.Y.Z/install.sh | sh -s -- --name NAME
```

It stops the Hub, backs up its data to `~/agent-bus-backup-…/hub.tar` (restore it as [above](#restore)), then updates
the checkout to that release, builds it, and starts it, as a systemd user service, LaunchAgent (macOS, untested) or
`nohup` process, the way it started it before. Running the same release's installer again reuses the checkout and
leaves an already-running Hub running, unless its public address changes: a different `--public-url` (including
`""`, which removes it) rewrites the service and restarts the Hub. That re-run also starts the Hub if it is stopped,
installs the adapters you ask for with `--tools`, and prints a fresh sign-in link. Each installer is pinned to its own
release. A Hub the installer did not start is never restarted by it; upgrade that one
by hand (below). The installer upgrades only a Hub service it wrote and that is unchanged since (no edits, no
drop-ins, nothing waiting for `systemctl --user daemon-reload`); otherwise it stops without changing anything, and you
upgrade by hand as below. So give the Hub its HTTPS address for phones with the installer's `--public-url`, not by
editing the service ([remote.md](remote.md)).

If you run Tasks: once the installer is done, start the Tasks service from the upgraded checkout, wait until it
answers, then restart the Hub once more: stop it as in [Backup](#backup) and start it as in
[Start the Hub](#start-the-hub). The Hub replays pending task events only when Tasks answers at its start, and the
installer starts the Hub while Tasks is still stopped. Start the status service again too.

**By hand**, or for a Hub you started yourself: the installer's checkout is `~/agent-hub` (or `$AGENT_HUB_DIR`; use
your path below). Keep the checkout that runs the Hub for that alone, not for development: the server reads its code
at start, and the website serves a `ui/` source file directly whenever it is newer than its build, so unfinished work
there would go live. Start a Hub you run by hand with `bun run agent-bus serve …` from its checkout (the `agent-bus`
command in `~/.local/bin` always runs the checkout where `install cli` was run).

1. Tell the agents (a short `@all` message), then stop the Hub, Tasks and status and take a backup: [Backup](#backup),
   with its "Before a manual upgrade" ending. Everything stays stopped until step 3.
2. Select the new release in that checkout and build it:

   ```sh
   cd ~/agent-hub && git fetch --tags && git checkout --detach vX.Y.Z && bun install --frozen-lockfile && bun run build
   ```

   Each command runs only if the one before it worked, so a missing release stops before anything is built.

3. Start the Tasks and status services from the new checkout, wait until Tasks answers, then start the Hub
   ([Start the Hub](#start-the-hub)). Connections come back by themselves. The database upgrades itself at start.

A change only to the website (`packages/server/ui`) is live after `bun run build` and a page refresh, without a
restart.

Either way, then update the adapters. On the Hub's machine the newer installer already updated the checkout; adding
`--tools` with the tools you use (or `auto`) to its command reinstalls their adapters too. On every other agent
machine, bring the checkout to the same release (`git fetch --tags && git checkout --detach vX.Y.Z && bun install
--frozen-lockfile`) and run `agent-bus install TOOL` again for each connected tool; it keeps the Hub URL. Several
adapters (Claude Code, Codex, GitHub Copilot, OpenCode, Antigravity) are copies made at install time and keep the old
version until reinstalled. Start new sessions of the tools afterwards. Hermes is the exception: `agent-bus install`
does not cover it, so on each machine that runs it, copy the plugin again from the upgraded checkout and restart the
gateway, then check with `agent-bus doctor --url URL` ([hermes.md](harnesses/hermes.md), Upgrade).

## Start the Hub

Start Tasks and status first if you run them. Then start a Hub the installer set up as below. Each way records the
release it started (`hub-commit` in the installer's state folder) only after the Hub answers on the checkout the
installer saved; the installer reads that record to know which release last ran on the data. It checks the record
against the running Hub (`/api/health`) and, with the Hub stopped, trusts it when it matches the checkout.

Before either way, paste this once in the same terminal. It checks that the Hub answering on port 7800 is this
installation's own process, by the same rules as the installer: the given process runs from the checkout with
exactly the options the installer saved, holds the listening socket on 127.0.0.1:7800 (read from `/proc` on Linux,
from `lsof` elsewhere; with neither it fails), and `/api/health` reports the version of the checkout's commit:

```sh
hub_verify_listener() {
  hv_pid=$1; hv_co=$2; hv_dd=$3; hv_s=${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub
  case "$hv_pid" in '' | 0 | *[!0-9]*) echo "no process id to check"; return 1 ;; esac
  set -- run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 --humans "$(cat "$hv_s/humans" 2>/dev/null)" \
    --data-dir "$hv_dd" --existing-data
  if [ -s "$hv_s/public-url" ]; then set -- "$@" --public-url "$(cat "$hv_s/public-url")"; fi
  if [ -r "/proc/$hv_pid/cmdline" ]; then
    [ "$(tr '\0' '\n' < "/proc/$hv_pid/cmdline" 2>/dev/null | sed 1d)" = "$(printf '%s\n' "$@")" ] ||
      { echo "process $hv_pid does not run with the options the installer saved"; return 1; }
    [ "$(cd -P "/proc/$hv_pid/cwd" 2>/dev/null && pwd -P)" = "$hv_co" ] || { echo "process $hv_pid does not run from $hv_co"; return 1; }
    hv_in=$(awk 'FNR > 1 && $4 == "0A" && ($2 == "0100007F:1E78" || $2 == "7F000001:1E78" ||
      $2 == "0000000000000000FFFF00000100007F:1E78" || $2 == "00000000000000000000FFFF0100007F:1E78") { print $10 }' \
      /proc/net/tcp /proc/net/tcp6 2>/dev/null)
    hv_fds=$(ls -l "/proc/$hv_pid/fd" 2>/dev/null | sed -n 's/.* -> //p')
    { printf '%s\n' "$hv_in"; echo ---; printf '%s\n' "$hv_fds"; } |
      awk '/^---$/ { s = 1; next } !s && NF { a["socket:[" $0 "]"] = 1; next } s && ($0 in a) { f = 1 } END { exit !f }' ||
      { echo "process $hv_pid does not hold the listening socket on 127.0.0.1:7800"; return 1; }
  elif command -v lsof > /dev/null 2>&1; then
    case "$(ps -o args= -p "$hv_pid" 2>/dev/null)" in *"bun run packages/cli/src/bin.ts serve"*) ;;
      *) echo "process $hv_pid is not a Hub"; return 1 ;; esac
    [ "$(lsof -a -p "$hv_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$hv_co" ] ||
      { echo "process $hv_pid does not run from $hv_co"; return 1; }
    lsof -nP -a -p "$hv_pid" -iTCP@127.0.0.1:7800 -sTCP:LISTEN > /dev/null 2>&1 ||
      { echo "process $hv_pid does not hold the listening socket on 127.0.0.1:7800"; return 1; }
  else echo "neither /proc nor lsof here to tell which process listens on 7800"; return 1; fi
  hv_live=$(curl -fsS --max-time 3 http://127.0.0.1:7800/api/health 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')
  hv_want=$(git -C "$hv_co" show HEAD:packages/protocol/src/types.ts 2>/dev/null | sed -n 's/^export const PROTOCOL_VERSION = "\([^"]*\)".*/\1/p')
  [ -n "$hv_want" ] && [ "$hv_live" = "$hv_want" ] || { echo "the Hub reports version ${hv_live:-none}, the checkout is ${hv_want:-unknown}"; return 1; }
}
echo "hub_verify_listener defined"
```

- **systemd user service (Linux):** (the same commands start the LaunchAgent on macOS, untested) the commands first
  check that the service is still exactly as the installer wrote it: its file equals the copy the installer kept in
  its state folder (`agent-hub.service.written`, or `com.agent-hub.hub.plist.written`), and on Linux systemd loads it
  from that file, with no drop-ins and no pending `daemon-reload`. The data directory is the one the installer saved
  (`data-dir`, an absolute path), and the service file must start the Hub with exactly that `--data-dir` argument
  (`/srv/hub` and `/srv/hub 2` differ). They also check that the service runs the checkout the installer
  saved, that the data directory holds `message-bus.sqlite` (so a data disk that is not mounted yet never gets a new,
  empty Hub), and that port 7800 is free. Then they start the service, wait up to 60 seconds for `/api/health`, and
  check with `hub_verify_listener` that the service's main process (`MainPID`, or the LaunchAgent's pid) is the one
  serving it. Only then do they write `hub-commit` and print `STARTED`; otherwise `NOT VERIFIED` and why:

  ```sh
  S=${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub; C=$(cat "$S/checkout" 2>/dev/null)
  CP=""; [ -n "$C" ] && CP=$(cd -P "$C" 2>/dev/null && pwd)
  UF=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/agent-hub.service; PL=$HOME/Library/LaunchAgents/com.agent-hub.hub.plist
  CHANGED=""
  if [ "$(uname)" = Darwin ]; then
    cmp -s "$PL" "$S/com.agent-hub.hub.plist.written" || CHANGED="$PL is not the file the installer wrote"
    WD=$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PL" 2>/dev/null)
  else
    if ! cmp -s "$UF" "$S/agent-hub.service.written"; then CHANGED="$UF is not the file the installer wrote"
    else
      PR=$(systemctl --user show agent-hub.service -p FragmentPath -p DropInPaths -p NeedDaemonReload 2>/dev/null)
      [ "$(printf '%s\n' "$PR" | sed -n 's/^FragmentPath=//p')" = "$UF" ] || CHANGED="systemd does not load it from $UF"
      [ -z "$(printf '%s\n' "$PR" | sed -n 's/^DropInPaths=//p')" ] || CHANGED="${CHANGED:-drop-ins change it}"
      [ "$(printf '%s\n' "$PR" | sed -n 's/^NeedDaemonReload=//p')" = no ] || CHANGED="${CHANGED:-it waits for a daemon-reload}"
    fi
    WD=$(systemctl --user show -p WorkingDirectory --value agent-hub.service 2>/dev/null)
  fi
  WP=""; [ -n "$WD" ] && WP=$(cd -P "$WD" 2>/dev/null && pwd)
  DD=$(cat "$S/data-dir" 2>/dev/null); case "$DD" in /*) ;; *) DD="" ;; esac
  SAME=no
  if [ "$(uname)" = Darwin ]; then
    i=0; prev=""
    while a=$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments:$i" "$PL" 2>/dev/null); do
      [ "$prev" != --data-dir ] || { [ "$a" = "$DD" ] && SAME=yes; }; prev=$a; i=$((i + 1))
    done
  else
    E=$(printf '%s' "$DD" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/\$/$$/g')
    ! grep -qF -- "\"--data-dir\" \"$E\" \"--existing-data\"" "$UF" || SAME=yes
  fi
  WANT=$(sed -n 's/^export const PROTOCOL_VERSION = "\([^"]*\)".*/\1/p' "$CP/packages/protocol/src/types.ts" 2>/dev/null)
  curl -s --max-time 2 -o /dev/null http://127.0.0.1:7800/; FREE=$?
  if ! command -v hub_verify_listener > /dev/null 2>&1; then echo "STOP: paste hub_verify_listener first (above); nothing was started"
  elif [ -n "$CHANGED" ]; then
    echo "STOP: this service was changed after install ($CHANGED); the installer no longer manages it. Start it yourself with the steps below; nothing was started"
  elif [ -z "$CP" ] || [ -z "$WANT" ] || [ "$WP" != "$CP" ]; then
    echo "STOP: the service does not run the checkout named in $S/checkout; nothing was started"
  elif [ -z "$DD" ]; then
    echo "NO DATA DIRECTORY: $S/data-dir is missing, empty or not an absolute path; nothing was started"
  elif [ "$SAME" != yes ]; then
    echo "STOP: the service does not start with the data directory in $S/data-dir ($DD); nothing was started"
  elif [ ! -f "$DD/message-bus.sqlite" ]; then
    echo "NO DATABASE: no message-bus.sqlite in $DD; is its disk mounted? Nothing was started"
  elif [ "$FREE" -ne 7 ]; then echo "STOP: port 7800 is taken (a Hub already runs?); nothing was started"
  elif ! if [ "$(uname)" = Darwin ]; then launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.agent-hub.hub.plist"
    else systemctl --user start agent-hub.service; fi; then echo "FAILED TO START: the service manager refused"
  else
    end=$(($(date +%s) + 60)); LIVE=""
    while [ "$(date +%s)" -lt "$end" ]; do
      LIVE=$(curl -fs --max-time 2 http://127.0.0.1:7800/api/health | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')
      [ -z "$LIVE" ] || break; sleep 1
    done
    if [ -z "$LIVE" ]; then echo "FAILED TO START: no answer on /api/health within 60 seconds; see the service's log"
    elif MP=$(if [ "$(uname)" = Darwin ]; then launchctl print "gui/$(id -u)/com.agent-hub.hub" 2>/dev/null |
        sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\).*/\1/p' | head -n 1
      else systemctl --user show -p MainPID --value agent-hub.service 2>/dev/null; fi)
      ! V=$(hub_verify_listener "$MP" "$CP" "$DD"); then
      echo "NOT VERIFIED: $V; hub-commit unchanged"
    elif H=$(git -C "$CP" rev-parse HEAD) && printf '%s\n' "$H" > "$S/hub-commit.tmp" && mv "$S/hub-commit.tmp" "$S/hub-commit"; then
      echo "STARTED from $CP"
    else echo "RUNNING BUT NOT RECORDED: $S/hub-commit could not be written"; fi
  fi
  ```

  If it stops with "this service was changed after install", the installer no longer manages it: it will not start
  or upgrade it (upgrade by hand), and running these commands again stops the same way. Start it yourself:

  1. Read the `--data-dir` in its start command: `systemctl --user cat agent-hub.service` (on a Mac, the
     `ProgramArguments` in `~/Library/LaunchAgents/com.agent-hub.hub.plist`).
  2. Check that `message-bus.sqlite` is in that directory (`ls -l DIR/message-bus.sqlite`). If it is not, its disk is
     probably not mounted: do not start the service.
  3. Run `systemctl --user start agent-hub.service` (or
     `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-hub.hub.plist`), and check that
     `curl -fs http://127.0.0.1:7800/api/health` answers.
  4. If the service runs the installer's checkout, record the release it started, so later runs of the same
     release's installer (for example to add a tool) do not stop and ask for a manual upgrade:

     ```sh
     S=${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub
     H=$(git -C "$(cat "$S/checkout")" rev-parse HEAD) && printf '%s\n' "$H" > "$S/hub-commit.tmp" &&
       mv "$S/hub-commit.tmp" "$S/hub-commit" && echo "RECORDED $H"
     ```

     The installer compares this record with the release it is asked for. It never upgrades a changed service; to
     let it manage the service again, put its copy back (`cp ~/.local/state/agent-hub/agent-hub.service.written
     ~/.config/systemd/user/agent-hub.service`, then `systemctl --user daemon-reload`) and start with the commands
     above.

- **nohup:** start it from the checkout and with the options the installer saved (`checkout`, the names in
  `humans`, the data directory in `data-dir`, and the HTTPS address in `public-url` if you gave one with
  `--public-url`), in the same order as the installer, plus `--existing-data`, so the Hub refuses to create a new
  database. The commands stop without touching `hub.pid` if the checkout or `humans` is missing, if `data-dir` does not
  name a directory holding `message-bus.sqlite` (a data disk not mounted yet),
  if a Hub process from the checkout already runs, or if port 7800 is taken. Otherwise they start the Hub and, once
  the process is still alive, `/api/health` answers (within 30 seconds) and `hub_verify_listener` confirms that the
  started process is the one serving it, write its process id to `hub.pid` and
  the checkout's commit to `hub-commit`. They print `STARTED` only if both writes worked. They recognise a Hub process
  as the stop commands in [Backup](#backup) do:

  ```sh
  S=${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub; C=$(cat "$S/checkout" 2>/dev/null)
  CP=""; [ -n "$C" ] && CP=$(cd -P "$C" 2>/dev/null && pwd)
  BUN=$(cat "$S/bun" 2>/dev/null); [ -x "$BUN" ] || BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
  DD=$(cat "$S/data-dir" 2>/dev/null); case "$DD" in /*) [ -d "$DD" ] || DD="" ;; *) DD="" ;; esac
  hubpids() { for p in $(pgrep -f 'packages/cli/src/bin.ts' 2>/dev/null); do
    if [ -r "/proc/$p/cmdline" ]; then
      case "$(readlink "/proc/$p/exe" 2>/dev/null)" in */bun) ;; *) continue ;; esac
      [ "$(tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null | sed -n '2,4p' | tr '\n' ' ')" = "run packages/cli/src/bin.ts serve " ] || continue
      cw=$(cd -P "/proc/$p/cwd" 2>/dev/null && pwd)
    else
      case "$(ps -o args= -p "$p" 2>/dev/null)" in *"bun run packages/cli/src/bin.ts serve"*) ;; *) continue ;; esac
      cw=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    fi
    if [ -n "$CP" ] && [ "$cw" = "$CP" ]; then echo "$p"; fi; done; }
  refused() { curl -s --max-time 2 -o /dev/null http://127.0.0.1:7800/; [ "$?" -eq 7 ]; }
  if ! command -v hub_verify_listener > /dev/null 2>&1; then echo "STOP: paste hub_verify_listener first (above); nothing was started"
  elif [ -z "$CP" ] || [ ! -f "$CP/packages/cli/src/bin.ts" ] || [ ! -s "$S/humans" ]; then
    echo "STOP: $S does not name a usable checkout and humans; nothing was started"
  elif [ -z "$DD" ] || [ ! -f "$DD/message-bus.sqlite" ]; then
    echo "NO DATABASE: $S/data-dir does not name a directory holding message-bus.sqlite (${DD:-none}); is its disk mounted? Nothing was started"
  elif [ -n "$(hubpids)" ] || ! refused; then
    echo "STOP: a Hub from $CP already runs or port 7800 is taken; nothing was started, hub.pid unchanged"
  else
    (cd "$CP" && if [ -s "$S/public-url" ]; then set -- --public-url "$(cat "$S/public-url")"; else set --; fi &&
      exec nohup "$BUN" run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 \
      --humans "$(cat "$S/humans")" --data-dir "$DD" --existing-data "$@" >> "$S/hub.log" 2>&1 < /dev/null) &
    NP=$!; end=$(($(date +%s) + 30)); UP=no
    while [ "$(date +%s)" -lt "$end" ] && kill -0 "$NP" 2>/dev/null; do
      if curl -fs --max-time 2 -o /dev/null http://127.0.0.1:7800/api/health; then UP=yes; break; fi; sleep 1
    done
    V=""; if [ "$UP" = yes ] && kill -0 "$NP" 2>/dev/null && V=$(hub_verify_listener "$NP" "$CP" "$DD"); then
      if echo "$NP" > "$S/hub.pid" && H=$(git -C "$CP" rev-parse HEAD) && printf '%s\n' "$H" > "$S/hub-commit.tmp" &&
        mv "$S/hub-commit.tmp" "$S/hub-commit"; then echo "STARTED from $CP"
      else echo "RUNNING BUT NOT RECORDED: the Hub runs as process $NP, but $S/hub.pid or hub-commit could not be written"; fi
    elif [ -n "$V" ]; then kill "$NP" 2>/dev/null; echo "FAILED TO START: $V; hub.pid unchanged"
    else kill "$NP" 2>/dev/null; echo "FAILED TO START: see $S/hub.log; hub.pid unchanged"; fi
  fi
  ```

  The process id in `hub.pid` is then the Hub's own, and the stop commands in [Backup](#backup) find it (and any
  other Hub process from the checkout) either way.
  Running the same release's installer again also starts it. After a
  manual upgrade or rollback, do not re-run another release's installer to start it: each installer checks out the
  release it is pinned to.
- **A Hub you started yourself:** start it again from its checkout with the same options.

## Rollback

An upgrade can change the database in ways older code cannot read, and no older version is tested against a newer
database. To go back, stop the Hub, Tasks and status (as in [Backup](#backup)), select the release that ran before
(below), restore the backup taken before the upgrade ([Restore](#restore)), and start everything as in
[Start the Hub](#start-the-hub); messages written since are lost.

```sh
cd ~/agent-hub && git checkout --detach vX.Y.Z && bun install --frozen-lockfile && bun run build
```

This does not change the installer's record of the release that ran (`hub-commit`): that happens only when the Hub
starts as in [Start the Hub](#start-the-hub), after the restore. So if you stop between the build and the restore,
the record still names the newer release, which matches the data.

Running the newer release's installer again after such a rollback upgrades the Hub again, taking a fresh backup first.
If an installer upgrade had failed, the installer keeps a record of it in `upgrade-recovery` in its state directory;
the next installer run, with the rolled-back Hub running, removes that record by itself, so you do not delete it.

## Access defaults

- **Listening:** the installer's Hub listens on this machine only (`--host 127.0.0.1`). Started by hand,
  `agent-bus serve` listens on all interfaces (`--host 0.0.0.0`), port 7800 (http). Anyone who can reach the port can try, but every
  read and write needs an identity (below). For people on phones or outside the house, serve https on a host name
  (`--https-port 7843 --tls-cert … --tls-key … --rp-id HOST`) or reach the Hub through a private network (for example
  Tailscale Serve and `--public-url`; for a Hub the installer started, give `--public-url` to the installer, see
  [remote.md](remote.md)). Plain http on the LAN sends session keys unencrypted.
- **People:** only the names in `--humans`. Each signs in with a passkey made from a one-time link: `agent-bus invite
  NAME`, valid 10 minutes, once. That short form fits a default install: it reads the database in `~/.agent-bus` (or
  `$AGENT_BUS_DATA_DIR`) and makes a link to `http://localhost:7800`. For a Hub with another data directory, set `D`
  with the block in [Backup](#backup), then run, on the Hub's machine with the Hub running. The installer's Hub uses
  port 7800; for a Hub you started on another `--port`, set `HUB_PORT` to it first.

  ```sh
  S=${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub; P=${HUB_PORT:-7800}
  BUN=$(cat "$S/bun" 2>/dev/null); [ -x "$BUN" ] || BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
  HUB_URL=$(curl -fsS --max-time 5 "http://127.0.0.1:$P/api/auth/state" 2>/dev/null | "$BUN" -e '
    const s = await Bun.stdin.json();
    const ok = (s.origins ?? []).find((o) => { const u = new URL(o), h = u.hostname;
      return (h === s.rpId || h.endsWith("." + s.rpId)) &&
        (u.protocol === "https:" || (u.protocol === "http:" && (h === "localhost" || h === "127.0.0.1"))); });
    console.log(ok ?? "")' 2>/dev/null)
  if [ -z "${D:-}" ]; then echo "set D first (Backup)"
  elif [ -z "$HUB_URL" ]; then
    echo "NO SIGN-IN ADDRESS: the Hub on port $P did not answer, or none of its addresses can make passkeys."
    echo "Run: agent-bus invite NAME --data-dir \"$D\" --url URL, where URL is the Hub's address whose host name is its --rp-id."
  else agent-bus invite NAME --data-dir "$D" --url "$HUB_URL"; fi
  ```

  `HUB_URL` is the Hub's own address for making passkeys: of the addresses it accepts passkeys from (its `origins`),
  the first whose host name is its `--rp-id` or ends in `.` and that name, and that uses `https://` (browsers make
  passkeys over plain `http://` only on `localhost` or `127.0.0.1`). On an installer's Hub that is
  `http://localhost:7800`; on a Hub started with `--rp-id hub.example` and `--https-port`, its `https://hub.example…`
  address. If the Hub does not answer or has no such address, the commands stop and say how to give the address by
  hand. Open a `localhost` link on the Hub's machine, or from another computer through the tunnel
  `ssh -L 7800:127.0.0.1:7800 HOST`. A `--public-url` address does not make passkeys; a phone signs in afterwards with
  **Add a device**, which uses that address. Further devices: your name at the top right → **Add a device**
  (QR code, 2 minutes, once). Sessions last 30 days; each device can be signed out there. To add a person to a Hub the
  installer started: stop it and remove its service file (systemd: `systemctl --user disable --now agent-hub.service`,
  then delete `~/.config/systemd/user/agent-hub.service`; LaunchAgent: `launchctl bootout
  gui/$(id -u)/com.agent-hub.hub`, then delete `~/Library/LaunchAgents/com.agent-hub.hub.plist`; nohup: stop it as in
  [Backup](#backup)), add the name to the comma-separated list in the installer's state `humans` file, then run the
  installer again with `--name NAME`. It starts the Hub again with all the names (the installer prints these steps
  when you run it with a new name).
- **Agents:** a machine account's token waits until a person allows it (website prompt with a short code, or
  `agent-bus approve CODE` on the Hub host); `agent-bus deny CODE` revokes. All agents of one machine account share
  that token: whoever can read it can connect as that account's agents, and revoking it removes them all. Agents
  offline 15 days are forgotten (`--forget-offline-days`).
- **What each reads:** its own conversations, `#all`, and open projects and rooms. People also read every conversation
  that has no person in it (agents among themselves, including discoverable and private projects and rooms), so they
  can oversee agents. A DM, group DM, or discoverable or private project or room with a person in it stays private to
  its members; an open project or room is readable by everyone. Discoverable projects show their name, topic and
  members to everyone.
- **Live output is not private:** any signed-in person or approved agent machine can watch an agent's Live output,
  including prompts and tool results from work started in a private DM. Do not treat a person–agent DM as
  confidential from the other people on the Hub.
- **Optional parts are off unless configured:** Tasks (`--task-ext`), speech-to-text (`--stt-url`), reading aloud
  (`--tts-url`), GPU booking (`--gpudash`), Workspace pages (`--ext`), bug-report DMs to an agent
  (`--bug-reports-to`), branding (`--brand-name/-logo/-icon`; without it the site says "Agent Hub").
- **Retention:** messages and files are kept until deleted; nothing expires them except messages held for offline
  agents (their hold, default 1 hour).
