"""Loads LFM3 1.7B (HF weights, its own code) in this venv's transformers 5.17.

Its config lists "conv" layers in layer_types but RoPE parameters only for the attention layers; transformers 5.17's
standardize_rope_params looks up every layer type and fails (KeyError 'conv'), and convert_rope_params_to_dict puts a
stray top-level "rope_theta" into the per-layer-type dict (validate_rope then fails on the float). Patched here to look
only at the layer types that have RoPE parameters, which is what the model's own rotary embedding does. Also 5.17
renames a custom-code config's "conv" layers to "linear_attention" (LFM2's legacy name), which the model's own code
does not know; that renaming is turned off and "conv" allowed as it is.
"""

import os

import torch
from transformers import AutoModelForCausalLM, PreTrainedTokenizerFast
from transformers import configuration_utils
from transformers.modeling_rope_utils import RotaryEmbeddingConfigMixin

BASE = os.path.expanduser(
    "~/.cache/huggingface/hub/models--LiquidAI--LFM3-1.7B/snapshots/0dc4268b561499c648c7ba7c9466bf3d8d01517a"
)

_standardize = RotaryEmbeddingConfigMixin.standardize_rope_params


def _standardize_attention_only(self):
    layer_types = getattr(self, "layer_types", None)
    rope = getattr(self, "rope_parameters", None)
    if not layer_types or not isinstance(rope, dict) or not set(rope) & set(layer_types):
        return _standardize(self)
    self.layer_types = [t for t in layer_types if t in rope]
    for key in [k for k, v in rope.items() if not isinstance(v, dict)]:
        del rope[key]
    try:
        return _standardize(self)
    finally:
        self.layer_types = layer_types


RotaryEmbeddingConfigMixin.standardize_rope_params = _standardize_attention_only
configuration_utils._LEGACY_LAYER_TYPE_REMAP.pop("conv", None)
configuration_utils.ALLOWED_ATTN_LAYER_TYPES = (*configuration_utils.ALLOWED_ATTN_LAYER_TYPES, "conv")


def tokenizer() -> PreTrainedTokenizerFast:
    return PreTrainedTokenizerFast(tokenizer_file=f"{BASE}/tokenizer.json")


def model(path: str = BASE):
    return AutoModelForCausalLM.from_pretrained(path, trust_remote_code=True, dtype=torch.bfloat16)
