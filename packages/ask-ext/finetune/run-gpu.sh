#!/usr/bin/env bash
# The GPU parts of the d1-2B routing fine-tune (Ümit #13659) on bariton's booking r_9e07e06d2fab (GPU 3, 10 GB), which
# holds the two live models (agent-bus-complete-model, agent-bus-ask-model) or this, not both. Each step stops both
# units, runs, and starts them again, always (also on failure), logging how long they were down.
#
#   run-gpu.sh train   — choose the epochs on a dev split (latest 15% of the training labels), then train on all the
#                        training items with that many epochs and merge (OUT/select, OUT/final)
#   run-gpu.sh eval    — the converted model (OUT/d1-2B-routing-BF16.gguf) in a test llama-server on :9973, eval.ts
#                        on the TEST set into OUT/results/trained.json
set -Eeuo pipefail

STEP=${1:?usage: run-gpu.sh train|eval}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HOME/.agent-bus/finetune/d1
PY=$HOME/.agent-bus/ask-eval/glide-venv/bin/python
LLAMA=$HOME/.agent-bus/ask-eval/llama.cpp-cuda
BOOKING=r_9e07e06d2fab
UNITS=(agent-bus-complete-model.service agent-bus-ask-model.service)
LOG=$OUT/run-gpu.log
export PYTHONPATH=$OUT/pylib # torchvision for d1's own code, kept out of the shared venv

exec > >(tee -a "$LOG") 2>&1
log() { echo "$(date '+%F %T') run-gpu $STEP: $*"; }

DOWN_AT=
TEST_PID=
finish() {
  local rc=$?
  trap - EXIT
  [[ -n $TEST_PID ]] && kill "$TEST_PID" 2>/dev/null && wait "$TEST_PID" 2>/dev/null || true
  pkill -f -- "llama-server -m $OUT/" || true # the server under agent-bus run's wrapper
  systemctl --user start "${UNITS[@]}" || log "systemctl start failed"
  local start=$SECONDS port
  for port in 9962 9963; do
    until curl -sf "http://127.0.0.1:$port/health" >/dev/null; do
      ((SECONDS - start < 180)) || { log "port $port not healthy after 180 s"; break; }
      sleep 1
    done
  done
  [[ -n $DOWN_AT ]] && log "live units were down $(($(date +%s) - DOWN_AT)) s"
  log "done (exit $rc)"
}
trap finish EXIT
trap 'exit 143' TERM INT HUP

DOWN_AT=$(date +%s)
systemctl --user stop "${UNITS[@]}"
log "stopped ${UNITS[*]}"

if [[ $STEP == train ]]; then
  agent-bus run "$BOOKING" -- "$PY" "$HERE/train.py" --data "$OUT/data/train.jsonl" --out "$OUT/select" --dev-share 0.15 --epochs 4 --max-gib 8.5
  # The epoch with the best forced dev accuracy, the fewest epochs on a tie.
  EPOCHS=$(jq '[.epochs[] | {e: .epoch, a: .dev.forced}] | max_by(.a * 100 - .e / 10) | .e' "$OUT/select/train-log.json")
  log "chosen epochs: $EPOCHS"
  agent-bus run "$BOOKING" -- "$PY" "$HERE/train.py" --data "$OUT/data/train.jsonl" --out "$OUT/final" --epochs "$EPOCHS" --max-gib 8.5 --merge
elif [[ $STEP == eval ]]; then
  agent-bus run "$BOOKING" -- "$LLAMA/build/bin/llama-server" -m "$OUT/d1-2B-routing-BF16.gguf" --host 127.0.0.1 --port 9973 \
    -ngl 99 -b 8192 -ub 8192 -c 8192 --no-webui >"$OUT/test-server.log" 2>&1 &
  TEST_PID=$!
  start=$SECONDS
  until curl -sf http://127.0.0.1:9973/health >/dev/null; do
    ((SECONDS - start < 180)) || { log "test server not healthy after 180 s"; exit 1; }
    sleep 1
  done
  mkdir -p "$OUT/results"
  bun "$HERE/eval.ts" 9973 "$OUT/data/test.jsonl" "$OUT/results/trained.json"
else
  log "unknown step"
  exit 2
fi
