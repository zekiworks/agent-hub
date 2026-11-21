#!/usr/bin/env bash
# The GPU parts of the "needs you" measurement (Ümit #13719), as ../finetune/run-gpu.sh: bariton's booking
# r_9e07e06d2fab (GPU 3, 10 GB) holds the two live models (agent-bus-complete-model, agent-bus-ask-model) or this, not
# both. Each step stops both units, runs, and starts them again, always (also on failure), logging how long they were down.
#
#   run-gpu.sh train            — train.py on OUT/data/{train,dev}.jsonl (export.ts) into OUT/final
#   run-gpu.sh eval PHRASING    — the converted model (OUT/d1-2B-needs-you-BF16.gguf) in a test llama-server on :9973,
#                                 ask.ts on the dev sample and the TEST set into OUT/results/{dev,test}-trained-PHRASING.json
set -Eeuo pipefail

STEP=${1:?usage: run-gpu.sh train|eval PHRASING}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HOME/.agent-bus/finetune/needs-you
PY=$HOME/.agent-bus/ask-eval/glide-venv/bin/python
LLAMA=$HOME/.agent-bus/ask-eval/llama.cpp-cuda
BOOKING=r_9e07e06d2fab
UNITS=(agent-bus-complete-model.service agent-bus-ask-model.service)
LOG=$OUT/run-gpu.log
export PYTHONPATH=$HOME/.agent-bus/finetune/d1/pylib # torchvision for d1's own code, kept out of the shared venv

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

if [[ $STEP == eval ]]; then
  PHRASING=${2:?usage: run-gpu.sh eval PHRASING}
  [[ -f $OUT/d1-2B-needs-you-BF16.gguf ]] || { log "no $OUT/d1-2B-needs-you-BF16.gguf"; exit 2; }
elif [[ $STEP != train ]]; then
  log "unknown step"
  exit 2
fi

DOWN_AT=$(date +%s)
systemctl --user stop "${UNITS[@]}"
log "stopped ${UNITS[*]}"

if [[ $STEP == train ]]; then
  agent-bus run "$BOOKING" -- "$PY" "$HERE/train.py" --data "$OUT/data" --out "$OUT/final" --epochs 2 --max-gib 8.5
else
  agent-bus run "$BOOKING" -- "$LLAMA/build/bin/llama-server" -m "$OUT/d1-2B-needs-you-BF16.gguf" --host 127.0.0.1 --port 9973 \
    -ngl 99 -b 8192 -ub 8192 -c 8192 --no-webui >"$OUT/test-server.log" 2>&1 &
  TEST_PID=$!
  start=$SECONDS
  until curl -sf http://127.0.0.1:9973/health >/dev/null; do
    ((SECONDS - start < 180)) || { log "test server not healthy after 180 s"; exit 1; }
    sleep 1
  done
  mkdir -p "$OUT/results"
  bun "$HERE/ask.ts" 9973 "$PHRASING" dev "$OUT/results/dev-trained-$PHRASING.json"
  bun "$HERE/ask.ts" 9973 "$PHRASING" test "$OUT/results/test-trained-$PHRASING.json"
fi
