#!/bin/sh
# Agent Hub installer: one command, after which the Hub runs on this machine and you get your sign-in link.
#
#   curl -fsSL https://raw.githubusercontent.com/zekiworks/agent-hub/v1.0.0/install.sh | sh
#
# FOR A CODING AGENT GIVEN THIS URL
# What it does, on this machine, without sudo: installs Bun 1.4 if missing or older (into ~/.bun), clones Agent Hub
# v1.0.0 into ~/agent-hub (or updates a clean checkout there), builds it, puts the `agent-bus` command in ~/.local/bin,
# starts the Hub on http://localhost:7800 as a user service (systemd --user on Linux, a LaunchAgent on macOS, otherwise
# nohup), connects the coding tools it is told to, and prints a one-time sign-in link. Running it again reuses all of
# it; the installer of a newer release backs up the data and restarts the Hub on it, as long as its service is
# unchanged since install (add --public-url with this installer, not by editing the service; after other edits,
# upgrade by hand: https://github.com/zekiworks/agent-hub/blob/v1.0.0/docs/operations.md#upgrade).
# Tested on Ubuntu; its macOS path is untested.
# Before running it, ASK your person:
#   1. their name for the Hub (a short lowercase id, e.g. maya);
#   2. which coding tools on this machine should join the Hub: all the script finds (auto), none, or a list.
# Then run it with their answers; it asks nothing and needs no terminal. For example, for maya, Codex and Claude Code:
#   curl -fsSL https://raw.githubusercontent.com/zekiworks/agent-hub/v1.0.0/install.sh | sh -s -- --name maya --tools codex,claude
# (--tools auto connects every tool found, --tools none connects none.)
# Afterwards, relay these lines of its output to your person, word for word: the one starting "SIGN-IN LINK:" (they
# open it themselves, on this machine, within 10 minutes: it makes their passkey), the one starting "ALLOW THIS
# MACHINE:", and every line starting "OVER SSH:", "KEEP RUNNING:", "NEXT FOR" or "TOOL FAILED". It exits non-zero
# when a tool failed to connect.
# Anything else (a Hub on another machine, HTTPS or Tailscale for phones, typing suggestions): follow
# https://raw.githubusercontent.com/zekiworks/agent-hub/v1.0.0/INSTALL.md
#
# Options: --name NAME (or $AGENT_HUB_NAME)   --tools auto|none|TOOL,TOOL (or $AGENT_HUB_TOOLS)
#          --public-url https://HOST (the Hub's HTTPS address for phones and other computers, e.g. Tailscale Serve;
#          "" removes it)   --help
# Environment: AGENT_HUB_DIR (default ~/agent-hub), AGENT_HUB_REPO and AGENT_HUB_REF (where to clone from, and which
# tag, branch or commit; default the GitHub repo at v1.0.0), AGENT_BUS_DATA_DIR (a new Hub's data; default ~/.agent-bus).
# -f: no pathname expansion; tool lists are split on spaces and commas, and a * or ? in them must stay literal.
set -euf

REPO_DEFAULT="https://github.com/zekiworks/agent-hub.git"
REF_DEFAULT="v1.0.0"
BUN_TESTED="bun-v1.4.4"
PORT=7800
# The browser opens localhost (passkeys are bound to that name); tools use the address the Hub listens on.
HUB_URL="http://localhost:$PORT"
TOOL_URL="http://127.0.0.1:$PORT"
UNIT_NAME="agent-hub.service"
LAUNCHD_LABEL="com.agent-hub.hub"
OWNER="Written by the Agent Hub installer (install.sh)."
KNOWN_TOOLS="omp pi claude codex copilot opencode antigravity qwen grok"
DOCS="https://github.com/zekiworks/agent-hub/blob/v1.0.0"

say() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\n!!  %s\n' "$*" >&2; }
# What the Hub keeps in its data directory, as a backup holds it (docs/operations.md, Backup).
HUB_ITEMS="message-bus.sqlite message-bus.sqlite-wal message-bus.sqlite-shm files push-vapid.json task-ext
task-extension.secret status attention-people.txt attention.jsonl box-reports.jsonl finetune/needs-you"
# Set once an upgrade has stopped the Hub: every later error also says how to get it running again.
STOPPED_NOTE=""
# What this run undoes if it ends early (any exit, or a signal): the folder it clones and checks out in, until that
# is moved into place; its installation lock (and the guard it takes over a stale lock under); and the one-off start
# that creates a first database.
CLONE_TMP=""
INSTALL_LOCK=""
LOCK_GUARD=""
BOOT_PID=""
STATE_MADE=""
cleanup() {
  if [ -n "$BOOT_PID" ]; then kill "$BOOT_PID" 2>/dev/null || true; BOOT_PID=""; fi
  if [ -n "$CLONE_TMP" ]; then
    rm -rf "$CLONE_TMP"
    printf '(Removed the unfinished clone in %s.)\n' "$CLONE_TMP" >&2
    CLONE_TMP=""
  fi
  for l in "$LOCK_GUARD" "$INSTALL_LOCK"; do
    if [ -n "$l" ] && [ -L "$l" ] && [ "$(readlink "$l" 2>/dev/null)" = "$$" ]; then rm -f "$l"; fi
  done
  LOCK_GUARD=""
  INSTALL_LOCK=""
  # The state folder, if this run made it for its lock and left nothing else in it.
  if [ -n "$STATE_MADE" ]; then rmdir "$STATE_MADE" 2>/dev/null || true; STATE_MADE=""; fi
}
trap cleanup EXIT
# A signal ends the run through exit, so the EXIT trap runs (dash does not run it on a signal by itself).
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
die() {
  printf '\nError: %s\n' "$*" >&2
  [ -z "$STOPPED_NOTE" ] || printf '%s\n' "$STOPPED_NOTE" >&2
  exit 1
}

usage() {
  cat <<EOF
Agent Hub installer.

  curl -fsSL https://raw.githubusercontent.com/zekiworks/agent-hub/$REF_DEFAULT/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/zekiworks/agent-hub/$REF_DEFAULT/install.sh | sh -s -- --name maya --tools codex,claude

  --name NAME     your name on the Hub (lowercase letters, digits, - and _); asked when not given
  --tools LIST    which coding tools to connect: auto (all found), none, or a list such as codex,claude;
                  without it, asked when there is a terminal, otherwise none (the commands are printed)
  --public-url https://HOST
                  another address the website is reachable at, over HTTPS (e.g. tailscale serve --bg 7800); offered
                  for linking a phone. Given again, it changes the Hub's service and restarts it; "" removes it

Environment: AGENT_HUB_NAME, AGENT_HUB_TOOLS, AGENT_HUB_DIR (default ~/agent-hub), AGENT_HUB_REPO, AGENT_HUB_REF
(default $REF_DEFAULT), AGENT_BUS_DATA_DIR (a new Hub's data; default ~/.agent-bus).
EOF
}

# A terminal to ask on: /dev/tty, which ask() reads (stdin is the script itself under `curl | sh`).
have_tty() {
  [ -r /dev/tty ] && [ -w /dev/tty ] && (exec </dev/tty >/dev/tty) 2>/dev/null
}

ask() {
  printf '%s' "$1" >/dev/tty
  answer=""
  IFS= read -r answer </dev/tty || answer=""
}

# A word for sh, in single quotes.
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# A value inside XML (the LaunchAgent).
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"; }

# One ExecStart argument for systemd: double quotes, with \ " escaped, % and $ doubled.
sd_arg() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/\$/$$/g')"; }
# A path in other systemd settings: % doubled.
sd_path() { printf '%s' "$1" | sed -e 's/%/%%/g'; }

# git@github.com:a/b(.git), ssh://git@github.com/a/b, https://github.com/a/b(.git) all become github.com/a/b.
norm_url() {
  printf '%s\n' "$1" | sed -e 's#/*$##' -e 's#\.git$##' -e 's#^[a-z+]*://##' -e 's#^[^@/]*@##' -e 's#^\([^/:]*\):#\1/#'
}

health() { curl -fsS --max-time 3 "$TOOL_URL/api/health" 2>/dev/null; }
hub_answers() { health | grep -q '"ok": *true'; }

# 0 when nothing listens on the port (curl exit 7: could not connect).
port_free() {
  rc=0
  curl -sS --max-time 3 -o /dev/null "$TOOL_URL/" 2>/dev/null || rc=$?
  [ "$rc" -eq 7 ]
}

wait_for() { # wait_for up|down SECONDS
  i=0
  while :; do
    if [ "$1" = up ]; then hub_answers && return 0; else port_free && return 0; fi
    i=$((i + 1))
    [ "$i" -le "$2" ] || return 1
    sleep 1
  done
}

hub_cli() { (cd "$DIR" && "$BUN" run packages/cli/src/bin.ts "$@") </dev/null; }

version_ok() {
  # $1 like 1.4.4 (or 1.4.4-canary…): at least 1.4.
  major=$(printf '%s' "$1" | cut -d. -f1)
  minor=$(printf '%s' "$1" | cut -d. -f2)
  case "$major$minor" in '' | *[!0-9]*) return 1 ;; esac
  [ "$major" -gt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -ge 4 ]; }
}

tool_found() {
  case "$1" in
    pi) command -v pi >/dev/null 2>&1 || [ -x "$HOME/.pi/agent/bin/pi" ] ;;
    copilot) command -v copilot >/dev/null 2>&1 || [ -d "${COPILOT_HOME:-$HOME/.copilot}" ] ;;
    antigravity)
      command -v antigravity >/dev/null 2>&1 || [ -d "$HOME/.gemini/antigravity" ] || [ -d "$HOME/.gemini/antigravity-ide" ] ||
        [ -d "$HOME/.gemini/antigravity-cli" ] || [ -d /Applications/Antigravity.app ]
      ;;
    *) command -v "$1" >/dev/null 2>&1 ;;
  esac
}

# What a person must still do for a connected tool before Hub messages can wake it.
next_for() {
  case "$1" in
    codex) echo "start Codex, then review its hooks (the Review hooks prompt, or /hooks): check they are the message-bus plugin's from ~/.agent-bus/codex-marketplace and trust them, now and after every plugin update. Until then Codex gets no Hub messages." ;;
    claude) echo "a message wakes an idle Claude Code session only when it is signed in with a claude.ai account and started as: claude --dangerously-load-development-channels plugin:message-bus@agent-bus. Otherwise messages wait for its next turn." ;;
    copilot) echo "turn on Copilot's experimental extensions once (copilot --experimental, or /experimental on), check /extensions has them on, and allow the message-bus tool when asked." ;;
    grok)
      # Leader mode on (the CLI set it, or it was already), as Grok reads config.toml: agent-bus doctor says so.
      hub_cli doctor 2>/dev/null | grep -qF "idle wake: leader mode on" ||
        echo "Grok wakes for Hub messages only in leader mode, which is off (in leader mode one Grok process owns every Grok session on this machine). Turn it on with: agent-bus install grok --leader, or start Grok as grok --leader. Until then it reads messages only when it next calls message-bus."
      ;;
    qwen) echo "use Qwen Code 0.28: its 1.0 previews read messages only at the next prompt." ;;
  esac
}

systemd_ok() { [ "$OS" = Linux ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }
gui_ok() { [ "$OS" = Darwin ] && launchctl print "gui/$UID_" >/dev/null 2>&1; }
ours() { grep -qF "$OWNER" "$1"; }

# hub_proc PID prints the checkout (physical path) whose Agent Hub PID is, and nothing when PID is not one. The rule
# is the one docs/operations.md uses to stop a nohup Hub: the executable is bun, arguments 2-4 (NUL-separated) are
# exactly run, packages/cli/src/bin.ts and serve, and the working directory is the checkout; without /proc (macOS),
# best effort from ps and lsof. The same function is written into stop-hub.sh.
HUB_PROC_FN='hub_proc() {
  case "$1" in "" | *[!0-9]* | 0*) return 0 ;; esac
  if [ -r "/proc/$1/cmdline" ]; then
    case "$(readlink "/proc/$1/exe" 2>/dev/null)" in */bun) ;; *) return 0 ;; esac
    [ "$(tr "\0" "\n" <"/proc/$1/cmdline" 2>/dev/null | sed -n "2,4p" | tr "\n" " ")" = "run packages/cli/src/bin.ts serve " ] || return 0
    (cd -P "/proc/$1/cwd" 2>/dev/null && pwd -P) || true
  else
    case "$(ps -o args= -p "$1" 2>/dev/null)" in *"bun run packages/cli/src/bin.ts serve"*) ;; *) return 0 ;; esac
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n "s/^n//p"
  fi
  return 0
}'
eval "$HUB_PROC_FN"

# The Hub this installer started with nohup, if it still runs: hub.pid names an Agent Hub of this checkout (hub_proc)
# whose executable is the bun the installer started it with. A reused pid, or another checkout's Hub, is not it.
nohup_pid() {
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  [ "$(hub_proc "$pid")" = "$DIR" ] || return 1
  saved_bun=$(cat "$STATE_DIR/bun" 2>/dev/null || true)
  [ -z "$saved_bun" ] || ! readlink "/proc/$pid/exe" >/dev/null 2>&1 || [ "/proc/$pid/exe" -ef "$saved_bun" ]
}

# A directory by its physical path (symlinks and . resolved), as /proc and lsof report a process's directory.
canon() { if [ -d "$1" ]; then (cd -P "$1" 2>/dev/null && pwd -P) || printf '%s\n' "$1"; else printf '%s\n' "$1"; fi; }

# The pids of Agent Hub processes that run this checkout's code, whatever port they use: hub_proc's form, or the
# agent-bus command's (bun run /path/to/checkout/packages/cli/src/bin.ts serve, from anywhere).
checkout_pids() {
  ps -eo pid=,args= 2>/dev/null | while read -r ps_pid args; do
    case "$args" in *"packages/cli/src/bin.ts serve"*) ;; *) continue ;; esac
    hub_dir=$(hub_proc "$ps_pid")
    if [ -z "$hub_dir" ] && [ -r "/proc/$ps_pid/cmdline" ]; then
      script=$(tr '\0' '\n' <"/proc/$ps_pid/cmdline" 2>/dev/null | sed -n '3p')
      case "$(tr '\0' '\n' <"/proc/$ps_pid/cmdline" 2>/dev/null | sed -n '2p;4p' | tr '\n' ' ')|$script" in
        "run serve |/"*/packages/cli/src/bin.ts) hub_dir=$(canon "${script%/packages/cli/src/bin.ts}") ;;
      esac
    elif [ -z "$hub_dir" ]; then
      case "$args" in *" run $DIR/packages/cli/src/bin.ts serve"*) hub_dir="$DIR" ;; esac
    fi
    if [ -n "$hub_dir" ] && [ "$hub_dir" = "$DIR" ]; then echo "$ps_pid"; fi
  done
}

# The pids of this machine's Hub as this installer runs it (its service's main process, or its nohup process).
own_pids() {
  case "$EXISTING" in
    systemd) if systemd_ok; then systemctl --user show -p MainPID --value "$UNIT_NAME" 2>/dev/null || true; fi ;;
    launchd) if [ "$OS" = Darwin ]; then launchctl print "gui/$UID_/$LAUNCHD_LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\).*/\1/p'; fi ;;
  esac
  if nohup_pid; then echo "$pid"; fi
}

# How the Hub answering on the port runs: systemd, launchd or nohup when this installer started it, else other.
running_mode() {
  case "$EXISTING" in
    systemd) if systemd_ok && systemctl --user is-active --quiet "$UNIT_NAME"; then echo systemd && return; fi ;;
    launchd) if launchctl print "gui/$UID_/$LAUNCHD_LABEL" >/dev/null 2>&1; then echo launchd && return; fi ;;
  esac
  if nohup_pid; then echo nohup; else echo other; fi
}

# Why this machine's service is not exactly as this installer wrote it (edited, overridden by drop-ins, waiting for a
# daemon-reload); nothing when it is. The installer upgrades only a service it can vouch for: then it starts on the
# checkout, people and data directory the installer saved.
service_changed() {
  case "$EXISTING" in
    systemd)
      cmp -s "$UNIT_FILE" "$STATE_DIR/$UNIT_NAME.written" 2>/dev/null || { echo "$UNIT_FILE is not the file the installer wrote"; return 0; }
      # One query, failing closed: a property systemd does not report, or an unexpected answer, counts as changed.
      systemd_ok || { echo "no systemd user session here to check it"; return 0; }
      props=$(systemctl --user show "$UNIT_NAME" -p FragmentPath -p DropInPaths -p NeedDaemonReload 2>/dev/null) ||
        { echo "systemctl --user show failed"; return 0; }
      fragment=$(printf '%s\n' "$props" | sed -n 's/^FragmentPath=//p')
      dropins=$(printf '%s\n' "$props" | sed -n 's/^DropInPaths=//p')
      reload=$(printf '%s\n' "$props" | sed -n 's/^NeedDaemonReload=//p')
      [ "$fragment" = "$UNIT_FILE" ] || { echo "systemd loads it from ${fragment:-nowhere}, not $UNIT_FILE"; return 0; }
      [ -z "$dropins" ] || { echo "drop-ins change it: $dropins"; return 0; }
      case "$reload" in
        no) ;;
        yes) echo "its file changed on disk and systemd has not reloaded it (systemctl --user daemon-reload)" ;;
        *) echo "systemd did not say whether it needs a daemon-reload (NeedDaemonReload=${reload:-nothing})" ;;
      esac
      ;;
    launchd)
      cmp -s "$PLIST" "$STATE_DIR/$LAUNCHD_LABEL.plist.written" 2>/dev/null || echo "$PLIST is not the file the installer wrote"
      ;;
  esac
}

# service_args_problem SERVE-ARGS…: says how the installer's service file (unit or plist, when there is one) does not
# start the Hub from $DIR with exactly `run packages/cli/src/bin.ts SERVE-ARGS…` (its --data-dir among them); prints
# nothing when it does. Read from the file itself, so it holds for a stopped service too.
service_args_problem() {
  case "$EXISTING" in
    systemd)
      [ -f "$UNIT_FILE" ] || return 0
      want=""
      for a in run packages/cli/src/bin.ts "$@"; do want="$want $(sd_arg "$a")"; done
      [ "$(grep -c '^ExecStart=' "$UNIT_FILE")" = 1 ] || { echo "$UNIT_FILE has not exactly one ExecStart"; return 0; }
      case "$(grep '^ExecStart=' "$UNIT_FILE")" in
        'ExecStart="'*"$want") ;;
        *) echo "$UNIT_FILE does not start the Hub with the saved arguments (--humans $HUB_HUMANS --data-dir $HUB_DATA${RUN_PUBLIC:+ --public-url $RUN_PUBLIC})"; return 0 ;;
      esac
      grep -qxF "WorkingDirectory=$(sd_path "$DIR")" "$UNIT_FILE" || echo "$UNIT_FILE does not start the Hub from the saved checkout $DIR"
      ;;
    launchd)
      [ -f "$PLIST" ] || return 0
      want=$(for a in run packages/cli/src/bin.ts "$@"; do printf '    <string>%s</string>\n' "$(xml "$a")"; done)
      have=$(sed -n '/<key>ProgramArguments<\/key>/,/<\/array>/p' "$PLIST" | sed -e '1,3d' -e '$d')
      [ "$have" = "$want" ] || { echo "$PLIST does not start the Hub with the saved arguments (--humans $HUB_HUMANS --data-dir $HUB_DATA${RUN_PUBLIC:+ --public-url $RUN_PUBLIC})"; return 0; }
      grep -qF "<key>WorkingDirectory</key><string>$(xml "$DIR")</string>" "$PLIST" || echo "$PLIST does not start the Hub from the saved checkout $DIR"
      ;;
  esac
}

# write_unit SERVE-ARGS…: the unit, published so an interruption anywhere can be finished: its exact bytes staged in
# the state folder and the live unit's state before (its cksum, or absent) recorded, then the live unit replaced in one
# rename, then the .written copy (which says the unit is the installer's) made from the staged bytes. A later run
# finishes or drops an unfinished publication (finish_or_drop_unit) before it reads anything about the service.
write_unit() {
  mkdir -p "$(dirname "$UNIT_FILE")"
  {
    printf '# %s\n' "$OWNER"
    printf '%s\n' "[Unit]" "Description=Agent Hub on 127.0.0.1:$PORT" "After=network.target" "" "[Service]"
    printf 'WorkingDirectory=%s\n' "$(sd_path "$DIR")"
    printf 'Environment="PATH=%s:/usr/local/bin:/usr/bin:/bin"\n' "$(sd_path "$(dirname "$BUN")" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
    printf 'ExecStart=%s' "$(sd_arg "$BUN")"
    for a in run packages/cli/src/bin.ts "$@"; do printf ' %s' "$(sd_arg "$a")"; done
    printf '\n%s\n' "Restart=on-failure" "RestartSec=5" "" "[Install]" "WantedBy=default.target"
  } >"$STATE_DIR/$UNIT_NAME.staged" || die "could not write $STATE_DIR/$UNIT_NAME.staged"
  if [ -e "$UNIT_FILE" ]; then unit_before=$(cksum <"$UNIT_FILE"); else unit_before=absent; fi
  if ! { printf '%s\n' "$unit_before" >"$STATE_DIR/$UNIT_NAME.publishing.tmp" &&
    mv "$STATE_DIR/$UNIT_NAME.publishing.tmp" "$STATE_DIR/$UNIT_NAME.publishing" &&
    cp "$STATE_DIR/$UNIT_NAME.staged" "$UNIT_FILE.tmp" && mv "$UNIT_FILE.tmp" "$UNIT_FILE"; }; then
    die "could not write $UNIT_FILE"
  fi
  finish_unit
}
# finish_unit: the .written copy from the staged bytes (written whole, then renamed), systemd reloaded, and only then
# the journal removed.
finish_unit() {
  # Reloaded before the journal goes, so a run interrupted anywhere here finds it and finishes again; without a
  # systemd session to reload it, nothing of the publication is touched.
  systemd_ok || die "$UNIT_FILE was written but cannot be loaded: there is no systemd user session here. Run this again from a login session of this user; nothing of its publication was changed."
  if ! { cp "$STATE_DIR/$UNIT_NAME.staged" "$STATE_DIR/$UNIT_NAME.written.tmp" &&
    mv "$STATE_DIR/$UNIT_NAME.written.tmp" "$STATE_DIR/$UNIT_NAME.written"; }; then
    die "could not save $STATE_DIR/$UNIT_NAME.written"
  fi
  systemctl --user daemon-reload </dev/null || die "systemctl --user daemon-reload failed; run this again"
  rm -f "$STATE_DIR/$UNIT_NAME.staged" "$STATE_DIR/$UNIT_NAME.publishing"
}
# finish_or_drop_unit: an unfinished publication of the unit (its journal there) is finished when the live unit is
# the staged bytes, dropped when the live unit is still as recorded before it (the replacement never happened), and
# otherwise stops the run: the unit changed in between, by someone else.
finish_or_drop_unit() {
  [ -f "$STATE_DIR/$UNIT_NAME.publishing" ] || { rm -f "$STATE_DIR/$UNIT_NAME.staged" "$STATE_DIR/$UNIT_NAME.written.tmp"; return 0; }
  unit_before=$(cat "$STATE_DIR/$UNIT_NAME.publishing" 2>/dev/null || true)
  if [ -f "$STATE_DIR/$UNIT_NAME.staged" ] && [ -f "$UNIT_FILE" ] && cmp -s "$STATE_DIR/$UNIT_NAME.staged" "$UNIT_FILE"; then
    finish_unit
    note "Finished writing $UNIT_FILE, which an interrupted run had replaced"
  elif { [ "$unit_before" = absent ] && [ ! -e "$UNIT_FILE" ]; } ||
    { [ -f "$UNIT_FILE" ] && [ "$unit_before" = "$(cksum <"$UNIT_FILE")" ]; }; then
    rm -f "$STATE_DIR/$UNIT_NAME.staged" "$STATE_DIR/$UNIT_NAME.publishing" "$UNIT_FILE.tmp"
  else
    die "$UNIT_FILE changed while an interrupted run of this installer was writing it; it is neither what that run wrote nor what was there before. Check it, then remove $STATE_DIR/$UNIT_NAME.publishing and run this again. Nothing was changed."
  fi
}

write_plist() {
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LAUNCHD_LOG")"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
      "<!-- $OWNER -->" '<plist version="1.0">' '<dict>'
    printf '  <key>Label</key><string>%s</string>\n' "$LAUNCHD_LABEL"
    printf '  <key>ProgramArguments</key>\n  <array>\n'
    for a in "$BUN" run packages/cli/src/bin.ts "$@"; do printf '    <string>%s</string>\n' "$(xml "$a")"; done
    printf '  </array>\n  <key>WorkingDirectory</key><string>%s</string>\n' "$(xml "$DIR")"
    printf '  <key>EnvironmentVariables</key>\n  <dict><key>PATH</key><string>%s:/usr/local/bin:/usr/bin:/bin</string></dict>\n' "$(xml "$(dirname "$BUN")")"
    printf '  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n'
    printf '  <key>StandardOutPath</key><string>%s</string>\n  <key>StandardErrorPath</key><string>%s</string>\n' "$(xml "$LAUNCHD_LOG")" "$(xml "$LAUNCHD_LOG")"
    printf '%s\n' '</dict>' '</plist>'
  } >"$PLIST"
  cp "$PLIST" "$STATE_DIR/$LAUNCHD_LABEL.plist.written"
}

launchd_unload() {
  launchctl bootout "gui/$UID_/$LAUNCHD_LABEL" 2>/dev/null || true
  # bootout returns before launchd has let go of the job; bootstrap fails until it has.
  k=0
  while launchctl print "gui/$UID_/$LAUNCHD_LABEL" >/dev/null 2>&1 && [ "$k" -lt 15 ]; do
    k=$((k + 1))
    sleep 1
  done
}

start_nohup() {
  say "Starting the Hub in the background with nohup (no systemd user session or macOS login session here); log: $NOHUP_LOG"
  write_stop_script
  if command -v setsid >/dev/null 2>&1; then detach=setsid; else detach=""; fi
  # shellcheck disable=SC2086 # $detach is empty or one word
  (cd "$DIR" && exec $detach nohup "$BUN" run packages/cli/src/bin.ts "$@" >>"$NOHUP_LOG" 2>&1 </dev/null) &
  printf '%s\n' "$!" >"$PID_FILE"
}

# stop-hub.sh in the state folder, printed as the way to stop the nohup Hub. It signals only Agent Hub processes of
# the saved checkout (hub_proc, the same function as the installer's) run by the saved bun; a hub.pid naming anything
# else is left alone. Like the nohup stop in docs/operations.md, it says HUB STOPPED only once no Hub of the checkout
# is left and port 7800 refuses connections (curl exit 7; a timeout or an empty reply means something still holds
# it), within 30 s.
write_stop_script() {
  {
    printf '%s\n' '#!/bin/sh' '# Written by the Agent Hub installer (install.sh): stops the Hub it started with nohup, and nothing else.'
    printf '%s\n' "$HUB_PROC_FN"
    cat <<'EOF'
S=$(cd "$(dirname "$0")" && pwd); C=$(cat "$S/checkout" 2>/dev/null); B=$(cat "$S/bun" 2>/dev/null)
# An empty or missing saved checkout must not resolve to the current folder (cd -P "" stays where it is).
CP=""; if [ -n "$C" ]; then CP=$(cd -P "$C" 2>/dev/null && pwd -P); fi
if [ -z "$CP" ]; then echo "$S/checkout does not name an existing checkout; nothing signalled"; exit 1; fi
hubpids() { for p in $(pgrep -f ' serve' 2>/dev/null); do if [ "$(hub_proc "$p")" = "$CP" ]; then echo "$p"; fi; done; }
saved_bun() { [ -z "$B" ] || ! readlink "/proc/$1/exe" >/dev/null 2>&1 || [ "/proc/$1/exe" -ef "$B" ]; }
refused() { curl -s --max-time 2 -o /dev/null http://127.0.0.1:7800/; [ "$?" -eq 7 ]; }
P=$(cat "$S/hub.pid" 2>/dev/null)
case " $(hubpids | tr '\n' ' ') " in *" $P "*) ;; *) [ -z "$P" ] || echo "hub.pid ($P) is not a Hub of $CP; left alone" ;; esac
for p in $(hubpids); do
  if saved_bun "$p"; then kill "$p"; else echo "pid $p runs a Hub of $CP with another bun than $B; left alone"; fi
done
end=$(($(date +%s) + 30)); STOPPED=no
while [ "$(date +%s)" -lt "$end" ]; do
  if [ -z "$(hubpids)" ] && refused; then STOPPED=yes; break; fi; sleep 1
done
if [ "$STOPPED" = yes ]; then echo "HUB STOPPED"
else echo "STILL RUNNING: a Hub process or another program still uses port 7800; stop it before copying or moving data"; exit 1; fi
EOF
  } >"$STATE_DIR/stop-hub.sh"
}

# The files that say how this installer starts the Hub (the documented starts read them too), and their journal: all
# are written as NAME.new first, then the marker service-state.publishing says the set is complete, then each is renamed
# into place and the marker removed. A run that finds the marker finishes the renames; .new files without it are a set
# never completed and are dropped. So the record is never seen half old, half new.
STATE_FILES="checkout humans data-dir bun public-url"
publish_state() {
  if ! { printf '%s\n' "$DIR" >"$STATE_DIR/checkout.new" &&
    printf '%s\n' "$HUB_HUMANS" >"$STATE_DIR/humans.new" &&
    printf '%s\n' "$HUB_DATA" >"$STATE_DIR/data-dir.new" &&
    printf '%s\n' "$BUN" >"$STATE_DIR/bun.new" &&
    if [ -n "$HUB_PUBLIC" ]; then printf '%s\n' "$HUB_PUBLIC"; fi >"$STATE_DIR/public-url.new" &&
    : >"$STATE_DIR/service-state.publishing.tmp" &&
    mv "$STATE_DIR/service-state.publishing.tmp" "$STATE_DIR/service-state.publishing"; }; then
    die "could not write the Hub's saved state in $STATE_DIR"
  fi
  finish_publish
}
# finish_publish: completes a published set (an empty public-url.new means no public address).
finish_publish() {
  for f in $STATE_FILES; do
    [ -f "$STATE_DIR/$f.new" ] || continue
    if [ "$f" = public-url ] && [ ! -s "$STATE_DIR/$f.new" ]; then
      rm -f "$STATE_DIR/public-url" "$STATE_DIR/$f.new"
    else
      mv "$STATE_DIR/$f.new" "$STATE_DIR/$f" || die "could not save $STATE_DIR/$f"
    fi
  done
  rm -f "$STATE_DIR/service-state.publishing"
}
# start_hub: start the Hub in $MODE with the service arguments in "$@" (writing the unit or plist if missing).
start_hub() {
  # An existing service of this installer is started only as written and as saved: the full checks (its file the
  # installer's copy, loaded from there, no drop-ins, reloaded; its arguments and folder the saved ones), before any
  # state is written or anything started.
  if { [ "$MODE" = systemd ] && [ -f "$UNIT_FILE" ]; } || { [ "$MODE" = launchd ] && [ -f "$PLIST" ]; }; then
    changed=$(service_changed)
    [ -z "$changed" ] || die "the service was changed after install ($changed). Not starting it: check it, then run the Hub by hand ($DOCS/docs/operations.md#start-the-hub)."
    # (A new public address rewrites the service below: its old arguments are replaced, not checked.)
    if [ "$RECONFIGURE" -eq 0 ]; then
      mismatch=$(service_args_problem "$@")
      [ -z "$mismatch" ] || die "$mismatch: the service and the installer's saved state ($STATE_DIR) disagree about which data or checkout is this Hub's. Not starting it: check which one is right, then run the Hub by hand ($DOCS/docs/operations.md#start-the-hub)."
    fi
  fi
  # What the Hub starts with, saved for the next run (which reads these instead of the service's configuration),
  # published as one record: see publish_state.
  publish_state
  case "$MODE" in
    systemd)
      if [ -f "$UNIT_FILE" ] && [ "$RECONFIGURE" -eq 0 ]; then
        say "Starting the Hub with its systemd user service ($UNIT_FILE)"
      else
        say "Starting the Hub as a systemd user service: writing $UNIT_FILE, then systemctl --user enable --now"
        write_unit "$@"
      fi
      rm -f "$PID_FILE"
      systemctl --user daemon-reload </dev/null
      systemctl --user enable --quiet "$UNIT_NAME" </dev/null
      # A deliberate start: clear systemd's start rate limit and failed state from earlier stops and crashes.
      systemctl --user reset-failed "$UNIT_NAME" </dev/null 2>/dev/null || true
      systemctl --user restart "$UNIT_NAME" </dev/null || die "systemctl --user restart $UNIT_NAME failed; see journalctl --user -u $UNIT_NAME"
      ;;
    launchd)
      wrote=0
      if [ -f "$PLIST" ] && [ "$RECONFIGURE" -eq 0 ]; then
        say "Starting the Hub with its LaunchAgent ($PLIST)"
      else
        say "Starting the Hub as a LaunchAgent: writing $PLIST, then launchctl bootstrap"
        write_plist "$@"
        wrote=1
      fi
      plutil -lint "$PLIST" >/dev/null || die "$PLIST is not a valid property list (plutil -lint $PLIST)"
      rm -f "$PID_FILE"
      launchd_unload
      launchctl enable "gui/$UID_/$LAUNCHD_LABEL" 2>/dev/null || true
      if ! launchctl bootstrap "gui/$UID_" "$PLIST"; then
        [ "$wrote" -eq 1 ] || die "launchctl bootstrap gui/$UID_ $PLIST failed. Start it from a login session on this Mac, then run this again."
        warn "launchctl bootstrap failed (over SSH without a login session on this Mac?); removing $PLIST and using nohup instead."
        rm -f "$PLIST"
        MODE="nohup"
        start_nohup "$@"
      fi
      ;;
    nohup) start_nohup "$@" ;;
  esac
}

log_hint() {
  case "$MODE" in
    systemd) printf 'journalctl --user -u %s' "$UNIT_NAME" ;;
    launchd) printf '%s' "$LAUNCHD_LOG" ;;
    *) printf '%s' "$NOHUP_LOG" ;;
  esac
}

# stop_cmd MODE: the command that stops this machine's Hub in MODE.
stop_cmd() {
  case "$1" in
    systemd) printf 'systemctl --user stop %s' "$UNIT_NAME" ;;
    launchd) printf 'launchctl bootout gui/%s/%s' "$UID_" "$LAUNCHD_LABEL" ;;
    *) printf 'sh %s' "$(q "$STATE_DIR/stop-hub.sh")" ;;
  esac
}
# restore_note WHY MODE: how to go back to the version that ran before, from the first attempt's backup.
restore_note() {
  printf '%s, so to run the version that ran before:\n  1. stop it if it runs: %s\n  2. restore %s/hub.tar as in %s\n  3. then run:\n%s' \
    "$1" "$(stop_cmd "$2")" "$first_backup" "$DOCS/docs/operations.md#restore" "$back"
}
# require_as_written WHAT-INSTEAD: stops (nothing changed) unless this machine's Hub is as the installer set it up: no
# other Hub on the port, its service exactly as written (service_changed), and a running Hub started from the
# checkout with exactly the arguments the installer starts it with (its saved people, data and public address).
require_as_written() {
  instead="$1"
  if hub_answers && [ "$(running_mode)" = other ]; then
    die "a Hub this installer did not start answers on port $PORT, so this machine's Hub cannot be changed safely now. Stop that Hub, then run this again. Nothing was changed."
  fi
  changed=$(service_changed)
  case "$EXISTING" in systemd) service_file="$UNIT_NAME" ;; launchd) service_file="$LAUNCHD_LABEL.plist" ;; *) service_file="" ;; esac
  [ -z "$changed" ] || die "$service_file was changed after install ($changed); $instead. Nothing was changed."
  set -- serve --host 127.0.0.1 --port "$PORT" --humans "$HUB_HUMANS" --data-dir "$HUB_DATA" --existing-data
  [ -z "$RUN_PUBLIC" ] || set -- "$@" --public-url "$RUN_PUBLIC"
  mismatch=$(service_args_problem "$@")
  [ -z "$mismatch" ] || die "$mismatch: the service and the installer's saved state ($STATE_DIR) disagree about which data or checkout is this Hub's; $instead. Nothing was changed."
  set -- run packages/cli/src/bin.ts serve --host 127.0.0.1 --port "$PORT" --humans "$HUB_HUMANS" --data-dir "$HUB_DATA" --existing-data
  [ -z "$RUN_PUBLIC" ] || set -- "$@" --public-url "$RUN_PUBLIC"
  expected=$(printf '%s\n' "$@")
  for running_pid in $(own_pids); do
    [ "$running_pid" != 0 ] && [ -r "/proc/$running_pid/cmdline" ] || continue
    running_args=$(tr '\0' '\n' <"/proc/$running_pid/cmdline" 2>/dev/null | sed '1d')
    running_cwd=$( (cd -P "/proc/$running_pid/cwd" 2>/dev/null && pwd -P) || true)
    if [ "$running_args" != "$expected" ] || { [ -n "$running_cwd" ] && [ "$running_cwd" != "$DIR" ]; }; then
      die "the running Hub (pid $running_pid) was not started the way the installer starts it (from $DIR, with --humans $HUB_HUMANS --data-dir $HUB_DATA${RUN_PUBLIC:+ --public-url $RUN_PUBLIC}); $instead. Nothing was changed."
    fi
  done
}

# valid_ipv4 A.B.C.D: four decimal octets 0-255, no leading zeros.
valid_ipv4() {
  printf '%s\n' "$1" | awk -F. 'NF != 4 { exit 1 } { for (i = 1; i <= 4; i++) if ($i !~ /^(0|[1-9][0-9]*)$/ || length($i) > 3 || $i + 0 > 255) exit 1 }'
}
# valid_ipv6 ADDR]: an IPv6 address in brackets (the ] still on): hex groups of 1-4 digits, eight of them, or fewer
# with one ::, and an IPv4 address allowed as the last two groups.
valid_ipv6() {
  case "$1" in *]) ;; *) return 1 ;; esac
  printf '%s\n' "${1%]}" | awk '
    function v4(x, o, i) { if (split(x, o, ".") != 4) return 0
      for (i = 1; i <= 4; i++) if (o[i] !~ /^(0|[1-9][0-9]*)$/ || length(o[i]) > 3 || o[i] + 0 > 255) return 0
      return 1 }
    function groups(x, last, a, c, i) { if (x == "") return 0; c = split(x, a, ":")
      for (i = 1; i <= c; i++) {
        if (last && i == c && a[i] ~ /\./) { if (!v4(a[i])) return -1; count += 2; continue }
        if (a[i] !~ /^[0-9A-Fa-f]+$/ || length(a[i]) > 4) return -1; count++ }
      return 0 }
    $0 == "" { exit 1 }
    { n = split($0, h, "::"); if (n > 2) exit 1; count = 0
      if (groups(h[1], n == 1) < 0) exit 1
      if (n == 2 && groups(h[2], 1) < 0) exit 1
      exit !(n == 1 ? count == 8 : count <= 7) }'
}

# data_self_contained: every Hub item in the data directory is a plain file or directory, with no link or special file
# inside, and no directory on its way there (finetune of finetune/needs-you) is a link: a backup of a link would not
# hold what it points to. What cannot be read whole also stops it.
data_self_contained() {
  for i in $HUB_ITEMS; do
    j="$i"
    while :; do
      if [ -L "$HUB_DATA/$j" ]; then
        die "$j in the Hub's data ($HUB_DATA) is a link to $(readlink "$HUB_DATA/$j"); a backup would not hold what it points to. Copy it into the data directory, or back it up yourself and upgrade by hand ($DOCS/docs/operations.md#upgrade). Nothing was changed."
      fi
      case "$j" in */*) j="${j%/*}" ;; *) break ;; esac
    done
    p="$HUB_DATA/$i"
    case "$(path_presence "$p")" in
      no) continue ;;
      error) die "$i in the Hub's data ($HUB_DATA) cannot be looked at (a folder without permission?); a backup would leave it out. Fix the permissions, then run this again. Nothing was changed." ;;
    esac
    # Every file inside must be readable too, or the backup (after the Hub stopped) would fail on it.
    found=$(find "$p" \( ! -type f ! -type d -print \) -o \( -type f -exec sh -c 'for f do [ -r "$f" ] || printf "unreadable:%s\n" "$f"; done' sh {} + \) 2>/dev/null) ||
      die "$i in the Hub's data ($HUB_DATA) cannot be read whole (permissions?); a backup would not hold all of it. Nothing was changed."
    unread=$(printf '%s\n' "$found" | sed -n 's/^unreadable://p' | sed -n 1p)
    [ -z "$unread" ] ||
      die "${unread#"$HUB_DATA"/} in the Hub's data cannot be read (its permissions); a backup would fail on it after the Hub stopped. Fix its permissions, then run this again. Nothing was changed."
    odd=$(printf '%s\n' "$found" | sed -n 1p)
    if [ -n "$odd" ]; then
      if [ -L "$odd" ]; then what="a link to $(readlink "$odd")"; else what="not a regular file or directory"; fi
      die "${odd#"$HUB_DATA"/} in the Hub's data is $what; a backup would not hold it. Copy it into the data directory, or back it up yourself and upgrade by hand ($DOCS/docs/operations.md#upgrade). Nothing was changed."
    fi
  done
}

# archive_ok DIR: DIR/hub.tar is a complete Hub backup by the checks of hub_check_backup in docs/operations.md's Backup; otherwise
# $archive_problem says why. items.txt beside it names the main database and only known Hub items, none twice; the
# archive lists to the end (tar exits 0), holds only regular files and directories, has no member twice and matches
# items.txt both ways; and every database in it, with its -wal and -shm, on a throwaway copy, passes PRAGMA
# integrity_check and has the tables its service creates (an empty file passes the integrity check).
archive_ok() {
  archive_problem=""
  archive_dir="$1"
  [ -f "$1/items.txt" ] || { archive_problem="no items.txt in $1"; return 1; }
  grep -qx message-bus.sqlite "$1/items.txt" || { archive_problem="items.txt does not name message-bus.sqlite"; return 1; }
  if awk 'NF' "$1/items.txt" | sort | uniq -d | grep -q .; then archive_problem="items.txt names an item twice"; return 1; fi
  while IFS= read -r item || [ -n "$item" ]; do
    case "$item" in
      '' | message-bus.sqlite | message-bus.sqlite-wal | message-bus.sqlite-shm | files | push-vapid.json | task-ext) ;;
      task-extension.secret | status | attention-people.txt | attention.jsonl | box-reports.jsonl | finetune/needs-you) ;;
      *) archive_problem="items.txt names an unknown item: $item"; return 1 ;;
    esac
  done <"$1/items.txt"
  raw=$(tar -tf "$1/hub.tar" 2>/dev/null) || { archive_problem="hub.tar does not list to the end"; return 1; }
  # The member types and the listing by the rules of hub_check_backup in docs/operations.md's Backup (the same awk programs):
  # only regular files and directories; paths canonical (empty and . segments dropped), none absolute or with .., none
  # twice, nothing outside the items, and each item there.
  listing_problem=$(tar -tvf "$1/hub.tar" 2>/dev/null | awk '{ t = substr($0, 1, 1) } t != "-" && t != "d" { print "not a file or directory in the archive: " $0; bad = 1 } END { exit bad }') ||
    { archive_problem=$(printf '%s\n' "$listing_problem" | head -n 1); return 1; }
  listing_problem=$(printf '%s\n' "$raw" | awk 'NR == FNR { if (NF) it[$0] = 1; next }
 { abs = ($0 ~ /^\//); up = 0; n = ""; c = split($0, p, "/")
   for (k = 1; k <= c; k++) { if (p[k] == "" || p[k] == ".") continue; if (p[k] == "..") up = 1; n = (n == "" ? p[k] : n "/" p[k]) }
   if (abs || up) { print "unsafe path in the archive: " $0; bad = 1; next }
   if (n == "") next
   if (seen[n]++) { print "in the archive twice: " n; bad = 1; next }
   ok = (n in it); if (!ok) for (i in it) if (index(n, i "/") == 1) { ok = 1; break }
   if (!ok) { print "in the archive but not in items.txt: " n; bad = 1 }
   for (i in it) if (n == i || index(n, i "/") == 1) found[i] = 1 }
 END { for (i in it) if (!(i in found)) { print "missing from the archive: " i; bad = 1 }; exit bad }' "$1/items.txt" -) ||
    { archive_problem=$(printf '%s\n' "$listing_problem" | head -n 1); archive_problem="${archive_problem:-hub.tar does not match items.txt}"; return 1; }
  # Only the databases and their -wal and -shm are unpacked, by their names as listed (matched canonically, as above);
  # a database that is a directory entry is refused, and the main database must be there.
  set --
  for db in message-bus.sqlite task-ext/tasks.sqlite status/status.sqlite; do
    for f in "$db" "$db-wal" "$db-shm"; do
      m=$(printf '%s\n' "$raw" | awk -v f="$f" '{ n = ""; c = split($0, p, "/")
        for (k = 1; k <= c; k++) { if (p[k] == "" || p[k] == ".") continue; n = (n == "" ? p[k] : n "/" p[k]) } }
        n == f { print ($0 ~ /\/$/ ? "DIR" : "") $0; exit }')
      case "$m" in
        '') ;;
        DIR*) archive_problem="$f is a directory in hub.tar"; return 1 ;;
        *) set -- "$@" "$m" ;;
      esac
    done
  done
  [ $# -gt 0 ] || { archive_problem="message-bus.sqlite is not in hub.tar"; return 1; }
  check_dir=$(mktemp -d)
  verdict=""
  if tar -C "$check_dir" -xf "$archive_dir/hub.tar" "$@" 2>/dev/null; then
    for db in message-bus.sqlite task-ext/tasks.sqlite status/status.sqlite; do
      if [ -e "$check_dir/$db" ] && [ ! -f "$check_dir/$db" ]; then verdict="$db is not a file in hub.tar"; fi
    done
    [ -f "$check_dir/message-bus.sqlite" ] || verdict="${verdict:-message-bus.sqlite is not in hub.tar}"
    [ -n "$verdict" ] || verdict=$(cd "$check_dir" && "$BUN" -e '
      const { Database } = require("bun:sqlite");
      const { existsSync } = require("fs");
      const found = ["message-bus.sqlite", "task-ext/tasks.sqlite", "status/status.sqlite"].filter((f) => existsSync(f));
      let bad = "";
      for (const f of found) {
        if (bad) break;
        try {
          const db = new Database(f);
          if (db.query("PRAGMA integrity_check").all().map((r) => Object.values(r)[0]).join(" ") !== "ok") bad = f + " is damaged";
          else {
            // The tables each service creates (packages/server, packages/task-ext, packages/status-ext); an empty file
            // passes the integrity check.
            const need = { "message-bus.sqlite": ["messages", "participants"], "task-ext/tasks.sqlite": ["tasks", "task_history", "events"], "status/status.sqlite": ["asks", "updates"] }[f];
            const have = new Set(db.query("SELECT name FROM sqlite_master WHERE type = ?").all("table").map((r) => r.name));
            const missing = need.filter((t) => !have.has(t));
            if (missing.length) bad = f + " lacks the tables " + missing.join(", ");
          }
          db.close();
        } catch { bad = f + " is damaged"; }
      }
      console.log(bad || "ok");' 2>/dev/null)
  fi
  rm -rf "$check_dir"
  [ "$verdict" = ok ] || { archive_problem="${verdict:-hub.tar did not unpack or could not be checked}"; return 1; }
}

# record_ok: upgrade-recovery names a backup that passes archive_ok, and, once the checkout is there (in preflight
# only if it exists; after a fresh clone, again), a commit of it.
record_ok() {
  if [ -z "$rec_prev" ] || { [ -d "$DIR/.git" ] && ! git -C "$DIR" cat-file -e "$rec_prev^{commit}" 2>/dev/null; }; then
    archive_problem="\"$rec_prev\" is not a commit of this checkout"
    return 1
  fi
  archive_ok "$rec_backup"
}

# write_hub_commit: records $commit as the release that runs (written whole, then renamed into place).
write_hub_commit() {
  if ! { printf '%s\n' "$commit" >"$STATE_DIR/hub-commit.tmp" && mv "$STATE_DIR/hub-commit.tmp" "$STATE_DIR/hub-commit"; }; then
    die "could not record the release that runs in $STATE_DIR/hub-commit"
  fi
}

# path_presence PATH: yes, no (ls confirms it does not exist: ENOENT), or error (it cannot be looked at, say a parent
# without search permission). Only "no" may count as absent.
path_presence() {
  if [ -e "$1" ] || [ -L "$1" ]; then echo yes; return; fi
  case "$(LC_ALL=C ls -d -- "$1" 2>&1)" in *"No such file or directory"*) echo no ;; *) echo error ;; esac
}

# tree_check A B MODE: every Hub item path under A (links not followed) is in B too; with MODE full, also of the same
# type (a link with the same target) and, for a file, with the same bytes (cmp). Names are only ever passed as
# arguments, never parsed from a listing. A path counts as absent only when ls confirms it does not exist (ENOENT);
# one that cannot be looked at (a parent without search permission) is unreadable. Prints the first problem as
# "missing PATH", "differs PATH" or "unreadable PATH" and fails; it also fails, maybe without a line, when anything
# under A or B cannot be read.
tree_check() {
  (
    cd "$1" || exit 1
    for i in $HUB_ITEMS; do
      case "$(path_presence "$i")" in
        no) continue ;;
        error) printf 'unreadable %s\n' "$i"; exit 1 ;;
      esac
      find "$i" -exec sh -c '
        b=$1; mode=$2; shift 2
        for p do
          q="$b/$p"
          if [ ! -e "$q" ] && [ ! -L "$q" ]; then
            case "$(LC_ALL=C ls -d -- "$q" 2>&1)" in
              *"No such file or directory"*) printf "missing %s\n" "$p" ;;
              *) printf "unreadable %s\n" "$p" ;;
            esac
            exit 1
          fi
          [ "$mode" = full ] || continue
          if [ -L "$p" ]; then
            if [ ! -L "$q" ] || [ "$(readlink "$p")" != "$(readlink "$q")" ]; then printf "differs %s\n" "$p"; exit 1; fi
          elif [ -d "$p" ]; then
            if [ ! -d "$q" ] || [ -L "$q" ]; then printf "differs %s\n" "$p"; exit 1; fi
          elif [ -f "$p" ]; then
            if [ ! -f "$q" ] || [ -L "$q" ]; then printf "differs %s\n" "$p"; exit 1; fi
            cmp -s "$p" "$q"
            case $? in 0) ;; 1) printf "differs %s\n" "$p"; exit 1 ;; *) printf "unreadable %s\n" "$p"; exit 1 ;; esac
          else
            printf "differs %s\n" "$p"; exit 1
          fi
        done' sh "$2" "$3" {} + || exit 1
    done
  )
}

# data_matches_backup DIR: the Hub's items in $HUB_DATA are those in DIR/hub.tar, unpacked: the same paths (none
# missing, none extra: attachments in files/ too), each of the same type, every file with the same bytes. The data
# is that backup, restored, with nothing run on it since. Otherwise $data_problem names the first difference, or why
# they could not be compared (which never counts as a match).
data_matches_backup() {
  data_problem=""
  dmb=$(mktemp -d) || { data_problem="no temporary folder to unpack $1/hub.tar in"; return 1; }
  if ! mkdir "$dmb/b" || ! tar -C "$dmb/b" -xf "$1/hub.tar" 2>/dev/null; then
    data_problem="$1/hub.tar does not unpack"
  elif [ ! -f "$dmb/b/message-bus.sqlite" ] || [ -L "$dmb/b/message-bus.sqlite" ]; then
    data_problem="$1/hub.tar has no message-bus.sqlite"
  elif [ ! -f "$HUB_DATA/message-bus.sqlite" ] || [ -L "$HUB_DATA/message-bus.sqlite" ]; then
    data_problem="message-bus.sqlite is in the backup but not in the data"
  else
    rc=0; out=$(tree_check "$dmb/b" "$HUB_DATA" full 2>/dev/null) || rc=$?
    first=$(printf '%s\n' "$out" | sed -n 1p)
    if [ "$rc" -ne 0 ]; then
      case "$first" in
        "missing "*) data_problem="${first#missing } is in the backup but not in the data" ;;
        "differs "*) data_problem="${first#differs } differs from the backup (type or contents)" ;;
        "unreadable "*) data_problem="${first#unreadable } could not be read in $HUB_DATA" ;;
        *) data_problem="$1/hub.tar or $HUB_DATA could not be read whole" ;;
      esac
    else
      rc=0; out=$(tree_check "$HUB_DATA" "$dmb/b" exists 2>/dev/null) || rc=$?
      first=$(printf '%s\n' "$out" | sed -n 1p)
      if [ "$rc" -ne 0 ]; then
        case "$first" in
          "missing "*) data_problem="${first#missing } is in the data but not in the backup" ;;
          "unreadable "*) data_problem="${first#unreadable } could not be read in $HUB_DATA" ;;
          *) data_problem="$HUB_DATA could not be read whole" ;;
        esac
      fi
    fi
  fi
  rm -rf "$dmb"
  [ -z "$data_problem" ]
}

# write_recovery PREVIOUS BACKUP ATTEMPTED: the record of an upgrade under way (written whole, then renamed into
# place): the release that ran before, the backup from before the first attempt, and the release last tried, which
# may have changed the database.
write_recovery() {
  if ! { printf '%s\n%s\n%s\n' "$1" "$2" "$3" >"$recovery.tmp" && mv "$recovery.tmp" "$recovery"; }; then
    die "could not write $recovery"
  fi
}

# slug_ids RAW: prints the ids the Hub makes of the comma-separated people RAW, each followed by a comma: its own
# slugifyId from the checkout's packages/protocol, run with Bun (the installation's saved Bun, else the one on PATH or
# in ~/.bun); a copy of it where the checkout is not there. Fails without Bun.
slug_ids() {
  slug_bun=$(cat "$STATE_DIR/bun" 2>/dev/null || true)
  [ -x "$slug_bun" ] || slug_bun=$(command -v bun || true)
  [ -x "$slug_bun" ] || slug_bun="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
  [ -x "$slug_bun" ] || { printf 'no Bun here'; return 1; }
  SLUG_RAW="$1" SLUG_SRC="$DIR/packages/protocol/src/address.ts" "$slug_bun" -e '
    const slug = require("fs").existsSync(process.env.SLUG_SRC) ? require(process.env.SLUG_SRC).slugifyId
      : (s) => s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 48);
    process.stdout.write(process.env.SLUG_RAW.split(",").map(slug).join(",") + ",");'
}

# verify_listener exact COMMIT SERVE-ARGS… | verify_listener any COMMIT: the Hub answering on 127.0.0.1:$PORT is this
# installation's own process: its service's (or nohup's) pid ($vpid), running from $DIR (with exactly
# `run packages/cli/src/bin.ts SERVE-ARGS…` when exact), holding the listening socket on 127.0.0.1:$PORT itself (not
# another address on that port), and reporting the version of COMMIT. Otherwise returns 1, with $verify_problem saying
# why. Linux reads /proc; elsewhere (macOS) lsof; with neither it cannot tell, and fails.
verify_listener() {
  verify_problem=""
  vmode="$1"
  vcommit="$2"
  shift 2
  vpid=""
  for p in $(own_pids); do if [ "$p" != 0 ]; then vpid="$p" && break; fi; done
  [ -n "$vpid" ] || { verify_problem="no process of this installation's Hub runs"; return 1; }
  if [ -r "/proc/$vpid/cmdline" ]; then
    if [ "$vmode" = exact ] && [ "$(tr '\0' '\n' <"/proc/$vpid/cmdline" 2>/dev/null | sed '1d')" != "$(printf '%s\n' run packages/cli/src/bin.ts "$@")" ]; then
      verify_problem="its process (pid $vpid) does not run with the arguments this run started it with"
      return 1
    fi
    [ "$( (cd -P "/proc/$vpid/cwd" 2>/dev/null && pwd -P) || true)" = "$DIR" ] ||
      { verify_problem="its process (pid $vpid) does not run from $DIR"; return 1; }
  fi
  vlive=$(health | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')
  vwant=$(commit_version "$vcommit")
  if [ -z "$vwant" ] || [ "$vlive" != "$vwant" ]; then
    verify_problem="it reports version ${vlive:-none}, $(git -C "$REPO_DIR" rev-parse --short "$vcommit" 2>/dev/null || printf '%s' "$vcommit") is ${vwant:-unknown}"
    return 1
  fi
  vfound=0
  if [ -r /proc/net/tcp ] && [ -d "/proc/$vpid/fd" ]; then
    # 127.0.0.1:PORT as /proc/net/tcp writes it (the address in host byte order: either end), or v4-mapped in tcp6.
    vport=$(printf '%04X' "$PORT")
    vinodes=$(awk -v p="$vport" 'FNR > 1 && $4 == "0A" && ($2 == "0100007F:" p || $2 == "7F000001:" p ||
      $2 == "0000000000000000FFFF00000100007F:" p || $2 == "0000000000000000FFFF00007F000001:" p ||
      $2 == "00000000000000000000FFFF0100007F:" p) { print $10 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null)
    # (Names listed with ls: the installer runs with globbing off, and fd names are numbers.)
    # shellcheck disable=SC2045
    for fd in $(ls "/proc/$vpid/fd" 2>/dev/null); do
      l=$(readlink "/proc/$vpid/fd/$fd" 2>/dev/null) || continue
      for ino in $vinodes; do if [ "$l" = "socket:[$ino]" ]; then vfound=1; fi; done
    done
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -nP -a -p "$vpid" -iTCP@127.0.0.1:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then vfound=1; fi
  else
    verify_problem="neither /proc nor lsof here to tell which process listens on 127.0.0.1:$PORT"
    return 1
  fi
  [ "$vfound" -eq 1 ] || { verify_problem="127.0.0.1:$PORT is held by another process than this Hub's (pid $vpid)"; return 1; }
}

# Whether the process PID started at least two seconds after the checkout's HEAD last moved (by git's reflog; whole
# seconds, hence the margin). Fails when either time cannot be told.
started_after_head_moved() {
  age=$(ps -o etimes= -p "$1" 2>/dev/null | tr -d ' ' || true)
  moved=$(git -C "$DIR" reflog -1 --date=unix --format=%gd HEAD 2>/dev/null | sed -n 's/.*{\([0-9][0-9]*\)}.*/\1/p')
  case "$age" in '' | *[!0-9]*) return 1 ;; esac
  [ -n "$moved" ] && [ "$(($(date +%s) - age))" -ge $((moved + 2)) ]
}

# stop_verified MODE: stops the Hub run by MODE (and a nohup Hub this installer started), whether or not it answers
# right now (a service between automatic restarts does not). Returns 0 only when it is verifiably down: the manager
# says so, no Hub process runs from the checkout, the port is free; otherwise $stop_problem says what is left.
stop_verified() {
  stop_problem=""
  case "$1" in
    systemd)
      if systemd_ok; then
        systemctl --user stop "$UNIT_NAME" </dev/null || stop_problem="systemctl --user stop $UNIT_NAME failed"
        state=$(systemctl --user show -p ActiveState --value "$UNIT_NAME" 2>/dev/null || true)
        case "$state" in inactive | failed) ;; *) stop_problem="$UNIT_NAME is still $state after systemctl --user stop" ;; esac
      else
        stop_problem="no systemd user session here to stop $UNIT_NAME"
      fi
      ;;
    launchd)
      if [ "$OS" = Darwin ]; then
        launchd_unload
        ! launchctl print "gui/$UID_/$LAUNCHD_LABEL" >/dev/null 2>&1 || stop_problem="launchd still has $LAUNCHD_LABEL after launchctl bootout"
      fi
      ;;
  esac
  if nohup_pid; then
    kill "$pid" 2>/dev/null || true
    k=0
    while nohup_pid && [ "$k" -lt 30 ]; do
      k=$((k + 1))
      sleep 1
    done
  fi
  left=$(checkout_pids | tr '\n' ' ')
  [ -z "$left" ] || stop_problem="${stop_problem:+$stop_problem; }a Hub process still runs from $DIR (pid ${left% })"
  [ -n "$stop_problem" ] || wait_for down 30 || stop_problem="port $PORT is still in use"
  [ -z "$stop_problem" ]
}
stop_existing() { stop_verified "$EXISTING" || die "could not stop this machine's Hub: $stop_problem. The checkout and the data are unchanged."; }

# The Hub's data as docs/operations.md backs it up, with the Hub stopped.
backup_data() {
  [ -f "$HUB_DATA/message-bus.sqlite" ] ||
    die "the Hub's database $HUB_DATA/message-bus.sqlite is missing, so there is nothing to back up from where this Hub keeps its data. Not upgrading; check its data directory (--data-dir or AGENT_BUS_DATA_DIR of its service). The Hub is stopped."
  BACKUP="$HOME/agent-bus-backup-$(date +%Y%m%d-%H%M%S)"
  while [ -e "$BACKUP" ]; do BACKUP="$BACKUP-1"; done
  mkdir -m 700 "$BACKUP" || die "could not create $BACKUP for the backup; the Hub is stopped and its data untouched"
  for i in $HUB_ITEMS; do
    case "$(path_presence "$HUB_DATA/$i")" in
      yes) printf '%s\n' "$i" ;;
      no) ;;
      *) die "$i in the Hub's data ($HUB_DATA) cannot be looked at (a folder without permission?); a backup would leave it out. The Hub is stopped and its data untouched; fix the permissions, then run this again." ;;
    esac
  done >"$BACKUP/items.txt"
  tar -C "$HUB_DATA" -cf "$BACKUP/hub.tar" -T "$BACKUP/items.txt" || die "the backup into $BACKUP failed; the Hub is stopped and its data untouched"
  archive_ok "$BACKUP" ||
    die "the backup in $BACKUP is not complete ($archive_problem). Not upgrading without a backup that a restore would accept; the Hub is stopped and its data untouched (check the data, then run this again; to start the Hub as it was, follow the steps below)."
  note "Backed up the Hub's data to $BACKUP/hub.tar (restore: $DOCS/docs/operations.md#restore)"
}

# resolve_ref: the commit $REF names in the checkout: the release tag as fetched by this installer, else a local tag,
# a branch of origin, or a commit.
resolve_ref() {
  git -C "$REPO_DIR" rev-parse -q --verify "refs/agent-hub-installer/tags/$REF^{commit}" 2>/dev/null ||
    git -C "$REPO_DIR" rev-parse -q --verify "refs/tags/$REF^{commit}" 2>/dev/null ||
    git -C "$REPO_DIR" rev-parse -q --verify "refs/remotes/origin/$REF^{commit}" 2>/dev/null ||
    git -C "$REPO_DIR" rev-parse -q --verify "$REF^{commit}" 2>/dev/null
}

# commit_version COMMIT: the protocol version that commit's server reports in /api/health.
commit_version() {
  git -C "$REPO_DIR" show "$1:packages/protocol/src/types.ts" 2>/dev/null | sed -n 's/^export const PROTOCOL_VERSION = "\([^"]*\)".*/\1/p'
}

# ran_release: sets $ran_commit to the commit that last ran on the Hub's data (a pending upgrade-recovery record is
# handled before, and decides instead). The checkout's commit ($head) and the one this installer, or a documented start,
# last recorded ($recorded) agree, or one is missing: that one. They differ: with the Hub stopped, nothing tells (a
# checkout changed by hand): the Hub has to run first. With it running, the one whose version the Hub reports in
# /api/health, and when both have that version, the one checked out when its process started (by whole seconds, so
# only with two seconds between them). A running Hub must also report that commit's version. Otherwise returns 1,
# with $ran_problem saying why.
ran_release() {
  ran_problem=""
  ran_advice="Start the Hub on the release that should run ($DOCS/docs/operations.md#start-the-hub), then run this again, so the version it reports decides"
  if [ -z "$head" ] && [ -z "$recorded" ]; then
    ran_problem="the checkout is missing and the installer has no record of the release that ran"
    ran_advice="Put the checkout back at $DIR, or upgrade by hand ($DOCS/docs/operations.md#upgrade)"
    return 1
  fi
  if [ -z "$head" ] || [ -z "$recorded" ] || [ "$head" = "$recorded" ]; then ran_commit="${recorded:-$head}"; else ran_commit=""; fi
  run_pid=""
  for p in $(own_pids); do if [ "$p" != 0 ]; then run_pid="$p" && break; fi; done
  short_head=$(git -C "$REPO_DIR" rev-parse --short "$head" 2>/dev/null || printf '%s' "$head")
  short_rec=$(git -C "$REPO_DIR" rev-parse --short "$recorded" 2>/dev/null || printf '%s' "$recorded")
  if [ -z "$ran_commit" ]; then
    if [ -z "$run_pid" ]; then
      ran_problem="the checkout is at $short_head but the installer last started $short_rec, and the Hub is not running to say which of them ran last (a checkout changed by hand, such as a manual rollback)"
    else
      live=$(health | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')
      v_head=$(commit_version "$head")
      v_rec=$(commit_version "$recorded")
      if [ -n "$live" ] && [ "$v_head" = "$live" ] && [ "$v_rec" != "$live" ]; then
        ran_commit="$head"
      elif [ -n "$live" ] && [ "$v_rec" = "$live" ] && [ "$v_head" != "$live" ]; then
        ran_commit="$recorded"
      else
        # The same version (or none): by when the process started against the checkout's last change.
        age=$(ps -o etimes= -p "$run_pid" 2>/dev/null | tr -d ' ' || true)
        moved=$(git -C "$REPO_DIR" reflog -1 --date=unix --format=%gd HEAD 2>/dev/null | sed -n 's/.*{\([0-9][0-9]*\)}.*/\1/p')
        case "$age" in '' | *[!0-9]*) age="" ;; esac
        if [ -n "$age" ] && [ -n "$moved" ]; then
          started=$(($(date +%s) - age))
          if [ "$started" -ge $((moved + 2)) ]; then ran_commit="$head"; elif [ "$started" -le $((moved - 2)) ]; then ran_commit="$recorded"; fi
        fi
      fi
      [ -n "$ran_commit" ] ||
        ran_problem="the checkout is at $short_head, the installer last started $short_rec, the running Hub (pid $run_pid) reports version ${live:-none}, and when it started compared to the checkout's last change cannot be told"
    fi
  fi
  if [ -n "$ran_commit" ] && [ -n "$run_pid" ]; then
    live=$(health | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')
    want=$(commit_version "$ran_commit")
    if [ -n "$want" ] && [ "$live" != "$want" ]; then
      ran_problem="the running Hub reports version ${live:-none}, but $(git -C "$REPO_DIR" rev-parse --short "$ran_commit" 2>/dev/null || printf '%s' "$ran_commit") has version $want (the checkout is at $short_head, the installer last started $short_rec)"
      ran_commit=""
    fi
  fi
  [ -n "$ran_commit" ]
}

# need_manager: the service manager that runs this machine's Hub is reachable here, to stop and start it.
need_manager() {
  case "$EXISTING" in
    systemd) systemd_ok || die "$UNIT_FILE is this machine's Hub, but there is no systemd user session here to stop and start it. Run this again from a login session of this user (over SSH, one with systemd --user, or after loginctl enable-linger $(id -un)). Nothing was changed." ;;
    launchd) gui_ok || die "$PLIST is this machine's Hub, but there is no login session on this Mac here (over SSH?) to stop and start it. Log in at the Mac, then run this again there. Nothing was changed." ;;
  esac
}

main() {
  NAME="${AGENT_HUB_NAME:-}"
  TOOLS="${AGENT_HUB_TOOLS:-}"
  PUBLIC_URL=""
  PUBLIC_SET=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) [ $# -ge 2 ] || die "--name needs a value"; NAME="$2"; shift 2 ;;
      --name=*) NAME="${1#--name=}"; shift ;;
      --tools) [ $# -ge 2 ] || die "--tools needs a value"; TOOLS="$2"; shift 2 ;;
      --tools=*) TOOLS="${1#--tools=}"; shift ;;
      --public-url) [ $# -ge 2 ] || die "--public-url needs a value (\"\" removes it)"; PUBLIC_URL="$2"; PUBLIC_SET=1; shift 2 ;;
      --public-url=*) PUBLIC_URL="${1#--public-url=}"; PUBLIC_SET=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option $1 (see --help)" ;;
    esac
  done
  if [ "$PUBLIC_SET" -eq 1 ] && [ -n "$PUBLIC_URL" ]; then
    # https://HOST[:PORT] and at most one trailing slash: no path (the website adds /auth), credentials, query or
    # fragment; HOST a name or a [v6 address], PORT 1-65535.
    PUBLIC_URL="${PUBLIC_URL%/}"
    bad_url() { die "--public-url: \"$1\" is not https://HOST or https://HOST:PORT (no path, user, query or fragment; \"\" removes it). Nothing was changed."; }
    case "$PUBLIC_URL" in https://*) ;; *) bad_url "$PUBLIC_URL" ;; esac
    url_rest="${PUBLIC_URL#https://}"
    case "$url_rest" in */* | *\?* | *#* | *@* | *[[:space:]]* | *\"* | *\'* | *\\*) bad_url "$PUBLIC_URL" ;; esac
    url_port=""
    case "$url_rest" in
      \[*\]) url_host="$url_rest" ;;
      \[*\]:*) url_port="${url_rest##*]:}"; url_host="${url_rest%:"$url_port"}" ;;
      *:*) url_host="${url_rest%%:*}"; url_port="${url_rest#*:}"; [ -n "$url_port" ] || bad_url "$PUBLIC_URL" ;;
      *) url_host="$url_rest" ;;
    esac
    case "$url_host" in
      \[*\]) valid_ipv6 "${url_host#[}" || bad_url "$PUBLIC_URL" ;;
      '' | .* | *..* | *[!A-Za-z0-9.-]*) bad_url "$PUBLIC_URL" ;;
      *)
        # As a browser reads a host (WHATWG URL): one whose last label is a number must be a whole IPv4 address.
        url_last="${url_host%.}"
        url_last="${url_last##*.}"
        case "$url_last" in
          *[!0-9]*) case "$url_last" in 0[xX]*) valid_ipv4 "$url_host" || bad_url "$PUBLIC_URL" ;; esac ;;
          *) valid_ipv4 "$url_host" || bad_url "$PUBLIC_URL" ;;
        esac
        ;;
    esac
    case "$url_rest" in *:) bad_url "$PUBLIC_URL" ;; esac
    if [ -n "$url_port" ]; then
      case "$url_port" in *[!0-9]* | 0*) bad_url "$PUBLIC_URL" ;; esac
      [ "${#url_port}" -le 5 ] && [ "$url_port" -le 65535 ] || bad_url "$PUBLIC_URL"
    fi
  fi

  REPO="${AGENT_HUB_REPO:-$REPO_DEFAULT}"
  REF="${AGENT_HUB_REF:-$REF_DEFAULT}"
  DIR="${AGENT_HUB_DIR:-$HOME/agent-hub}"
  case "$DIR" in /*) ;; *) DIR="$(pwd)/$DIR" ;; esac
  DIR="${DIR%/}"
  [ ! -d "$DIR" ] || DIR=$(canon "$DIR")
  DATA_DIR="${AGENT_BUS_DATA_DIR:-$HOME/.agent-bus}"
  case "$DATA_DIR" in /*) ;; *) DATA_DIR="$(pwd)/$DATA_DIR" ;; esac
  STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub"
  OS=$(uname -s)
  UID_=$(id -u)
  UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT_NAME"
  PLIST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
  LAUNCHD_LOG="$HOME/Library/Logs/agent-hub.log"
  PID_FILE="$STATE_DIR/hub.pid"
  NOHUP_LOG="$STATE_DIR/hub.log"

  [ "$UID_" -ne 0 ] || warn "Running as root: the Hub, its data and the agent-bus command will belong to root. Run it as your own user unless that is what you want."

  case "$TOOLS" in
    '' | auto | none) ;;
    *)
      for t in $(printf '%s' "$TOOLS" | tr ',' ' '); do
        case " $KNOWN_TOOLS " in *" $t "*) ;; *) die "--tools: unknown tool \"$t\" (known: $(printf '%s' "$KNOWN_TOOLS" | tr ' ' ','), or auto, none)" ;; esac
      done
      ;;
  esac

  # 1. The name, checked against a Hub this installer set up before: nothing changes until it fits.
  if [ -z "$NAME" ]; then
    have_tty || die "no name given and no terminal to ask on. Run it with your name: ... | sh -s -- --name NAME"
    ask "Your name on the Hub (short and lowercase, e.g. maya): "
    NAME="$answer"
  fi
  NAME=$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')
  case "$NAME" in
    '' | all | [-_]* | *[-_] | *[!a-z0-9_-]*) die "\"$NAME\" cannot be a name on the Hub: use lowercase letters, digits, - and _ (e.g. maya)" ;;
    system | resources | task | status) die "\"$NAME\" cannot be a name on the Hub: the Hub keeps it for itself. Choose another name. Nothing was changed." ;;
  esac
  [ "${#NAME}" -le 48 ] || die "the name is longer than 48 characters"

  # One run of this installer at a time for this user's installation (whatever its AGENT_HUB_DIR: the service, port
  # and state are shared), from here, before any of the service's or installer's state is read, to the end. The lock
  # is a symlink in the state folder whose target is the run's pid, made in one step, so it is never there without its
  # owner; anything already at its path (a directory too, into which ln would link) means taken. A lock whose run is
  # gone, still so a second later and more than 10 minutes old, is taken over under a second lock (LOCK_GUARD), so two
  # runs never take over at once and nothing ever moves or removes a lock a live run holds.
  if [ ! -d "$STATE_DIR" ]; then
    mkdir -p "$STATE_DIR" || die "could not create $STATE_DIR"
    STATE_MADE="$STATE_DIR"
  fi
  lock="$STATE_DIR/install.lock"
  lock_taken() {
    die "another run of this installer (pid ${holder:-unknown}) holds $lock: it is installing or updating this machine's Hub. Wait for it to finish, then run this again. If none runs: a lock whose run ended is taken over 10 minutes after it was made; anything else at that path (or a $lock.takeover left behind) you remove yourself. Nothing was changed."
  }
  # link_lock PATH: makes PATH a symlink to this run's pid, only if nothing was there.
  link_lock() {
    [ ! -e "$1" ] && [ ! -L "$1" ] || return 1
    ln -s "$$" "$1" 2>/dev/null || return 1
    if [ -L "$1" ] && [ "$(readlink "$1" 2>/dev/null)" = "$$" ]; then return 0; fi
    # A directory appeared at PATH and ln linked inside it: undo that.
    if [ -L "$1/$$" ] && [ "$(readlink "$1/$$" 2>/dev/null)" = "$$" ]; then rm -f "$1/$$"; fi
    return 1
  }
  if link_lock "$lock"; then
    INSTALL_LOCK="$lock"
  else
    holder=""
    [ ! -L "$lock" ] || holder=$(readlink "$lock" 2>/dev/null || true)
    case "$holder" in '' | *[!0-9]*) lock_taken ;; esac
    if kill -0 "$holder" 2>/dev/null || [ -z "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then lock_taken; fi
    sleep 1
    link_lock "$lock.takeover" || lock_taken
    LOCK_GUARD="$lock.takeover"
    # Under the guard only this run may replace a lock; one that is still the same dead run's is removed and taken.
    if [ ! -L "$lock" ] || [ "$(readlink "$lock" 2>/dev/null || true)" != "$holder" ] || kill -0 "$holder" 2>/dev/null; then lock_taken; fi
    rm -f "$lock"
    link_lock "$lock" || lock_taken
    INSTALL_LOCK="$lock"
    rm -f "$LOCK_GUARD"
    LOCK_GUARD=""
    note "Took over the lock of an installer run that ended (pid $holder)"
  fi
  # The saved state as the last run left it: a published set finished, a set never completed dropped.
  if [ -f "$STATE_DIR/service-state.publishing" ]; then
    finish_publish
    note "Finished saving the state an interrupted run had written ($STATE_DIR)"
  else
    for f in $STATE_FILES; do rm -f "$STATE_DIR/$f.new"; done
  fi
  # The unit as the last run left it: a publication it had begun, finished or dropped.
  finish_or_drop_unit

  # The agent-hub.service systemd would run (Linux, with a user session) is none, or the installer's own file: a unit
  # from anywhere else (say /etc/systemd/user) is one the installer must not shadow or replace. Asked before anything
  # changes; if systemd cannot say, nothing changes either.
  if systemd_ok; then
    unit_props=$(systemctl --user show "$UNIT_NAME" -p LoadState -p FragmentPath -p DropInPaths -p NeedDaemonReload 2>/dev/null) ||
      die "could not ask systemd about $UNIT_NAME (systemctl --user show failed). Nothing was changed."
    unit_load=$(printf '%s\n' "$unit_props" | sed -n 's/^LoadState=//p')
    unit_fragment=$(printf '%s\n' "$unit_props" | sed -n 's/^FragmentPath=//p')
    [ -n "$unit_load" ] || die "could not ask systemd about $UNIT_NAME (no LoadState). Nothing was changed."
    if [ -n "$unit_fragment" ] && [ "$unit_fragment" != "$UNIT_FILE" ]; then
      die "systemd runs $UNIT_NAME from $unit_fragment, not from the installer's $UNIT_FILE; this installer does not shadow or replace a service it did not write. Nothing was changed."
    fi
    if [ -z "$unit_fragment" ] && [ "$unit_load" != not-found ]; then
      die "systemd knows $UNIT_NAME ($unit_load) but not from the installer's $UNIT_FILE; this installer does not shadow or replace a service it did not write. Nothing was changed."
    fi
    unit_dropins=$(printf '%s\n' "$unit_props" | sed -n 's/^DropInPaths=//p')
    if [ ! -f "$UNIT_FILE" ] && [ -n "$unit_dropins" ]; then
      die "drop-ins for $UNIT_NAME already exist ($unit_dropins); they would change the service this installer writes. Remove them, or run the Hub by hand. Nothing was changed."
    fi
  fi
  # This machine's Hub as this installer set it up: its service file (or nohup), and what it starts with, as the
  # installer saved it in the state folder at each start. The service's own configuration is not read: an upgrade
  # goes ahead only for a service exactly as the installer wrote it (service_changed).
  EXISTING=""
  HUB_HUMANS=""
  HUB_DATA=""
  HUB_DIR=""
  if [ -f "$UNIT_FILE" ]; then
    ours "$UNIT_FILE" || die "$UNIT_FILE exists and was not written by this installer: not touching it."
    EXISTING="systemd"
  elif [ -f "$PLIST" ]; then
    ours "$PLIST" || die "$PLIST exists and was not written by this installer: not touching it."
    EXISTING="launchd"
  elif [ -f "$STATE_DIR/humans" ]; then
    EXISTING="nohup"
  fi
  if [ -n "$EXISTING" ]; then
    HUB_HUMANS=$(cat "$STATE_DIR/humans" 2>/dev/null || true)
    HUB_DATA=$(cat "$STATE_DIR/data-dir" 2>/dev/null || true)
    HUB_DIR=$(cat "$STATE_DIR/checkout" 2>/dev/null || true)
    [ -n "$HUB_HUMANS" ] && [ -n "$HUB_DATA" ] && [ -n "$HUB_DIR" ] ||
      die "this machine's Hub has no complete record of how the installer started it ($STATE_DIR: checkout, humans, data-dir). Run or upgrade it by hand: $DOCS/docs/operations.md#upgrade. Nothing was changed."
    case "$HUB_DATA" in /*) ;; *) HUB_DATA="$HUB_DIR/$HUB_DATA" ;; esac
    HUB_DIR=$(canon "${HUB_DIR%/}")
    [ -z "${AGENT_HUB_DIR:-}" ] || [ "$DIR" = "$HUB_DIR" ] ||
      die "this machine's Hub runs from $HUB_DIR, but AGENT_HUB_DIR is $DIR. Run this again without AGENT_HUB_DIR, or with AGENT_HUB_DIR=$(q "$HUB_DIR"). Nothing was changed."
    DIR="$HUB_DIR"
    # The stop command this run prints, whatever it ends up doing.
    [ "$EXISTING" != nohup ] || write_stop_script
    # As the server reads --humans: each entry made an id by its own slugifyId (packages/protocol, run with Bun).
    hub_ids=$(slug_ids "$HUB_HUMANS") ||
      die "could not read the saved people ($HUB_HUMANS) as the Hub does: $hub_ids. Nothing was changed."
    case ",$hub_ids" in
      *",$NAME,"*) ;;
      *)
        case "$EXISTING" in
          systemd) how="stop it and remove its service (systemctl --user disable --now $UNIT_NAME; rm $(q "$UNIT_FILE")), write $HUB_HUMANS,$NAME into $(q "$STATE_DIR/humans")" ;;
          launchd) how="stop it and remove its LaunchAgent (launchctl bootout gui/$UID_/$LAUNCHD_LABEL; rm $(q "$PLIST")), write $HUB_HUMANS,$NAME into $(q "$STATE_DIR/humans")" ;;
          nohup) how="stop it ($(stop_cmd nohup)), write $HUB_HUMANS,$NAME into $(q "$STATE_DIR/humans")" ;;
        esac
        die "this machine's Hub, set up by this installer, signs in only: $HUB_HUMANS. A sign-in link for $NAME would not work.
  To sign in as one of them: run this again with --name $(printf '%s' "$HUB_HUMANS" | cut -d, -f1).
  To add $NAME to it: $how; then run this again with --name $NAME (it starts the Hub again with both)."
        ;;
    esac
  else
    HUB_HUMANS="$NAME"
    HUB_DATA="$DATA_DIR"
  fi
  # The Hub's public address: what it runs with now (saved at its last start), and what it is to start with. A new
  # value given here changes an unchanged service of this installer (RECONFIGURE), and restarts the Hub.
  RUN_PUBLIC=""
  [ -z "$EXISTING" ] || RUN_PUBLIC=$(cat "$STATE_DIR/public-url" 2>/dev/null || true)
  HUB_PUBLIC="$RUN_PUBLIC"
  [ "$PUBLIC_SET" -eq 0 ] || HUB_PUBLIC="$PUBLIC_URL"
  RECONFIGURE=0
  if [ -n "$EXISTING" ] && [ "$HUB_PUBLIC" != "$RUN_PUBLIC" ]; then RECONFIGURE=1; fi
  # git works in REPO_DIR: the checkout, or until a fresh clone is moved into place, that clone.
  REPO_DIR="$DIR"

  # A first run of this installer (none of its state) on data a Hub already has: with a Hub (not this installer's)
  # answering, this run only uses that Hub, and stops if it goes away before the end; with none answering, it is a Hub
  # run by hand, stopped, whose release is not known, so no release is started on it. Unless the database is the one
  # an interrupted run of this installer created: new-database names it, and the release it was for, which may resume.
  new_db_record="$STATE_DIR/new-database"
  REUSE_ONLY=0
  RESUME_DB=""
  BOOT_TAKEN=0
  if [ -z "$EXISTING" ]; then
    if hub_answers; then
      # The listener may be the first start of an interrupted run of this installer (its record names this data): one
      # process from this checkout with exactly the arguments that first start has, answering with the recorded
      # release's version. That one is stopped and the install finished; anything else is a Hub run by hand.
      boot_pid=""
      if [ -f "$new_db_record" ] && [ "$(sed -n 1p "$new_db_record")" = "$HUB_DATA" ] && [ "$(running_mode)" = other ]; then
        boot_commit=$(sed -n 2p "$new_db_record")
        boot_want=$(printf '%s\n' run packages/cli/src/bin.ts serve --host 127.0.0.1 --port "$PORT" --humans "$HUB_HUMANS" --data-dir "$HUB_DATA")
        boot_live=$(health | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')
        boot_n=0
        for p in $(checkout_pids); do
          boot_n=$((boot_n + 1))
          [ -r "/proc/$p/cmdline" ] || continue
          [ "$(tr '\0' '\n' <"/proc/$p/cmdline" 2>/dev/null | sed '1d')" = "$boot_want" ] || continue
          [ "$( (cd -P "/proc/$p/cwd" 2>/dev/null && pwd -P) || true)" = "$DIR" ] || continue
          boot_pid="$p"
        done
        if [ "$boot_n" -ne 1 ] || [ -z "$boot_live" ] || [ "$boot_live" != "$(commit_version "$boot_commit")" ]; then boot_pid=""; fi
      fi
      if [ -n "$boot_pid" ]; then
        # Only for the release that run was for: what this run asks for (a branch fetched now, while the first start
        # still runs) must be that commit. Checked before the first start is stopped; the rest of the run uses it.
        # The checkout is checked as step 3 checks it, before anything is fetched or stopped.
        [ -d "$DIR/.git" ] || die "$DIR exists but is not a git checkout. Move it away, or set AGENT_HUB_DIR to another folder. Nothing was changed."
        boot_origin=$(git -C "$DIR" remote get-url origin 2>/dev/null || true)
        [ "$(norm_url "$boot_origin")" = "$(norm_url "$REPO")" ] ||
          die "$DIR is a checkout of \"$boot_origin\", not $REPO. Not touching it; set AGENT_HUB_DIR to another folder. Nothing was changed."
        [ -z "$(git -C "$DIR" status --porcelain)" ] ||
          die "$DIR has local changes (git -C $(q "$DIR") status). Not touching it: commit or stash them, or set AGENT_HUB_DIR to another folder. Nothing was changed."
        git -C "$DIR" fetch --quiet --no-tags origin "+refs/heads/*:refs/remotes/origin/*" "+refs/tags/*:refs/agent-hub-installer/tags/*" </dev/null ||
          die "git fetch in $DIR failed, so whether $REF is still the release the interrupted install was for cannot be told. Its first start (pid $boot_pid) still runs. Nothing was changed."
        boot_req=$(resolve_ref || true)
        [ "$boot_req" = "$boot_commit" ] ||
          die "the first start of an interrupted install of $(git -C "$REPO_DIR" rev-parse --short "$boot_commit" 2>/dev/null || printf '%s' "$boot_commit") still runs (pid $boot_pid), but this run asks for $REF${boot_req:+ ($(git -C "$REPO_DIR" rev-parse --short "$boot_req" 2>/dev/null))}. Run the installer of that release (AGENT_HUB_REF=$boot_commit with the same command) to finish it. Nothing was changed."
        note "The first start of an interrupted install of this Hub still runs (pid $boot_pid): stopping it to finish that install"
        kill "$boot_pid" 2>/dev/null || true
        wait_for down 30 || die "the first start of an interrupted install (pid $boot_pid) did not stop; stop it, then run this again. Nothing else was changed."
        RESUME_DB="$boot_commit"
        BOOT_TAKEN=1
      else
        [ "$(running_mode)" != other ] || REUSE_ONLY=1
      fi
    elif [ -f "$HUB_DATA/message-bus.sqlite" ]; then
      if [ -f "$new_db_record" ] && [ "$(sed -n 1p "$new_db_record")" = "$HUB_DATA" ]; then
        RESUME_DB=$(sed -n 2p "$new_db_record")
        note "Resuming the install that created $HUB_DATA/message-bus.sqlite (recorded in $new_db_record)"
      else
        die "$HUB_DATA already holds a Hub's database (message-bus.sqlite), but this installer never started a Hub on it (a Hub run by hand?). Not starting a release on a database whose release is not known: upgrade that Hub by hand ($DOCS/docs/operations.md#upgrade), or set AGENT_BUS_DATA_DIR to an empty folder for a new Hub. Nothing was changed."
      fi
    fi
  fi

  # This machine's Hub as the installer set it up, but another Hub answers on its port: nothing here may act on that
  # one, nor on this installation's data for it (an invite minted into a database it does not open). Only a first
  # install (no installation) may use a Hub it did not start, reuse-only, above. Whose Hub it is, its service manager
  # says: without one here (systemd or a Mac login session), the run stops at that.
  if [ -n "$EXISTING" ] && hub_answers; then
    need_manager
    if [ "$(running_mode)" = other ]; then
      die "port $PORT is used by another Hub (not this installation's); stop it, then run this again. Nothing was changed."
    fi
  fi
  # A Hub this installer did not start keeps its own start command: a public address given here cannot reach it.
  if [ "$PUBLIC_SET" -eq 1 ] && hub_answers && [ "$(running_mode)" = other ]; then
    die "--public-url cannot be applied to the Hub answering on 127.0.0.1:$PORT: this installer did not start it, so it does not change how it runs. Give that Hub --public-url where it is started (docs/remote.md), or stop it and run this again. Nothing was changed."
  fi

  # The record of an upgrade that did not finish (written below): the version that ran before, the backup taken before
  # the first attempt, and the release last tried (older records lack it). Read before Bun or git do anything, so every
  # error of this run (a failed fetch too) says how to go back. It is retired once that version runs again: its Hub
  # answers from the checkout at that version, or
  # a start of it was recorded (hub-commit, which the installer and the documented starts write only after the Hub
  # answered) after the record was written. Otherwise it decides the way back for this run, whatever it does: its
  # backup must still be one a restore accepts, and every failure from here says to restore it before going back,
  # until a start succeeds.
  recovery="$STATE_DIR/upgrade-recovery"
  rec_prev=""
  rec_backup=""
  rec_attempt=""
  if [ -f "$recovery" ]; then
    rec_prev=$(sed -n 1p "$recovery")
    rec_backup=$(sed -n 2p "$recovery")
    rec_attempt=$(sed -n 3p "$recovery")
    pre_head=""
    [ ! -d "$DIR/.git" ] || pre_head=$(git -C "$DIR" rev-parse HEAD 2>/dev/null || true)
    last_start=$(cat "$STATE_DIR/hub-commit" 2>/dev/null || true)
    retire=0
    if [ -n "$rec_prev" ] && [ "$pre_head" = "$rec_prev" ] && hub_answers && [ "$(running_mode)" != other ]; then
      # Its Hub runs: but it is that release only if the process serving 127.0.0.1:$PORT is its own, from this
      # checkout, reports that release's version (verify_listener), and started after the checkout moved to it (a
      # failed release still running under a checkout changed by hand is not).
      if verify_listener any "$rec_prev" && started_after_head_moved "$vpid"; then
        note "The rollback to $rec_prev is in place and its Hub runs: the record of the upgrade that did not finish is retired."
        retire=1
      fi
    fi
    # Also when the running Hub could not be told apart (started within 2 s of the checkout, no etimes): a start of
    # that release recorded after the record was written.
    if [ "$retire" -eq 0 ] && [ -n "$rec_prev" ] && [ "$last_start" = "$rec_prev" ] && [ "$STATE_DIR/hub-commit" -nt "$recovery" ]; then
      note "$rec_prev started again after the upgrade that did not finish (recorded in $STATE_DIR/hub-commit): the record of that upgrade is retired."
      retire=1
    fi
    if [ "$retire" -eq 1 ]; then
      rm -f "$recovery"
      rec_prev=""
      rec_backup=""
      rec_attempt=""
    else
      # The Bun that checks the backup's databases: the one the installer saved, else the one on PATH.
      BUN=$(cat "$STATE_DIR/bun" 2>/dev/null || true)
      [ -x "$BUN" ] || BUN=$(command -v bun || true)
      [ -x "$BUN" ] || BUN="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
      record_ok ||
        die "$recovery records an upgrade that did not finish, but its way back is not usable ($archive_problem): \"$rec_prev\", $rec_backup. Check them; delete that file only once the Hub runs the version you want on the data you want. Nothing was changed."
      first_backup="$rec_backup"
      back="  curl -fsSL https://raw.githubusercontent.com/zekiworks/agent-hub/$REF_DEFAULT/install.sh | AGENT_HUB_REF=$rec_prev sh -s -- --name $NAME --tools none"
      STOPPED_NOTE=$(restore_note "An earlier upgrade did not finish, and its new version may already have changed the database" "$EXISTING")
      note "An earlier upgrade did not finish: going back means version $rec_prev and $first_backup/hub.tar"
    fi
  fi

  # A Hub that has run before starts only on its own data: never on a new, empty database because the saved data
  # directory is gone (moved, an unmounted disk).
  if [ -n "$EXISTING" ] && [ ! -f "$HUB_DATA/message-bus.sqlite" ]; then
    die "the Hub's database $HUB_DATA/message-bus.sqlite is missing (its data directory moved, or a disk not mounted?). Not starting the Hub on a new, empty database. Put the data back, or restore a backup ($DOCS/docs/operations.md#restore), then run this again. Nothing was changed."
  fi
  # Before Bun or git change anything: a run that will change this machine's Hub (its address, or its version as far
  # as the checkout already knows the release asked for) needs its service manager here and the Hub as the installer
  # set it up. The same checks run again right before the Hub is stopped, once the fetch has said which commit the
  # release is.
  if [ -n "$EXISTING" ] && [ ! -d "$DIR/.git" ]; then
    # The checkout is gone: this run clones and builds it again, a change to this machine's Hub.
    need_manager
    require_as_written "upgrade by hand: $DOCS/docs/operations.md#upgrade"
  elif [ -n "$EXISTING" ]; then
    known=$(resolve_ref || true)
    last_run=$(cat "$STATE_DIR/hub-commit" 2>/dev/null || true)
    if [ "$RECONFIGURE" -eq 1 ]; then
      need_manager
      require_as_written "change its public address by hand (--public-url), as in $DOCS/docs/remote.md"
    elif [ -z "$known" ] || [ "$known" != "$(git -C "$DIR" rev-parse HEAD 2>/dev/null)" ] ||
      { [ -n "$last_run" ] && [ "$known" != "$last_run" ]; } || [ -f "$STATE_DIR/upgrade-recovery" ]; then
      # Another version than the checkout's or the one that last ran on the data, or a failed upgrade to retry.
      need_manager
      require_as_written "upgrade by hand: $DOCS/docs/operations.md#upgrade"
    fi
  fi
  # A stopped Hub (nothing on its port) is started from its service at the end: that service must be startable here
  # and exactly as written and saved, checked now rather than after Bun, the fetch and the build.
  if [ -n "$EXISTING" ] && [ "$RECONFIGURE" -eq 0 ] && ! hub_answers; then
    need_manager
    changed=$(service_changed)
    [ -z "$changed" ] || die "this machine's Hub is stopped and its service was changed after install ($changed). Not starting it: check it, then run the Hub by hand ($DOCS/docs/operations.md#start-the-hub). Nothing was changed."
    if [ -n "$HUB_PUBLIC" ]; then
      mismatch=$(service_args_problem serve --host 127.0.0.1 --port "$PORT" --humans "$HUB_HUMANS" --data-dir "$HUB_DATA" --existing-data --public-url "$HUB_PUBLIC")
    else
      mismatch=$(service_args_problem serve --host 127.0.0.1 --port "$PORT" --humans "$HUB_HUMANS" --data-dir "$HUB_DATA" --existing-data)
    fi
    [ -z "$mismatch" ] || die "$mismatch: the service and the installer's saved state ($STATE_DIR) disagree about which data or checkout is this Hub's. Not starting it: check which one is right, then run the Hub by hand ($DOCS/docs/operations.md#start-the-hub). Nothing was changed."
  fi

  # 2. Tools this needs.
  say "Checking for git, curl and Bun"
  git --version >/dev/null 2>&1 || die "git is missing (on macOS: xcode-select --install; on Ubuntu: apt install git). Install it, then run this again."
  command -v curl >/dev/null 2>&1 || die "curl is missing. Install it (e.g. apt install curl), then run this again."
  BUN_HOME="${BUN_INSTALL:-$HOME/.bun}"
  BUN=""
  if command -v bun >/dev/null 2>&1 && version_ok "$(bun --version 2>/dev/null)"; then
    BUN=$(command -v bun)
  elif [ -x "$BUN_HOME/bin/bun" ] && version_ok "$("$BUN_HOME/bin/bun" --version 2>/dev/null)"; then
    BUN="$BUN_HOME/bin/bun"
  fi
  if [ -n "$BUN" ]; then
    note "Bun $("$BUN" --version) at $BUN"
  else
    if command -v bun >/dev/null 2>&1; then
      say "Bun $(bun --version 2>/dev/null || printf unknown) is older than 1.4: installing Bun ${BUN_TESTED#bun-v} with the official installer (https://bun.sh/install) into $BUN_HOME"
    else
      say "Bun is missing: installing Bun ${BUN_TESTED#bun-v} with the official installer (https://bun.sh/install) into $BUN_HOME"
    fi
    command -v unzip >/dev/null 2>&1 || die "Bun's installer needs unzip. Install it (e.g. apt install unzip), then run this again."
    command -v bash >/dev/null 2>&1 || die "Bun's installer needs bash. Install it, then run this again."
    bun_script=$(mktemp "${TMPDIR:-/tmp}/bun-install.XXXXXX")
    if ! curl -fsSL https://bun.sh/install -o "$bun_script"; then
      rm -f "$bun_script"
      die "could not download Bun's installer from https://bun.sh/install"
    fi
    if ! bash "$bun_script" "$BUN_TESTED" </dev/null; then
      rm -f "$bun_script"
      die "the Bun installer failed (see above)"
    fi
    rm -f "$bun_script"
    BUN="$BUN_HOME/bin/bun"
    [ -x "$BUN" ] || die "Bun's installer finished but $BUN is not there"
    version_ok "$("$BUN" --version 2>/dev/null)" || die "Bun at $BUN is still older than 1.4 after its installer ran"
    note "Installed Bun $("$BUN" --version) at $BUN (its installer added it to your shell's startup file)"
  fi
  PATH="$(dirname "$BUN"):$PATH"
  export PATH

  # The people this run starts the Hub with, as the server reads --humans (each entry trimmed and made an id as
  # slugifyId in packages/protocol does): none may be the Hub's own agents (system, task, status, resources), nor an
  # agent or an agent's old name in its database: the server refuses to start then. The database must also be a Hub's
  # (messages and participants tables), unless it is the bare one of an interrupted first install, recorded in
  # new-database, which its release sets up. Checked read-only, before anything is stopped or changed.
  HUB_DB_BARE=0
  if [ "$REUSE_ONLY" -eq 0 ]; then
    # The database of this installation's own running Hub (its service active, or its nohup process) is read where it
    # is; any other (stopped, or another Hub on the port) on a private copy with its -wal and -shm, when there: even a
    # read-only open leaves those behind, and stopped data must stay exactly as it was (a backup is compared with it
    # byte for byte). A copy that fails stops the run.
    check_db=""
    check_tmp=""
    if [ -f "$HUB_DATA/message-bus.sqlite" ]; then
      check_db="$HUB_DATA/message-bus.sqlite"
      if [ "$(running_mode)" = other ]; then
        check_tmp=$(mktemp -d) || die "could not make a temporary folder to check the Hub's database in. Nothing was changed."
        for f in message-bus.sqlite message-bus.sqlite-wal message-bus.sqlite-shm; do
          if [ -f "$HUB_DATA/$f" ] && ! cp "$HUB_DATA/$f" "$check_tmp/$f"; then
            rm -rf "$check_tmp"
            die "could not copy $HUB_DATA/$f to check it. Nothing was changed."
          fi
        done
        check_db="$check_tmp/message-bus.sqlite"
      fi
    fi
    humans_conflict=$(CHECK_DB="$check_db" CHECK_HUMANS="$HUB_HUMANS" SLUG_SRC="$DIR/packages/protocol/src/address.ts" "$BUN" -e '
      const { Database } = require("bun:sqlite");
      const slug = require("fs").existsSync(process.env.SLUG_SRC) ? require(process.env.SLUG_SRC).slugifyId
        : (s) => s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 48);
      const ids = [];
      for (const entry of process.env.CHECK_HUMANS.split(",")) {
        const id = slug(entry);
        if (["system", "status", "task", "resources"].includes(id)) {
          console.log(`"${id}" is the Hub'"'"'s own agent and cannot be a person'"'"'s name`);
          process.exit(0);
        }
        if (id && id !== "all" && !ids.includes(id)) ids.push(id);
      }
      if (process.env.CHECK_DB) {
        const db = new Database(process.env.CHECK_DB, { readonly: true });
        db.exec("PRAGMA busy_timeout = 5000");
        const has = (t) => db.query("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", t);
        if (!has("messages") || !has("participants")) {
          console.log("BARE");
        } else {
          const hasAliases = has("participant_aliases");
          for (const id of ids) {
            const agent = db.query("SELECT id FROM participants WHERE id = ?1 AND kind = ?2").get(id, "agent");
            const alias = hasAliases ? db.query("SELECT new_id FROM participant_aliases WHERE old_id = ?1").get(id) : null;
            if (agent || alias) {
              console.log(`"${id}" is ${agent ? "an agent" : `the old name of agent "${alias.new_id}"`} on this Hub and cannot also be a person'"'"'s name`);
              break;
            }
          }
        }
        db.close();
      }' 2>&1) || { [ -z "$check_tmp" ] || rm -rf "$check_tmp"; die "could not check the people ($HUB_HUMANS) against the agents in $HUB_DATA/message-bus.sqlite: $humans_conflict. Nothing was changed."; }
    [ -z "$check_tmp" ] || rm -rf "$check_tmp"
    if [ "$humans_conflict" = BARE ]; then
      [ -n "$RESUME_DB" ] ||
        die "$HUB_DATA/message-bus.sqlite is not a Hub database (no messages and participants tables): an empty or foreign file where this Hub's data should be. Not starting the Hub on it. Put the Hub's database back, or restore a backup ($DOCS/docs/operations.md#restore), then run this again. Nothing was changed."
      HUB_DB_BARE=1
    elif [ -n "$humans_conflict" ]; then
      die "$humans_conflict; the Hub would refuse to start with --humans $HUB_HUMANS. Pick another name for that person (in $STATE_DIR/humans, or --name). Nothing was changed."
    fi
  fi

  # 3. The code (under this run's lock, taken above).
  fresh=0
  if [ -e "$DIR" ]; then
    say "Updating the Agent Hub checkout in $DIR to $REF"
    [ -d "$DIR/.git" ] || die "$DIR exists but is not a git checkout. Move it away, or set AGENT_HUB_DIR to another folder."
    origin=$(git -C "$DIR" remote get-url origin 2>/dev/null || true)
    [ "$(norm_url "$origin")" = "$(norm_url "$REPO")" ] ||
      die "$DIR is a checkout of \"$origin\", not $REPO. Not touching it; set AGENT_HUB_DIR to another folder."
    [ -z "$(git -C "$DIR" status --porcelain)" ] ||
      die "$DIR has local changes (git -C $(q "$DIR") status). Not touching it: commit or stash them, or set AGENT_HUB_DIR to another folder."
    # The remote's branches and tags, the tags into a ref namespace of the installer's own, so local tags stay as they are.
    git -C "$DIR" fetch --quiet --no-tags origin "+refs/heads/*:refs/remotes/origin/*" "+refs/tags/*:refs/agent-hub-installer/tags/*" </dev/null ||
      die "git fetch in $DIR failed"
  else
    say "Downloading Agent Hub ($REF) into $DIR"
    mkdir -p "$(dirname "$DIR")" || die "could not create $(dirname "$DIR")"
    # Cloned and checked out in a folder of this run's own next to it (registered for removal as it is made), then
    # moved into place: a run that ends before that leaves nothing behind. Until then git works in REPO_DIR, the
    # clone there; DIR stays the checkout's own path, which running Hub processes are compared with.
    CLONE_TMP=$(mktemp -d "$(dirname "$DIR")/.agent-hub-clone.XXXXXX") || die "could not create a folder next to $DIR"
    git clone --quiet --no-checkout "$REPO" "$CLONE_TMP/agent-hub" </dev/null || die "git clone $REPO failed"
    fresh=1
    REPO_DIR="$CLONE_TMP/agent-hub"
    # The way back of a pending record must be a commit of this new clone too.
    if [ -n "$rec_prev" ] && ! git -C "$REPO_DIR" cat-file -e "$rec_prev^{commit}" 2>/dev/null; then
      die "$recovery names \"$rec_prev\" as the way back, but it is not a commit of $REPO. Check it; delete that file only once the Hub runs the version you want on the data you want."
    fi
  fi
  commit=$(resolve_ref) || die "$REF is not a tag, branch or commit of $REPO"
  if [ "$BOOT_TAKEN" -eq 1 ]; then
    # Checked against the fetched ref before the first start was stopped: that commit, even if the branch moved since.
    commit="$RESUME_DB"
  elif [ -n "$RESUME_DB" ] && [ "$RESUME_DB" != "$commit" ]; then
    die "$HUB_DATA/message-bus.sqlite was created by an install of $(git -C "$REPO_DIR" rev-parse --short "$RESUME_DB" 2>/dev/null || printf '%s' "$RESUME_DB") that was interrupted, not of $REF. Finish that one first (AGENT_HUB_REF=$RESUME_DB with the same command), then upgrade. Nothing was changed."
  fi

  head=""
  [ "$fresh" -eq 1 ] || head=$(git -C "$DIR" rev-parse HEAD 2>/dev/null || true)
  recorded=$(cat "$STATE_DIR/hub-commit" 2>/dev/null || true)

  # The release that last ran on the Hub's data: the way back if this upgrade fails, and what it upgrades from.
  previous=""
  if [ -n "$rec_prev" ]; then
    previous="$rec_prev"
  elif [ -n "$EXISTING" ]; then
    ran_release ||
      die "cannot tell which release this Hub last ran: $ran_problem. $ran_advice. Nothing was changed."
    previous="$ran_commit"
  fi
  UPGRADE=0
  if [ -n "$EXISTING" ] && [ -n "$previous" ] && [ "$previous" != "$commit" ]; then UPGRADE=1; fi

  # An upgrade ends by starting the service; without its manager here, stop now, before anything changes.
  if [ "$UPGRADE" -eq 1 ]; then need_manager; fi

  # A Hub process that runs this checkout's code and is not the one this installer runs (started by hand, on any
  # port): checking out or building under it would change its code while it runs. Reusing it is fine while the
  # checkout and its build stay as they are.
  built="$DIR/packages/server/public/.installed-commit"
  if [ -d "$DIR/node_modules" ] && [ -f "$built" ] && [ "$(cat "$built")" = "$commit" ] && [ "$head" = "$commit" ]; then
    rebuild=0
  else
    rebuild=1
  fi
  if [ "$fresh" -eq 0 ] && { [ "$head" != "$commit" ] || [ "$rebuild" -eq 1 ]; }; then
    own=" $(own_pids | tr '\n' ' ') "
    for p in $(checkout_pids); do
      case "$own" in
        *" $p "*) ;;
        *) die "A Hub not started by this installer runs from $DIR; stop it first (pid $p), then run this again. Nothing was changed." ;;
      esac
    done
  fi

  # Only forward: the target must descend from the release that last ran on the Hub's data (recorded at each start)
  # and, with no upgrade pending, from the checkout's commit. An older release, or one on another branch, may not read
  # a database the current one already changed; that takes a backup and a manual upgrade or rollback. The way back
  # recorded after a failed upgrade is the exception. Checked before the Hub is stopped.
  if [ -n "$rec_prev" ]; then forward_bases="$rec_prev $recorded"; else forward_bases="$recorded $head"; fi
  if [ "$UPGRADE" -eq 1 ] && [ "$commit" != "$rec_prev" ]; then
    for base in $forward_bases; do
      if [ "$commit" != "$base" ] && ! git -C "$REPO_DIR" merge-base --is-ancestor "$base" "$commit" 2>/dev/null; then
        die "$REF does not follow the release this Hub last ran ($(git -C "$REPO_DIR" rev-parse --short "$base" 2>/dev/null || printf '%s' "$base")): it is older, or on another line, and that release may already have changed the Hub's database. Change to it by hand, from a backup: $DOCS/docs/operations.md#upgrade, or to go back, #restore then #rollback. The Hub and its data were not touched."
      fi
    done
  fi
  # After an upgrade that did not finish, the release it last tried (and the checkout's, which it may have left there)
  # may have changed the database: the target must be each of them or follow it, unless the data is still the backup
  # from before the first attempt. A record that does not say which release it tried (an older installer's) always
  # takes that. The data is compared again once the Hub is stopped.
  pending_why=""
  pending_advice=""
  if [ "$UPGRADE" -eq 1 ] && [ -n "$rec_prev" ] && [ "$commit" != "$rec_prev" ]; then
    if [ -z "$rec_attempt" ]; then
      pending_why="$recovery (an older installer's) does not say which release the upgrade that did not finish tried, and that release may already have changed the Hub's data"
      pending_advice="Restore $rec_backup/hub.tar first"
    else
      for base in $rec_attempt $head; do
        if [ -z "$pending_why" ] && [ "$commit" != "$base" ] && ! git -C "$REPO_DIR" merge-base --is-ancestor "$base" "$commit" 2>/dev/null; then
          pending_why="$REF does not follow $(git -C "$REPO_DIR" rev-parse --short "$base" 2>/dev/null || printf '%s' "$base"), which the upgrade that did not finish tried or left checked out and which may already have changed the Hub's data"
          pending_advice="Run the installer of that release or a later one, or restore $rec_backup/hub.tar first"
        fi
      done
    fi
  fi
  if [ -n "$pending_why" ] && ! data_matches_backup "$rec_backup"; then
    die "$pending_why ($data_problem). $pending_advice ($DOCS/docs/operations.md#restore), then run this again. The Hub and its data were not touched."
  fi

  # A new version for this machine's Hub (running or not): stop it if it runs and back up its data before the checkout
  # changes, so neither the old process nor a service manager restarting it runs new code on data not yet backed up.
  mkdir -p "$STATE_DIR"
  if [ "$UPGRADE" -eq 1 ]; then
    say "Upgrading this machine's Hub to $REF: stopping it and backing up its data before the code changes"
    back="  curl -fsSL https://raw.githubusercontent.com/zekiworks/agent-hub/$REF_DEFAULT/install.sh | AGENT_HUB_REF=$previous sh -s -- --name $NAME --tools none"
    require_as_written "upgrade by hand: $DOCS/docs/operations.md#upgrade"
    [ -f "$HUB_DATA/message-bus.sqlite" ] ||
      die "the Hub's database $HUB_DATA/message-bus.sqlite is missing: that is where the installer started this Hub on its data. Not upgrading without a backup of it. Nothing was changed."
    data_self_contained
    stop_existing
    if [ -n "$rec_prev" ]; then
      STOPPED_NOTE="The Hub is stopped. $STOPPED_NOTE"
    else
      STOPPED_NOTE="The Hub is stopped. To run the version that ran before:
$back"
    fi
    # Stopped now, nothing writes to the data: what allowed this target must still hold.
    if [ -n "$pending_why" ] && ! data_matches_backup "$rec_backup"; then
      die "the Hub's data no longer matches $rec_backup/hub.tar once the Hub was stopped ($data_problem): $pending_why. Restore $rec_backup/hub.tar first ($DOCS/docs/operations.md#restore), then run this again. Nothing else was changed."
    fi
    backup_data
    # The record says, before the checkout changes, which release is about to run on the data; each retry updates it.
    if [ -z "$rec_prev" ]; then
      first_backup="$BACKUP"
      write_recovery "$previous" "$first_backup" "$commit"
      STOPPED_NOTE="$STOPPED_NOTE
Its data from before the upgrade is in $first_backup/hub.tar."
    else
      write_recovery "$rec_prev" "$rec_backup" "$commit"
    fi
  elif [ -n "$rec_prev" ]; then
    # Going back after an upgrade that did not finish: whatever still runs (the new version, started late, or hung)
    # must be verifiably gone before the checkout changes under it and the version before starts.
    say "Going back to $rec_prev after the upgrade that did not finish: stopping whatever Hub still runs first"
    stop_verified "$EXISTING" ||
      die "could not stop this machine's Hub before going back to $rec_prev: $stop_problem. Stop it yourself (step 1 below), then run this again; nothing else was changed."
    # The version before starts only on the backup from before the upgrade, restored or never touched (every Hub item
    # as in the archive: data_matches_backup): the failed version, or the new checkout started some other way (a service at
    # login after an interrupted upgrade), may have changed the data.
    if ! data_matches_backup "$rec_backup"; then
      die "the Hub's data is not the backup from before the upgrade ($data_problem): the failed version, or its checkout started some other way, may have changed it, so $rec_prev does not start on it. Restore $rec_backup/hub.tar first ($DOCS/docs/operations.md#restore), then run this again. The Hub is stopped; nothing else was changed."
    fi
  elif [ "$RECONFIGURE" -eq 1 ]; then
    say "Changing the Hub's public address to ${HUB_PUBLIC:-none}: its service is rewritten and the Hub restarted"
    require_as_written "change its public address by hand (--public-url), as in $DOCS/docs/remote.md"
    stop_existing
  fi

  if [ "$fresh" -eq 1 ]; then
    git -C "$REPO_DIR" -c advice.detachedHead=false checkout --quiet --detach "$commit" </dev/null ||
      die "git checkout of $REF in $REPO_DIR failed"
    # Moved into place only while nothing is there (the lock keeps other runs of this installer out).
    [ ! -e "$DIR" ] && [ ! -L "$DIR" ] || die "$DIR appeared while this run was cloning; not replacing it"
    mv "$REPO_DIR" "$DIR" || die "could not move the clone into $DIR"
    rm -rf "$CLONE_TMP"
    CLONE_TMP=""
    DIR=$(canon "$DIR")
    REPO_DIR="$DIR"
    built="$DIR/packages/server/public/.installed-commit"
  elif [ "$(git -C "$DIR" rev-parse HEAD)" = "$commit" ]; then
    note "Already at $REF"
  else
    branch=$(git -C "$DIR" symbolic-ref -q --short HEAD 2>/dev/null || true)
    # The build belongs to the commit it was made from (a manual rollback rebuilds an older one without saying so).
    rm -f "$built"
    git -C "$DIR" -c advice.detachedHead=false checkout --quiet --detach "$commit" </dev/null
    note "Now at $REF${branch:+ (was on branch $branch; git -C $(q "$DIR") switch $branch goes back)}"
  fi

  # 4. Build, unless this commit is already built with these dependencies.
  if [ "$rebuild" -eq 0 ]; then
    say "Already built ($REF)"
  else
    # Gone until the build succeeds, so a failed build is never taken for a finished one.
    rm -f "$built"
    say "Installing dependencies (bun install)"
    (cd "$DIR" && "$BUN" install --frozen-lockfile) </dev/null || die "bun install failed (see above)"
    say "Building the website (bun run build)"
    (cd "$DIR" && "$BUN" run build) </dev/null || die "bun run build failed (see above)"
    printf '%s\n' "$commit" >"$built"
  fi

  # 5. The agent-bus command.
  say "Installing the agent-bus command into ~/.local/bin"
  hub_cli install cli || die "agent-bus install cli failed (see above)"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) AB="agent-bus" ;;
    *) AB="$(q "$HOME/.local/bin/agent-bus")" ;;
  esac

  # 6. The Hub.
  set -- serve --host 127.0.0.1 --port "$PORT" --humans "$HUB_HUMANS" --data-dir "$HUB_DATA" --existing-data
  [ -z "$HUB_PUBLIC" ] || set -- "$@" --public-url "$HUB_PUBLIC"
  if hub_answers; then
    MODE=$(running_mode)
    if [ "$MODE" = other ]; then
      # Only a first install whose checks chose to use a Hub it did not start does so; any other Hub that took the port
      # meanwhile is not this installation's, and nothing is recorded or minted for it.
      [ "$REUSE_ONLY" -eq 1 ] ||
        die "port $PORT is now used by another Hub (not this installation's), which was not there when this run began. Stop it, then run this again; nothing was recorded for it."
      say "A Hub not started by this installer already answers on 127.0.0.1:$PORT: using it"
      note "It signs in only the people in its own --humans list and keeps its data where it was started with; the sign-in link below is checked against it."
      HUB_DATA="$DATA_DIR"
    else
      say "The Hub already runs $REF on 127.0.0.1:$PORT: nothing to start"
      # Its arguments are its service's (a unit edited by hand may add some); the rest must hold.
      verify_listener any "$commit" ||
        die "the Hub answering on 127.0.0.1:$PORT is not this installation's as expected ($verify_problem). Not recording it as running $REF; check what runs there, then run this again."
      write_hub_commit
      rm -f "$STATE_DIR/upgrade-recovery"
    fi
  else
    # A first run that only uses a Hub not its own does not start one when that Hub went away meanwhile.
    if [ "$REUSE_ONLY" -eq 1 ]; then
      die "the Hub this run found answering on 127.0.0.1:$PORT (not started by this installer) no longer answers. Not starting a release on its data: start that Hub again and run this again, or upgrade it by hand ($DOCS/docs/operations.md#upgrade)."
    fi
    # Nor on a database that appeared since the checks (or is not the one an interrupted run of this release made).
    if [ -z "$EXISTING" ] && [ -f "$HUB_DATA/message-bus.sqlite" ] && [ -z "$RESUME_DB" ]; then
      die "$HUB_DATA/message-bus.sqlite appeared while this run was installing (a Hub started by hand?). Not starting a release on a database whose release is not known; see $DOCS/docs/operations.md#upgrade."
    fi
    port_free || die "something that is not an Agent Hub is using port $PORT on this machine. Stop it, then run this again."
    case "$EXISTING" in
      systemd)
        systemd_ok || die "$UNIT_FILE is this machine's Hub, but there is no systemd user session here. Start it from one (systemctl --user start $UNIT_NAME), then run this again."
        MODE="systemd"
        ;;
      launchd)
        gui_ok || die "$PLIST is this machine's Hub, but there is no login session on this Mac here (over SSH?). Log in at the Mac, or start it there (launchctl bootstrap gui/$UID_ $(q "$PLIST")), then run this again."
        MODE="launchd"
        ;;
      *)
        if systemd_ok; then MODE="systemd"; elif gui_ok; then MODE="launchd"; else MODE="nohup"; fi
        ;;
    esac
    if [ "$UPGRADE" -eq 1 ]; then
      # From here the new version may run, restart or have stopped, and may already have changed the database.
      STOPPED_NOTE="The upgraded Hub did not come up; its log: $(log_hint). $(restore_note "It may already have changed the database" "$MODE")"
    fi
    # Every start the installer writes opens only an existing database (--existing-data: an unmounted data volume at
    # login must not become a new, empty Hub). A first install has none yet: one start without that option creates it,
    # only for a first install (no installation of this installer here, no release recorded as started, no data
    # directory saved).
    if [ ! -f "$HUB_DATA/message-bus.sqlite" ] || [ "$HUB_DB_BARE" -eq 1 ]; then
      if [ -n "$EXISTING" ] || [ -s "$STATE_DIR/hub-commit" ] || [ -e "$STATE_DIR/data-dir" ]; then
        die "the Hub's database $HUB_DATA/message-bus.sqlite is missing (its data directory moved, or a disk not mounted?). Not starting the Hub on a new, empty database. Put the data back, or restore a backup ($DOCS/docs/operations.md#restore), then run this again."
      fi
      # Recorded first, written whole: a run interrupted from here on resumes this database with the same release.
      if ! { printf '%s\n%s\n' "$HUB_DATA" "$commit" >"$new_db_record.tmp" && mv "$new_db_record.tmp" "$new_db_record"; }; then
        die "could not record the new database in $new_db_record"
      fi
      say "Creating the Hub's database in $HUB_DATA"
      mkdir -p "$HUB_DATA" || die "could not create $HUB_DATA"
      (cd "$DIR" && exec "$BUN" run packages/cli/src/bin.ts serve --host 127.0.0.1 --port "$PORT" --humans "$HUB_HUMANS" \
        --data-dir "$HUB_DATA" >>"$STATE_DIR/first-start.log" 2>&1 </dev/null) &
      BOOT_PID=$!
      wait_for up 60 || die "the first start that creates the Hub's database did not answer within a minute; see $STATE_DIR/first-start.log"
      kill "$BOOT_PID" 2>/dev/null || true
      wait "$BOOT_PID" 2>/dev/null || true
      BOOT_PID=""
      wait_for down 30 || die "the first start that created the Hub's database did not stop; see $STATE_DIR/first-start.log"
      [ -f "$HUB_DATA/message-bus.sqlite" ] || die "the first start did not create $HUB_DATA/message-bus.sqlite; see $STATE_DIR/first-start.log"
    fi
    if [ "$RECONFIGURE" -eq 1 ]; then
      # The service is written again with the new address (start_hub: the unit replaced in one rename); the one it
      # replaces is kept beside the state.
      case "$MODE" in systemd) service_path="$UNIT_FILE" ;; launchd) service_path="$PLIST" ;; *) service_path="" ;; esac
      if [ -n "$service_path" ] && [ -f "$service_path" ]; then
        kept="$STATE_DIR/$(basename "$service_path").before-$(date +%Y%m%d-%H%M%S)"
        cp "$service_path" "$kept" || die "could not keep a copy of $service_path in $kept"
        note "The service as it was is kept in $kept"
      fi
    fi
    start_hub "$@"
    if ! wait_for up 60; then
      if [ "$UPGRADE" -eq 1 ]; then
        if stop_verified "$MODE"; then
          STOPPED_NOTE="(The installer has stopped it and checked that no Hub process runs from $DIR.) $STOPPED_NOTE"
        else
          case "$MODE" in
            systemd) confirm="systemctl --user is-active $UNIT_NAME prints inactive or failed" ;;
            launchd) confirm="launchctl print gui/$UID_/$LAUNCHD_LABEL fails" ;;
            *) confirm="ps -o pid,args -p \$(cat $(q "$PID_FILE")) lists no process" ;;
          esac
          STOPPED_NOTE="The installer could not confirm that the upgraded Hub is stopped: $stop_problem. Before restoring anything, stop it and check that $confirm, that ps shows no 'bin.ts serve' running from $DIR, and that curl $TOOL_URL/api/health fails.
$STOPPED_NOTE"
        fi
      fi
      die "the Hub did not answer on $TOOL_URL/api/health within a minute; see $(log_hint)"
    fi
    # What answers must be the process just started: from this checkout, with these arguments, holding the port, and
    # reporting this release's version. Only then is the release recorded as running and a pending recovery retired.
    # (It is this installation's Hub now, in the mode it was started in: a first install's too.)
    EXISTING="$MODE"
    verify_listener exact "$commit" "$@" ||
      die "the Hub answering on 127.0.0.1:$PORT is not the one this run started ($verify_problem). Not recording $REF as running; check what runs there ($(log_hint)), then run this again."
    write_hub_commit
    STOPPED_NOTE=""
    rm -f "$STATE_DIR/upgrade-recovery" "$new_db_record"
    if [ "$UPGRADE" -eq 1 ]; then note "The Hub answers on $HUB_URL, now on $REF"; else note "The Hub answers on $HUB_URL"; fi
  fi

  # 7. Coding tools.
  found=""
  for t in $KNOWN_TOOLS; do
    if tool_found "$t"; then found="$found $t"; fi
  done
  found="${found# }"
  say "Coding tools on this machine"
  if [ -z "$found" ]; then
    note "None of: $(printf '%s' "$KNOWN_TOOLS" | tr ' ' ',')."
  else
    note "Found: $(printf '%s' "$found" | tr ' ' ',')."
  fi
  # 1 when the person picked the tools at the prompt: the grok install may then ask them about leader mode too.
  picked=0
  if [ -z "$TOOLS" ] && [ -n "$found" ] && have_tty; then
    ask "Connect $(printf '%s' "$found" | tr ' ' ',') to the Hub now? [y/N] "
    case "$answer" in [yY]*) TOOLS=auto picked=1 ;; *) TOOLS=none ;; esac
  fi
  case "$TOOLS" in
    auto) chosen="$found" ;;
    '' | none) chosen="" ;;
    *) chosen=$(printf '%s' "$TOOLS" | tr ',' ' ') ;;
  esac
  done_tools=""
  failed_tools=""
  for t in $chosen; do
    tool_found "$t" || note "$t was not found on this machine; installing its adapter anyway, as asked."
    # Grok's leader mode changes every Grok session on this machine: asked only of a person at the prompt, never
    # changed for an agent's run (NEXT FOR grok then says how to turn it on).
    leader_flag=""
    if [ "$t" = grok ] && [ "$picked" -eq 0 ]; then leader_flag=--no-leader; fi
    say "Connecting $t: agent-bus install $t --url $TOOL_URL${leader_flag:+ $leader_flag}"
    if hub_cli install "$t" --url "$TOOL_URL" ${leader_flag:+"$leader_flag"}; then
      done_tools="$done_tools $t"
      grep -qx "$t" "$STATE_DIR/tools" 2>/dev/null || printf '%s\n' "$t" >>"$STATE_DIR/tools"
    else
      failed_tools="$failed_tools $t"
    fi
  done
  done_tools="${done_tools# }"
  failed_tools="${failed_tools# }"
  for t in $found; do
    case " $done_tools $failed_tools " in
      *" $t "*) ;;
      *) note "To connect $t later: $AB install $t --url $TOOL_URL" ;;
    esac
  done
  note "Hermes Agent is set up by hand: $DOCS/docs/harnesses/hermes.md"

  # 8. The sign-in link, minted last so the ten minutes start now, for the address the Hub accepts passkeys from, and
  #    checked against the running Hub.
  say "Making a one-time sign-in link for $NAME"
  auth_state=$(curl -fsS --max-time 5 "$TOOL_URL/api/auth/state" 2>/dev/null) || die "the Hub on 127.0.0.1:$PORT did not answer /api/auth/state"
  rp=$(printf '%s' "$auth_state" | sed -n 's/.*"rpId": *"\([^"]*\)".*/\1/p')
  https_port=$(printf '%s' "$auth_state" | sed -n 's/.*"httpsPort": *\([0-9][0-9]*\).*/\1/p')
  # The website origins the Hub accepts passkeys from: the running Hub says (auth/state "origins"); a Hub without that
  # field (an older one): https://RP:HTTPS-PORT and http://localhost:PORT, its defaults (packages/server/src/server.ts).
  # A link must open at one whose host is the passkeys' site.
  origins=$(printf '%s' "$auth_state" | sed -n 's/.*"origins": *\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')
  if [ -z "$origins" ]; then
    origins="http://localhost:$PORT"
    [ -z "$https_port" ] || origins="https://$rp:$https_port $origins"
  fi
  # The first origin whose host is the passkeys' site (rpId, or a subdomain of it) and that a browser treats as secure:
  # https, or http on localhost / 127.0.0.1 (the same rule as the invite command in docs/operations.md).
  base=""
  for o in $origins; do
    o="${o%/}"
    h=$(printf '%s' "$o" | sed -e 's#^[a-z]*://##' -e 's#[/:].*##')
    case "$h" in "$rp" | *".$rp") ;; *) continue ;; esac
    case "$o" in https://*) base="$o" && break ;; esac
    case "$o" in http://localhost | http://localhost:* | http://127.0.0.1 | http://127.0.0.1:*) base="$o" && break ;; esac
  done
  [ -n "$base" ] || die "NO SIGN-IN ADDRESS: this Hub's passkeys are for $rp, but none of the addresses it accepts them from is on $rp over https (or localhost) ($(printf '%s' "$origins" | tr '\n' ' ')). Give the Hub the address people open it at (--origin https://$rp, or --https-port), restart it, then run this again; or make the link yourself: agent-bus invite $NAME --url https://$rp. No link printed."
  invite=$(hub_cli invite "$NAME" --data-dir "$HUB_DATA" --url "$base") || die "agent-bus invite $NAME failed (see above)"
  link=$(printf '%s\n' "$invite" | grep -E '^https?://' | head -n 1)
  [ -n "$link" ] || die "agent-bus invite printed no link: $invite"
  token="${link#*#invite=}"
  check="$STATE_DIR/invite-check.json"
  code=$(curl -sS --max-time 5 -o "$check" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    --data "{\"invite\":\"$token\"}" "$TOOL_URL/api/auth/register/options" 2>/dev/null) || code="000"
  reason=$(sed -n 's/.*"error": *"\([^"]*\)".*/\1/p' "$check" 2>/dev/null | head -n 1)
  opt_rp=$(sed -n 's/.*"rp": *{ *"id": *"\([^"]*\)".*/\1/p' "$check" 2>/dev/null | head -n 1)
  opt_user=$(sed -n 's/.*"user": *{[^}]*"name": *"\([^"]*\)".*/\1/p' "$check" 2>/dev/null | head -n 1)
  rm -f "$check"
  [ "$code" = 200 ] ||
    die "the Hub on 127.0.0.1:$PORT does not accept a sign-in link for $NAME (HTTP $code${reason:+: $reason}). It was started for other people or with another data directory; no link printed."
  [ "$opt_user" = "$NAME" ] && [ "$opt_rp" = "$rp" ] ||
    die "the Hub would make a passkey for \"$opt_user\" on \"$opt_rp\", not for $NAME on $rp; no link printed."

  # 9. Summary.
  if [ "$base" = "http://localhost:$PORT" ]; then
    say "Agent Hub is running at $HUB_URL (only on this machine)"
  else
    say "Agent Hub is running on 127.0.0.1:$PORT; people sign in at $base"
  fi
  case "$MODE" in
    systemd)
      note "Stop: systemctl --user stop $UNIT_NAME     Start: systemctl --user start $UNIT_NAME (it starts at login)"
      note "Log: journalctl --user -u $UNIT_NAME"
      note "Keep it running while you are logged out: loginctl enable-linger \$USER"
      ;;
    launchd)
      note "Stop: launchctl bootout gui/$UID_/$LAUNCHD_LABEL     Start: launchctl bootstrap gui/$UID_ $(q "$PLIST") (it starts at login)"
      note "Log: $LAUNCHD_LOG"
      ;;
    nohup)
      note "Stop: $(stop_cmd nohup)     Start: run this installer again (it does not start by itself after a reboot)"
      note "Log: $NOHUP_LOG"
      ;;
    other) note "It was started outside this installer: stop and start it the way it was started." ;;
  esac
  [ "$OS" != Darwin ] || note "This installer's macOS path is untested: if anything here does not work, use the manual steps in $DOCS/INSTALL.md"
  note "Upgrade: run the installer of a newer release; it backs up the data and restarts the Hub, as long as its service is unchanged since install (add --public-url with this installer, not by editing the service; after other edits upgrade by hand: $DOCS/docs/operations.md#upgrade)."
  [ -z "$HUB_PUBLIC" ] || [ "$MODE" = other ] || note "Public address (for linking phones and other computers): $HUB_PUBLIC"
  if [ "$AB" != agent-bus ]; then
    note "agent-bus is in ~/.local/bin, which is not on your PATH. Run this, and add it to ~/.bashrc or ~/.zshrc:"
    note "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
  note "Uninstall, in this order:"
  case "$MODE" in
    systemd) note "  systemctl --user disable --now $UNIT_NAME; rm $(q "$UNIT_FILE"); systemctl --user daemon-reload" ;;
    launchd) note "  launchctl bootout gui/$UID_/$LAUNCHD_LABEL; rm $(q "$PLIST")" ;;
    nohup) note "  $(stop_cmd nohup)" ;;
  esac
  for t in $(cat "$STATE_DIR/tools" 2>/dev/null || true); do note "  $AB uninstall $t"; done
  note "  $AB uninstall cli; rm -rf $(q "$STATE_DIR")"
  note "  Then, by hand and only if you no longer need them: the checkout $(q "$DIR") (check it for work of your own"
  note "  first) and the Hub's data $(q "$HUB_DATA") (messages, passkeys, files; back it up first)."
  note "More (other machines, phones over HTTPS, the manual steps): $DOCS/INSTALL.md"
  printf '\n'
  printf 'SIGN-IN LINK: %s\n' "$link"
  if [ "$base" = "http://localhost:$PORT" ]; then
    printf '    Open it on this machine within 10 minutes, once: it makes your passkey (a fingerprint or face check).\n'
  else
    printf '    Open it within 10 minutes, once, at the address it names: it makes your passkey (a fingerprint or face check).\n'
  fi
  if [ -n "${SSH_CONNECTION:-}" ] && [ "$base" = "http://localhost:$PORT" ]; then
    # The website accepts passkeys only from http://localhost:7800 exactly, so the forward must use local port 7800.
    here=$(printf '%s\n' "$SSH_CONNECTION" | cut -d' ' -f3)
    ssh_port=$(printf '%s\n' "$SSH_CONNECTION" | cut -d' ' -f4)
    case "$ssh_port" in '' | 22) ssh_port="" ;; *) ssh_port="-p $ssh_port " ;; esac
    if [ -n "$here" ]; then
      extra=" ($here is this machine's address on your SSH connection; use the name or address you ssh to if it differs)"
    else
      here="<the address you ssh to>"
      extra=""
    fi
    printf 'OVER SSH: open the link on the computer in front of you, through a tunnel: there, run  ssh %s-L %s:127.0.0.1:%s %s@%s%s. Port %s must be free on that computer: the website accepts passkeys only from localhost:%s.\n' \
      "$ssh_port" "$PORT" "$PORT" "$(id -un)" "$here" "$extra" "$PORT" "$PORT"
  fi
  if [ -n "${SSH_CONNECTION:-}" ]; then
    if [ "$MODE" = systemd ] && [ "$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null || true)" = "Linger=no" ]; then
      printf 'KEEP RUNNING: you are on SSH; the Hub stops when you log out unless you run: loginctl enable-linger %s\n' "$(id -un)"
    fi
  fi
  if [ -n "$done_tools" ]; then
    printf 'ALLOW THIS MACHINE: start a new session of %s in a project folder. The Hub website then shows "A new machine wants to put agents on the Hub" with a short code. Compare it with the code the tool shows (agent-bus doctor prints it too); click Allow only when they match.\n' "$(printf '%s' "$done_tools" | sed 's/ /, /g')"
  else
    printf 'ALLOW THIS MACHINE: after you connect a tool (agent-bus install TOOL --url %s) and start a new session of it in a project folder, the Hub website shows "A new machine wants to put agents on the Hub" with a short code. Compare it with the code the tool shows (agent-bus doctor prints it too); click Allow only when they match.\n' "$TOOL_URL"
  fi
  for t in $done_tools; do
    n=$(next_for "$t")
    [ -z "$n" ] || printf 'NEXT FOR %s: %s\n' "$t" "$n"
  done
  for t in $failed_tools; do
    printf 'TOOL FAILED: %s did not connect (its error is above). Retry: %s install %s --url %s\n' "$t" "$AB" "$t" "$TOOL_URL"
  done
  [ -z "$failed_tools" ] || exit 1
}

# Everything runs from main, so `curl | sh` has read the whole script before any command can read stdin.
main "$@"
