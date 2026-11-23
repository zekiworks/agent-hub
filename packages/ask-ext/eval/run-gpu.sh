#!/usr/bin/env bash
# The GPU runs of the "Ask @agent" comparison (Ümit #13030): starts a System One server for one model on ONE booked GPU,
# runs the harness (run.ts) over every item, then stops the server. Book the GPU first (the bus's resources); this
# script does not book anything.
#
#   packages/ask-ext/eval/run-gpu.sh glide GPU_INDEX [run.ts flags…]   # fastino/GLiDE-2B, transformers, bf16, port 9964
#   packages/ask-ext/eval/run-gpu.sh d1 GPU_INDEX [run.ts flags…]      # LiquidAI d1-2B (D1_QUANT, default BF16 as the hub runs it), llama.cpp CUDA, port 9965
#   packages/ask-ext/eval/run-gpu.sh omni GPU_INDEX [run.ts flags…]    # LiquidAI/d1-Omni-2B, transformers bf16, port 9966
#
# GLiDE needs ~/.agent-bus/ask-eval/glide-venv and ~/.agent-bus/models/GLiDE-2B. d1 needs
# ~/.agent-bus/ask-eval/llama.cpp-cuda and ~/.agent-bus/models/d1-2B-<D1_QUANT>.gguf. Omni needs
# ~/.agent-bus/ask-eval/d1-venv with torch, torchvision, Pillow and transformers>=5.19; override its interpreter with
# D1_PYTHON when an equivalent environment already exists. Writes ~/.agent-bus/ask-eval/results-<glide|d1|omni>-gpu.jsonl
# (+ .meta.json), the server log next to it, and prints peak GPU memory.
#
# The Omni candidate is LiquidAI/d1-Omni-2B at its published revision, using the model card's exact system_one call.
set -euo pipefail

which="${1:?glide, d1, or omni}"
gpu="${2:?the index of the booked GPU}"
shift 2
eval_dir="${ASK_EVAL_DIR:-$HOME/.agent-bus/ask-eval}"
models="$HOME/.agent-bus/models"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
gpu_name="$(nvidia-smi -i "$gpu" --query-gpu=name --format=csv,noheader)"
export CUDA_VISIBLE_DEVICES="$gpu"

case "$which" in
  glide)
    port=9964
    model=GLiDE-2B
    hardware="bariton GPU $gpu ($gpu_name): transformers bf16, GLIDE_MAX_BATCH=1"
    # One request at a time and no batching across requests: deterministic, and the latency of a single call.
    PYTHONPATH="$models/GLiDE-2B" GLIDE_DEVICE=cuda GLIDE_MAX_BATCH=1 TRITON_CACHE_DIR="$eval_dir/triton-cache" \
      "$eval_dir/glide-venv/bin/python" -m glide.server --model "$models/GLiDE-2B" --host 127.0.0.1 --port "$port" \
      >"$eval_dir/glide-server.log" 2>&1 &
    ;;
  d1)
    port=9965
    quant="${D1_QUANT:-BF16}"
    model="d1-2B-$quant"
    hardware="bariton GPU $gpu ($gpu_name): llama.cpp CUDA, $quant, all layers on the GPU"
    "$eval_dir/llama.cpp-cuda/build/bin/llama-server" -m "$models/d1-2B-$quant.gguf" --host 127.0.0.1 --port "$port" \
      -ngl 99 -b 8192 -ub 8192 -c 8192 -t 4 --no-webui >"$eval_dir/d1-gpu-server.log" 2>&1 &
    ;;
  omni)
    port=9966
    model=LiquidAI/d1-Omni-2B
    hardware="bariton GPU $gpu ($gpu_name): transformers bf16, Liquid system_one, text-only routing"
    d1_python="${D1_PYTHON:-$eval_dir/d1-venv/bin/python}"
    [[ -x "$d1_python" ]] || { echo "no $d1_python; install the Liquid d1 requirements or set D1_PYTHON" >&2; exit 2; }
    "$d1_python" -B "$repo/packages/ask-ext/eval/d1-server.py" --model "$model" \
      --revision 81222dae8bf8bdd7f903643b5b2a8803bf2e3176 --device cuda:0 --host 127.0.0.1 --port "$port" \
      >"$eval_dir/omni-gpu-server.log" 2>&1 &
    ;;
  *)
    echo "usage: $0 glide|d1|omni GPU_INDEX [run.ts flags…]" >&2
    exit 2
    ;;
esac
server=$!
peak_file="$(mktemp)"
echo 0 >"$peak_file"
watcher=""
cleanup() {
  [ -n "$watcher" ] && kill "$watcher" 2>/dev/null || true
  kill "$server" 2>/dev/null || true
  wait "$server" 2>/dev/null || true
  echo "peak GPU memory of the $which server: $(cat "$peak_file") MiB"
  rm -f "$peak_file"
}
trap cleanup EXIT

echo "waiting for the $which server on 127.0.0.1:$port (GPU $gpu, $gpu_name)…"
for _ in $(seq 1 300); do
  if ! kill -0 "$server" 2>/dev/null; then
    echo "the $which server exited; see its log in $eval_dir" >&2
    exit 1
  fi
  if curl -sf "http://127.0.0.1:$port/health" >/dev/null; then break; fi
  sleep 1
done
curl -sf "http://127.0.0.1:$port/health" >/dev/null || { echo "the $which server did not come up in 300 s" >&2; exit 1; }

# The server's GPU memory, sampled every second (its peak is printed at the end).
(
  while kill -0 "$server" 2>/dev/null; do
    used="$(nvidia-smi -i "$gpu" --query-compute-apps=pid,used_memory --format=csv,noheader,nounits | awk -F', ' -v p="$server" '$1 == p { print $2 }')"
    if [ -n "$used" ] && [ "$used" -gt "$(cat "$peak_file")" ]; then echo "$used" >"$peak_file"; fi
    sleep 1
  done
) &
watcher=$!

cd "$repo"
bun packages/ask-ext/eval/run.ts --url "http://127.0.0.1:$port" --model "$model" --hardware "$hardware" --warmup 10 \
  --out "$eval_dir/results-$which-gpu.jsonl" "$@"
