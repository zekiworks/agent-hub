#!/usr/bin/env bash
# The typing-suggestion bench (Ümit #14949, #14950): each week, after weekly.sh has retrained LFM3, the other small
# models are fine-tuned on the same export and every model is tested against the live one on the same cut points.
# Nothing here goes live; it only measures. Called by weekly.sh with the live units stopped, on the same booking.
#
# Models: LFM3 1.7B untrained; Qwen3.5-2B and MiniCPM5-2B untrained and fine-tuned (train.py --base, our LoRA settings;
# Qwen with 1,024-token windows: 2,048 does not fit the 9.3 GiB cap with its 248k vocabulary).
# Outputs: <week>/bench/ (eval-<model>/ with table.md, results.jsonl, summary.json; train-<model>/ with the LoRA and
# train-log.json); one line per model per week in ~/.agent-bus/finetune/suggest-bench.jsonl; table.md for the post.
# A fine-tuned GGUF is deleted after its test (rebuilt next week); the untrained ones stay in ~/.agent-bus/models.
#
# Usage: bench.sh WEEK_DIR LIVE_GGUF   (QUICK=1: 5 training steps, 60 cut points, no history line: checks the wiring.)
set -Eeuo pipefail

WEEK=$1 LIVE=$2
QUICK=${QUICK:-0}
HERE=$(cd "$(dirname "$0")" && pwd)
PY=$HOME/.agent-bus/ask-eval/glide-venv/bin/python
LLAMA=$HOME/.agent-bus/ask-eval/llama.cpp-cuda
SERVER=$LLAMA/build/bin/llama-server
AGENT_BUS=$HOME/.local/bin/agent-bus
BOOKING=r_9e07e06d2fab
MODELS=$HOME/.agent-bus/models
DB=$HOME/.agent-bus/message-bus.sqlite
HISTORY=$HOME/.agent-bus/finetune/suggest-bench.jsonl
HF=$HOME/.cache/huggingface/hub
OUT=$WEEK/bench$([[ $QUICK == 1 ]] && echo -quick || true)
SAMPLES=$([[ $QUICK == 1 ]] && echo 60 || echo 3000)

# name | Hugging Face folder | window tokens
TUNE=(
  "Qwen3.5-2B|$HF/models--Qwen--Qwen3.5-2B/snapshots/15852e8c16360a2fea060d615a32b45270f8a8fc|1024"
  "MiniCPM5-2B|$HF/models--openbmb--MiniCPM5-2B/snapshots/42433e90dad95123ab87729fd7011e7110629556|2048"
)
# label | GGUF (fine-tuned ones are added as they are made)
TEST=(
  "LFM3-1.7B|$MODELS/LFM3-1.7B-BF16.gguf"
  "Qwen3.5-2B|$MODELS/Qwen3.5-2B-BF16.gguf"
  "MiniCPM5-2B|$MODELS/MiniCPM5-2B-BF16.gguf"
)

log() { echo "$(date '+%F %T') bench: $*"; }
umask 077
mkdir -p "$OUT"
CUTOFF=$(jq -r '.cutoff_ms / 1000 | strftime("%Y-%m-%dT%H:%M:%SZ")' "$WEEK/data/stats.json")

stop_servers() { pkill -f -- "--port 998[12] " 2>/dev/null || true; sleep 2; }
trap stop_servers EXIT

healthy() { # port seconds
  local start=$SECONDS
  until curl -sf "http://127.0.0.1:$1/health" >/dev/null; do ((SECONDS - start < $2)) || return 1; sleep 1; done
}

for entry in "${TUNE[@]}"; do
  IFS='|' read -r name base tokens <<<"$entry"
  work=$OUT/train-$name
  mkdir -p "$work"
  free=$(nvidia-smi -i 3 --query-gpu=memory.free --format=csv,noheader,nounits)
  if ((free < 10000)); then log "$name: GPU 3 has only $free MiB free; not trained this week"; continue; fi
  log "$name: training (${tokens}-token windows)"
  quick=()
  [[ $QUICK == 1 ]] && quick=(--max-steps 5 --max-windows 24)
  if ! (cd "$HERE" && PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True PYTHONUNBUFFERED=1 "$AGENT_BUS" run "$BOOKING" -- "$PY" train.py \
    --base "$base" --data "$WEEK/data" --out "$work" --people can,umit --device cuda --micro-batch 1 --checkpointing \
    --max-gib 9.3 --max-tokens "$tokens" "${quick[@]}" >"$work/train.log" 2>&1); then
    log "$name: training failed (tail of $work/train.log below)"; tail -5 "$work/train.log"; continue
  fi
  if ! PYTHONPATH=$HOME/.agent-bus/finetune/suggest-candidates/pydeps "$PY" "$LLAMA/convert_hf_to_gguf.py" "$work/merged" \
    --outtype bf16 --outfile "$OUT/$name-tuned-BF16.gguf" >"$work/convert.log" 2>&1; then
    log "$name: conversion failed ($work/convert.log)"; continue
  fi
  rm -rf "$work/merged"
  TEST+=("$name-tuned|$OUT/$name-tuned-BF16.gguf")
done

for entry in "${TEST[@]}"; do
  IFS='|' read -r label gguf <<<"$entry"
  eval_out=$OUT/eval-$label
  mkdir -p "$eval_out"
  [[ -f $gguf ]] || { log "$label: no $gguf; skipped"; continue; }
  stop_servers
  "$AGENT_BUS" run "$BOOKING" -- "$SERVER" -m "$LIVE" --host 127.0.0.1 --port 9981 -ngl 99 -c 8192 -np 2 --no-webui >"$eval_out/server-live.log" 2>&1 &
  "$AGENT_BUS" run "$BOOKING" -- "$SERVER" -m "$gguf" --host 127.0.0.1 --port 9982 -ngl 99 -c 8192 -np 2 --no-webui >"$eval_out/server.log" 2>&1 &
  if ! healthy 9981 300 || ! healthy 9982 300; then log "$label: a test server did not come up ($eval_out)"; continue; fi
  log "$label: testing on $SAMPLES cut points after $CUTOFF"
  if ! (cd "$HERE" && bun run eval.ts http://127.0.0.1:9981 http://127.0.0.1:9982 --db "$DB" --people can,umit --cutoff "$CUTOFF" \
    --out "$eval_out" --samples "$SAMPLES" --labels "live LFM3,$label" >"$eval_out/eval.log" 2>&1); then
    log "$label: test failed ($eval_out/eval.log)"; continue
  fi
  if [[ $gguf == "$OUT"/* ]]; then rm -f "$gguf"; fi
done
stop_servers

# One row per model, "all" cut points: the live model once (from the first test), then each tested model.
# table.md columns: cut points, model, n, next-word top-1, shown, right of shown, shown & right, words saved per shown,
# words saved per cut, median ms.
row() { grep -m1 -F "| all | $2 |" "$1/table.md" | awk -F'|' -v m="$3" '{printf "| %s |%s|%s|%s|%s|\n", m, $8, $5, $10, $11}'; }
{
  echo "| model | suggested & right | next word right | words saved per place | median ms |"
  echo "|---|---|---|---|---|"
  first=1
  for entry in "${TEST[@]}"; do
    IFS='|' read -r label _ <<<"$entry"
    d=$OUT/eval-$label
    [[ -f $d/table.md ]] || { echo "| $label | not tested this week | | | |"; continue; }
    ((first)) && row "$d" "live LFM3" "LFM3-1.7B fine-tuned (live)" && first=0
    row "$d" "$label" "$label"
  done
} >"$OUT/table.md"

if [[ $QUICK != 1 ]]; then
  for entry in "${TEST[@]}"; do
    IFS='|' read -r label _ <<<"$entry"
    s=$OUT/eval-$label/summary.json
    [[ -f $s ]] || continue
    jq -c --arg week "$(basename "$WEEK")" --arg model "$label" \
      '{week: $week, model: $model, cutoff, cuts, shownRight: .shownRight.tuned, top1: .top1.tuned,
        liveShownRight: .shownRight.base, liveTop1: .top1.base, rightWins, rightLosses}' "$s" >>"$HISTORY"
  done
fi
log "done: $OUT/table.md"
