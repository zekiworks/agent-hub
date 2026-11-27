#!/bin/sh
# Clean-machine test of install.sh in Docker: Ubuntu, a non-root user with no Bun, the repo served from a bare repo
# holding this working tree's tracked files (committed or not) as tag v1.0.0, plus v1.0.1 and v1.0.2, which change the
# version the server reports and create a table at start (so the test sees which code ran on which database). Installed
# the way the README says (`curl … | sh`, so no terminal), into a folder whose path has a space and an ampersand.
#
#   dash tests/smoke/install-sh.sh [nohup|systemd]    (default nohup; needs Docker and network for Bun and npm)
#
# nohup:   the container has no systemd, so the Hub runs under nohup.
# systemd: systemd is PID 1 (a --privileged container) and maya's user manager runs, so the Hub is a user unit.
# Checks, in order: without --name and a terminal it stops before changing anything; the first run installs Bun,
# builds, starts the Hub and prints a sign-in link the Hub accepts for maya; the second run (over SSH) reuses all of it;
# another name stops without a link; with a terminal it asks the name and about the tools found; the coding-agent form
# connects a tool and `agent-bus doctor` reaches the Hub; a tool that fails to connect gives a retry line and exit 1; a
# stopped Hub is started again; v1.0.1 over the running Hub backs up before the code changes; v1.0.2 over a stopped Hub,
# without AGENT_HUB_DIR, backs up and upgrades the checkout the Hub runs from; a conflicting AGENT_HUB_DIR is refused;
# a Hub whose passkeys are for another site gets a link at that site (systemd) or a clear stop without a link; a Hub
# started by hand from the checkout is reused as it is, but a version that would change its checkout is refused.
# Also: a manual rollback (docs/operations.md) and re-upgrade, the unit between automatic restarts (systemd), a unit
# edited after install, a drop-in and a pending daemon-reload (refused, nothing changed), a damaged recovery backup
# (refused), decoy processes and a stale hub.pid that must survive, and a proxied Hub accepting passkeys only from
# https://localhost.
# Removes its image, container and temp folder afterwards (KEEP=1 keeps them).
set -eu

MODE="${1:-nohup}"
case "$MODE" in nohup | systemd) ;; *) echo "usage: dash tests/smoke/install-sh.sh [nohup|systemd]" >&2; exit 2 ;; esac
REPO=$(cd "$(dirname "$0")/../.." && pwd)
IMAGE="agent-hub-install-smoke:$MODE-$$"
NAME="agent-hub-install-smoke-$MODE-$$"
CHECKOUT="/home/maya/Code & Docs/agent-hub"
# Under ~/.cache, not /tmp: a snap-packaged Docker cannot mount the host's /tmp.
mkdir -p "$HOME/.cache"
TMP=$(mktemp -d "$HOME/.cache/agent-hub-install-smoke.XXXXXX")
failures=0

cleanup() {
  [ "${KEEP:-}" = 1 ] && { echo "kept: container $NAME, image $IMAGE, $TMP"; return; }
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

check() { # check LABEL COMMAND…
  label="$1"
  shift
  if "$@"; then echo "PASS  $label"; else echo "FAIL  $label"; failures=$((failures + 1)); fi
}
has() { grep -qF -- "$2" "$TMP/$1.log"; }
lacks() { ! grep -qF -- "$2" "$TMP/$1.log"; }
line_of() { grep -nF -- "$2" "$TMP/$1.log" | head -n 1 | cut -d: -f1; }

echo "== image and repo"
docker build -q -t "$IMAGE" -f "$REPO/tests/smoke/install-sh.Dockerfile" "$REPO/tests/smoke" >/dev/null
# The working tree as a commit (git stash create changes no ref, index or file), pushed as v1.0.0 to a scratch repo.
snapshot=$(git -C "$REPO" stash create)
git init -q --bare "$TMP/agent-hub.git"
git -C "$REPO" push -q "$TMP/agent-hub.git" "${snapshot:-HEAD}:refs/tags/v1.0.0" "${snapshot:-HEAD}:refs/heads/main"
git -C "$TMP/agent-hub.git" symbolic-ref HEAD refs/heads/main
# make_tag TAG VERSION TABLE: the previous tag with PROTOCOL_VERSION (which /api/health reports) set to VERSION, a
# table TABLE the server creates at start, and "<!-- smoke VERSION -->" in the website's index.html (the built bundle).
git clone -q "$TMP/agent-hub.git" "$TMP/work"
git -C "$TMP/work" -c advice.detachedHead=false checkout -q v1.0.0
# The line in server.ts after which the smoke releases add their own: the one that opens the database (by its start).
anchor='  const db = new BusDatabase('
[ "$(grep -cF "$anchor" "$TMP/work/packages/server/src/server.ts")" = 1 ] || { echo "server.ts changed: update the smoke tags' anchor" >&2; exit 1; }
make_tag() {
  sed "s/^export const PROTOCOL_VERSION = .*/export const PROTOCOL_VERSION = \"$2\";/" \
    "$TMP/work/packages/protocol/src/types.ts" >"$TMP/edit.ts"
  mv "$TMP/edit.ts" "$TMP/work/packages/protocol/src/types.ts"
  awk -v a="$anchor" -v t="$3" '{ print } index($0, a) == 1 { print "  db.db.exec(\"CREATE TABLE IF NOT EXISTS " t " (at INTEGER)\");" }' \
    "$TMP/work/packages/server/src/server.ts" >"$TMP/edit.ts"
  mv "$TMP/edit.ts" "$TMP/work/packages/server/src/server.ts"
  echo "<!-- smoke $2 -->" >>"$TMP/work/packages/server/ui/index.html"
  git -C "$TMP/work" -c user.name=smoke -c user.email=smoke@localhost commit -q -am "smoke: $1"
  git -C "$TMP/work" push -q origin "HEAD:refs/tags/$1"
}
make_tag v1.0.1 2.0.0-smoke1 smoke_v101
make_tag v1.0.2 2.0.0-smoke2 smoke_v102
make_tag v1.0.3 2.0.0-smoke3 smoke_v103
make_tag v1.0.4 2.0.0-smoke4 smoke_v104
# Broken releases, all from v1.0.4: v1.0.5's build fails; v1.0.6's server runs but never answers (blocked before it
# listens); v1.0.7's does the same and also ignores SIGTERM and SIGINT, so a plain stop cannot end it.
base=$(git -C "$TMP/work" rev-parse HEAD)
{ echo 'process.exit(1);'; cat "$TMP/work/packages/server/scripts/build-ui.ts"; } >"$TMP/edit.ts"
mv "$TMP/edit.ts" "$TMP/work/packages/server/scripts/build-ui.ts"
git -C "$TMP/work" -c user.name=smoke -c user.email=smoke@localhost commit -q -am "smoke: v1.0.5, build fails"
git -C "$TMP/work" push -q origin "HEAD:refs/tags/v1.0.5"
broken_start() { # broken_start TAG LINE…: v1.0.4 with LINEs after the anchor in server.ts
  tag="$1"
  shift
  git -C "$TMP/work" -c advice.detachedHead=false checkout -q "$base"
  for line in "$@"; do
    awk -v a="$anchor" -v l="$line" '{ print } index($0, a) == 1 { print "  " l }' "$TMP/work/packages/server/src/server.ts" >"$TMP/edit.ts"
    mv "$TMP/edit.ts" "$TMP/work/packages/server/src/server.ts"
  done
  git -C "$TMP/work" -c user.name=smoke -c user.email=smoke@localhost commit -q -am "smoke: $tag, never answers"
  git -C "$TMP/work" push -q origin "HEAD:refs/tags/$tag"
}
block='Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);'
# v1.0.6 also writes to the database before it blocks: a retry must not take its backup for the way back.
broken_start v1.0.6 "$block" 'db.db.exec("CREATE TABLE IF NOT EXISTS smoke_hang (at INTEGER)");'
broken_start v1.0.7 "$block" 'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {});' 'db.db.exec("CREATE TABLE IF NOT EXISTS smoke_hung (at INTEGER)");'
# v1.0.8: v1.0.4 with its own version that blocks 65 s before it listens: it answers, but only after the installer's
# minute is up.
git -C "$TMP/work" -c advice.detachedHead=false checkout -q "$base"
sed 's/^export const PROTOCOL_VERSION = .*/export const PROTOCOL_VERSION = "2.0.0-smoke8";/' \
  "$TMP/work/packages/protocol/src/types.ts" >"$TMP/edit.ts"
mv "$TMP/edit.ts" "$TMP/work/packages/protocol/src/types.ts"
awk -v a="$anchor" '{ print } index($0, a) == 1 { print "  db.db.exec(\"CREATE TABLE IF NOT EXISTS smoke_late (at INTEGER)\");"; print "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 65000);" }' \
  "$TMP/work/packages/server/src/server.ts" >"$TMP/edit.ts"
mv "$TMP/edit.ts" "$TMP/work/packages/server/src/server.ts"
git -C "$TMP/work" -c user.name=smoke -c user.email=smoke@localhost commit -q -am "smoke: v1.0.8, answers late"
git -C "$TMP/work" push -q origin "HEAD:refs/tags/v1.0.8"
# v1.0.9 (B): v1.0.4 with its own version, a working release; v1.0.10 (C): v1.0.9 whose server writes to the database,
# then never answers. C failing leaves data that B, before C, must not start on.
git -C "$TMP/work" -c advice.detachedHead=false checkout -q "$base"
make_tag v1.0.9 2.0.0-smoke9 smoke_v109
awk -v a="$anchor" -v l="$block" '{ print } index($0, a) == 1 { print "  db.db.exec(\"CREATE TABLE IF NOT EXISTS smoke_c (at INTEGER)\");"; print "  " l }' \
  "$TMP/work/packages/server/src/server.ts" >"$TMP/edit.ts"
mv "$TMP/edit.ts" "$TMP/work/packages/server/src/server.ts"
git -C "$TMP/work" -c user.name=smoke -c user.email=smoke@localhost commit -q -am "smoke: v1.0.10, writes, never answers"
git -C "$TMP/work" push -q origin "HEAD:refs/tags/v1.0.10"
# A release on another line: v1.0.1-side is v1.0.0 plus its own commit, a sibling of v1.0.1.
git -C "$TMP/work" -c advice.detachedHead=false checkout -q v1.0.0
echo "<!-- smoke side -->" >>"$TMP/work/packages/server/ui/index.html"
git -C "$TMP/work" -c user.name=smoke -c user.email=smoke@localhost commit -q -am "smoke: v1.0.1-side"
git -C "$TMP/work" push -q origin "HEAD:refs/tags/v1.0.1-side"
rm -rf "$TMP/work"
cp "$REPO/install.sh" "$TMP/install.sh"
# The nohup stop and start commands of docs/operations.md, as written there: the test stops and starts the Hub with them.
doc_block() { # doc_block MARKER: the first ```sh block after the line containing MARKER
  awk -v m="$1" 'index($0, m) { f = 1 } f && /^[[:space:]]*```sh/ { b = 1; next } b && /^[[:space:]]*```/ { exit } b { sub(/^  /, ""); print }' \
    "$REPO/docs/operations.md"
}
doc_block '- **nohup** (the installer found no systemd user session' >"$TMP/doc-nohup-stop.sh"
# The documented starts, each after the helper block the doc says to paste first.
{
  doc_block 'Before either way, paste this once in the same terminal.'
  doc_block '- **nohup:** start it from the checkout'
} >"$TMP/doc-nohup-start.sh"
{
  doc_block 'Before either way, paste this once in the same terminal.'
  doc_block '(the same commands start the LaunchAgent on macOS'
} >"$TMP/doc-systemd-start.sh"
grep -q 'hub_verify_listener()' "$TMP/doc-nohup-start.sh" || { echo "docs/operations.md: the hub_verify_listener block was not found" >&2; exit 1; }
# Restore from docs/operations.md as written: the block that sets D, then Restore's steps 1 and 2, with B (which the
# doc says to set) taken from $RESTORE_B.
{
  doc_block 'Then set `D`, the Hub'"'"'s data directory, once.'
  doc_block 'Then define the check that Backup and Restore share.'
  doc_block '1. Unpack the backup into a private staging directory' | sed 's#^ *B=~/agent-bus-backup-YYYYMMDD-HHMMSS;#B="$RESTORE_B";#'
  doc_block '2. Stop the Hub as in [Backup](#backup)'
} >"$TMP/doc-restore.sh"
# Backup from docs/operations.md as written: the block that sets D, the shared check, and the backup itself.
{
  doc_block 'Then set `D`, the Hub'"'"'s data directory, once.'
  doc_block 'Then define the check that Backup and Restore share.'
  doc_block 'Then take the backup:'
} >"$TMP/doc-backup.sh"
grep -q 'echo "Backup written to $B"' "$TMP/doc-backup.sh" || { echo "docs/operations.md: the Backup block was not found" >&2; exit 1; }
# Rollback's and Upgrade-by-hand's commands as written, with their placeholders filled: the checkout path and the
# release ($ROLLBACK_TO, $UPGRADE_TO).
doc_block '## Rollback' | sed -e 's#cd ~/agent-hub#cd "$CHECKOUT"#' -e 's#vX\.Y\.Z#"$ROLLBACK_TO"#' >"$TMP/doc-rollback.sh"
doc_block '2. Select the new release in that checkout and build it:' |
  sed -e 's#cd ~/agent-hub#cd "$CHECKOUT"#' -e 's#vX\.Y\.Z#"$UPGRADE_TO"#' >"$TMP/doc-upgrade.sh"
if ! grep -q 'git checkout --detach "\$ROLLBACK_TO" && bun install --frozen-lockfile && bun run build' "$TMP/doc-rollback.sh" ||
  ! grep -q 'git checkout --detach "\$UPGRADE_TO" && bun install --frozen-lockfile && bun run build' "$TMP/doc-upgrade.sh" ||
  ! grep -q 'STARTED from' "$TMP/doc-systemd-start.sh"; then
  echo "docs/operations.md: the Rollback, Upgrade or systemd start command was not found" >&2
  exit 1
fi
if ! grep -q 'HUB STOPPED' "$TMP/doc-nohup-stop.sh" || ! grep -q 'STARTED from' "$TMP/doc-nohup-start.sh" ||
  ! grep -q '^B="\$RESTORE_B";' "$TMP/doc-restore.sh" || ! grep -q 'echo "RESTORED' "$TMP/doc-restore.sh"; then
  echo "docs/operations.md: the nohup stop and start blocks or the Restore blocks were not found" >&2
  exit 1
fi
# smoke-db.ts mark VALUE FILE: adds a marker row; smoke-db.ts show FILE: "<smoke_ tables> <marker values>".
cat >"$TMP/smoke-db.ts" <<'EOF'
import { Database } from "bun:sqlite";
const [cmd, a, b] = process.argv.slice(2);
const db = new Database(cmd === "mark" || cmd === "docmark" || cmd === "agent" || cmd === "alias" || cmd === "unagent" ? b : a);
db.exec("PRAGMA busy_timeout = 5000");
if (cmd === "agent") {
  // smoke-db.ts agent ID FILE: an agent participant ID.
  db.query("INSERT INTO participants (id, kind, settings_json, created_at, last_seen_at) VALUES (?1, 'agent', '{}', 0, 0)").run(a);
} else if (cmd === "alias") {
  // smoke-db.ts alias OLD:NEW FILE: OLD is the old name of agent NEW.
  const [o, n] = a.split(":");
  db.query("INSERT INTO participant_aliases (old_id, new_id, renamed_at) VALUES (?1, ?2, 0)").run(o, n);
} else if (cmd === "unagent") {
  // smoke-db.ts unagent ID FILE: the agent ID and every old name of it gone again.
  db.query("DELETE FROM participant_aliases WHERE new_id = ?1").run(a);
  db.query("DELETE FROM participants WHERE id = ?1 AND kind = 'agent'").run(a);
} else if (cmd === "mark") {
  db.exec("CREATE TABLE IF NOT EXISTS smoke_marker (v TEXT)");
  db.query("INSERT INTO smoke_marker VALUES (?1)").run(a);
} else if (cmd === "docmark") {
  // A marker outside the smoke_ tables that show lists, for the documented backup and restore.
  db.exec("CREATE TABLE IF NOT EXISTS zz_docmark (v TEXT)");
  db.query("INSERT INTO zz_docmark VALUES (?1)").run(a);
} else if (cmd === "docmarks") {
  const has = db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'zz_docmark'").get()!.n;
  console.log(has ? db.query<{ v: string }, []>("SELECT v FROM zz_docmark ORDER BY v").all().map((r) => r.v).join(",") : "");
} else {
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'smoke%' ORDER BY name").all().map((r) => r.name);
  const marks = tables.includes("smoke_marker") ? db.query<{ v: string }, []>("SELECT v FROM smoke_marker ORDER BY v").all().map((r) => r.v) : [];
  console.log(`${tables.join(",")} ${marks.join(",")}`);
}
EOF

if [ "$MODE" = systemd ]; then
  docker run -d --name "$NAME" --privileged --cgroupns=private -v "$TMP:/src:ro" "$IMAGE" /sbin/init >/dev/null
  i=0
  until docker exec "$NAME" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded'; do
    i=$((i + 1)); [ "$i" -le 60 ] || { echo "systemd did not come up" >&2; exit 1; }; sleep 1
  done
  # In a container, pam_unix's account check for the user manager fails (unix_chkpwd gives no answer); this test
  # machine lets it start without it, as a login would on a real one.
  docker exec "$NAME" sh -c 'printf "account required pam_permit.so\nsession required pam_permit.so\nsession optional pam_systemd.so\n" >/etc/pam.d/systemd-user && systemctl start "user@$(id -u maya).service"'
else
  docker run -d --init --name "$NAME" -v "$TMP:/src:ro" "$IMAGE" sleep infinity >/dev/null
fi
docker exec "$NAME" sh -c 'cp -r /src/agent-hub.git /src/install.sh /src/smoke-db.ts /src/doc-*.sh /srv/ && chown -R maya /srv/agent-hub.git /srv/install.sh /srv/smoke-db.ts /srv/doc-*.sh'
UID_MAYA=$(docker exec "$NAME" id -u maya)

# As maya, without a terminal (docker exec without -t), like `curl … | sh`. $REF picks the tag (default v1.0.0);
# AGENT_HUB_DIR is $CHECKOUT unless $HUB_DIR says otherwise ("-" leaves it unset); $SSH_CONN sets SSH_CONNECTION;
# NO_SESSION=1 leaves out the user session (XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS); $DATA_ENV sets
# AGENT_BUS_DATA_DIR.
as_maya() {
  cmd="$1"
  set -- -e HOME=/home/maya -e USER=maya -e PATH=/usr/local/bin:/usr/bin:/bin \
    -e AGENT_HUB_REPO=file:///srv/agent-hub.git -e "AGENT_HUB_REF=${REF:-v1.0.0}" -e "CHECKOUT=$CHECKOUT"
  [ "${NO_SESSION:-}" = 1 ] ||
    set -- "$@" -e "XDG_RUNTIME_DIR=/run/user/$UID_MAYA" -e "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID_MAYA/bus"
  [ "${HUB_DIR:-}" = "-" ] || set -- "$@" -e "AGENT_HUB_DIR=${HUB_DIR:-$CHECKOUT}"
  [ -z "${SSH_CONN:-}" ] || set -- "$@" -e "SSH_CONNECTION=$SSH_CONN"
  [ -z "${DATA_ENV:-}" ] || set -- "$@" -e "AGENT_BUS_DATA_DIR=$DATA_ENV"
  docker exec -i -u maya -w "${WORKDIR:-/home/maya}" "$@" "$NAME" sh -c "$cmd" </dev/null
}
run_log() { # run_log LOG SHELL-COMMAND: runs it as maya, keeps the output, shows its end; returns its exit code
  rc=0
  as_maya "$2" >"$TMP/$1.log" 2>&1 || rc=$?
  echo "-- $1 (exit $rc), last lines:"
  tail -n 12 "$TMP/$1.log" | sed 's/^/   | /'
  return "$rc"
}
install_run() { run_log "$1" "sh -s -- $2 </srv/install.sh"; } # install.sh piped into sh, as curl would
healthy() { as_maya 'curl -fsS http://127.0.0.1:7800/api/health' | grep -q '"ok":true'; }
version_is() { docker exec "$NAME" curl -fsS http://127.0.0.1:7800/api/health | grep -q "\"version\":\"$1\""; }
# The sign-in link in LOG is one the running Hub accepts for PERSON (register/options checks it without using it).
link_works() {
  token=$(sed -n 's/^SIGN-IN LINK: .*#invite=//p' "$TMP/$1.log")
  [ -n "$token" ] && as_maya "curl -fsS -X POST -H 'Content-Type: application/json' --data '{\"invite\":\"$token\"}' http://127.0.0.1:7800/api/auth/register/options" | grep -q "\"name\":\"$2\""
}
db_show() { as_maya "\"\$HOME/.bun/bin/bun\" /srv/smoke-db.ts show $1"; }
# The number of Hub processes running from the checkout: arguments 2-4 exactly `run packages/cli/src/bin.ts serve`,
# working directory the checkout (the second checkout's Hub on 7802 and the decoys do not count).
checkout_hubs() { as_maya 'for p in $(pgrep -f "[b]in.ts serve"); do [ "$(readlink /proc/$p/cwd)" = "$CHECKOUT" ] || continue; if [ "$(tr "\0" "\n" </proc/$p/cmdline | sed -n 2,4p | tr "\n" " ")" = "run packages/cli/src/bin.ts serve " ]; then echo "$p"; fi; done | wc -l'; }
# goback_after_restore FAILLOG NAME: the way back ($last_commit) is refused while the data is what the failed version
# left; after the documented Restore of the backup FAILLOG named, it runs.
goback_after_restore() {
  REF="$last_commit"
  rc=0; install_run "$2-first" "--name maya --tools none" || rc=$?
  check "$2: before the restore, the way back is refused" sh -c "[ \"\$1\" -eq 1 ] && grep -q 'Restore .*hub.tar first' '$TMP/$2-first.log'" _ "$rc"
  check "$2: the record is kept" as_maya '[ -f ~/.local/state/agent-hub/upgrade-recovery ]'
  check "$2: and no Hub runs" [ "$(checkout_hubs)" = 0 ]
  b=$(sed -n 's/^ *2\. restore \(.*\)\/hub\.tar as in .*/\1/p' "$TMP/$1.log" | head -n 1)
  rc=0; run_log "$2-restore" "RESTORE_B='$b' sh /srv/doc-restore.sh" || rc=$?
  check "$2: the documented Restore says RESTORED" grep -q '^RESTORED\.' "$TMP/$2-restore.log"
  rc=0; install_run "$2" "--name maya --tools none" || rc=$?
  check "$2: then the way back exits 0" [ "$rc" -eq 0 ]
  check "$2: the Hub runs $LAST_TAG again" version_is "$LAST_VERSION"
}
# The database in the newest backup.
backup_show() { as_maya 'd=$(mktemp -d) && tar -C "$d" -xf "$(ls -d ~/agent-bus-backup-* | tail -n 1)/hub.tar" && "$HOME/.bun/bin/bun" /srv/smoke-db.ts show "$d/message-bus.sqlite"'; }
# Stop and start the Hub the way docs/operations.md says (for nohup: its stop and start blocks, run as written).
stop_hub() {
  if [ "$MODE" = systemd ]; then
    as_maya 'systemctl --user stop agent-hub.service'
  else
    out=$(as_maya 'sh /srv/doc-nohup-stop.sh' 2>&1 || true)
    case "$out" in *"HUB STOPPED"*) ;; *) echo "FAIL  the documented nohup stop: $out"; failures=$((failures + 1)) ;; esac
  fi
}
start_hub() {
  if [ "$MODE" = systemd ]; then
    out=$(as_maya 'sh /srv/doc-systemd-start.sh' 2>&1 || true)
    case "$out" in *"STARTED from"*) ;; *) echo "FAIL  the documented systemd start: $out"; failures=$((failures + 1)) ;; esac
  else
    out=$(as_maya 'sh /srv/doc-nohup-start.sh' 2>&1 || true)
    case "$out" in *"STARTED from"*) ;; *) echo "FAIL  the documented nohup start: $out"; failures=$((failures + 1)) ;; esac
  fi
  as_maya 'i=0; until curl -fsS http://127.0.0.1:7800/api/health >/dev/null 2>&1; do i=$((i+1)); [ $i -le 30 ] || exit 1; sleep 1; done'
}

echo "== the names the Hub keeps for itself: system, resources, task, status"
for n in system resources task status; do
  rc=0; install_run "name-$n" "--name $n" || rc=$?
  check "--name $n exits 1" [ "$rc" -eq 1 ]
  check "--name $n: says the Hub keeps it" has "name-$n" "\"$n\" cannot be a name on the Hub: the Hub keeps it for itself"
  check "--name $n: changed nothing (no checkout, no ~/.bun, no state)" as_maya '[ ! -e "$AGENT_HUB_DIR" ] && [ ! -e ~/.bun ] && [ ! -e ~/.local/state/agent-hub ]'
done

echo "== no name, no terminal"
rc=0; install_run noname "" || rc=$?
check "exits 1 without a name or terminal" [ "$rc" -eq 1 ]
check "says how to give the name" has noname "--name NAME"
check "changed nothing (no checkout, no ~/.bun)" as_maya '[ ! -e "$AGENT_HUB_DIR" ] && [ ! -e ~/.bun ]'

# A git that, the first time it is called for the step named in /tmp/slowgit.at, does its work and then pauses: until
# /tmp/slowgit.hold is removed (then it exits as git did), or else for 60 s (then it fails), so a run can be interrupted
# or overlapped there. Later calls run git directly.
as_maya 'mkdir -p ~/slowgit && printf "#!/bin/sh\nat=\$(cat /tmp/slowgit.at 2>/dev/null)\nfor a in \"\$@\"; do if [ \"\$a\" = \"\$at\" ] && [ ! -e /tmp/slowgit.reached ]; then /usr/bin/git \"\$@\"; s=\$?; touch /tmp/slowgit.reached; if [ -e /tmp/slowgit.hold ]; then while [ -e /tmp/slowgit.hold ]; do sleep 1; done; exit \$s; fi; sleep 60; exit 1; fi; done\nexec /usr/bin/git \"\$@\"\n" >~/slowgit/git && chmod +x ~/slowgit/git'
# paused_run LOG STEP WHILE: an installer run as maya that git pauses at STEP; the shell commands WHILE run (as maya)
# during the pause; then the run goes on. LOG gets "while-exit N", "run-exit N", then both outputs.
paused_run() {
  run_log "$1" "rm -f /tmp/slowgit.reached; touch /tmp/slowgit.hold; echo $2 >/tmp/slowgit.at
PATH=\"\$HOME/slowgit:\$PATH\" sh -s -- --name maya --tools none </srv/install.sh >/tmp/paused.out 2>&1 & p=\$!
i=0; until [ -e /tmp/slowgit.reached ]; do i=\$((i+1)); [ \$i -le 120 ] || exit 9; sleep 1; done
( $3 ) >/tmp/while.out 2>&1; echo \"while-exit \$?\"
rm -f /tmp/slowgit.hold /tmp/slowgit.at; wait \$p; echo \"run-exit \$?\"
echo '--- while'; cat /tmp/while.out; echo '--- run'; cat /tmp/paused.out" || true
}

echo "== first run: --name maya, while a second first install (another AGENT_HUB_DIR) starts: that one stops at the lock"
rc=0; run_log first "rm -f /tmp/slowgit.reached; touch /tmp/slowgit.hold; echo clone >/tmp/slowgit.at
PATH=\"\$HOME/slowgit:\$PATH\" sh -s -- --name maya </srv/install.sh >/tmp/first.out 2>&1 & p=\$!
i=0; until [ -e /tmp/slowgit.reached ]; do i=\$((i+1)); [ \$i -le 300 ] || exit 9; sleep 1; done
AGENT_HUB_DIR=/home/maya/other-hub sh -s -- --name maya </srv/install.sh >/tmp/other.out 2>&1; echo \"other-exit \$?\"
if [ -e /home/maya/other-hub ]; then echo other-hub-made; fi
rm -f /tmp/slowgit.hold /tmp/slowgit.at; wait \$p; s=\$?
echo '--- other'; cat /tmp/other.out; echo '--- first'; cat /tmp/first.out; exit \$s" || rc=$?
check "first run exits 0" [ "$rc" -eq 0 ]
check "the other first install exits 1 at the lock" sh -c "grep -qx 'other-exit 1' '$TMP/first.log' && grep -q 'another run of this installer (pid [0-9]*) holds .*/install.lock' '$TMP/first.log'"
check "and made nothing at its AGENT_HUB_DIR" sh -c "! grep -qx other-hub-made '$TMP/first.log'"
check "installed Bun" has first "Bun is missing: installing Bun"
check "bun is at ~/.bun/bin/bun" as_maya '"$HOME/.bun/bin/bun" --version >/dev/null'
check "cloned v1.0.0 into a path with a space and &" as_maya '[ "$(git -C "$AGENT_HUB_DIR" rev-parse HEAD)" = "$(git -C /srv/agent-hub.git rev-parse "v1.0.0^{commit}")" ]'
check "built the website" as_maya '[ -f "$AGENT_HUB_DIR/packages/server/public/app.js" ]'
check "installed agent-bus" as_maya '[ -x ~/.local/bin/agent-bus ]'
check "Hub answers /api/health" healthy
check "printed the Allow step" grep -q '^ALLOW THIS MACHINE: .*click Allow only when they match' "$TMP/first.log"
check "the sign-in link is at http://localhost:7800" grep -q '^SIGN-IN LINK: http://localhost:7800/auth#invite=' "$TMP/first.log"
check "the sign-in link is one the Hub accepts for maya" link_works first maya
check "told to put ~/.local/bin on PATH" has first 'export PATH="$HOME/.local/bin:$PATH"'
check "uninstall steps keep the checkout and data for the person to delete" lacks first "rm -rf '$CHECKOUT'"
if [ "$MODE" = systemd ]; then
  check "runs as the user unit" as_maya 'systemctl --user is-active --quiet agent-hub.service'
else
  check "runs under nohup with a pid file" as_maya 'kill -0 "$(cat ~/.local/state/agent-hub/hub.pid)"'
fi


echo "== a second run while the first holds the lock (paused at its first git command after taking it): it refuses"
paused_run lockpause rev-parse 'sh -s -- --name maya --tools none </srv/install.sh'
check "the second run exits 1" grep -qx 'while-exit 1' "$TMP/lockpause.log"
check "saying another run of this installer holds the lock" grep -q 'another run of this installer (pid [0-9]*) holds .*/install.lock' "$TMP/lockpause.log"
check "the first run then finishes (exit 0)" grep -qx 'run-exit 0' "$TMP/lockpause.log"
check "and lets go of the lock" as_maya 'l=~/.local/state/agent-hub/install.lock; [ ! -e "$l" ] && [ ! -L "$l" ]'

echo "== a directory at the lock's path (left by something else): refused, nothing linked inside it"
as_maya 'mkdir ~/.local/state/agent-hub/install.lock'
rc=0; install_run lockdir "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "says the lock is held" has lockdir "holds /home/maya/.local/state/agent-hub/install.lock"
check "the directory is still there, empty" as_maya '[ -d ~/.local/state/agent-hub/install.lock ] && [ -z "$(ls -A ~/.local/state/agent-hub/install.lock)" ]'
as_maya 'rmdir ~/.local/state/agent-hub/install.lock'

echo "== second run: the same command, over SSH"
if [ "$MODE" = nohup ]; then as_maya 'rm ~/.local/state/agent-hub/stop-hub.sh'; fi
SSH_CONN="10.9.8.7 50022 10.1.2.3 2222"
rc=0; install_run second "--name maya" || rc=$?
SSH_CONN=""
check "second run exits 0" [ "$rc" -eq 0 ]
check "reused the running Hub" has second "The Hub already runs v1.0.0 on 127.0.0.1:7800: nothing to start"
check "did not rebuild" has second "Already built (v1.0.0)"
check "did not install Bun again" lacks second "installing Bun"
check "printed a new sign-in link the Hub accepts" link_works second maya
if [ "$MODE" = nohup ]; then
  check "reusing the nohup Hub, it wrote the stop command it prints" sh -c "grep -qF \"Stop: sh '/home/maya/.local/state/agent-hub/stop-hub.sh'\" '$TMP/second.log' && docker exec '$NAME' test -f /home/maya/.local/state/agent-hub/stop-hub.sh"
  # A saved checkout that is empty must not stand for the folder the stop command runs in.
  rc=0; run_log emptycheckout 'd=$(mktemp -d) && cp ~/.local/state/agent-hub/stop-hub.sh ~/.local/state/agent-hub/hub.pid ~/.local/state/agent-hub/bun "$d"/ && : >"$d/checkout" && cd "$CHECKOUT" && sh "$d/stop-hub.sh"' || rc=$?
  check "the stop command with an empty saved checkout refuses" sh -c '[ "$1" -eq 1 ]' _ "$rc"
  check "saying the checkout is not named" has emptycheckout "does not name an existing checkout; nothing signalled"
  check "and the Hub still answers" healthy
fi
check "OVER SSH names the connection's address and port, and local port 7800" grep -q '^OVER SSH: .*ssh -p 2222 -L 7800:127.0.0.1:7800 maya@10.1.2.3 .*localhost:7800' "$TMP/second.log"
if [ "$MODE" = systemd ] && [ "$(as_maya 'loginctl show-user maya -p Linger' 2>/dev/null)" = "Linger=no" ]; then
  check "KEEP RUNNING: lingering is off, so it says how to keep the Hub after logout" grep -qx 'KEEP RUNNING: you are on SSH; the Hub stops when you log out unless you run: loginctl enable-linger maya' "$TMP/second.log"
else
  check "no KEEP RUNNING line (not a systemd user service, or lingering is on)" lacks second "KEEP RUNNING:"
fi

echo "== another name: --name leo"
rc=0; install_run leo "--name leo" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "prints no sign-in link" lacks leo "SIGN-IN LINK"
check "says who the Hub signs in and how to add leo" has leo "signs in only: maya"
check "Hub still answers" healthy

echo "== with a terminal, as curl | sh in a terminal: asks the name and whether to connect qwen (answers: Maya, n)"
as_maya 'mkdir -p ~/bin && printf "#!/bin/sh\necho qwen 0.28.0\n" > ~/bin/qwen && chmod +x ~/bin/qwen'
# script(1) gives the run a terminal; stdin is still the script itself, so the answers come through /dev/tty.
check "terminal run exits 0" run_log tty 'printf "Maya\nn\n" | PATH=$HOME/bin:$PATH script -qec "sh </srv/install.sh" /dev/null'
check "asked the name" has tty "Your name on the Hub"
check "asked about the tools found" has tty "Connect qwen to the Hub now? [y/N]"
check "after n, printed the command instead" has tty "install qwen --url http://127.0.0.1:7800"
check "after n, connected nothing" as_maya '[ ! -e ~/.qwen/settings.json ]'

echo "== coding-agent form: --name maya --tools auto, with the qwen and a grok on PATH"
as_maya 'printf "#!/bin/sh\necho grok 1.0.45\n" > ~/bin/grok && chmod +x ~/bin/grok'
check "agent run exits 0" run_log agent 'PATH=$HOME/bin:$PATH sh -s -- --name maya --tools auto </srv/install.sh'
check "connected qwen through 127.0.0.1" has agent "Connecting qwen: agent-bus install qwen --url http://127.0.0.1:7800"
check "qwen's settings name the Hub" as_maya 'grep -q "http://127.0.0.1:7800" ~/.qwen/settings.json'
check "qwen's adapter runs a lasting runtime, not bun's temp node shim" as_maya '! grep -q bun-node- ~/.qwen/settings.json'
check "printed NEXT FOR qwen" grep -q '^NEXT FOR qwen: ' "$TMP/agent.log"
check "uninstall steps remove the qwen adapter" has agent "uninstall qwen"
check "connected grok without changing its leader mode" has agent "Connecting grok: agent-bus install grok --url http://127.0.0.1:7800 --no-leader"
check "printed NEXT FOR grok" grep -q '^NEXT FOR grok: ' "$TMP/agent.log"
check "left Grok's leader mode alone (no use_leader in its config)" as_maya '[ -f ~/.grok/config.toml ] && ! grep -q use_leader ~/.grok/config.toml'
run_log doctor '"$HOME/.local/bin/agent-bus" doctor' || true
check "agent-bus doctor reaches the Hub" grep -Eiq '(bus|hub) http://127\.0\.0\.1:7800: (reachable|this machine is not allowed)' "$TMP/doctor.log"

echo "== with a terminal, connecting the tools found and answering y to Grok's leader-mode question"
check "terminal run exits 0" run_log ttyleader 'printf "y\ny\n" | PATH=$HOME/bin:$PATH script -qec "sh -s -- --name maya </srv/install.sh" /dev/null'
check "connected grok asking the person (no --no-leader)" grep -qE '^==> Connecting grok: agent-bus install grok --url http://127\.0\.0\.1:7800.?$' "$TMP/ttyleader.log"
check "turned on Grok's leader mode as answered" as_maya 'grep -q "use_leader = true" ~/.grok/config.toml'

echo "== a tool that fails to connect: --tools claude, with a claude that fails"
as_maya 'mkdir -p ~/bin2 && printf "#!/bin/sh\necho claude broke >&2\nexit 1\n" > ~/bin2/claude && chmod +x ~/bin2/claude'
SSH_CONN="10.9.8.7 50022 10.1.2.3 22"
rc=0; run_log failing 'PATH=$HOME/bin2:$PATH sh -s -- --name maya --tools claude </srv/install.sh' || rc=$?
SSH_CONN=""
check "OVER SSH on port 22 has no -p" grep -q '^OVER SSH: .*ssh -L 7800:127.0.0.1:7800 maya@10.1.2.3 ' "$TMP/failing.log"
check "exits 1" [ "$rc" -eq 1 ]
check "printed TOOL FAILED with the retry command" grep -q '^TOOL FAILED: claude .*Retry: .*install claude --url http://127.0.0.1:7800' "$TMP/failing.log"
check "still printed a sign-in link the Hub accepts" link_works failing maya

echo "== the Hub stopped, then the installer again"
stop_hub
rc=0; healthy || rc=1
check "Hub is down" [ "$rc" -eq 1 ]
check "restart run exits 0" install_run restart "--name maya --tools none"
check "Hub answers again" healthy
if [ "$MODE" = systemd ]; then check "kept the existing unit" has restart "Starting the Hub with its systemd user service"; fi

echo "== the Hub stopped and its data directory moved away: the installer does not start it on a new, empty database"
stop_hub
as_maya 'mv ~/.agent-bus ~/.agent-bus.away'
rc=0; install_run nodata "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "says the database is missing and that it does not start on an empty one" has nodata "Not starting the Hub on a new, empty database"
rc=0; healthy || rc=1
check "the port stays closed" [ "$rc" -eq 1 ]
check "and no new database (or data directory) appeared" as_maya '[ ! -e ~/.agent-bus ]'
echo "== the data directory an empty folder (an unmounted volume): a direct start of the service, or the documented start, creates nothing"
as_maya 'mkdir ~/.agent-bus'
if [ "$MODE" = systemd ]; then
  as_maya 'systemctl --user start agent-hub.service; sleep 4'
else
  run_log emptydata-start 'sh /srv/doc-nohup-start.sh' || true
  check "the documented start does not say STARTED" lacks emptydata-start "STARTED"
fi
rc=0; healthy || rc=1
check "the port stays closed" [ "$rc" -eq 1 ]
check "and no database appeared" as_maya '[ ! -e ~/.agent-bus/message-bus.sqlite ]'
if [ "$MODE" = systemd ]; then as_maya 'systemctl --user stop agent-hub.service; systemctl --user reset-failed agent-hub.service 2>/dev/null || true'; fi
as_maya 'rmdir ~/.agent-bus && mv ~/.agent-bus.away ~/.agent-bus'
check "with the data back, the installer starts it" install_run nodata-back "--name maya --tools none"
echo "== the same release, the Hub stopped, its database a zero-byte file and no first install pending: refused, the file left as it is"
stop_hub
as_maya 'mkdir ~/db.keep && for f in message-bus.sqlite message-bus.sqlite-wal message-bus.sqlite-shm; do if [ -e ~/.agent-bus/$f ]; then mv ~/.agent-bus/$f ~/db.keep/; fi; done && : >~/.agent-bus/message-bus.sqlite'
rc=0; install_run zerodb "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "says it is not a Hub database" has zerodb "message-bus.sqlite is not a Hub database (no messages and participants tables)"
check "the file is still zero bytes, with nothing beside it" as_maya '[ -f ~/.agent-bus/message-bus.sqlite ] && [ ! -s ~/.agent-bus/message-bus.sqlite ] && [ ! -e ~/.agent-bus/message-bus.sqlite-wal ] && [ ! -e ~/.agent-bus/message-bus.sqlite-shm ]'
rc=0; healthy || rc=1
check "started nothing" [ "$rc" -eq 1 ]
as_maya 'rm ~/.agent-bus/message-bus.sqlite && mv ~/db.keep/* ~/.agent-bus/ && rmdir ~/db.keep'
check "with the database back, the installer starts it" install_run zerodb-back "--name maya --tools none"
check "Hub answers again" healthy

echo "== this Hub stopped, another Hub (other data) answering on 7800: refused up front, this Hub's stopped database not written"
stop_hub
check "the stopped database has no -wal or -shm" as_maya '[ ! -e ~/.agent-bus/message-bus.sqlite-wal ] && [ ! -e ~/.agent-bus/message-bus.sqlite-shm ]'
db_sum=$(as_maya 'cksum <~/.agent-bus/message-bus.sqlite')
as_maya 'mkdir -p /tmp/other-hub-data && cd "$CHECKOUT" && (setsid nohup "$HOME/.bun/bin/bun" run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 --humans maya --data-dir /tmp/other-hub-data >/tmp/other-hub.log 2>&1 </dev/null &) && i=0 && until curl -fsS http://127.0.0.1:7800/api/health >/dev/null 2>&1; do i=$((i+1)); [ $i -le 30 ] || exit 1; sleep 1; done'
rc=0; install_run otherhub "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "says port 7800 is used by another Hub" has otherhub "port 7800 is used by another Hub (not this installation's); stop it, then run this again. Nothing was changed."
check "refused before Bun, the fetch and the invite" sh -c "! grep -qE 'Checking for git, curl and Bun|Updating the Agent Hub checkout|Making a one-time sign-in link' '$TMP/otherhub.log'"
check "this Hub's stopped database is byte-identical, with no -wal or -shm" sh -c "[ \"\$(docker exec -u maya '$NAME' sh -c 'cksum <~/.agent-bus/message-bus.sqlite')\" = '$db_sum' ] && docker exec -u maya '$NAME' sh -c '[ ! -e ~/.agent-bus/message-bus.sqlite-wal ] && [ ! -e ~/.agent-bus/message-bus.sqlite-shm ]'"
as_maya 'pkill -f "[b]un run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 --humans maya --data-dir /tmp/other-hub-data"; sleep 2; rm -rf /tmp/other-hub-data'
start_hub
check "this Hub answers again" healthy

if [ "$MODE" = systemd ]; then
  echo "== the unit unchanged and stopped, a second valid database, the saved data-dir pointing at it: refused before the start"
  stop_hub
  as_maya 'cp -a ~/.agent-bus ~/.agent-bus-b && cp ~/.local/state/agent-hub/data-dir ~/data-dir.keep && echo /home/maya/.agent-bus-b >~/.local/state/agent-hub/data-dir'
  backups=$(as_maya 'ls -d ~/agent-bus-backup-* 2>/dev/null | wc -l')
  rc=0; install_run twodb "--name maya --tools none" || rc=$?
  check "exits 1" [ "$rc" -eq 1 ]
  check "says the unit does not start the Hub with the saved --data-dir" sh -c "grep -q 'agent-hub.service does not start the Hub with the saved arguments (--humans .* --data-dir /home/maya/.agent-bus-b' '$TMP/twodb.log'"
  check "refused before Bun and the fetch" lacks twodb "Checking for git, curl and Bun"
  rc=0; healthy || rc=1
  check "started nothing" [ "$rc" -eq 1 ]
  check "took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* 2>/dev/null | wc -l')" = "$backups" ]
  check "left the unit as it was" as_maya 'cmp -s ~/.config/systemd/user/agent-hub.service ~/.local/state/agent-hub/agent-hub.service.written'
  as_maya 'mv ~/data-dir.keep ~/.local/state/agent-hub/data-dir && rm -rf ~/.agent-bus-b'
  start_hub
  check "with the saved data-dir back, the Hub starts" healthy
  echo "== the unit stopped, the same release, and a drop-in that starts it on a second database: refused before the start"
  stop_hub
  as_maya 'cp -a ~/.agent-bus ~/.agent-bus-b && mkdir -p ~/.config/systemd/user/agent-hub.service.d && { printf "[Service]\nExecStart=\n"; grep "^ExecStart=" ~/.config/systemd/user/agent-hub.service | sed "s#/home/maya/.agent-bus\"#/home/maya/.agent-bus-b\"#"; } >~/.config/systemd/user/agent-hub.service.d/data.conf && systemctl --user daemon-reload'
  rc=0; install_run dropindb "--name maya --tools none" || rc=$?
  check "exits 1" [ "$rc" -eq 1 ]
  check "says a drop-in changes the service" has dropindb "drop-ins change it"
  check "refused before Bun and the fetch" lacks dropindb "Checking for git, curl and Bun"
  rc=0; healthy || rc=1
  check "started nothing" [ "$rc" -eq 1 ]
  as_maya 'rm -rf ~/.config/systemd/user/agent-hub.service.d ~/.agent-bus-b && systemctl --user daemon-reload'
  start_hub
  check "without the drop-in, the Hub starts" healthy
fi

echo "== a person added to the Hub (in the saved humans) named like an existing agent, or an agent's old name: refused before any stop"
as_maya '"$HOME/.bun/bin/bun" /srv/smoke-db.ts agent robo "$HOME/.agent-bus/message-bus.sqlite" && "$HOME/.bun/bin/bun" /srv/smoke-db.ts alias oldbot:robo "$HOME/.agent-bus/message-bus.sqlite"'
as_maya 'cp ~/.local/state/agent-hub/humans ~/humans.keep'
backups=$(as_maya 'ls -d ~/agent-bus-backup-* 2>/dev/null | wc -l')
for who in robo oldbot; do
  as_maya "printf '%s,$who\n' \"\$(cat ~/humans.keep)\" >~/.local/state/agent-hub/humans"
  rc=0; install_run "humanagent-$who" "--name maya --tools none" || rc=$?
  check "$who: exits 1" [ "$rc" -eq 1 ]
  check "$who: the Hub still answers (nothing was stopped)" healthy
  check "$who: took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* 2>/dev/null | wc -l')" = "$backups" ]
done
check "robo: says it is an agent on this Hub" has humanagent-robo "\"robo\" is an agent on this Hub and cannot also be a person's name"
check "oldbot: says it is the old name of agent robo" has humanagent-oldbot "\"oldbot\" is the old name of agent \"robo\" on this Hub and cannot also be a person's name"
echo "== the saved humans \"maya, Robo\" (read as the server reads them: robo) and \"maya,system\": both refused before any stop"
for entry in ' Robo:robo-spaced' 'system:system-second'; do
  as_maya "printf '%s,%s\n' \"\$(cat ~/humans.keep)\" '${entry%%:*}' >~/.local/state/agent-hub/humans"
  rc=0; install_run "humanagent-${entry#*:}" "--name maya --tools none" || rc=$?
  check "${entry#*:}: exits 1" [ "$rc" -eq 1 ]
  check "${entry#*:}: the Hub still answers (nothing was stopped)" healthy
done
check "robo-spaced: says robo is an agent on this Hub" has humanagent-robo-spaced "\"robo\" is an agent on this Hub and cannot also be a person's name"
check "system-second: says system is the Hub's own agent" has humanagent-system-second "\"system\" is the Hub's own agent and cannot be a person's name"
as_maya 'mv ~/humans.keep ~/.local/state/agent-hub/humans && "$HOME/.bun/bin/bun" /srv/smoke-db.ts unagent robo "$HOME/.agent-bus/message-bus.sqlite"'

# remove_service: the Hub stopped and its service removed, the documented way to change who signs in.
remove_service() {
  if [ "$MODE" = systemd ]; then
    as_maya 'systemctl --user disable --now agent-hub.service >/dev/null 2>&1; rm -f ~/.config/systemd/user/agent-hub.service; systemctl --user daemon-reload'
  else
    stop_hub
  fi
}
echo "== a person added the documented way (saved humans \"maya, Leo\", the service removed): --name leo is accepted"
remove_service
as_maya 'cp ~/.local/state/agent-hub/humans ~/humans.keep && printf "maya, Leo,İpek\n" >~/.local/state/agent-hub/humans'
rc=0; install_run addleo "--name leo --tools none" || rc=$?
check "exits 0" [ "$rc" -eq 0 ]
check "the sign-in link is one the Hub accepts for leo" link_works addleo leo
echo "== the same saved humans: --name i-pek (\"İpek\" as the server makes it an id) is accepted too"
rc=0; install_run addipek "--name i-pek --tools none" || rc=$?
check "exits 0" [ "$rc" -eq 0 ]
check "the sign-in link is one the Hub accepts for i-pek" link_works addipek i-pek
remove_service
as_maya 'mv ~/humans.keep ~/.local/state/agent-hub/humans'
check "back to maya alone, the installer starts it again" install_run addleo-back "--name maya --tools none"

echo "== the database lost after the run's checks (paused at its fetch, the data directory replaced by an empty one): nothing is created"
stop_hub
paused_run lostdb fetch 'mv ~/.agent-bus ~/.agent-bus.away && mkdir ~/.agent-bus'
check "the run exits 1" grep -qx 'run-exit 1' "$TMP/lostdb.log"
check "saying it does not start on a new, empty database" grep -q 'Not starting the Hub on a new, empty database' "$TMP/lostdb.log"
check "the empty data directory stays empty" as_maya '[ -z "$(ls -A ~/.agent-bus)" ]'
rc=0; healthy || rc=1
check "and the port stays closed" [ "$rc" -eq 1 ]
as_maya 'rmdir ~/.agent-bus && mv ~/.agent-bus.away ~/.agent-bus'
check "with the data back, the installer starts it" install_run lostdb-back "--name maya --tools none"

echo "== the Hub stopped, then the installer from a shell whose AGENT_BUS_DATA_DIR names another database"
stop_hub
as_maya 'cp -r ~/.agent-bus ~/other-data'
DATA_ENV=/home/maya/other-data
rc=0; install_run otherenv "--name maya --tools none" || rc=$?
DATA_ENV=""
check "exits 0" [ "$rc" -eq 0 ]
check "the Hub was started on its own data (--data-dir /home/maya/.agent-bus)" as_maya 'tr "\0" "\n" <"/proc/$(pgrep -f "[b]in.ts serve" | head -n 1)/cmdline" | grep -qx /home/maya/.agent-bus'
check "the sign-in link works (its invite is in that database)" link_works otherenv maya

echo "== --public-url https://hub.tailnet.ts.net/ given to the same release: the service is rewritten and the Hub restarted"
PUB=https://hub.tailnet.ts.net
public_runs() { # the running Hub's arguments end with --public-url $1, and /api/auth/state lists it
  as_maya "p=\$(pgrep -f '[b]in.ts serve' | head -n 1) && [ \"\$(tr '\\0' '\\n' </proc/\$p/cmdline | tail -n 2 | tr '\\n' ' ')\" = '--public-url $1 ' ]" &&
    as_maya 'curl -fsS http://127.0.0.1:7800/api/auth/state' | grep -qF "\"publicUrls\":[\"$1\"]"
}
echo "== --public-url with a compressed IPv6 address: accepted"
rc=0; install_run pub6 "--name maya --tools none --public-url 'https://[2001:db8::1]'" || rc=$?
check "exits 0" [ "$rc" -eq 0 ]
check "the Hub runs with --public-url https://[2001:db8::1]" as_maya "p=\$(pgrep -f '[b]in.ts serve' | head -n 1) && [ \"\$(tr '\\0' '\\n' </proc/\$p/cmdline | tail -n 2 | tr '\\n' ' ')\" = '--public-url https://[2001:db8::1] ' ]"
check "saved it" as_maya '[ "$(cat ~/.local/state/agent-hub/public-url)" = "https://[2001:db8::1]" ]'
if [ "$MODE" = systemd ]; then
  echo "== a new public address, the run killed between replacing the unit and saving its .written copy: the same command finishes it"
  as_maya 'mkdir -p ~/slowcp && printf "#!/bin/sh\nfor last in \"\$@\"; do :; done\ncase \"\$last\" in *agent-hub.service.written.tmp) touch /tmp/slowcp.reached; sleep 120 ;; esac\nexec /bin/cp \"\$@\"\n" >~/slowcp/cp && chmod +x ~/slowcp/cp && rm -f /tmp/slowcp.reached'
  rc=0; run_log unitint "PATH=\"\$HOME/slowcp:\$PATH\" setsid sh -s -- --name maya --tools none --public-url https://pubint.example </srv/install.sh >/tmp/unitint.out 2>&1 & p=\$!; i=0; until [ -e /tmp/slowcp.reached ]; do i=\$((i+1)); [ \$i -le 1200 ] || exit 9; sleep 0.1; done; /bin/kill -s KILL -- \"-\$p\"; wait \"\$p\"; s=\$?; cat /tmp/unitint.out; exit \"\$s\"" || rc=$?
  check "the run was killed there (exit 137)" [ "$rc" -eq 137 ]
  check "the live unit is the new one, its .written copy not yet" as_maya 'grep -qF "\"--public-url\" \"https://pubint.example\"" ~/.config/systemd/user/agent-hub.service && ! cmp -s ~/.config/systemd/user/agent-hub.service ~/.local/state/agent-hub/agent-hub.service.written'
  as_maya 'touch -h -d "-11 min" ~/.local/state/agent-hub/install.lock'
  rc=0; install_run unitint-again "--name maya --tools none --public-url https://pubint.example" || rc=$?
  check "the same command exits 0" [ "$rc" -eq 0 ]
  check "it finished the unit's publication" has unitint-again "Finished writing"
  check "the Hub runs with --public-url https://pubint.example" public_runs https://pubint.example
  check "the unit is again the file the installer wrote" as_maya 'cmp -s ~/.config/systemd/user/agent-hub.service ~/.local/state/agent-hub/agent-hub.service.written && [ ! -e ~/.local/state/agent-hub/agent-hub.service.publishing ]'
  echo "== another new public address, the run killed after the .written copy and before systemd's reload: the same command finishes it"
  as_maya 'mkdir -p ~/slowsd && printf "#!/bin/sh\nfor a in \"\$@\"; do if [ \"\$a\" = daemon-reload ] && [ ! -e /tmp/slowsd.reached ]; then touch /tmp/slowsd.reached; sleep 120; fi; done\nexec /usr/bin/systemctl \"\$@\"\n" >~/slowsd/systemctl && chmod +x ~/slowsd/systemctl && rm -f /tmp/slowsd.reached'
  rc=0; run_log unitint2 "PATH=\"\$HOME/slowsd:\$PATH\" setsid sh -s -- --name maya --tools none --public-url https://pubint2.example </srv/install.sh >/tmp/unitint2.out 2>&1 & p=\$!; i=0; until [ -e /tmp/slowsd.reached ]; do i=\$((i+1)); [ \$i -le 1200 ] || exit 9; sleep 0.1; done; /bin/kill -s KILL -- \"-\$p\"; wait \"\$p\"; s=\$?; cat /tmp/unitint2.out; exit \"\$s\"" || rc=$?
  check "the run was killed there (exit 137)" [ "$rc" -eq 137 ]
  check "the unit and its .written copy are the new ones, the publication record still there" as_maya 'grep -qF "\"--public-url\" \"https://pubint2.example\"" ~/.config/systemd/user/agent-hub.service && cmp -s ~/.config/systemd/user/agent-hub.service ~/.local/state/agent-hub/agent-hub.service.written && [ -e ~/.local/state/agent-hub/agent-hub.service.publishing ]'
  as_maya 'touch -h -d "-11 min" ~/.local/state/agent-hub/install.lock'
  rc=0; install_run unitint2-again "--name maya --tools none --public-url https://pubint2.example" || rc=$?
  check "the same command exits 0" [ "$rc" -eq 0 ]
  check "it finished the unit's publication" has unitint2-again "Finished writing"
  check "the Hub runs with --public-url https://pubint2.example" public_runs https://pubint2.example
  check "no publication record is left" as_maya '[ ! -e ~/.local/state/agent-hub/agent-hub.service.publishing ] && [ ! -e ~/.local/state/agent-hub/agent-hub.service.staged ]'
fi
rc=0; install_run pubset "--name maya --tools none --public-url $PUB/" || rc=$?
check "exits 0" [ "$rc" -eq 0 ]
check "says it rewrites the service and restarts the Hub" has pubset "Changing the Hub's public address to $PUB"
check "the Hub runs with --public-url $PUB (trailing slash dropped) and lists it" public_runs "$PUB"
check "saved it" as_maya "[ \"\$(cat ~/.local/state/agent-hub/public-url)\" = '$PUB' ]"
if [ "$MODE" = systemd ]; then
  check "the unit has it, and is the file the installer wrote" as_maya "grep -qF '\"--public-url\" \"$PUB\"' ~/.config/systemd/user/agent-hub.service && cmp -s ~/.config/systemd/user/agent-hub.service ~/.local/state/agent-hub/agent-hub.service.written"
  check "the unit it replaced is kept" as_maya 'ls ~/.local/state/agent-hub/agent-hub.service.before-* >/dev/null'
fi
check "the sign-in link still works" link_works pubset maya

echo "== upgrade of the running Hub: the installer of v1.0.1"
check "before: the running server reports v1.0.0's version" version_is 2.0.0
as_maya '"$HOME/.bun/bin/bun" /srv/smoke-db.ts mark m1 "$HOME/.agent-bus/message-bus.sqlite"'
# A local tag of the person's own, named like a release: fetching must not replace it.
as_maya 'git -C "$CHECKOUT" tag -f v1.0.3 v1.0.0 >/dev/null'
refs_before=$(as_maya 'git -C "$CHECKOUT" show-ref --tags')
REF=v1.0.1
rc=0; install_run upgrade1 "--name maya --tools none" || rc=$?
check "upgrade run exits 0" [ "$rc" -eq 0 ]
check "said it upgrades" has upgrade1 "Upgrading this machine's Hub to v1.0.1"
check "backed up before checking out v1.0.1" [ "$(line_of upgrade1 "Backed up the Hub's data")" -lt "$(line_of upgrade1 "Now at v1.0.1")" ]
check "built v1.0.1 after the backup" as_maya '[ -n "$(find "$AGENT_HUB_DIR/packages/server/public/.installed-commit" -newer "$(ls -d ~/agent-bus-backup-* | tail -n 1)/hub.tar")" ]'
check "the backup holds the database from before (marker m1, not opened by v1.0.1)" [ "$(backup_show)" = "smoke_marker m1" ]
check "the live database was then opened by v1.0.1" [ "$(db_show '"$HOME/.agent-bus/message-bus.sqlite"')" = "smoke_marker,smoke_v101 m1" ]
check "the running server reports v1.0.1's version" version_is 2.0.0-smoke1
check "the sign-in link still works after the upgrade" link_works upgrade1 maya
if [ "$MODE" = systemd ]; then check "still the user unit" as_maya 'systemctl --user is-active --quiet agent-hub.service'; fi
check "the upgrade kept the public address" public_runs "$PUB"
check "the checkout's own tags were not replaced (v1.0.3 still points at v1.0.0)" [ "$(as_maya 'git -C "$CHECKOUT" show-ref --tags')" = "$refs_before" ]

echo "== the original pinned command (v1.0.0) after the upgrade: an older release is refused"
backups=$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')
REF=v1.0.0
rc=0; install_run downgrade "--name maya --tools none" || rc=$?
REF=v1.0.1
check "exits 1" [ "$rc" -eq 1 ]
check "says v1.0.0 does not follow the installed release" has downgrade "v1.0.0 does not follow the release this Hub last ran"
check "points to the manual upgrade, and to Restore then Rollback" sh -c "grep -q 'operations.md#upgrade, or to go back, #restore then #rollback' '$TMP/downgrade.log'"
check "took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')" = "$backups" ]
check "left the checkout at v1.0.1" as_maya '[ "$(git -C "$CHECKOUT" rev-parse HEAD)" = "$(git -C /srv/agent-hub.git rev-parse "v1.0.1^{commit}")" ]'
check "the Hub still runs v1.0.1" version_is 2.0.0-smoke1

echo "== a release on another line (v1.0.1-side, a sibling of v1.0.1): refused"
REF=v1.0.1-side
rc=0; install_run sideways "--name maya --tools none" || rc=$?
REF=v1.0.1
check "exits 1" [ "$rc" -eq 1 ]
check "says it does not follow the installed release" has sideways "v1.0.1-side does not follow the release this Hub last ran"
check "took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')" = "$backups" ]
check "left the checkout at v1.0.1" as_maya '[ "$(git -C "$CHECKOUT" rev-parse HEAD)" = "$(git -C /srv/agent-hub.git rev-parse "v1.0.1^{commit}")" ]'
check "the Hub still runs v1.0.1" version_is 2.0.0-smoke1

echo "== the checkout already at the older v1.0.0 (by hand), the installer of v1.0.0: refused, the data last ran v1.0.1"
as_maya 'git -C "$CHECKOUT" -c advice.detachedHead=false checkout -q --detach v1.0.0'
REF=v1.0.0
rc=0; install_run oldcheckout "--name maya --tools none" || rc=$?
REF=v1.0.1
check "exits 1" [ "$rc" -eq 1 ]
check "says v1.0.0 does not follow the release the Hub last ran" has oldcheckout "v1.0.0 does not follow the release this Hub last ran"
check "did not stop the Hub (it still runs v1.0.1)" version_is 2.0.0-smoke1
check "took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')" = "$backups" ]
v101=$(as_maya 'git -C /srv/agent-hub.git rev-parse "v1.0.1^{commit}"')
echo "== the same older checkout, and a forward upgrade (v1.0.5) whose build fails: the way back is v1.0.1, which ran"
REF=v1.0.5
rc=0; install_run oldcheckout-fail "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "the build failed" has oldcheckout-fail "bun run build failed"
check "the printed way back is v1.0.1 (what ran), not the checkout's v1.0.0" has oldcheckout-fail "AGENT_HUB_REF=$v101 sh -s -- --name maya"
REF="$v101"
rc=0; install_run oldcheckout-back "--name maya --tools none" || rc=$?
REF=v1.0.1
check "the printed way back exits 0" [ "$rc" -eq 0 ]
check "and runs v1.0.1 again" version_is 2.0.0-smoke1
check "from a checkout at v1.0.1" as_maya "[ \"\$(git -C \"\$CHECKOUT\" rev-parse HEAD)\" = '$v101' ]"
backups=$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')

echo "== the checkout gone (moved away) while its Hub still runs: refused before the clone, the Hub left running"
as_maya 'mv "$CHECKOUT" "$CHECKOUT.aside"'
REF=v1.0.1
rc=0; install_run gonerunning "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "did not clone" lacks gonerunning "Downloading Agent Hub"
check "the checkout path is still absent" as_maya '[ ! -e "$CHECKOUT" ]'
check "the Hub still runs v1.0.1" version_is 2.0.0-smoke1
as_maya 'mv "$CHECKOUT.aside" "$CHECKOUT"'

echo "== the checkout gone (moved away), the Hub stopped, the installer of v1.0.0 clones it again: refused, the data last ran v1.0.1"
stop_hub
as_maya 'mv "$CHECKOUT" "$CHECKOUT.aside"'
REF=v1.0.0
rc=0; install_run recloned "--name maya --tools none" || rc=$?
REF=v1.0.1
check "exits 1" [ "$rc" -eq 1 ]
check "says v1.0.0 does not follow the release the Hub last ran" has recloned "v1.0.0 does not follow the release this Hub last ran"
check "took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')" = "$backups" ]
check "removed the clone it made (the checkout path is absent again)" as_maya '[ ! -e "$CHECKOUT" ]'
check "and said so" has recloned "(Removed the unfinished clone in"
if [ "$MODE" = systemd ]; then
  echo "== the checkout gone and the unit edited: refused before Bun, the fetch and the clone"
  as_maya 'echo "# edited" >>~/.config/systemd/user/agent-hub.service'
  rc=0; install_run goneedited "--name maya --tools none" || rc=$?
  check "exits 1" [ "$rc" -eq 1 ]
  check "says agent-hub.service was changed after install" has goneedited "agent-hub.service was changed after install"
  check "refused before Bun and the clone" sh -c "! grep -qE 'Checking for git, curl and Bun|Downloading Agent Hub' '$TMP/goneedited.log'"
  check "the checkout path is still absent" as_maya '[ ! -e "$CHECKOUT" ]'
  as_maya 'cp ~/.local/state/agent-hub/agent-hub.service.written ~/.config/systemd/user/agent-hub.service && systemctl --user daemon-reload'
fi
interrupt_at() { # interrupt_at STEP LOG: an installer run, TERM to it once git has done STEP
  as_maya "rm -f /tmp/slowgit.reached && echo $1 >/tmp/slowgit.at"
  rc=0; run_log "$2" 'PATH="$HOME/slowgit:$PATH" setsid sh -s -- --name maya --tools none </srv/install.sh >/tmp/interrupted.out 2>&1 & p=$!; i=0; until [ -e /tmp/slowgit.reached ]; do i=$((i+1)); [ $i -le 120 ] || exit 9; sleep 1; done; /bin/kill -s TERM -- "-$p"; wait "$p"; s=$?; cat /tmp/interrupted.out; exit "$s"' || rc=$?
  check "$2: the run reached git $1 and ended on TERM (exit 143)" [ "$rc" -eq 143 ]
  check "$2: said it removed the unfinished clone" has "$2" "(Removed the unfinished clone"
  check "$2: the checkout path is absent" as_maya '[ ! -e "$CHECKOUT" ]'
  check "$2: no temporary clone folder is left" as_maya '! ls -d "$(dirname "$CHECKOUT")"/.agent-hub-clone.* >/dev/null 2>&1'
  check "$2: and the lock is released" as_maya 'l=~/.local/state/agent-hub/install.lock; [ ! -e "$l" ] && [ ! -L "$l" ]'
}
echo "== runs interrupted (TERM) during the clone, and between the clone and the first checkout: nothing is left"
interrupt_at clone interrupted-clone
interrupt_at checkout interrupted-checkout
as_maya 'rm -f /tmp/slowgit.at'
echo "== two installs of v1.0.1 at once into the missing checkout: the second stops at the lock, the first finishes"
rc=0; run_log race 'touch /tmp/slowgit.hold; echo checkout >/tmp/slowgit.at; rm -f /tmp/slowgit.reached
PATH="$HOME/slowgit:$PATH" setsid sh -s -- --name maya --tools none </srv/install.sh >/tmp/winner.out 2>&1 & p=$!
i=0; until [ -e /tmp/slowgit.reached ]; do i=$((i+1)); [ $i -le 120 ] || exit 9; sleep 1; done
sh -s -- --name maya --tools none </srv/install.sh >/tmp/loser.out 2>&1; echo "loser-exit $?"
if ls -d "$(dirname "$CHECKOUT")"/.agent-hub-clone.* >/dev/null 2>&1; then echo winner-clone-kept; fi
if [ ! -e "$CHECKOUT" ]; then echo checkout-not-yet; fi
rm -f /tmp/slowgit.hold; wait "$p"; echo "winner-exit $?"; rm -f /tmp/slowgit.at
echo "--- loser"; cat /tmp/loser.out; echo "--- winner"; tail -n 5 /tmp/winner.out' || rc=$?
check "the second run exits 1 at the lock" sh -c "grep -qx 'loser-exit 1' '$TMP/race.log' && grep -q 'another run of this installer (pid [0-9]*) holds .*/install.lock' '$TMP/race.log'"
check "it left the first run's clone alone, and made no checkout of its own" sh -c "grep -qx winner-clone-kept '$TMP/race.log' && grep -qx checkout-not-yet '$TMP/race.log'"
check "the first run then finishes (exit 0)" grep -qx 'winner-exit 0' "$TMP/race.log"
check "the Hub runs v1.0.1 again" version_is 2.0.0-smoke1
check "from a new checkout at v1.0.1" as_maya "[ \"\$(git -C \"\$CHECKOUT\" rev-parse HEAD)\" = '$v101' ]"
check "the lock is released" as_maya 'l=~/.local/state/agent-hub/install.lock; [ ! -e "$l" ] && [ ! -L "$l" ]'
as_maya 'rm -rf "$CHECKOUT.aside"'

echo "== files in the data is a link elsewhere: the upgrade to v1.0.2 is refused before the Hub stops"
as_maya 'mkdir -p /tmp/elsewhere && if [ -e ~/.agent-bus/files ]; then mv ~/.agent-bus/files ~/files.keep; fi && ln -s /tmp/elsewhere ~/.agent-bus/files'
REF=v1.0.2
rc=0; install_run linkfiles "--name maya --tools none" || rc=$?
REF=v1.0.1
check "exits 1" [ "$rc" -eq 1 ]
check "says files is a link and what to do" has linkfiles "files in the Hub's data (/home/maya/.agent-bus) is a link to /tmp/elsewhere; a backup would not hold what it points to. Copy it into the data directory"
check "did not stop the Hub (it still runs v1.0.1)" version_is 2.0.0-smoke1
check "took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')" = "$backups" ]
as_maya 'rm ~/.agent-bus/files && if [ -e ~/files.keep ]; then mv ~/files.keep ~/.agent-bus/files; fi'
echo "== finetune in the data is a link (finetune/needs-you behind it): the upgrade to v1.0.2 is refused before the Hub stops"
as_maya 'mkdir -p /tmp/elsewhere-ft && touch /tmp/elsewhere-ft/needs-you && ln -s /tmp/elsewhere-ft ~/.agent-bus/finetune'
REF=v1.0.2
rc=0; install_run linkparent "--name maya --tools none" || rc=$?
REF=v1.0.1
check "exits 1" [ "$rc" -eq 1 ]
check "says finetune is a link" has linkparent "finetune in the Hub's data (/home/maya/.agent-bus) is a link to /tmp/elsewhere-ft"
check "did not stop the Hub (it still runs v1.0.1)" version_is 2.0.0-smoke1
check "took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')" = "$backups" ]
as_maya 'rm ~/.agent-bus/finetune && rm -rf /tmp/elsewhere-ft'
echo "== finetune in the data without search permission (finetune/needs-you behind it): the upgrade to v1.0.2 is refused before the Hub stops"
as_maya 'mkdir -p ~/.agent-bus/finetune && touch ~/.agent-bus/finetune/needs-you && chmod 000 ~/.agent-bus/finetune'
REF=v1.0.2
rc=0; install_run noaccess-ft "--name maya --tools none" || rc=$?
REF=v1.0.1
as_maya 'chmod 755 ~/.agent-bus/finetune && rm -rf ~/.agent-bus/finetune'
check "exits 1" [ "$rc" -eq 1 ]
check "says finetune/needs-you cannot be looked at" has noaccess-ft "finetune/needs-you in the Hub's data (/home/maya/.agent-bus) cannot be looked at"
check "did not stop the Hub (it still runs v1.0.1)" version_is 2.0.0-smoke1
check "took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')" = "$backups" ]
echo "== an attachment the installer cannot read (mode 000): the upgrade to v1.0.2 is refused before the Hub stops"
as_maya 'mkdir -p ~/.agent-bus/files && echo secret >~/.agent-bus/files/locked.txt && chmod 000 ~/.agent-bus/files/locked.txt'
REF=v1.0.2
rc=0; install_run locked-file "--name maya --tools none" || rc=$?
REF=v1.0.1
as_maya 'rm -f ~/.agent-bus/files/locked.txt'
check "exits 1" [ "$rc" -eq 1 ]
check "says files/locked.txt cannot be read" has locked-file "files/locked.txt in the Hub's data cannot be read"
check "the original Hub still answers (v1.0.1)" version_is 2.0.0-smoke1
check "took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')" = "$backups" ]

echo "== an empty Tasks database in the data: the new backup lacks its tables, and the upgrade to v1.0.2 refused"
as_maya 'mkdir -p ~/.agent-bus/task-ext && : >~/.agent-bus/task-ext/tasks.sqlite'
REF=v1.0.2
rc=0; install_run emptytasks "--name maya --tools none" || rc=$?
REF=v1.0.1
check "exits 1" [ "$rc" -eq 1 ]
check "says task-ext/tasks.sqlite lacks its tables" has emptytasks "task-ext/tasks.sqlite lacks the tables tasks, task_history, events"
check "left the checkout at v1.0.1" as_maya '[ "$(git -C "$CHECKOUT" rev-parse HEAD)" = "$(git -C /srv/agent-hub.git rev-parse "v1.0.1^{commit}")" ]'
echo "== the documented Backup with the empty Tasks database: BACKUP FAILED, never Backup written"
rc=0; run_log docbackup-bad 'sh /srv/doc-backup.sh' || rc=$?
check "it prints BACKUP FAILED" has docbackup-bad "BACKUP FAILED"
check "and never Backup written" lacks docbackup-bad "Backup written"
as_maya 'rm -r ~/.agent-bus/task-ext'
echo "== the documented Backup of valid data, then the documented Restore of it: the marker written before it survives"
as_maya '"$HOME/.bun/bin/bun" /srv/smoke-db.ts docmark before-backup "$HOME/.agent-bus/message-bus.sqlite"'
# The documented backup names its folder by the second; the failed one above may hold this second's name.
sleep 1
rc=0; run_log docbackup-ok 'sh /srv/doc-backup.sh' || rc=$?
check "it prints Backup written" has docbackup-ok "Backup written to"
docb=$(sed -n 's/^Backup written to //p' "$TMP/docbackup-ok.log")
as_maya '"$HOME/.bun/bin/bun" /srv/smoke-db.ts docmark after-backup "$HOME/.agent-bus/message-bus.sqlite"'
rc=0; run_log docrestore-own "RESTORE_B='$docb' sh /srv/doc-restore.sh" || rc=$?
check "the documented Restore of it says READY and RESTORED" sh -c "grep -qx READY '$TMP/docrestore-own.log' && grep -q '^RESTORED\.' '$TMP/docrestore-own.log'"
check "the restored database has the marker from before the backup, not the one after" [ "$(as_maya '"$HOME/.bun/bin/bun" /srv/smoke-db.ts docmarks "$HOME/.agent-bus/message-bus.sqlite"')" = "before-backup" ]
rc=0; install_run emptytasks-start "--name maya --tools none" || rc=$?
check "this release's installer again starts the Hub" sh -c '[ "$1" -eq 0 ]' _ "$rc"

echo "== a Tasks database in the data that is damaged: the new backup is checked, and the upgrade to v1.0.2 refused"
as_maya 'mkdir -p ~/.agent-bus/task-ext && printf "this is not a database, but it is long enough to look like one at a glance....." >~/.agent-bus/task-ext/tasks.sqlite'
REF=v1.0.2
rc=0; install_run badtasks "--name maya --tools none" || rc=$?
REF=v1.0.1
check "exits 1" [ "$rc" -eq 1 ]
check "says the backup is not complete: task-ext/tasks.sqlite is damaged" has badtasks "is not complete (task-ext/tasks.sqlite is damaged)"
check "says to follow the steps below to start the Hub as it was" has badtasks "to start the Hub as it was, follow the steps below"
v101=$(as_maya 'git -C /srv/agent-hub.git rev-parse "v1.0.1^{commit}"')
check "and the steps follow: the command for the version that ran before" sh -c "grep -A1 -F 'The Hub is stopped. To run the version that ran before:' '$TMP/badtasks.log' | grep -qF 'AGENT_HUB_REF=$v101 sh -s -- --name maya'"
check "left the checkout at v1.0.1" as_maya '[ "$(git -C "$CHECKOUT" rev-parse HEAD)" = "$(git -C /srv/agent-hub.git rev-parse "v1.0.1^{commit}")" ]'
check "wrote no record of an upgrade in progress" as_maya '[ ! -e ~/.local/state/agent-hub/upgrade-recovery ]'
as_maya 'rm -r ~/.agent-bus/task-ext'
rc=0; install_run badtasks-start "--name maya --tools none" || rc=$?
check "this release's installer again starts the Hub as it was" sh -c '[ "$1" -eq 0 ]' _ "$rc"
check "on v1.0.1" version_is 2.0.0-smoke1

echo "== --public-url values that are not https://HOST[:PORT]: refused before anything"
for u in 'https://:7800' '/' 'https://h/x' 'https://u@h' 'https://h?q' 'https://h#f' 'https://h:0' 'https://h:65536' 'http://h' 'https://h//' 'https://[1:2:3]' 'https://999.999.999.999' 'https://[]' 'https://example.123'; do
  rc=0; install_run badurl "--name maya --tools none --public-url '$u'" || rc=$?
  check "--public-url $u: exits 1 saying what is accepted" sh -c '[ "$1" -eq 1 ] && grep -qF "is not https://HOST or https://HOST:PORT" "$2"' _ "$rc" "$TMP/badurl.log"
  check "--public-url $u: got no further than the options" lacks badurl "Checking for git, curl and Bun"
done
check "the Hub still runs with its public address" public_runs "$PUB"

echo "== --public-url \"\": the address is removed"
rc=0; install_run pubclear "--name maya --tools none --public-url ''" || rc=$?
check "exits 0" [ "$rc" -eq 0 ]
check "the Hub runs without --public-url" as_maya "p=\$(pgrep -f '[b]in.ts serve' | head -n 1) && ! tr '\\0' '\\n' </proc/\$p/cmdline | grep -qx -- --public-url"
check "and lists no public address" sh -c "docker exec '$NAME' curl -fsS http://127.0.0.1:7800/api/auth/state | grep -qF '\"publicUrls\":[]'"
check "nothing saved" as_maya '[ ! -e ~/.local/state/agent-hub/public-url ]'
check "the Hub still runs v1.0.1" version_is 2.0.0-smoke1

echo "== upgrade of a stopped Hub, without AGENT_HUB_DIR: the installer of v1.0.2"
stop_hub
as_maya '"$HOME/.bun/bin/bun" /srv/smoke-db.ts mark m2 "$HOME/.agent-bus/message-bus.sqlite"'
REF=v1.0.2
HUB_DIR="-"
rc=0; install_run upgrade2 "--name maya --tools none" || rc=$?
HUB_DIR=""
check "upgrade run exits 0" [ "$rc" -eq 0 ]
check "said it upgrades" has upgrade2 "Upgrading this machine's Hub to v1.0.2"
check "backed up before checking out v1.0.2" [ "$(line_of upgrade2 "Backed up the Hub's data")" -lt "$(line_of upgrade2 "Now at v1.0.2")" ]
check "the backup holds the database from before (m1 and m2, opened by v1.0.1 only)" [ "$(backup_show)" = "smoke_marker,smoke_v101 m1,m2" ]
check "upgraded the checkout the Hub runs from" as_maya '[ "$(git -C "$CHECKOUT" rev-parse HEAD)" = "$(git -C /srv/agent-hub.git rev-parse "v1.0.2^{commit}")" ]'
check "did not make a second checkout in ~/agent-hub" as_maya '[ ! -e ~/agent-hub ]'
check "the running server reports v1.0.2's version" version_is 2.0.0-smoke2
check "the live database was then opened by v1.0.2" [ "$(db_show '"$HOME/.agent-bus/message-bus.sqlite"')" = "smoke_marker,smoke_v101,smoke_v102 m1,m2" ]
check "the sign-in link works" link_works upgrade2 maya

echo "== the checkout moved back to v1.0.1 by hand (not as documented), the Hub stopped: the installer of v1.0.2 cannot tell which release ran, and stops"
pre102=$(sed -n "s/^ *Backed up the Hub's data to \(.*\)\/hub\.tar .*/\1/p" "$TMP/upgrade2.log")
stop_hub
as_maya 'git -C "$CHECKOUT" -c advice.detachedHead=false checkout -q --detach v1.0.1'
backups=$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')
REF=v1.0.2
rc=0; install_run stoppedrollback "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "says it cannot tell, and to start the Hub on the release that should run" sh -c "grep -q 'cannot tell which release this Hub last ran: the checkout is at .* but the installer last started .*, and the Hub is not running' '$TMP/stoppedrollback.log' && grep -qF 'operations.md#start-the-hub' '$TMP/stoppedrollback.log'"
check "took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')" = "$backups" ]
check "left the checkout at v1.0.1" as_maya '[ "$(git -C "$CHECKOUT" rev-parse HEAD)" = "$(git -C /srv/agent-hub.git rev-parse "v1.0.1^{commit}")" ]'
check "left the data as it was (v1.0.2 had opened it)" [ "$(db_show '"$HOME/.agent-bus/message-bus.sqlite"')" = "smoke_marker,smoke_v101,smoke_v102 m1,m2" ]
rc=0; healthy || rc=1
check "and did not start the Hub" [ "$rc" -eq 1 ]

echo "== manual rollback to v1.0.1 as documented (Rollback; Restore of the backup from before v1.0.2; Start, which records the release), then the installer of v1.0.2 with the Hub stopped"
rc=0; run_log docrollback 'PATH="$HOME/.bun/bin:$PATH" ROLLBACK_TO=v1.0.1 sh /srv/doc-rollback.sh' || rc=$?
check "the documented Rollback command selects and builds v1.0.1" sh -c '[ "$1" -eq 0 ]' _ "$rc"
rc=0; run_log docrestore102 "RESTORE_B='$pre102' sh /srv/doc-restore.sh" || rc=$?
check "the documented Restore of the backup from before v1.0.2 says READY and RESTORED" sh -c "grep -qx READY '$TMP/docrestore102.log' && grep -q '^RESTORED\.' '$TMP/docrestore102.log'"
check "the v1.0.2-only table is gone with it" [ "$(db_show '"$HOME/.agent-bus/message-bus.sqlite"')" = "smoke_marker,smoke_v101 m1,m2" ]
start_hub
check "rolled back: the server reports v1.0.1's version" version_is 2.0.0-smoke1
check "and the documented start recorded it as the release that runs (hub-commit)" as_maya "[ \"\$(cat ~/.local/state/agent-hub/hub-commit)\" = '$v101' ]"
as_maya '"$HOME/.bun/bin/bun" /srv/smoke-db.ts mark m3 "$HOME/.agent-bus/message-bus.sqlite"'
stop_hub
REF=v1.0.2
rc=0; install_run reupgrade "--name maya --tools none" || rc=$?
check "re-upgrade exits 0" [ "$rc" -eq 0 ]
check "treated the rolled-back checkout as an upgrade" has reupgrade "Upgrading this machine's Hub to v1.0.2"
check "the fresh backup holds the rolled-back state (m3, no v1.0.2 table)" [ "$(backup_show)" = "smoke_marker,smoke_v101 m1,m2,m3" ]
check "the upgraded database keeps the message written after the rollback (m3)" [ "$(db_show '"$HOME/.agent-bus/message-bus.sqlite"')" = "smoke_marker,smoke_v101,smoke_v102 m1,m2,m3" ]
check "the running server reports v1.0.2's version" version_is 2.0.0-smoke2
check "and the website bundle is v1.0.2's again (rebuilt after the manual rollback)" as_maya 'grep -q "smoke 2.0.0-smoke2" "$CHECKOUT/packages/server/public/index.html"'

echo "== the documented Upgrade-by-hand command with a release that does not exist: it stops, and nothing is built"
as_maya 'mkdir -p ~/fakebun && printf "#!/bin/sh\ntouch /tmp/fakebun.ran\n" >~/fakebun/bun && chmod +x ~/fakebun/bun && rm -f /tmp/fakebun.ran'
rc=0; run_log docupgrade-missing 'PATH="$HOME/fakebun:$PATH" UPGRADE_TO=v9.9.9 sh /srv/doc-upgrade.sh' || rc=$?
check "it fails" sh -c '[ "$1" -ne 0 ]' _ "$rc"
check "and no bun command ran" as_maya '[ ! -e /tmp/fakebun.ran ]'
check "the checkout is still at v1.0.2" as_maya '[ "$(git -C "$CHECKOUT" rev-parse HEAD)" = "$(git -C /srv/agent-hub.git rev-parse "v1.0.2^{commit}")" ]'

echo "== a manual upgrade to v1.0.3 by the documented commands (Upgrade by hand, Start: it runs and is recorded), the Hub stopped, then the installer of v1.0.2: refused"
stop_hub
rc=0; run_log docupgrade 'PATH="$HOME/.bun/bin:$PATH" UPGRADE_TO=v1.0.3 sh /srv/doc-upgrade.sh' || rc=$?
check "the documented Upgrade-by-hand command selects and builds v1.0.3" sh -c '[ "$1" -eq 0 ]' _ "$rc"
start_hub
check "v1.0.3 runs, and the documented start recorded it" sh -c "docker exec '$NAME' curl -fsS http://127.0.0.1:7800/api/health | grep -q '\"version\":\"2.0.0-smoke3\"' && [ \"\$(docker exec -u maya '$NAME' cat /home/maya/.local/state/agent-hub/hub-commit)\" = \"\$(docker exec -u maya '$NAME' git -C /srv/agent-hub.git rev-parse 'v1.0.3^{commit}')\" ]"
stop_hub
backups=$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')
REF=v1.0.2
rc=0; install_run olderinstaller "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "says v1.0.2 does not follow the release this Hub last ran" has olderinstaller "v1.0.2 does not follow the release this Hub last ran"
check "took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')" = "$backups" ]
check "left the checkout at v1.0.3" as_maya '[ "$(git -C "$CHECKOUT" rev-parse HEAD)" = "$(git -C /srv/agent-hub.git rev-parse "v1.0.3^{commit}")" ]'
rc=0; healthy || rc=1
check "and did not start the Hub" [ "$rc" -eq 1 ]

echo "== the installer of v1.0.3, run from /tmp: the data directory is the one the installer recorded"
as_maya '"$HOME/.bun/bin/bun" /srv/smoke-db.ts mark m4 "$HOME/.agent-bus/message-bus.sqlite"'
REF=v1.0.3
WORKDIR=/tmp
rc=0; install_run fromtmp "--name maya --tools none" || rc=$?
WORKDIR=""
check "exits 0" [ "$rc" -eq 0 ]
check "v1.0.3 already ran (by hand, recorded): no upgrade, it starts it" has fromtmp "Already at v1.0.3"
check "the running server reports v1.0.3's version" version_is 2.0.0-smoke3
check "v1.0.3 opened that database" [ "$(db_show '"$HOME/.agent-bus/message-bus.sqlite"')" = "smoke_marker,smoke_v101,smoke_v102,smoke_v103 m1,m2,m3,m4" ]
LAST_TAG=v1.0.3
LAST_VERSION=2.0.0-smoke3

if [ "$MODE" = systemd ]; then
  echo "== the unit between automatic restarts (its process killed), the installer of v1.0.4"
  as_maya '"$HOME/.bun/bin/bun" /srv/smoke-db.ts mark m5 "$HOME/.agent-bus/message-bus.sqlite"'
  as_maya 'kill -9 "$(systemctl --user show -p MainPID --value agent-hub.service)"; sleep 1'
  check "the unit waits to restart" [ "$(as_maya 'systemctl --user show -p SubState --value agent-hub.service')" = "auto-restart" ]
  REF=v1.0.4
  rc=0; install_run autorestart "--name maya --tools none" || rc=$?
  check "upgrade exits 0" [ "$rc" -eq 0 ]
  check "stopped the unit before its restart came (no restart was scheduled)" sh -c "! docker exec '$NAME' journalctl --no-pager | grep -q 'agent-hub.service: Scheduled restart job'"
  check "the backup holds only the old schema (m5, no smoke_v104)" [ "$(backup_show)" = "smoke_marker,smoke_v101,smoke_v102,smoke_v103 m1,m2,m3,m4,m5" ]
  check "the running server reports v1.0.4's version" version_is 2.0.0-smoke4
  LAST_TAG=v1.0.4
  LAST_VERSION=2.0.0-smoke4

  # A service changed after install (edited, a drop-in, a change systemd has not reloaded): the installer does not
  # read its configuration, it refuses to upgrade it, before changing anything.
  refused() { # refused LOG REASON
    backups=$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')
    REF=v1.0.5
    rc=0; install_run "$1" "--name maya --tools none" || rc=$?
    check "$1: exits 1" [ "$rc" -eq 1 ]
    check "$1: says agent-hub.service was changed after install ($2) and to upgrade by hand" has "$1" "agent-hub.service was changed after install ($2"
    check "$1: points to the manual upgrade" has "$1" "docs/operations.md#upgrade"
    check "$1: refused before Bun and the fetch" sh -c "! grep -qE 'Checking for git, curl and Bun|Updating the Agent Hub checkout' '$TMP/$1.log'"
    check "$1: took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')" = "$backups" ]
    check "$1: left the checkout at v1.0.4" as_maya '[ "$(git -C "$CHECKOUT" rev-parse HEAD)" = "$(git -C /srv/agent-hub.git rev-parse "v1.0.4^{commit}")" ]'
    check "$1: the Hub still runs v1.0.4" version_is 2.0.0-smoke4
    REF="$LAST_TAG"
  }
  unit=/home/maya/.config/systemd/user/agent-hub.service
  echo "== the unit edited after install (a --data-dir in systemd's escape syntax): the installer of v1.0.3 refuses"
  as_maya "cp '$unit' /tmp/unit.keep && sed 's#^ExecStart=.*#& \"--data-dir\" \"/srv/Hub\\\\sData\"#' /tmp/unit.keep >'$unit' && systemctl --user daemon-reload && grep -q 'Hub.sData' '$unit'"
  refused edited "$unit is not the file the installer wrote"
  as_maya "cp /tmp/unit.keep '$unit' && systemctl --user daemon-reload"
  echo "== a drop-in for the unit: refused"
  as_maya 'd=~/.config/systemd/user/agent-hub.service.d && mkdir -p "$d" && printf "[Service]\nEnvironment=AGENT_BUS_DATA_DIR=/srv/elsewhere\n" >"$d/smoke.conf" && systemctl --user daemon-reload'
  refused dropin "drop-ins change it"
  as_maya 'rm -r ~/.config/systemd/user/agent-hub.service.d && systemctl --user daemon-reload'
  echo "== the unit file changed on disk, not reloaded by systemd: refused"
  as_maya "touch -d '+1 minute' '$unit'"
  check "systemd says it needs a daemon-reload" [ "$(as_maya 'systemctl --user show -p NeedDaemonReload --value agent-hub.service')" = yes ]
  refused reload "its file changed on disk and systemd has not reloaded it"
  as_maya 'systemctl --user daemon-reload'

  echo "== a stopped agent-hub.service under /etc/systemd/user, none in ~/.config: refused before Bun, git or the state change"
  as_maya "systemctl --user stop agent-hub.service && mv '$unit' /tmp/unit.mine"
  docker exec "$NAME" sh -c 'mkdir -p /etc/systemd/user && printf "[Service]\nExecStart=/bin/sleep 1000\n" >/etc/systemd/user/agent-hub.service'
  as_maya 'systemctl --user daemon-reload'
  snapshot() {
    docker exec "$NAME" sha256sum /etc/systemd/user/agent-hub.service
    as_maya 'find ~/.local/state/agent-hub -type f -exec sha256sum {} + | sort; git -C "$CHECKOUT" show-ref; git -C "$CHECKOUT" rev-parse HEAD; ls -d ~/agent-bus-backup-*'
  }
  before=$(snapshot)
  REF=v1.0.5
  rc=0; install_run etcunit "--name maya --tools none" || rc=$?
  REF="$LAST_TAG"
  check "exits 1" [ "$rc" -eq 1 ]
  check "says systemd runs it from /etc/systemd/user" has etcunit "systemd runs agent-hub.service from /etc/systemd/user/agent-hub.service, not from the installer's $unit"
  check "did not get as far as the checkout" lacks etcunit "Updating the Agent Hub checkout"
  check "the /etc unit, the state folder, the checkout's refs and the backups are as they were" [ "$(snapshot)" = "$before" ]
  check "wrote no unit in ~/.config" as_maya "[ ! -e '$unit' ]"
  docker exec "$NAME" rm /etc/systemd/user/agent-hub.service
  as_maya "mv /tmp/unit.mine '$unit' && systemctl --user daemon-reload && systemctl --user start agent-hub.service"
  check "the installer's Hub runs again" sh -c 'i=0; until docker exec "$1" curl -fsS http://127.0.0.1:7800/api/health >/dev/null 2>&1; do i=$((i+1)); [ $i -le 30 ] || exit 1; sleep 1; done' _ "$NAME"
fi

if [ "$MODE" = systemd ]; then
  echo "== another version from a shell without a systemd user session: stops before changing anything"
  backups=$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')
  REF=v1.0.2
  NO_SESSION=1
  rc=0; install_run nosession "--name maya --tools none" || rc=$?
  NO_SESSION=""
  check "exits 1" [ "$rc" -eq 1 ]
  check "says there is no systemd user session" has nosession "there is no systemd user session here to stop and start it"
  check "took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')" = "$backups" ]
  check "left the checkout at $LAST_TAG" as_maya "[ \"\$(git -C \"\$CHECKOUT\" rev-parse HEAD)\" = \"\$(git -C /srv/agent-hub.git rev-parse \"$LAST_TAG^{commit}\")\" ]"
  check "the Hub still runs $LAST_TAG" version_is "$LAST_VERSION"
fi

last_commit=$(as_maya "git -C /srv/agent-hub.git rev-parse \"$LAST_TAG^{commit}\"")
# An attachment, so the backups hold one (files/), for the check that the way back compares every Hub item.
as_maya 'mkdir -p ~/.agent-bus/files && echo attachment >~/.agent-bus/files/smoke-attachment.txt && printf "tab\n" >"$(printf "%s/.agent-bus/files/with\ttab.txt" "$HOME")"'
echo "== a release whose build fails (v1.0.5), then the command the installer gives to go back"
REF=v1.0.5
rc=0; install_run badbuild "--name maya --tools none" || rc=$?
check "the record names v1.0.5 as the release tried" as_maya '[ "$(sed -n 3p ~/.local/state/agent-hub/upgrade-recovery)" = "$(git -C /srv/agent-hub.git rev-parse "v1.0.5^{commit}")" ]'
check "exits 1" [ "$rc" -eq 1 ]
check "says the build failed" has badbuild "bun run build failed"
check "left no build marker behind" as_maya '[ ! -e "$CHECKOUT/packages/server/public/.installed-commit" ]'
check "gives the command to run the version before" has badbuild "AGENT_HUB_REF=$last_commit sh -s -- --name maya"
if [ "$MODE" = systemd ]; then
  echo "== the unit edited after the failed build, then the same release again: refused before Bun and the fetch"
  as_maya 'echo "# edited" >>~/.config/systemd/user/agent-hub.service'
  rc=0; install_run editedretry "--name maya --tools none" || rc=$?
  check "exits 1" [ "$rc" -eq 1 ]
  check "says agent-hub.service was changed after install" has editedretry "agent-hub.service was changed after install"
  check "refused before Bun and the fetch" sh -c "! grep -qE 'Checking for git, curl and Bun|Updating the Agent Hub checkout' '$TMP/editedretry.log'"
  as_maya 'cp ~/.local/state/agent-hub/agent-hub.service.written ~/.config/systemd/user/agent-hub.service && systemctl --user daemon-reload'
fi
echo "== retries after the failed build: with the first backup damaged (refused, also for the way back), then intact (it proceeds)"
bb_tar=$(sed -n 's/^Its data from before the upgrade is in \(.*\)\.$/\1/p' "$TMP/badbuild.log")
as_maya "cp '$bb_tar' /tmp/bb.keep && truncate -s \$((\$(wc -c <'$bb_tar') / 2)) '$bb_tar'"
backups=$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')
rc=0; install_run bbdamaged "--name maya --tools none" || rc=$?
check "the retry of v1.0.5 exits 1" [ "$rc" -eq 1 ]
check "saying the way back is not usable" has bbdamaged "its way back is not usable"
REF="$last_commit"
rc=0; install_run bbdamaged-back "--name maya --tools none" || rc=$?
REF=v1.0.5
check "the way back itself (the same release as before) is refused too" sh -c "[ \"\$1\" -eq 1 ] && grep -q 'its way back is not usable' '$TMP/bbdamaged-back.log'" _ "$rc"
check "neither took a backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')" = "$backups" ]
as_maya "cp /tmp/bb.keep '$bb_tar'"
rc=0; install_run bbintact "--name maya --tools none" || rc=$?
check "with the archive intact, the retry proceeds (to the build, which fails again)" sh -c "[ \"\$1\" -eq 1 ] && grep -q 'bun run build failed' '$TMP/bbintact.log'" _ "$rc"
check "and still names the first backup and version as the way back" has bbintact "going back means version $last_commit and $bb_tar"
check "and the restore steps name that first backup" has bbintact "2. restore $bb_tar as in"
echo "== a retry while the origin cannot be reached: the fetch fails, and the error still says how to go back"
docker exec "$NAME" mv /srv/agent-hub.git /srv/agent-hub.git.off
rc=0; install_run bbnofetch "--name maya --tools none" || rc=$?
docker exec "$NAME" mv /srv/agent-hub.git.off /srv/agent-hub.git
check "exits 1 on the fetch" sh -c "[ \"\$1\" -eq 1 ] && grep -q 'git fetch in .* failed' '$TMP/bbnofetch.log'" _ "$rc"
check "and prints the way back: restore the first backup, then the version before" sh -c "grep -qF '2. restore $bb_tar as in' '$TMP/bbnofetch.log' && grep -qF 'AGENT_HUB_REF=$last_commit sh -s -- --name maya' '$TMP/bbnofetch.log'"
if [ "$MODE" = nohup ]; then
  echo "== the record of the failed upgrade, the checkout moved back to $LAST_TAG by hand, this Hub's pid serving 7801 while another Hub answers on 7800: the record is kept"
  ft_head=$(as_maya 'git -C "$CHECKOUT" rev-parse HEAD')
  as_maya "git -C \"\$CHECKOUT\" -c advice.detachedHead=false checkout -q --detach $last_commit"
  sleep 3
  as_maya 'mkdir -p /tmp/own-7801 /tmp/intruder2 && cd "$CHECKOUT" && (setsid nohup "$HOME/.bun/bin/bun" run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7801 --humans maya --data-dir /tmp/own-7801 >/tmp/own7801.log 2>&1 </dev/null & echo $! >~/.local/state/agent-hub/hub.pid) && (setsid nohup "$HOME/.bun/bin/bun" run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 --humans maya --data-dir /tmp/intruder2 >/tmp/intruder2.log 2>&1 </dev/null &) && i=0 && until curl -fsS http://127.0.0.1:7800/api/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:7801/api/health >/dev/null 2>&1; do i=$((i+1)); [ $i -le 30 ] || exit 1; sleep 1; done'
  sleep 3
  REF="$last_commit"
  rc=0; install_run retire-intruder "--name maya --tools none" || rc=$?
  check "exits 1" [ "$rc" -eq 1 ]
  check "does not retire the record" lacks retire-intruder "is retired"
  check "the record is kept" as_maya '[ -f ~/.local/state/agent-hub/upgrade-recovery ]'
  as_maya 'pkill -f "[b]un run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 780[01] --humans maya --data-dir /tmp/"; sleep 2; rm -f ~/.local/state/agent-hub/hub.pid; rm -rf /tmp/own-7801 /tmp/intruder2'
  as_maya "git -C \"\$CHECKOUT\" -c advice.detachedHead=false checkout -q --detach $ft_head"
fi
echo "== the way back with the checkout gone (moved away) while the record of the failed build exists: it clones and goes back"
as_maya 'mv "$CHECKOUT" "$CHECKOUT.gone"'
REF="$last_commit"
echo "== the way back with one attachment gone from the data (the databases as in the backup): refused"
as_maya 'mv ~/.agent-bus/files/smoke-attachment.txt ~/smoke-attachment.txt'
rc=0; install_run goback1-attachment "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "names the missing attachment" has goback1-attachment "files/smoke-attachment.txt is in the backup but not in the data"
check "the record is kept" as_maya '[ -f ~/.local/state/agent-hub/upgrade-recovery ]'
as_maya 'mv ~/smoke-attachment.txt ~/.agent-bus/files/smoke-attachment.txt'
echo "== the way back with the attachment whose name has a tab changed: refused, naming it"
as_maya 'f="$(printf "%s/.agent-bus/files/with\ttab.txt" "$HOME")"; cp "$f" ~/tab.keep && printf "changed\n" >"$f"'
rc=0; install_run goback1-tab "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "names it as different from the backup" sh -c "grep -q \"files/with$(printf '\t')tab.txt differs from the backup\" '$TMP/goback1-tab.log'"
as_maya 'cp ~/tab.keep "$(printf "%s/.agent-bus/files/with\ttab.txt" "$HOME")" && rm ~/tab.keep'
echo "== the way back with an attachment the installer cannot read: refused (never taken for a match)"
as_maya 'chmod 000 ~/.agent-bus/files/smoke-attachment.txt'
rc=0; install_run goback1-unreadable "--name maya --tools none" || rc=$?
as_maya 'chmod 644 ~/.agent-bus/files/smoke-attachment.txt'
check "exits 1" [ "$rc" -eq 1 ]
check "says it could not be read" has goback1-unreadable "files/smoke-attachment.txt could not be read in"
check "the record is kept" as_maya '[ -f ~/.local/state/agent-hub/upgrade-recovery ]'
echo "== the way back with a Hub item whose parent cannot be searched (finetune/needs-you, not in the backup): refused"
as_maya 'mkdir -p ~/.agent-bus/finetune && touch ~/.agent-bus/finetune/needs-you && chmod 000 ~/.agent-bus/finetune'
rc=0; install_run goback1-noaccess "--name maya --tools none" || rc=$?
as_maya 'chmod 755 ~/.agent-bus/finetune && rm -rf ~/.agent-bus/finetune'
check "exits 1" [ "$rc" -eq 1 ]
check "says finetune/needs-you could not be read (not taken as absent)" has goback1-noaccess "finetune/needs-you could not be read in"
echo "== the way back, another Hub taking port 7800 after the checks (paused at its checkout): nothing recorded, no invite"
paused_run goback1-intruder checkout 'mkdir -p /tmp/intruder-data && cd "$CHECKOUT.gone" && (setsid nohup "$HOME/.bun/bin/bun" run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 --humans maya --data-dir /tmp/intruder-data >/tmp/intruder.log 2>&1 </dev/null &) && i=0 && until curl -fsS http://127.0.0.1:7800/api/health >/dev/null 2>&1; do i=$((i+1)); [ $i -le 30 ] || exit 1; sleep 1; done'
check "the run exits 1" grep -qx 'run-exit 1' "$TMP/goback1-intruder.log"
check "saying another Hub now uses the port" grep -q 'port 7800 is now used by another Hub (not this installation' "$TMP/goback1-intruder.log"
check "no sign-in link was made" sh -c "! grep -qE 'Making a one-time sign-in link|SIGN-IN LINK' '$TMP/goback1-intruder.log'"
check "the record of the failed upgrade is kept" as_maya '[ -f ~/.local/state/agent-hub/upgrade-recovery ]'
as_maya 'pkill -f "[b]un run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 --humans maya --data-dir /tmp/intruder-data"; sleep 2; rm -rf /tmp/intruder-data "$CHECKOUT"'
rc=0; install_run goback1 "--name maya --tools none" || rc=$?
check "going back exits 0" [ "$rc" -eq 0 ]
check "it cloned the checkout again" has goback1 "Downloading Agent Hub"
check "rebuilt the version before instead of trusting the old build" has goback1 "Building the website (bun run build)"
check "the Hub runs $LAST_TAG again" version_is "$LAST_VERSION"
check "the record is retired" as_maya '[ ! -e ~/.local/state/agent-hub/upgrade-recovery ]'
as_maya 'rm -rf "$CHECKOUT.gone"'

echo "== a release whose server does not start (v1.0.6)"
REF=v1.0.6
rc=0; install_run badstart "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "says the Hub did not answer" has badstart "did not answer on http://127.0.0.1:7800/api/health within a minute"
check "says it stopped it, checked it is down, and to restore the backup before going back" has badstart "(The installer has stopped it and checked that no Hub process runs from $CHECKOUT.) The upgraded Hub did not come up"
check "points to restoring the backup" has badstart "docs/operations.md#restore"
first_tar=$(sed -n 's/^ *2\. restore \(.*\) as in .*/\1/p' "$TMP/badstart.log")
first_dir="${first_tar%/hub.tar}"

echo "== a retry while the first attempt's backup is damaged (truncated, or without its items.txt): stops before anything"
damaged() { # damaged LOG: the retry refuses, takes no backup and leaves the checkout as it is
  backups=$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')
  head_before=$(as_maya 'git -C "$CHECKOUT" rev-parse HEAD')
  rc=0; install_run "$1" "--name maya --tools none" || rc=$?
  check "$1: exits 1" [ "$rc" -eq 1 ]
  check "$1: says the record's way back is not usable" has "$1" "records an upgrade that did not finish, but its way back is not usable"
  check "$1: took no backup" [ "$(as_maya 'ls -d ~/agent-bus-backup-* | wc -l')" = "$backups" ]
  check "$1: left the checkout as it was" [ "$(as_maya 'git -C "$CHECKOUT" rev-parse HEAD')" = "$head_before" ]
}
as_maya "cp '$first_tar' /tmp/hub.tar.keep && truncate -s \$((\$(wc -c <'$first_tar') / 2)) '$first_tar' && ! tar -tf '$first_tar' >/dev/null 2>&1"
damaged truncated
as_maya "cp /tmp/hub.tar.keep '$first_tar'"
as_maya "mv '$first_dir/items.txt' /tmp/items.txt.keep"
damaged noitems
as_maya "mv /tmp/items.txt.keep '$first_dir/items.txt'"
as_maya "cp '$first_dir/items.txt' /tmp/items.txt.keep && echo message-bus.sqlite >>'$first_dir/items.txt'"
damaged duplicate
as_maya "cp /tmp/items.txt.keep '$first_dir/items.txt'"
# An archive whose database is an empty file (it passes PRAGMA integrity_check, but has no Hub tables).
as_maya "d=\$(mktemp -d) && tar -C \"\$d\" -xf /tmp/hub.tar.keep && for f in '' -wal -shm; do if [ -e \"\$d/message-bus.sqlite\$f\" ]; then : >\"\$d/message-bus.sqlite\$f\"; fi; done && tar -C \"\$d\" -cf '$first_tar' -T '$first_dir/items.txt'"
damaged emptydb
as_maya "cp /tmp/hub.tar.keep '$first_tar'"
# A healthy Hub database, but a damaged Tasks database in the archive.
as_maya "d=\$(mktemp -d) && tar -C \"\$d\" -xf /tmp/hub.tar.keep && mkdir -p \"\$d/task-ext\" && printf 'not a database, not at all, though long enough..........' >\"\$d/task-ext/tasks.sqlite\" && if ! grep -qx task-ext '$first_dir/items.txt'; then echo task-ext >>'$first_dir/items.txt'; fi && tar -C \"\$d\" -cf '$first_tar' -T '$first_dir/items.txt'"
damaged badtasksdb
check "badtasksdb: names the damaged Tasks database" has badtasksdb "task-ext/tasks.sqlite is damaged"
as_maya "cp /tmp/hub.tar.keep '$first_tar' && cp /tmp/items.txt.keep '$first_dir/items.txt'"
# GNU tar keeps a .. in a member name with -P; the member files/../escape is the file escape renamed.
as_maya "d=\$(mktemp -d) && tar -C \"\$d\" -xf /tmp/hub.tar.keep && echo outside >\"\$d/escape\" && tar -C \"\$d\" -cPf '$first_tar' --transform 's,^escape\$,files/../escape,' -T '$first_dir/items.txt' escape && tar -tf '$first_tar' | grep -qx 'files/../escape'"
damaged escape
check "escape: names the unsafe path" has escape "unsafe path in the archive: files/../escape"
as_maya "d=\$(mktemp -d) && tar -C \"\$d\" -xf /tmp/hub.tar.keep && rm -f \"\$d/message-bus.sqlite\" && mkdir \"\$d/message-bus.sqlite\" && tar -C \"\$d\" -cf '$first_tar' -T '$first_dir/items.txt' && tar -tf '$first_tar' | grep -qx 'message-bus.sqlite/'"
damaged dirdb
check "dirdb: says the database is a directory" has dirdb "message-bus.sqlite is a directory in hub.tar"
as_maya "cp /tmp/hub.tar.keep '$first_tar'"
# A link as a member (attention-people.txt pointing elsewhere).
as_maya "d=\$(mktemp -d) && tar -C \"\$d\" -xf /tmp/hub.tar.keep && rm -f \"\$d/attention-people.txt\" && ln -s /etc/hostname \"\$d/attention-people.txt\" && if ! grep -qx attention-people.txt '$first_dir/items.txt'; then echo attention-people.txt >>'$first_dir/items.txt'; fi && tar -C \"\$d\" -cf '$first_tar' -T '$first_dir/items.txt'"
damaged linkmember
check "linkmember: says it is not a file or directory" has linkmember "not a file or directory in the archive"
as_maya "cp /tmp/hub.tar.keep '$first_tar' && cp /tmp/items.txt.keep '$first_dir/items.txt'"
# An empty status database.
as_maya "d=\$(mktemp -d) && tar -C \"\$d\" -xf /tmp/hub.tar.keep && mkdir -p \"\$d/status\" && : >\"\$d/status/status.sqlite\" && if ! grep -qx status '$first_dir/items.txt'; then echo status >>'$first_dir/items.txt'; fi && tar -C \"\$d\" -cf '$first_tar' -T '$first_dir/items.txt'"
damaged emptystatus
check "emptystatus: says status/status.sqlite lacks its tables" has emptystatus "status/status.sqlite lacks the tables asks, updates"
as_maya "cp /tmp/items.txt.keep '$first_dir/items.txt'"
as_maya "cp /tmp/hub.tar.keep '$first_tar'"

rc=0; install_run badstart2 "--name maya --tools none" || rc=$?
check "a second attempt also exits 1" [ "$rc" -eq 1 ]
check "it still points at the first attempt's backup" sh -c '[ -n "$1" ] && [ "$1" = "$2" ]' _ "$first_tar" "$(sed -n 's/^ *2\. restore \(.*\) as in .*/\1/p' "$TMP/badstart2.log")"
check "that archive lacks what v1.0.6 wrote (smoke_hang)" as_maya "d=\$(mktemp -d) && tar -C \"\$d\" -xf '$first_tar' && ! \"\$HOME/.bun/bin/bun\" /srv/smoke-db.ts show \"\$d/message-bus.sqlite\" | grep -q smoke_hang"
check "while the live database has it" sh -c "printf '%s\n' '$(db_show '"$HOME/.agent-bus/message-bus.sqlite"')' | grep -q smoke_hang"
rc=0; healthy || rc=1
check "the broken Hub is not left running (no process, port free)" sh -c "[ \"\$1\" -eq 1 ]" _ "$rc"
check "no Hub process runs from the checkout" as_maya '! pgrep -f "[b]in.ts serve" >/dev/null'
if [ "$MODE" = systemd ]; then check "the unit is stopped" [ "$(as_maya 'systemctl --user show -p ActiveState --value agent-hub.service')" != active ]; fi

echo "== a manual rollback by docs/operations.md (Restore of the first backup as written, check out $LAST_TAG, build, start), then another attempt"
rc=0; run_log docrestore "RESTORE_B='$first_dir' sh /srv/doc-restore.sh" || rc=$?
check "the documented Restore step 1 says READY" grep -qx READY "$TMP/docrestore.log"
check "and step 2 says RESTORED" grep -q '^RESTORED\. The replaced items are in ' "$TMP/docrestore.log"
check "the restored database lacks what v1.0.6 wrote" sh -c "! printf '%s\n' '$(db_show '"$HOME/.agent-bus/message-bus.sqlite"')' | grep -q smoke_hang"
rc=0; run_log docrollback-last "PATH=\"\$HOME/.bun/bin:\$PATH\" ROLLBACK_TO=$last_commit sh /srv/doc-rollback.sh" || rc=$?
check "the documented Rollback command selects and builds $LAST_TAG" sh -c '[ "$1" -eq 0 ]' _ "$rc"
start_hub
check "rolled back: the Hub runs $LAST_TAG" version_is "$LAST_VERSION"
as_maya '"$HOME/.bun/bin/bun" /srv/smoke-db.ts mark after-rollback "$HOME/.agent-bus/message-bus.sqlite"'
stop_hub
REF=v1.0.6
rc=0; install_run badstart3 "--name maya --tools none" || rc=$?
check "the attempt exits 1" [ "$rc" -eq 1 ]
check "it retired the record of the earlier attempts (the rolled-back release started, recorded after them)" has badstart3 "$last_commit started again after the upgrade that did not finish"
third_tar=$(sed -n 's/^ *2\. restore \(.*\) as in .*/\1/p' "$TMP/badstart3.log")
check "its way back is a new backup" sh -c '[ -n "$1" ] && [ "$1" != "$2" ]' _ "$third_tar" "$first_tar"
check "which holds what was written after the rollback" as_maya "d=\$(mktemp -d) && tar -C \"\$d\" -xf '$third_tar' && \"\$HOME/.bun/bin/bun\" /srv/smoke-db.ts show \"\$d/message-bus.sqlite\" | grep -q after-rollback"

echo "== a stale hub.pid naming the Hub of a second checkout (port 7802), then the installer goes back to $LAST_TAG"
as_maya 'git clone -q /srv/agent-hub.git ~/second && git -C ~/second -c advice.detachedHead=false checkout -q v1.0.4 && cd ~/second && "$HOME/.bun/bin/bun" install --frozen-lockfile >/dev/null 2>&1'
as_maya 'cd ~/second && (setsid nohup "$HOME/.bun/bin/bun" run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7802 --humans maya --data-dir "$HOME/second-data" >/tmp/second.log 2>&1 </dev/null &) && i=0 && until curl -fsS http://127.0.0.1:7802/api/health >/dev/null 2>&1; do i=$((i+1)); [ $i -le 30 ] || exit 1; sleep 1; done'
as_maya 'pgrep -f "[-]-port 7802" | head -n 1 >~/.local/state/agent-hub/hub.pid && cat ~/.local/state/agent-hub/hub.pid'
if [ "$MODE" = nohup ]; then
  rc=0; run_log stalestop 'sh ~/.local/state/agent-hub/stop-hub.sh' || rc=$?
  check "the printed stop command leaves that pid alone" has stalestop "is not a Hub of $CHECKOUT; left alone"
  check "and says the Hub is stopped (none from this checkout runs, port 7800 refuses)" sh -c '[ "$1" -eq 0 ]' _ "$rc"
  check "the second checkout's Hub still answers" as_maya 'curl -fsS http://127.0.0.1:7802/api/health >/dev/null'
  echo "== decoys in the checkout: a bun -e process carrying the Hub's arguments as one argument, and a python process"
  as_maya 'cd "$CHECKOUT" && (setsid nohup "$HOME/.bun/bin/bun" -e "setInterval(() => {}, 1e6)" "run packages/cli/src/bin.ts serve" >/dev/null 2>&1 </dev/null &) && (setsid nohup python3 -c "import time; time.sleep(100000)" run packages/cli/src/bin.ts serve >/dev/null 2>&1 </dev/null &) && sleep 1'
  bun_decoy=$(as_maya 'pgrep -f "[b]un -e setInterval" | head -n 1')
  py_decoy=$(as_maya 'pgrep -f "[p]ython3 -c import time" | head -n 1')
  for decoy in "$bun_decoy" "$py_decoy"; do
    as_maya "echo '$decoy' >~/.local/state/agent-hub/hub.pid"
    rc=0; run_log "decoy-$decoy" 'sh ~/.local/state/agent-hub/stop-hub.sh' || rc=$?
    check "stop-hub.sh leaves decoy $decoy alone" as_maya "kill -0 '$decoy'"
  done
fi
goback_after_restore badstart3 goback2
check "on data without what v1.0.6 wrote (smoke_hang)" sh -c "! printf '%s\n' '$(db_show '"$HOME/.agent-bus/message-bus.sqlite"')' | grep -q smoke_hang"
check "the second checkout's Hub survived" as_maya 'curl -fsS http://127.0.0.1:7802/api/health >/dev/null'
if [ "$MODE" = nohup ]; then
  check "the bun -e decoy survived the upgrade" as_maya "kill -0 '$bun_decoy'"
  check "the python decoy survived the upgrade" as_maya "kill -0 '$py_decoy'"
  as_maya "kill '$bun_decoy' '$py_decoy'"
fi

if [ "$MODE" = nohup ]; then
  # (systemd: a stop that fails needs a drop-in, which the installer refuses to upgrade; covered above.)
  echo "== a release whose server never answers and ignores the stop signal (v1.0.7): the installer cannot stop it"
  REF=v1.0.7
  rc=0; install_run badstop "--name maya --tools none" || rc=$?
  check "exits 1" [ "$rc" -eq 1 ]
  check "does not claim it stopped it" lacks badstop "(The installer has stopped it"
  check "says it could not confirm the Hub is stopped, and how to check before restoring" has badstop "The installer could not confirm that the upgraded Hub is stopped"
  check "names the process still running from the checkout" has badstop "a Hub process still runs from $CHECKOUT (pid"
  check "the process is indeed still there" as_maya 'pgrep -f "[b]in.ts serve" >/dev/null'
  echo "== the way back while that v1.0.7 process still runs: refused, nothing started next to it, the record kept"
  REF="$last_commit"
  rc=0; install_run goback3-hung "--name maya --tools none" || rc=$?
  check "exits 1" [ "$rc" -eq 1 ]
  check "says it could not stop the Hub before going back" has goback3-hung "could not stop this machine's Hub before going back to $last_commit"
  check "and how (the restore steps, step 1 the stop)" has goback3-hung "1. stop it if it runs:"
  check "still exactly one Hub process from the checkout" [ "$(checkout_hubs)" = 1 ]
  check "the record of the failed upgrade is kept" as_maya '[ -f ~/.local/state/agent-hub/upgrade-recovery ]'
  as_maya 'pkill -9 -f "[b]un run packages/cli"; sleep 1'
  goback_after_restore badstop goback3
fi

echo "== a release that answers only after the installer gave up (v1.0.8), started again later, then the way back"
REF=v1.0.8
rc=0; install_run late "--name maya --tools none" || rc=$?
check "the upgrade exits 1 (no answer within a minute)" sh -c "[ \"\$1\" -eq 1 ] && grep -q 'did not answer on http://127.0.0.1:7800/api/health within a minute' '$TMP/late.log'" _ "$rc"
if [ "$MODE" = systemd ]; then
  as_maya 'systemctl --user reset-failed agent-hub.service 2>/dev/null; systemctl --user start agent-hub.service'
else
  as_maya 'cd "$CHECKOUT" && (setsid nohup "$HOME/.bun/bin/bun" run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 --humans maya --data-dir "$HOME/.agent-bus" --existing-data >>/tmp/late-hub.log 2>&1 </dev/null & echo $! >~/.local/state/agent-hub/hub.pid)'
fi
as_maya 'i=0; until curl -fsS http://127.0.0.1:7800/api/health 2>/dev/null | grep -q smoke8; do i=$((i+1)); [ $i -le 150 ] || exit 1; sleep 1; done' || true
check "v1.0.8, started again, now answers" version_is 2.0.0-smoke8
echo "== the checkout moved back to $LAST_TAG by hand while v1.0.8 runs: the record of the failed upgrade stays"
as_maya "git -C \"\$CHECKOUT\" -c advice.detachedHead=false checkout -q --detach $last_commit"
REF="$last_commit"
rc=0; install_run lateback-handcheckout "--name maya --tools none" || rc=$?
check "the run does not retire the record (v1.0.8 runs, not $LAST_TAG)" lacks lateback-handcheckout "is retired"
check "it stopped v1.0.8 first" has lateback-handcheckout "stopping whatever Hub still runs first"
check "and, v1.0.8 having run on the data, it refuses until the backup is restored" sh -c "[ \"\$1\" -eq 1 ] && grep -q 'Restore .*hub.tar first' '$TMP/lateback-handcheckout.log'" _ "$rc"
check "the record is kept" as_maya '[ -f ~/.local/state/agent-hub/upgrade-recovery ]'
check "nothing runs" [ "$(checkout_hubs)" = 0 ]
rc=0; run_log docrestore-late "RESTORE_B='$(sed -n 's/^ *2\. restore \(.*\)\/hub\.tar as in .*/\1/p' "$TMP/late.log" | head -n 1)' sh /srv/doc-restore.sh" || rc=$?
check "the documented Restore of the first backup says RESTORED" grep -q '^RESTORED\.' "$TMP/docrestore-late.log"
rc=0; install_run lateback "--name maya --tools none" || rc=$?
check "the way back then exits 0" [ "$rc" -eq 0 ]
check "the Hub runs $LAST_TAG again" version_is "$LAST_VERSION"
check "on data without what v1.0.8 wrote (smoke_late)" sh -c "! printf '%s\n' '$(db_show '"$HOME/.agent-bus/message-bus.sqlite"')' | grep -q smoke_late"
check "exactly one Hub process from the checkout" [ "$(checkout_hubs)" = 1 ]
check "the record is retired only now, after $LAST_TAG started" as_maya '[ ! -e ~/.local/state/agent-hub/upgrade-recovery ]'

echo "== an upgrade (v1.0.6) interrupted (TERM) right after its checkout, the service then started on its own (as at login), then the way back"
REF=v1.0.6
as_maya 'rm -f /tmp/slowgit.reached /tmp/slowgit.hold && echo checkout >/tmp/slowgit.at'
rc=0; run_log upgint 'PATH="$HOME/slowgit:$PATH" setsid sh -s -- --name maya --tools none </srv/install.sh >/tmp/upgint.out 2>&1 & p=$!; i=0; until [ -e /tmp/slowgit.reached ]; do i=$((i+1)); [ $i -le 300 ] || exit 9; sleep 1; done; /bin/kill -s TERM -- "-$p"; wait "$p"; s=$?; cat /tmp/upgint.out; exit "$s"' || rc=$?
as_maya 'rm -f /tmp/slowgit.at'
check "the upgrade was interrupted after its checkout (exit 143)" [ "$rc" -eq 143 ]
check "its record of the upgrade is there" as_maya '[ -f ~/.local/state/agent-hub/upgrade-recovery ]'
if [ "$MODE" = systemd ]; then
  as_maya 'systemctl --user reset-failed agent-hub.service 2>/dev/null; systemctl --user start agent-hub.service'
else
  as_maya 'cd "$CHECKOUT" && (setsid nohup "$HOME/.bun/bin/bun" run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 --humans maya --data-dir "$HOME/.agent-bus" --existing-data >>/tmp/upgint-hub.log 2>&1 </dev/null & echo $! >~/.local/state/agent-hub/hub.pid)'
fi
as_maya 'i=0; until "$HOME/.bun/bin/bun" /srv/smoke-db.ts show "$HOME/.agent-bus/message-bus.sqlite" 2>/dev/null | grep -q smoke_hang; do i=$((i+1)); [ $i -le 30 ] || exit 1; sleep 1; done' || true
check "the new checkout (v1.0.6) ran on the data" sh -c "printf '%s\n' '$(db_show '"$HOME/.agent-bus/message-bus.sqlite"')' | grep -q smoke_hang"
REF="$last_commit"
rc=0; install_run upgint-back-first "--name maya --tools none" || rc=$?
check "the way back is refused until the backup is restored" sh -c "[ \"\$1\" -eq 1 ] && grep -q 'Restore .*hub.tar first' '$TMP/upgint-back-first.log'" _ "$rc"
check "the record is kept" as_maya '[ -f ~/.local/state/agent-hub/upgrade-recovery ]'
check "and no Hub runs" [ "$(checkout_hubs)" = 0 ]
upgint_b=$(as_maya 'sed -n 2p ~/.local/state/agent-hub/upgrade-recovery')
rc=0; run_log upgint-restore "RESTORE_B='$upgint_b' sh /srv/doc-restore.sh" || rc=$?
check "the documented Restore says RESTORED" grep -q '^RESTORED\.' "$TMP/upgint-restore.log"
rc=0; install_run upgint-back "--name maya --tools none" || rc=$?
check "then the way back exits 0" [ "$rc" -eq 0 ]
check "the Hub runs $LAST_TAG again" version_is "$LAST_VERSION"
check "on data without what v1.0.6 wrote" sh -c "! printf '%s\n' '$(db_show '"$HOME/.agent-bus/message-bus.sqlite"')' | grep -q smoke_hang"
check "the record is retired" as_maya '[ ! -e ~/.local/state/agent-hub/upgrade-recovery ]'
REF="$LAST_TAG"

# back_to_last LOG BACKUP: the Hub back on $LAST_TAG as documented: stop, Rollback, Restore of BACKUP, Start.
back_to_last() {
  stop_hub
  as_maya 'pkill -f "[b]un run packages/cli/src/bin.ts serve" || true; sleep 1'
  rc=0; run_log "$1-rollback" "PATH=\"\$HOME/.bun/bin:\$PATH\" ROLLBACK_TO=$last_commit sh /srv/doc-rollback.sh" || rc=$?
  check "$1: the documented Rollback to $LAST_TAG" [ "$rc" -eq 0 ]
  rc=0; run_log "$1-restore" "RESTORE_B='$2' sh /srv/doc-restore.sh" || rc=$?
  check "$1: the documented Restore says RESTORED" grep -q '^RESTORED\.' "$TMP/$1-restore.log"
  start_hub
  check "$1: the Hub runs $LAST_TAG" version_is "$LAST_VERSION"
}
# fail_c LOG: an upgrade to v1.0.10 (C), which writes to the data and never answers; the Hub then stopped. Sets c_backup.
fail_c() {
  REF=v1.0.10
  rc=0; install_run "$1" "--name maya --tools none" || rc=$?
  check "$1: the upgrade to v1.0.10 exits 1" [ "$rc" -eq 1 ]
  check "$1: the record names v1.0.10 as the release tried" as_maya '[ "$(sed -n 3p ~/.local/state/agent-hub/upgrade-recovery)" = "$(git -C /srv/agent-hub.git rev-parse "v1.0.10^{commit}")" ]'
  stop_hub
  as_maya 'pkill -f "[b]un run packages/cli/src/bin.ts serve" || true; sleep 1'
  check "$1: v1.0.10 wrote to the data" sh -c "printf '%s\n' '$(db_show '"$HOME/.agent-bus/message-bus.sqlite"')' | grep -q smoke_c"
  c_backup=$(sed -n 's/^ *2\. restore \(.*\)\/hub\.tar as in .*/\1/p' "$TMP/$1.log" | head -n 1)
}
c7=$(as_maya "git -C /srv/agent-hub.git rev-parse 'v1.0.10^{commit}'" | cut -c1-7)

echo "== an upgrade to v1.0.10 (C) that writes to the data and fails; retries to v1.0.9 (B, before C)"
fail_c failc
echo "== (a) the checkout still at C: a retry to B is refused, naming C and the backup"
REF=v1.0.9
rc=0; install_run retryb-here "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "names C, and the backup to restore" sh -c "grep -q 'v1.0.9 does not follow $c7' '$TMP/retryb-here.log' && grep -qF 'restore $c_backup/hub.tar first' '$TMP/retryb-here.log'"
check "nothing started" [ "$(checkout_hubs)" = 0 ]
check "the record still names v1.0.10" as_maya '[ "$(sed -n 3p ~/.local/state/agent-hub/upgrade-recovery)" = "$(git -C /srv/agent-hub.git rev-parse "v1.0.10^{commit}")" ]'
echo "== the same record as an older installer wrote it (two lines: no release tried): even a retry to C is refused"
as_maya 'cp ~/.local/state/agent-hub/upgrade-recovery ~/recovery.keep && sed -n 1,2p ~/recovery.keep >~/.local/state/agent-hub/upgrade-recovery'
REF=v1.0.10
rc=0; install_run retryc-twoline "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "says the record does not say which release was tried, and to restore the backup" sh -c "grep -q 'does not say which release the upgrade that did not finish tried' '$TMP/retryc-twoline.log' && grep -qF 'Restore $c_backup/hub.tar first' '$TMP/retryc-twoline.log'"
check "nothing started" [ "$(checkout_hubs)" = 0 ]
as_maya 'mv ~/recovery.keep ~/.local/state/agent-hub/upgrade-recovery'
REF=v1.0.9
echo "== the checkout lost: a retry to B is refused the same way"
as_maya 'mv "$CHECKOUT" "$CHECKOUT.lost"'
rc=0; install_run retryb "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "names C, and the backup to restore" sh -c "grep -q 'v1.0.9 does not follow $c7' '$TMP/retryb.log' && grep -qF 'restore $c_backup/hub.tar first' '$TMP/retryb.log'"
check "the checkout path is still absent" as_maya '[ ! -e "$CHECKOUT" ]'
as_maya 'mv "$CHECKOUT.lost" "$CHECKOUT"'
echo "== (b) the backup restored (the checkout still at C): the retry to B goes ahead"
rc=0; run_log retryb-restore "RESTORE_B='$c_backup' sh /srv/doc-restore.sh" || rc=$?
check "the documented Restore says RESTORED" grep -q '^RESTORED\.' "$TMP/retryb-restore.log"
# The record as an older installer wrote it: with the data restored, the retry still goes ahead.
as_maya 'sed -n 1,2p ~/.local/state/agent-hub/upgrade-recovery >~/rec2 && mv ~/rec2 ~/.local/state/agent-hub/upgrade-recovery'
rc=0; install_run retryb-restored "--name maya --tools none" || rc=$?
check "exits 0" [ "$rc" -eq 0 ]
check "the Hub runs v1.0.9" version_is 2.0.0-smoke9
check "on data without what v1.0.10 wrote" sh -c "! printf '%s\n' '$(db_show '"$HOME/.agent-bus/message-bus.sqlite"')' | grep -q smoke_c"
check "the record is retired" as_maya '[ ! -e ~/.local/state/agent-hub/upgrade-recovery ]'
back_to_last backfromb "$(sed -n "s/^ *Backed up the Hub's data to \(.*\)\/hub\.tar .*/\1/p" "$TMP/retryb-restored.log")"

echo "== (c) C fails again, then a manual rollback to $LAST_TAG retires the record and the same run upgrades to B"
fail_c failc2
back_to_last rollc "$c_backup"
REF=v1.0.9
rc=0; install_run retire-then-b "--name maya --tools none" || rc=$?
check "exits 0" [ "$rc" -eq 0 ]
check "it retired the record first" grep -q 'the record of .*upgrade.* is retired' "$TMP/retire-then-b.log"
check "then upgraded: the Hub runs v1.0.9" version_is 2.0.0-smoke9
check "no record is left" as_maya '[ ! -e ~/.local/state/agent-hub/upgrade-recovery ]'
back_to_last backfromb2 "$(sed -n "s/^ *Backed up the Hub's data to \(.*\)\/hub\.tar .*/\1/p" "$TMP/retire-then-b.log")"
REF="$LAST_TAG"
echo "== after the manual rollbacks, the installer of $LAST_TAG with the Hub stopped: it rebuilds that release and starts it"
stop_hub
rc=0; install_run settle "--name maya --tools none" || rc=$?
check "exits 0" [ "$rc" -eq 0 ]
check "rebuilt (the build was B's)" has settle "Building the website (bun run build)"
check "the Hub runs $LAST_TAG" version_is "$LAST_VERSION"

echo "== AGENT_HUB_DIR naming another folder than the Hub's"
HUB_DIR=/home/maya/elsewhere
rc=0; install_run otherdir "--name maya --tools none" || rc=$?
HUB_DIR=""
check "exits 1" [ "$rc" -eq 1 ]
check "says where the Hub runs from" has otherdir "this machine's Hub runs from $CHECKOUT, but AGENT_HUB_DIR is /home/maya/elsewhere"
check "changed nothing" as_maya '[ ! -e /home/maya/elsewhere ]'
check "the Hub still runs $LAST_TAG" version_is "$LAST_VERSION"

if [ "$MODE" = systemd ]; then
  echo "== the Hub's passkeys are for hub.example, opened at https://hub.example (unit edited by hand)"
  as_maya 'u=~/.config/systemd/user/agent-hub.service && sed "s#^ExecStart=.*#& \"--rp-id\" \"hub.example\" \"--origin\" \"https://hub.example\"#" "$u" >"$u.new" && mv "$u.new" "$u" && systemctl --user daemon-reload && systemctl --user restart agent-hub.service && sleep 3'
  check "rp run exits 0" install_run rp "--name maya --tools none"
  check "the sign-in link is at https://hub.example" grep -q '^SIGN-IN LINK: https://hub.example/auth#invite=' "$TMP/rp.log"
  check "the Hub accepts it for maya" link_works rp maya
  as_maya 'u=~/.config/systemd/user/agent-hub.service && sed "s# \"--rp-id\" \"hub.example\" \"--origin\" \"https://hub.example\"##" "$u" >"$u.new" && mv "$u.new" "$u" && systemctl --user daemon-reload && systemctl --user restart agent-hub.service && sleep 3'
fi

echo "== a Hub not started by this installer, with passkeys for hub.example and no address on it"
stop_hub
# Without installer state: an installation the installer set up refuses another Hub on its port (above); a first
# install may only use such a Hub.
as_maya 'mv ~/.local/state/agent-hub ~/.local/state/agent-hub.aside && if [ -f ~/.config/systemd/user/agent-hub.service ]; then mv ~/.config/systemd/user/agent-hub.service ~/agent-hub.service.aside; fi'
as_maya 'cd "$CHECKOUT" && (setsid nohup "$HOME/.bun/bin/bun" run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 --humans maya --rp-id hub.example >/tmp/foreign.log 2>&1 </dev/null &) && i=0 && until curl -fsS http://127.0.0.1:7800/api/health >/dev/null 2>&1; do i=$((i+1)); [ $i -le 30 ] || exit 1; sleep 1; done'
rc=0; install_run foreign "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "prints no sign-in link" lacks foreign "SIGN-IN LINK"
check "says the passkeys are for hub.example and what to do" has foreign "this Hub's passkeys are for hub.example"
check "it was going to use that Hub (the checkout stays as it is)" has foreign "A Hub not started by this installer already answers on 127.0.0.1:7800: using it"

echo "== a Hub not started by this installer, passkeys for hub.example, accepted from http://hub.example only (not secure)"
as_maya 'pkill -f "[b]un run packages/cli"; sleep 2'
as_maya 'cd "$CHECKOUT" && (setsid nohup "$HOME/.bun/bin/bun" run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 --humans maya --rp-id hub.example --origin http://hub.example >/tmp/foreign-http.log 2>&1 </dev/null &) && i=0 && until curl -fsS http://127.0.0.1:7800/api/health >/dev/null 2>&1; do i=$((i+1)); [ $i -le 30 ] || exit 1; sleep 1; done'
rc=0; install_run foreignhttp "--name maya --tools none" || rc=$?
check "exits 1" [ "$rc" -eq 1 ]
check "says NO SIGN-IN ADDRESS" has foreignhttp "NO SIGN-IN ADDRESS"
check "prints no sign-in link" lacks foreignhttp "SIGN-IN LINK"

echo "== a Hub not started by this installer behind a proxy: passkeys for localhost, accepted only from https://localhost"
as_maya 'pkill -f "[b]un run packages/cli"; sleep 2'
as_maya 'cd "$CHECKOUT" && (setsid nohup "$HOME/.bun/bin/bun" run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 --humans maya --rp-id localhost --origin https://localhost >/tmp/proxy.log 2>&1 </dev/null &) && i=0 && until curl -fsS http://127.0.0.1:7800/api/health >/dev/null 2>&1; do i=$((i+1)); [ $i -le 30 ] || exit 1; sleep 1; done'
check "proxy run exits 0" install_run proxy "--name maya --tools none"
check "the sign-in link is at https://localhost, the one origin it accepts" grep -q '^SIGN-IN LINK: https://localhost/auth#invite=' "$TMP/proxy.log"
check "the Hub accepts it for maya" link_works proxy maya
rc=0; install_run proxypub "--name maya --tools none --public-url https://hub.example" || rc=$?
check "--public-url for that Hub exits 1" [ "$rc" -eq 1 ]
check "saying it cannot be applied to it" has proxypub "--public-url cannot be applied to the Hub answering on 127.0.0.1:7800"
check "and prints no Public address" lacks proxypub "Public address"
as_maya 'rm -rf ~/.local/state/agent-hub'

echo "== the same hand-started Hub, no installer state, and a version that would change its checkout"
REF=v1.0.1
rc=0; install_run handmade "--name maya --tools none" || rc=$?
REF="$LAST_TAG"
check "exits 1" [ "$rc" -eq 1 ]
check "says to stop that Hub first" has handmade "A Hub not started by this installer runs from $CHECKOUT; stop it first (pid"
check "left the checkout at $LAST_TAG" as_maya "[ \"\$(git -C \"\$CHECKOUT\" rev-parse HEAD)\" = \"\$(git -C /srv/agent-hub.git rev-parse \"$LAST_TAG^{commit}\")\" ]"
check "the hand-started Hub still runs $LAST_TAG" version_is "$LAST_VERSION"
echo "== that hand-run Hub stopped, still no installer state, and an older release (v1.0.1): refused, nothing touched"
as_maya 'pkill -f "[b]un run packages/cli"; sleep 2'
db_sum=$(as_maya 'cksum <~/.agent-bus/message-bus.sqlite')
REF=v1.0.1
rc=0; install_run manualstopped "--name maya --tools none" || rc=$?
REF="$LAST_TAG"
check "exits 1" [ "$rc" -eq 1 ]
check "says the data holds a database it never started a Hub on, and points to the manual upgrade" sh -c "grep -q 'already holds a Hub.s database' '$TMP/manualstopped.log' && grep -q 'operations.md#upgrade' '$TMP/manualstopped.log'"
check "left the checkout at $LAST_TAG" as_maya "[ \"\$(git -C \"\$CHECKOUT\" rev-parse HEAD)\" = \"\$(git -C /srv/agent-hub.git rev-parse \"$LAST_TAG^{commit}\")\" ]"
check "left the database as it was" [ "$(as_maya 'cksum <~/.agent-bus/message-bus.sqlite')" = "$db_sum" ]
rc=0; healthy || rc=1
check "started nothing" [ "$rc" -eq 1 ]

echo "== still no installer state: a hand-run Hub answering when a run starts, gone during it: the run stops, starts nothing"
as_maya 'cd "$CHECKOUT" && (setsid nohup "$HOME/.bun/bin/bun" run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 --humans maya >/tmp/vanish-hub.log 2>&1 </dev/null &) && i=0 && until curl -fsS http://127.0.0.1:7800/api/health >/dev/null 2>&1; do i=$((i+1)); [ $i -le 30 ] || exit 1; sleep 1; done'
REF="$LAST_TAG"
paused_run vanish fetch 'pkill -f "[b]un run packages/cli"; sleep 2'
check "the run exits 1" grep -qx 'run-exit 1' "$TMP/vanish.log"
check "saying that Hub no longer answers and it starts nothing on its data" grep -q 'no longer answers. Not starting a release on its data' "$TMP/vanish.log"
rc=0; healthy || rc=1
check "the port stays closed" [ "$rc" -eq 1 ]
check "and it saved no installation" as_maya '[ ! -e ~/.local/state/agent-hub/humans ]'

# fresh_cleanup: the installation fresh_interrupt (or the case after it) made removed again.
fresh_cleanup() {
  if [ "$MODE" = systemd ]; then
    as_maya 'systemctl --user disable --now agent-hub.service >/dev/null 2>&1; rm -f ~/.config/systemd/user/agent-hub.service; systemctl --user daemon-reload; systemctl --user reset-failed agent-hub.service 2>/dev/null || true'
  else
    as_maya 'sh ~/.local/state/agent-hub/stop-hub.sh >/dev/null 2>&1 || true'
  fi
  as_maya 'pkill -f "[b]un run packages/cli/src/bin.ts serve" || true; sleep 1; rm -rf ~/.local/state/agent-hub ~/fresh-data'
}
# fresh_resumed LOG: the same first install again (after an interruption) exits 0 and runs $LAST_TAG on ~/fresh-data
# with its service, the record of the new database gone.
fresh_resumed() {
  DATA_ENV=/home/maya/fresh-data
  rc=0; install_run "$1" "--name maya --tools none${FRESH_PUB:+ --public-url $FRESH_PUB}" || rc=$?
  DATA_ENV=""
  check "$1: the same command again exits 0" [ "$rc" -eq 0 ]
  if [ -n "${FRESH_PUB:-}" ]; then
    check "$1: its service starts it with --public-url $FRESH_PUB" public_runs "$FRESH_PUB"
    check "$1: and saved that address" as_maya "[ \"\$(cat ~/.local/state/agent-hub/public-url)\" = '$FRESH_PUB' ]"
  fi
  check "$1: the Hub runs $LAST_TAG on ~/fresh-data" sh -c "docker exec '$NAME' curl -fsS http://127.0.0.1:7800/api/health | grep -q '\"version\":\"$LAST_VERSION\"' && [ \"\$(docker exec -u maya '$NAME' cat /home/maya/.local/state/agent-hub/data-dir)\" = /home/maya/fresh-data ]"
  check "$1: exactly one Hub process from the checkout" [ "$(checkout_hubs)" = 1 ]
  check "$1: the record of the new database is gone" as_maya '[ ! -e ~/.local/state/agent-hub/new-database ]'
}
# fresh_interrupt LOG UNTIL [KILL]: a first install into the empty ~/fresh-data, ended once the shell test UNTIL holds:
# TERM to its whole process group, or with KILL, SIGKILL to the installer alone (its first start lives on, and its
# lock stays: aged past 10 minutes here, as if that much later); then the same command again resumes and finishes.
fresh_interrupt() {
  if [ "${3:-}" = KILL ]; then stop_it='/bin/kill -s KILL "$p"'; want=137; else stop_it='/bin/kill -s TERM -- "-$p"'; want=143; fi
  DATA_ENV=/home/maya/fresh-data
  rc=0; run_log "$1" "setsid sh -s -- --name maya --tools none${FRESH_PUB:+ --public-url $FRESH_PUB} </srv/install.sh >/tmp/fresh.out 2>&1 & p=\$!; i=0; until $2; do i=\$((i+1)); [ \$i -le 3000 ] || exit 9; sleep 0.1; done; $stop_it; wait \"\$p\"; s=\$?; cat /tmp/fresh.out; exit \"\$s\"" || rc=$?
  DATA_ENV=""
  check "$1: the first install was ended (exit $want)" [ "$rc" -eq "$want" ]
  check "$1: it had recorded the new database and its release" as_maya "[ \"\$(sed -n 1p ~/.local/state/agent-hub/new-database)\" = /home/maya/fresh-data ] && [ \"\$(sed -n 2p ~/.local/state/agent-hub/new-database)\" = \"\$(git -C /srv/agent-hub.git rev-parse '$LAST_TAG^{commit}')\" ]"
  if [ "${3:-}" = KILL ]; then
    check "$1: its first start still answers" healthy
    as_maya 'touch -h -d "-11 min" ~/.local/state/agent-hub/install.lock'
  fi
  fresh_resumed "$1-again"
  fresh_cleanup
}
echo "== a first install interrupted right after it recorded its new database: the same command resumes it"
fresh_interrupt fresh1 '[ -e ~/.local/state/agent-hub/new-database ]'
echo "== a first install interrupted once its new database answers (before its service): the same command resumes it"
fresh_interrupt fresh2 'curl -fsS http://127.0.0.1:7800/api/health >/dev/null 2>&1'
check "fresh2: the resumed run said so" has fresh2-again "Resuming the install that created /home/maya/fresh-data/message-bus.sqlite"
echo "== the installer alone killed once its first start answers (that start lives on): the same command takes it over"
FRESH_PUB=https://hub.example.test
fresh_interrupt fresh3 'curl -fsS http://127.0.0.1:7800/api/health >/dev/null 2>&1' KILL
FRESH_PUB=""
check "fresh3: the resumed run stopped the surviving first start" has fresh3-again "The first start of an interrupted install of this Hub still runs (pid"
echo "== a first install from a branch, killed once its first start answers; the branch then moves (to v1.0.9): the same command stops nothing and names the new commit"
as_maya "git -C /srv/agent-hub.git branch -f smoke-branch '$LAST_TAG^{commit}'"
REF=smoke-branch
DATA_ENV=/home/maya/fresh-data
rc=0; run_log branch1 "setsid sh -s -- --name maya --tools none </srv/install.sh >/tmp/fresh.out 2>&1 & p=\$!; i=0; until curl -fsS http://127.0.0.1:7800/api/health >/dev/null 2>&1; do i=\$((i+1)); [ \$i -le 3000 ] || exit 9; sleep 0.1; done; /bin/kill -s KILL \"\$p\"; wait \"\$p\"; s=\$?; cat /tmp/fresh.out; exit \"\$s\"" || rc=$?
check "the first install was killed (exit 137)" [ "$rc" -eq 137 ]
as_maya 'touch -h -d "-11 min" ~/.local/state/agent-hub/install.lock'
as_maya "git -C /srv/agent-hub.git branch -f smoke-branch 'v1.0.9^{commit}'"
c9=$(as_maya "git -C /srv/agent-hub.git rev-parse 'v1.0.9^{commit}'" | cut -c1-7)
rc=0; install_run branch1-again "--name maya --tools none" || rc=$?
DATA_ENV=""
REF="$LAST_TAG"
check "exits 1" [ "$rc" -eq 1 ]
check "names the commit the branch is now" has branch1-again "asks for smoke-branch ($c9"
check "and stopped nothing: the first start still answers" healthy
check "the record of the new database is kept" as_maya '[ -f ~/.local/state/agent-hub/new-database ]'
fresh_cleanup
as_maya 'git -C /srv/agent-hub.git branch -D smoke-branch >/dev/null'
echo "== a first install killed once its first start answers, then the checkout made dirty: the same command stops nothing"
DATA_ENV=/home/maya/fresh-data
rc=0; run_log dirty1 "setsid sh -s -- --name maya --tools none </srv/install.sh >/tmp/fresh.out 2>&1 & p=\$!; i=0; until curl -fsS http://127.0.0.1:7800/api/health >/dev/null 2>&1; do i=\$((i+1)); [ \$i -le 3000 ] || exit 9; sleep 0.1; done; /bin/kill -s KILL \"\$p\"; wait \"\$p\"; s=\$?; cat /tmp/fresh.out; exit \"\$s\"" || rc=$?
check "the first install was killed (exit 137)" [ "$rc" -eq 137 ]
boot_before=$(as_maya 'pgrep -f "[b]un run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 --humans maya --data-dir /home/maya/fresh-data"')
as_maya 'touch -h -d "-11 min" ~/.local/state/agent-hub/install.lock && touch "$CHECKOUT/dirty.txt"'
rc=0; install_run dirty1-again "--name maya --tools none" || rc=$?
DATA_ENV=""
check "exits 1" [ "$rc" -eq 1 ]
check "says the checkout has local changes" has dirty1-again "has local changes"
check "the original first start still serves (same pid)" sh -c "[ -n '$boot_before' ] && [ \"\$(docker exec -u maya '$NAME' pgrep -f '[b]un run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7800 --humans maya --data-dir /home/maya/fresh-data')\" = '$boot_before' ] && docker exec '$NAME' curl -fsS http://127.0.0.1:7800/api/health >/dev/null"
as_maya 'rm -f "$CHECKOUT/dirty.txt"'
fresh_cleanup
echo "== interrupted before the server set up its new database (a bare file): the same command resumes it"
as_maya "mkdir -p ~/.local/state/agent-hub ~/fresh-data && : >~/fresh-data/message-bus.sqlite && printf '%s\n%s\n' /home/maya/fresh-data \"\$(git -C /srv/agent-hub.git rev-parse '$LAST_TAG^{commit}')\" >~/.local/state/agent-hub/new-database"
fresh_resumed fresh4
check "fresh4: it said it resumed" has fresh4 "Resuming the install that created /home/maya/fresh-data/message-bus.sqlite"
fresh_cleanup
as_maya 'mv ~/.local/state/agent-hub.aside ~/.local/state/agent-hub && if [ -f ~/agent-hub.service.aside ]; then mv ~/agent-hub.service.aside ~/.config/systemd/user/agent-hub.service; fi'
if [ "$MODE" = systemd ]; then as_maya 'systemctl --user daemon-reload'; fi

echo "== a Hub started by hand from the checkout on port 7801, with 7800 free, and a version that would change it"
as_maya 'pkill -f "[b]un run packages/cli"; sleep 2'
as_maya 'cd "$CHECKOUT" && (setsid nohup "$HOME/.bun/bin/bun" run packages/cli/src/bin.ts serve --host 127.0.0.1 --port 7801 --humans maya >/tmp/h7801.log 2>&1 </dev/null &) && i=0 && until curl -fsS http://127.0.0.1:7801/api/health >/dev/null 2>&1; do i=$((i+1)); [ $i -le 30 ] || exit 1; sleep 1; done'
rc=0; healthy || rc=1
check "port 7800 is free" [ "$rc" -eq 1 ]
REF=v1.0.1
HUB_DIR="."
WORKDIR="$CHECKOUT"
rc=0; install_run h7801 "--name maya --tools none" || rc=$?
HUB_DIR=""
WORKDIR=""
REF="$LAST_TAG"
check "exits 1" [ "$rc" -eq 1 ]
check "says to stop that Hub first" has h7801 "A Hub not started by this installer runs from $CHECKOUT; stop it first (pid"
check "left the checkout at $LAST_TAG" as_maya "[ \"\$(git -C \"\$CHECKOUT\" rev-parse HEAD)\" = \"\$(git -C /srv/agent-hub.git rev-parse \"$LAST_TAG^{commit}\")\" ]"
check "the Hub on 7801 still answers" as_maya 'curl -fsS http://127.0.0.1:7801/api/health >/dev/null'

echo
if [ "$failures" -eq 0 ]; then echo "install.sh smoke ($MODE): all checks passed"; else echo "install.sh smoke ($MODE): $failures failed"; exit 1; fi
