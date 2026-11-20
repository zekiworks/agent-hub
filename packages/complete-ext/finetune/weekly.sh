#!/usr/bin/env bash
# Weekly retraining of the live typing-suggestion model (Ümit #13481), run by agent-bus-retrain.timer (Sundays 04:00).
#
# 1. Exports the shared rooms (export.py --shared: rooms both can and umit are in, #all; no DMs) up to a cutoff 4 days
#    ago, into ~/.agent-bus/finetune/weekly/<date>/.
# 2. Stops the live models (agent-bus-complete-model, agent-bus-ask-model): the booking r_9e07e06d2fab (GPU 3, 10 GB
#    beside jevgammon) holds training or the two test servers, not both.
# 3. Trains a LoRA on LFM3 1.7B (train.py, micro-batch 1, checkpointing, at most 8.5 GiB), merges it, converts it to GGUF.
# 4. Tests the candidate against the live GGUF on can's and umit's messages after the cutoff (eval.ts: 3000 cut points,
#    fixed seed, the production pipeline), two llama-servers on 9971 and 9972.
# 5. Puts it live only if more of its suggestions are shown and right AND it wins more paired cut points than it loses:
#    ~/.agent-bus/models/LFM3-1.7B-bus-shared-<date>-BF16.gguf, the unit's -m pointed at it; the previous file stays for
#    rollback, older ones go (the last two are kept).
# 6. Starts both units again, always (also when anything fails), and posts the result to #hilde-hub without waking anyone.
#
# SMOKE=1: the same steps for real but 10 training steps and 200 cut points, into weekly/<date>-smoke; never puts the
# candidate live and posts nothing. Log: ~/.agent-bus/finetune/weekly.log.
set -Eeuo pipefail

SMOKE=${SMOKE:-0}
HERE=$(cd "$(dirname "$0")" && pwd)
PY=$HOME/.agent-bus/ask-eval/glide-venv/bin/python
LLAMA=$HOME/.agent-bus/ask-eval/llama.cpp-cuda
AGENT_BUS=$HOME/.local/bin/agent-bus
BUN=$HOME/.bun/bin/bun
BOOKING=r_9e07e06d2fab
MODELS=$HOME/.agent-bus/models
UNIT_FILE=$HOME/.config/systemd/user/agent-bus-complete-model.service
UNITS=(agent-bus-complete-model.service agent-bus-ask-model.service)
UNIT_PORTS=(9962 9963)
BUS=http://127.0.0.1:7800
ROOM=g_da0c689f9e05 # #hilde-hub
FINETUNE=$HOME/.agent-bus/finetune
LOG=$FINETUNE/weekly.log
DATE=$(date +%F)
WEEK=$FINETUNE/weekly/$DATE$([[ $SMOKE == 1 ]] && echo -smoke || true)
CUTOFF=$(date -d '4 days ago' --iso-8601=seconds)
SAMPLES=$([[ $SMOKE == 1 ]] && echo 200 || echo 3000)

umask 077
mkdir -p "$WEEK"
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

# Waits until each port's llama-server answers /health (a loaded model), at most $1 seconds; gives up at once when one
# of the eval servers has exited (a model that does not load).
healthy() {
  local limit=$1 port pid start=$SECONDS
  shift
  for port in "$@"; do
    until curl -sf "http://127.0.0.1:$port/health" >/dev/null; do
      ((SECONDS - start < limit)) || { log "port $port not healthy after ${limit}s"; return 1; }
      for pid in "${EVAL_PIDS[@]}"; do kill -0 "$pid" 2>/dev/null || { log "an eval server exited (port $port not up)"; return 1; }; done
      sleep 1
    done
  done
}

EVAL_PIDS=()
stop_eval_servers() {
  local pid
  for pid in "${EVAL_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${EVAL_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  EVAL_PIDS=()
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
  stop_eval_servers
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
CAND=$WEEK/LFM3-1.7B-bus-shared-$DATE-BF16.gguf
log "start$([[ $SMOKE == 1 ]] && echo ' (SMOKE)'): cutoff $CUTOFF, live model $LIVE, into $WEEK"

STEP=export
"$PY" "$HERE/export.py" --shared --cutoff "$CUTOFF" --out "$WEEK/data"

STEP="stop the live models"
DOWN_AT=$(date +%s)
systemctl --user stop "${UNITS[@]}"
log "stopped ${UNITS[*]}"

STEP=train
"$AGENT_BUS" run "$BOOKING" -- "$PY" "$HERE/train.py" --shared --root "$WEEK" --micro-batch 1 --checkpointing --max-gib 8.5 \
  $([[ $SMOKE == 1 ]] && echo --max-steps 10 || true) >"$WEEK/train.log" 2>&1 || { tail -20 "$WEEK/train.log"; exit 1; }
log "trained: $(jq -c '{total_steps, train_seconds, peak_reserved_gib, heldout_before: .heldout_before.all, heldout_after: .heldout_after.all}' "$WEEK/train-log.json")"

STEP=convert
"$PY" "$LLAMA/convert_hf_to_gguf.py" "$WEEK/merged" --outtype bf16 --outfile "$CAND" >"$WEEK/convert.log" 2>&1 || { tail -20 "$WEEK/convert.log"; exit 1; }
rm -rf "$WEEK/merged" # the adapter (lora/) rebuilds it
log "converted: $CAND"

STEP="eval servers"
for spec in "$LIVE 9971" "$CAND 9972"; do
  read -r model port <<<"$spec"
  "$AGENT_BUS" run "$BOOKING" -- "$LLAMA/build/bin/llama-server" -m "$model" --host 127.0.0.1 --port "$port" -ngl 99 \
    -c 8192 -np 2 --no-webui >"$WEEK/server-$port.log" 2>&1 &
  EVAL_PIDS+=($!)
done
healthy 180 9971 9972

STEP=eval
(cd "$HERE" && "$BUN" run eval.ts http://127.0.0.1:9971 http://127.0.0.1:9972 --cutoff "$CUTOFF" --out "$WEEK/results" \
  --samples "$SAMPLES" --labels live,candidate) >"$WEEK/eval.log" 2>&1 || { tail -20 "$WEEK/eval.log"; exit 1; }
STEP="stop eval servers"
stop_eval_servers

STEP=decide
S=$WEEK/results/summary.json
read -r cuts live_sr cand_sr wins losses < <(jq -r '[.cuts, .shownRight.base, .shownRight.tuned, .rightWins, .rightLosses] | @tsv' "$S")
pct() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f%%", b ? 100 * a / b : 0 }'; }
verdict="shown & right $(pct "$cand_sr" "$cuts") (candidate) vs $(pct "$live_sr" "$cuts") (live), paired $wins wins / $losses losses"
if [[ $SMOKE == 1 ]]; then
  rm -f "$CAND"
  outcome="smoke run, not put live ($verdict)"
elif ((cand_sr > live_sr && wins > losses)); then
  STEP=deploy
  NEW=$MODELS/LFM3-1.7B-bus-shared-$DATE-BF16.gguf
  mv "$CAND" "$NEW"
  sed -i "/^ExecStart=/s#-m $LIVE #-m $NEW #" "$UNIT_FILE"
  grep -q -- "-m $NEW " "$UNIT_FILE" || { log "the unit file does not point at $NEW"; exit 1; }
  systemctl --user daemon-reload
  # The last two stay (the new one and the one before it, for rollback).
  ls -t "$MODELS"/LFM3-1.7B-bus-shared*-BF16.gguf | tail -n +3 | while read -r old; do rm -f "$old" && log "deleted $old"; done
  outcome="went live: $(basename "$NEW") ($verdict; previous $(basename "$LIVE") kept for rollback)"
else
  rm -f "$CAND" # the adapter stays in lora/
  outcome="kept the current model ($(basename "$LIVE")), because the candidate was not better: $verdict"
fi
log "$outcome"

STEP="start the live models"
start_units

STEP=post
train_line=$(jq -r '"Training: \(.messages) messages (\(.conversations) shared conversations, no DMs), \(.tokens_train) tokens, before \(.cutoff_ms / 1000 | strftime("%Y-%m-%d %H:%M UTC"))"' "$WEEK/data/stats.json")
loss_line=$(jq -r '"held-out loss \(.heldout_before.all * 1000 | round / 1000) → \(.heldout_after.all * 1000 | round / 1000), \(.total_steps) steps in \(.train_seconds) s"' "$WEEK/train-log.json")
post "Weekly retraining of the typing model (Ümit #13481), $DATE: $outcome.
$train_line; $loss_line.
Test: $cuts cut points in can's and umit's messages after the cutoff, through the production pipeline:

$(jq -r .table "$S")"
STEP=end
