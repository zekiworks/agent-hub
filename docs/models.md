# Models used by the optional services

Agent Hub works without any local model. The default wake rule does not use a model. This page lists the models the
optional services use and the alternatives that were measured.

## Speech to text

`packages/stt` uses faster-whisper large-v3-turbo. Each person can let
[Liquid AI LFM3-Audio-2B](https://huggingface.co/LiquidAI/LFM3-Audio-2B) write their English instead (Settings). That
choice works only when the operator runs an LFM3-Audio server (llama-server) and sets `STT_LIQUID_URL` for
`packages/stt`; without it, English stays with Whisper. Other languages always use Whisper, which also picks the
language.

Measured on the same 100 English [FLEURS](https://huggingface.co/datasets/google/fleurs) recordings on CPU:

| Model | Wrong words | Wrong words, numbers as digits or words both counted right | Time per recording |
|---|---|---|---|
| Whisper large-v3-turbo (default) | 4.9% | 4.7% | 1.5 s |
| LFM3-Audio-2B (supported for English; needs `STT_LIQUID_URL`) | 5.3% | 5.0% | 0.4 s |
| [IBM Granite Speech 5.0 2B](https://huggingface.co/ibm-granite/granite-speech-5.0-2b) (audio.cpp Q8_0; not supported) | 5.6% | 4.1% | 0.9 s |

Granite writes numbers out ("seventy" for 70), which explains the difference between the two columns. In Turkish,
LFM3-Audio gets 55% of words wrong and Granite Speech has no Turkish, so Turkish stays with Whisper.

## Small models

The reference Hub uses **LFM3-1.7B** for typing suggestions, **d1-2B** for the optional suggestion of which agent to
ask, **d1-2B with GLiDE-2B** for the Inbox's "Waiting for your answer" picks, and **LFM3-Audio-2B** to read messages
aloud.

The other models below were measured as alternatives on
[Model Atlas](https://zekiworks.github.io/analysis/?section=All+benches), in
[Reading](https://zekiworks.github.io/analysis/?section=Reading+%26+Grammar),
[Logic & Math](https://zekiworks.github.io/analysis/?section=Logic+%26+Math),
[Science](https://zekiworks.github.io/analysis/?section=Science),
[Tool Calling](https://zekiworks.github.io/analysis/?section=Toolbench) and
[Answer Check](https://zekiworks.github.io/analysis/?section=Answer+Check). These general benchmarks do not show how
well a model completes messages or picks the right agent; Agent Hub's own runners measure that before a model is
deployed.

**Small chat models measured on Model Atlas** (typing suggestions; in use: LFM3-1.7B, privately fine-tuned on
shared-room messages)

| Model | Maker | Hugging Face |
|---|---|---|
| LFM3-1.7B | Liquid AI | [LiquidAI/LFM3-1.7B](https://huggingface.co/LiquidAI/LFM3-1.7B) |
| MiniCPM5-2B | OpenBMB | [openbmb/MiniCPM5-2B](https://huggingface.co/openbmb/MiniCPM5-2B) |
| Qwen3.5-2B | Alibaba | [Qwen/Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B) |
| Qwen3.5-4B | Alibaba | [Qwen/Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B) |
| Gemma 4 E2B | Google | [google/gemma-4-E2B-it](https://huggingface.co/google/gemma-4-E2B-it) |
| Gemma 4 E4B | Google | [google/gemma-4-E4B-it](https://huggingface.co/google/gemma-4-E4B-it) |
| Gemma 4 12B | Google | [google/gemma-4-12B-it](https://huggingface.co/google/gemma-4-12B-it) |
| Granite 4.2 3B | IBM | [ibm-granite/granite-4.2-3b](https://huggingface.co/ibm-granite/granite-4.2-3b) |
| Raon-1 nano | KRAFTON | [KRAFTON/Raon-1-nano](https://huggingface.co/KRAFTON/Raon-1-nano) |
| SmolLM3-3B | Hugging Face | [HuggingFaceTB/SmolLM3-3B](https://huggingface.co/HuggingFaceTB/SmolLM3-3B) |
| Aion 1.0 Instruct | Microsoft | [microsoft/Aion-1.0-Instruct-2.3B](https://huggingface.co/microsoft/Aion-1.0-Instruct-2.3B) |
| Nemotron-Labs-Sigma-3B-instruct | NVIDIA | [nvidia/Nemotron-Labs-Sigma-3B-instruct](https://huggingface.co/nvidia/Nemotron-Labs-Sigma-3B-instruct) |

**Small decision models measured on Model Atlas** (agent suggestion and Inbox picks; in use: d1-2B, and GLiDE-2B for
the Inbox)

| Model | Maker | Hugging Face |
|---|---|---|
| d1-2B | Liquid AI | [LiquidAI/d1-2B](https://huggingface.co/LiquidAI/d1-2B) |
| d1-Omni-2B | Liquid AI | [LiquidAI/d1-Omni-2B](https://huggingface.co/LiquidAI/d1-Omni-2B) |
| d1-3B | Liquid AI | [LiquidAI/d1-3B](https://huggingface.co/LiquidAI/d1-3B) |
| GLiDE-2B | Fastino | [fastino/GLiDE-2B](https://huggingface.co/fastino/GLiDE-2B) |
| GLiDE-0.8B | Fastino | [fastino/GLiDE-0.8B](https://huggingface.co/fastino/GLiDE-0.8B) |
| KnowLine-2B-Gen1 | PelaAI | [PelaAI/KnowLine-2B-Gen1](https://huggingface.co/PelaAI/KnowLine-2B-Gen1) |
| StartLux-Decision v1.1 2B | StartLux | [startlux-models/StartLux-Decision-v1.1-2B-Instant](https://huggingface.co/startlux-models/StartLux-Decision-v1.1-2B-Instant) |
| Chinese Decision Pointer 4B | quincyqiang | [quincyqiang/chinese-decision-pointer-4b](https://huggingface.co/quincyqiang/chinese-decision-pointer-4b) |
| Verdin-4B-v1.1 | victorbennett | [victorbennett/Verdin-4B-v1.1](https://huggingface.co/victorbennett/Verdin-4B-v1.1) |
| Metask-Jev-4B | Metask Lab | [wayfind/metask-jev-4b-policy-mix](https://huggingface.co/wayfind/metask-jev-4b-policy-mix) |
| Perplexity Decider Flash v1.3 | Perplexity | [perplexity-ai/pplx-decider-flash-v1.3](https://huggingface.co/perplexity-ai/pplx-decider-flash-v1.3) |
| vera-medium-omni | scar-ai | [scar-ai/vera-medium-omni](https://huggingface.co/scar-ai/vera-medium-omni) |
