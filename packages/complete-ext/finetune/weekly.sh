#!/usr/bin/env bash
# Weekly retraining of bariton's live typing-suggestion model (Ümit #13481), run by agent-bus-retrain.timer (Sundays
# 04:00): our own setup around `agent-bus train-suggestions` (train-suggestions.ts, Ümit #13513), which does the work.
#
# 1. Stops the live models (agent-bus-complete-model, agent-bus-ask-model): the booking r_9e07e06d2fab (GPU 3, 10 GB
#    beside jevgammon) holds training or the two test servers, not both.
# 2. Runs train-suggestions on that booking with our settings: can's and umit's shared rooms (no DMs) up to 4 days ago,
#    training capped at 8.5 GiB, in the env and llama.cpp we already have; the candidate is tested against the live
#    model (the unit's -m) on the 4 days after and replaces that file only if better, the one before kept as
#    *.previous.gguf for rollback. Outputs: ~/.agent-bus/suggest-training/<date>/.
# 3. Starts both units again, always (also when anything fails), and posts the result to #hilde-hub without waking anyone.
#
# SMOKE=1: train-suggestions --smoke (the export and 5 training steps on a sample) into suggest-training/<date>-smoke;
# never puts anything live and posts nothing. Log: ~/.agent-bus/finetune/weekly.log.
set -Eeuo pipefail

SMOKE=${SMOKE:-0}
PY=$HOME/.agent-bus/ask-eval/glide-venv/bin/python
LLAMA=$HOME/.agent-bus/ask-eval/llama.cpp-cuda
AGENT_BUS=$HOME/.local/bin/agent-bus
BOOKING=r_9e07e06d2fab
UNIT_FILE=$HOME/.config/systemd/user/agent-bus-complete-model.service
UNITS=(agent-bus-complete-model.service agent-bus-ask-model.service)
UNIT_PORTS=(9962 9963)
BUS=http://127.0.0.1:7800
ROOM=g_da0c689f9e05 # #hilde-hub
FINETUNE=$HOME/.agent-bus/finetune
LOG=$FINETUNE/weekly.log
DATE=$(date +%F)
WEEK=$HOME/.agent-bus/suggest-training/$DATE$([[ $SMOKE == 1 ]] && echo -smoke || true)

umask 077
mkdir -p "$FINETUNE"
# Straight to the file, not through tee: a stop of the service must not kill the logger before the trap has run.
exec >>"$LOG" 2>&1
exec 9>"$FINETUNE/weekly.lock"
flock -n 9 || { echo "$(date '+%F %T') weekly: another run holds $FINETUNE/weekly.lock"; exit 1; }

log() { echo "$(date '+%F %T') weekly: $*"; }

post() {
  [[ $SMOKE == 1 ]] && { log "smoke run, not posted:"$'\n'"$1"; return; }
  jq -n --arg from message-bus --arg conv "$ROOM" --arg text "$1" '{from: $from, conversationId: $conv, text: $text, wake: []}' |
    curl -sf -X POST "$BUS/api/messages?as=message-bus" -H "Content-Type: application/json" \
      -H "X-Agent-Token: $(cat "$HOME/.agent-bus/agent-token")" --data-binary @- >/dev/null &&
    log "posted to #hilde-hub" || log "posting to #hilde-hub failed"
}

# Waits until each port's llama-server answers /health (a loaded model), at most $1 seconds.
healthy() {
  local limit=$1 port start=$SECONDS
  shift
  for port in "$@"; do
    until curl -sf "http://127.0.0.1:$port/health" >/dev/null; do
      ((SECONDS - start < limit)) || { log "port $port not healthy after ${limit}s"; return 1; }
      sleep 1
    done
  done
}

DOWN_AT=
start_units() {
  systemctl --user start "${UNITS[@]}" || log "systemctl start failed"
  if healthy 180 "${UNIT_PORTS[@]}"; then log "live models up again (${UNITS[*]})"; fi
  if [[ -n $DOWN_AT ]]; then
    log "live models were down $(($(date +%s) - DOWN_AT)) s"
    DOWN_AT=
  fi
}

STEP=start
finish() {
  local rc=$?
  trap - EXIT
  start_units
  if ((rc != 0)); then
    log "FAILED at $STEP (exit $rc)"
    post "Weekly retraining of the typing model (Ümit #13481), $DATE: kept the current model, because the run failed at \"$STEP\" (exit $rc; ~/.agent-bus/finetune/weekly.log on bariton)."
  fi
  log "done (exit $rc)"
}
trap finish EXIT
trap 'exit 143' TERM INT HUP

LIVE=$(grep '^ExecStart=' "$UNIT_FILE" | grep -o -- ' -m [^ ]*' | head -1 | cut -c5-)
[[ -f $LIVE ]] || { log "the live model \"$LIVE\" (from $UNIT_FILE) is not a file"; exit 1; }
log "start$([[ $SMOKE == 1 ]] && echo ' (SMOKE)'): live model $LIVE, into $WEEK"

STEP="stop the live models"
DOWN_AT=$(date +%s)
systemctl --user stop "${UNITS[@]}"
log "stopped ${UNITS[*]}"

STEP=train-suggestions
"$AGENT_BUS" run "$BOOKING" -- "$AGENT_BUS" train-suggestions --data-dir "$HOME/.agent-bus" --people can,umit --test-days 4 \
  --model-out "$LIVE" --python "$PY" --llama-cpp "$LLAMA" --max-gib 8.5 $([[ $SMOKE == 1 ]] && echo --smoke || true)

STEP="start the live models"
start_units

[[ $SMOKE == 1 ]] && { STEP=end; exit 0; }
STEP=post
cuts=$(jq -r .cuts "$WEEK/results/summary.json")
outcome=$(jq -r 'if .installed then "went live: \(.modelOut | split("/") | last) (\(.verdict); previous kept as \(.previous | split("/") | last) for rollback)"
  else "kept the current model (\(.current | split("/") | last)), because the candidate was not better: \(.verdict)" end' "$WEEK/result.json")
log "$outcome"
train_line=$(jq -r '"Training: \(.messages) messages (\(.conversations) shared conversations, no DMs), \(.tokens_train) tokens, before \(.cutoff_ms / 1000 | strftime("%Y-%m-%d %H:%M UTC"))"' "$WEEK/data/stats.json")
loss_line=$(jq -r '"held-out loss \(.heldout_before.all * 1000 | round / 1000) → \(.heldout_after.all * 1000 | round / 1000), \(.total_steps) steps in \(.train_seconds) s"' "$WEEK/train-log.json")
post "Weekly retraining of the typing model (Ümit #13481), $DATE: $outcome.
$train_line; $loss_line.
Test: $cuts cut points in can's and umit's messages after the cutoff, through the production pipeline:

$(jq -r .table "$WEEK/results/summary.json")"
STEP=end
