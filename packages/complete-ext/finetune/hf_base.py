"""Loads another Hugging Face model in place of LFM3 1.7B (lfm3.py), for train.py --base DIR: trying other typing-
suggestion models (Ümit #14766). The same interface as lfm3.py: base(), tokenizer(), model(), TARGETS, PAD.

The model's own tokenizer (AutoTokenizer) with the special tokens its config adds (MiniCPM5's BOS, which llama.cpp adds
too; Gemma 4's config adds none, llama.cpp a BOS). A checkpoint with a vision tower (Qwen3.5, Gemma 4) loads whole, so
that the merged model saves under the checkpoint's own tensor names for convert_hf_to_gguf.py (Qwen3.5's multi-token-
prediction layer, which transformers does not load, is then left out of the GGUF; plain decoding does not use it). The
LoRA goes on the language model's linear layers only.
"""

import torch
from transformers import AutoConfig, AutoModelForCausalLM, AutoModelForImageTextToText, AutoTokenizer

_dir: str | None = None

# Attention, MLP and linear-attention projections (as LFM3's list covers its attention, conv and MLP), not lm_head and
# not a vision or audio tower's layers.
TARGETS = r"^(?!.*(visual|vision|audio)).*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj|in_proj_qkv|in_proj_z|out_proj)$"
PAD = 0  # labels are -100 there and padding is on the right of a causal model: never seen by a real token


def use(path: str) -> None:
    global _dir
    _dir = path


def base() -> str:
    if _dir is None:
        raise RuntimeError("hf_base.use(DIR) first")
    return _dir


def tokenizer():
    return AutoTokenizer.from_pretrained(base())


def model(path: str | None = None):
    config = AutoConfig.from_pretrained(path or base())
    auto = AutoModelForImageTextToText if hasattr(config, "vision_config") else AutoModelForCausalLM
    return auto.from_pretrained(path or base(), dtype=torch.bfloat16)
