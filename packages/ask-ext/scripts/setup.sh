#!/usr/bin/env bash
# One-time local setup of the "Ask @agent" box extension (Ümit #13030): a CPU-only llama.cpp of its own and the
# LiquidAI d1-2B decision model. Skips what is already there, then prints the two commands to run.
#
#   bash packages/ask-ext/scripts/setup.sh
#
# BF16 by default: on bariton's Zen 5 (AVX512-BF16) it answers in half the time of Q8_0 (0.49 s against 1.1 s for a
# 600-token room, 12 threads), with the same answers on the fixtures. D1_QUANT=Q8_0 (1.8 GB instead of 3.5 GB) for a
# CPU without BF16. LLAMA_DIR, MODELS_DIR, LLAMA_TAG and THREADS can be set in the environment too.
set -euo pipefail

LLAMA_TAG="${LLAMA_TAG:-b12557}" # d1 (lfm3-d1) is supported from b11960
LLAMA_DIR="${LLAMA_DIR:-$HOME/.agent-bus/llama.cpp-d1}"
MODELS_DIR="${MODELS_DIR:-$HOME/.agent-bus/models}"
THREADS="${THREADS:-12}" # bariton is shared: at most 12 threads
MODEL="d1-2B-${D1_QUANT:-BF16}.gguf"
SERVER="$LLAMA_DIR/src/build/bin/llama-server"
REPO_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
TODAY="$(date +%F)"

if [[ ! -x "$SERVER" ]]; then
  mkdir -p "$LLAMA_DIR"
  [[ -f "$LLAMA_DIR/METADATA" ]] || cat >"$LLAMA_DIR/METADATA" <<EOF
message-bus, $TODAY: a CPU-only llama.cpp ($LLAMA_TAG, -DGGML_CUDA=OFF) for the "Ask @agent" box extension
(Ümit #13030): its llama-server runs LiquidAI d1-2B ($MODELS_DIR/$MODEL) for packages/ask-ext (agent-hub).
Built by packages/ask-ext/scripts/setup.sh. Deletable when ask-ext no longer uses d1 on this machine.
EOF
  [[ -d "$LLAMA_DIR/src" ]] || git clone --depth 1 --branch "$LLAMA_TAG" https://github.com/ggml-org/llama.cpp "$LLAMA_DIR/src"
  cmake -S "$LLAMA_DIR/src" -B "$LLAMA_DIR/src/build" -DGGML_CUDA=OFF -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release
  nice cmake --build "$LLAMA_DIR/src/build" -j "$THREADS" --target llama-server
fi

if [[ ! -f "$MODELS_DIR/$MODEL" ]]; then
  mkdir -p "$MODELS_DIR"
  grep -qs "$MODEL" "$MODELS_DIR/METADATA" ||
    echo "$MODEL ($TODAY): LiquidAI/d1-2B-GGUF, the decision model of the \"Ask @agent\" box extension (packages/ask-ext, Ümit #13030). Keep while ask-ext uses it." >>"$MODELS_DIR/METADATA"
  curl -fL --retry 3 -o "$MODELS_DIR/$MODEL.part" "https://huggingface.co/LiquidAI/d1-2B-GGUF/resolve/main/$MODEL"
  mv "$MODELS_DIR/$MODEL.part" "$MODELS_DIR/$MODEL"
fi

cat <<EOF
Ready. Run the model, then the extension:

  $SERVER -m $MODELS_DIR/$MODEL --host 127.0.0.1 --port 9963 -t $THREADS -b 8192 -ub 8192 -c 8192 --no-webui
  ASK_PORT=7832 ASK_DECIDE_URL=http://127.0.0.1:9963 ASK_MIN_CONFIDENCE=0.5 bun run $REPO_DIR/packages/ask-ext/src/server.ts

and give it to the bus: serve --ext ask=http://127.0.0.1:7832,box=recipient
EOF
