"""LoRA fine-tuning of LFM3 1.7B on a hub's messages (export.py's windows), then the merged model for GGUF conversion.

Loss on all tokens of a window (the conversation as the model sees it in production). Held-out loss is measured before
and after, on all tokens and on the people's (--people) words only. Reads --data (export.py's output); writes to --out:
lora/ (adapter), merged/ (HF model with the adapter merged), train-log.json. Batches of 8 windows either way:
--micro-batch 1 (8 accumulated) with --checkpointing when the GPU is short of memory (about 9 GB then), and --max-gib
caps this process's CUDA memory (an out-of-memory error rather than crowding others on a shared GPU). --device cpu
trains on the CPU (hours). --max-steps, --max-windows and --max-tokens make a smoke run (a few steps on a sample);
--no-merge then skips merged/. --base DIR fine-tunes another Hugging Face model (hf_base.py) instead of LFM3 1.7B, with
the same data and settings. train-suggestions.ts runs it:

  python train.py --data DIR/data --out DIR --people carol,uma --micro-batch 1 --checkpointing [--device cpu]
"""

import argparse
import json
import math
import os
import random
import re
import shutil
import time

import torch
from peft import LoraConfig, get_peft_model

import hf_base
import lfm3

args = argparse.ArgumentParser()
args.add_argument("--data", required=True)
args.add_argument("--out", required=True)
args.add_argument("--people", required=True, help="comma-separated ids")
args.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
args.add_argument("--micro-batch", type=int, default=4)
args.add_argument("--checkpointing", action="store_true")
args.add_argument("--max-gib", type=float)
args.add_argument("--max-steps", type=int)
args.add_argument("--max-windows", type=int)
args.add_argument("--max-tokens", type=int, default=2048)
args.add_argument("--no-merge", action="store_true")
args.add_argument("--base", help="a Hugging Face model folder to fine-tune instead of LFM3 1.7B (hf_base.py)")
ARGS = args.parse_args()
if ARGS.base:
    hf_base.use(ARGS.base)
BASE = hf_base if ARGS.base else lfm3

ROOT = ARGS.out
DATA = ARGS.data
MAX_TOKENS = ARGS.max_tokens
EPOCHS = 2
BATCH = 8
MICRO_BATCH = ARGS.micro_batch
ACCUM = BATCH // MICRO_BATCH
LR = 2e-4
WARMUP = 20
RANK = 32
ALPHA = 64
TARGETS = BASE.TARGETS
PEOPLE_LINE = re.compile(f"^@({'|'.join(re.escape(p) for p in ARGS.people.split(',') if p)}): ", re.M)


def load(split: str, tok, limit: int | None = None) -> list[dict]:
    items = []
    for line in open(f"{DATA}/{split}.jsonl"):
        if limit is not None and len(items) >= limit:
            break
        text = json.loads(line)["text"]
        enc = tok(text, return_offsets_mapping=True)
        ids = enc.input_ids[:MAX_TOKENS]
        # The people's words: from after "@carol: " up to the end of that line (its newline included).
        spans = [(m.end(), text.find("\n", m.end()) + 1) for m in PEOPLE_LINE.finditer(text)]
        people = [any(a <= s < b for a, b in spans) for s, _e in enc.offset_mapping[:MAX_TOKENS]]
        items.append({"ids": ids, "people": people})
    return items


def batch_of(items: list[dict], pad: int, device) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    n = max(len(i["ids"]) for i in items)
    ids = torch.full((len(items), n), pad, dtype=torch.long)
    labels = torch.full((len(items), n), -100, dtype=torch.long)
    people = torch.zeros((len(items), n), dtype=torch.bool)
    for row, item in enumerate(items):
        k = len(item["ids"])
        ids[row, :k] = torch.tensor(item["ids"])
        labels[row, :k] = ids[row, :k]
        people[row, :k] = torch.tensor(item["people"])
    return ids.to(device), labels.to(device), people.to(device)


def token_losses(model, ids: torch.Tensor, labels: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Per-token loss of predicting token t+1, and which of those count (not padding)."""
    logits = model(input_ids=ids).logits[:, :-1].float()
    target = labels[:, 1:]
    loss = torch.nn.functional.cross_entropy(logits.reshape(-1, logits.size(-1)), target.reshape(-1), ignore_index=-100, reduction="none")
    return loss.view(target.shape), target != -100


@torch.no_grad()
def heldout_loss(model, items: list[dict], pad: int, device) -> dict:
    model.eval()
    total = tokens = ptotal = ptokens = 0.0
    for start in range(0, len(items), MICRO_BATCH):
        ids, labels, people = batch_of(items[start:start + MICRO_BATCH], pad, device)
        loss, mask = token_losses(model, ids, labels)
        pmask = mask & people[:, 1:]
        total += loss[mask].sum().item()
        tokens += mask.sum().item()
        ptotal += loss[pmask].sum().item()
        ptokens += pmask.sum().item()
    model.train()
    # A sample (a smoke run) may hold none of the people's words.
    people_loss = ptotal / ptokens if ptokens else None
    return {"all": total / tokens, "people": people_loss, "tokens": int(tokens), "people_tokens": int(ptokens)}


def main() -> None:
    t0 = time.time()
    device = torch.device(ARGS.device)
    cuda = device.type == "cuda"
    if cuda and ARGS.max_gib:
        torch.cuda.set_per_process_memory_fraction(ARGS.max_gib * 2**30 / torch.cuda.get_device_properties(device).total_memory)
    tok = BASE.tokenizer()
    pad = BASE.PAD
    train, held = load("train", tok, ARGS.max_windows), load("heldout", tok, ARGS.max_windows and max(1, ARGS.max_windows // 8))
    base = BASE.model().to(device)
    if ARGS.checkpointing:
        base.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        base.enable_input_require_grads()
    model = get_peft_model(base, LoraConfig(r=RANK, lora_alpha=ALPHA, lora_dropout=0.05, target_modules=TARGETS, task_type="CAUSAL_LM"))
    model.print_trainable_parameters()
    log = {"settings": {"epochs": EPOCHS, "micro_batch": MICRO_BATCH, "accum": ACCUM, "lr": LR, "warmup": WARMUP, "rank": RANK,
                        "alpha": ALPHA, "dropout": 0.05, "targets": TARGETS, "max_tokens": MAX_TOKENS, "loss": "all tokens",
                        "checkpointing": ARGS.checkpointing, "device": ARGS.device, "windows": len(train), "data": DATA}}
    log["heldout_before"] = heldout_loss(model, held, pad, device)
    print("held-out before", log["heldout_before"], flush=True)

    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=LR, weight_decay=0.0, betas=(0.9, 0.999))
    steps_per_epoch = math.ceil(len(train) / (MICRO_BATCH * ACCUM))
    total_steps = log["total_steps"] = min(steps_per_epoch * EPOCHS, ARGS.max_steps or steps_per_epoch * EPOCHS)
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / WARMUP) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / total_steps))))
    rng = random.Random(13289)
    if cuda:
        torch.cuda.reset_peak_memory_stats()
    t_train = time.time()
    step = 0
    log["steps"] = []
    for epoch in range(math.ceil(total_steps / steps_per_epoch)):
        # Batches of similar length (less padding), in random order.
        order = sorted(range(len(train)), key=lambda i: len(train[i]["ids"]) + rng.random() * 200)
        batches = [order[i:i + MICRO_BATCH] for i in range(0, len(order), MICRO_BATCH)]
        rng.shuffle(batches)
        for b0 in range(0, len(batches), ACCUM):
            group = batches[b0:b0 + ACCUM]
            n_tokens = sum(len(train[i]["ids"]) - 1 for b in group for i in b)
            running = 0.0
            for b in group:
                ids, labels, _ = batch_of([train[i] for i in b], pad, device)
                with torch.autocast(device.type, dtype=torch.bfloat16):
                    loss, mask = token_losses(model, ids, labels)
                summed = loss[mask].sum()
                (summed / n_tokens).backward()
                running += summed.item()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            step += 1
            if step % 10 == 0 or step == total_steps:
                entry = {"step": step, "epoch": epoch, "loss": running / n_tokens, "lr": sched.get_last_lr()[0],
                         "elapsed_s": round(time.time() - t_train, 1)}
                log["steps"].append(entry)
                print(entry, flush=True)
            if step == total_steps:
                break
        log[f"heldout_after_epoch{epoch + 1}"] = log["heldout_after"] = heldout_loss(model, held, pad, device)
        print(f"held-out after epoch {epoch + 1}", log["heldout_after"], flush=True)
    log["train_seconds"] = round(time.time() - t_train, 1)
    if cuda:
        log["peak_memory_gib"] = round(torch.cuda.max_memory_allocated() / 2**30, 2)
        log["peak_reserved_gib"] = round(torch.cuda.max_memory_reserved() / 2**30, 2)

    model.save_pretrained(f"{ROOT}/lora")
    if not ARGS.no_merge:
        merged = model.merge_and_unload()
        out = f"{ROOT}/merged"
        merged.save_pretrained(out, safe_serialization=True)
        # The base's own config, tokenizer and code (not its weights): the converter reads them as they are on the Hub.
        for name in os.listdir(BASE.base()):
            if not name.endswith(".safetensors") and name != "model.safetensors.index.json" and not name.startswith("."):
                shutil.copy(os.path.join(BASE.base(), name), os.path.join(out, name))
    log["total_seconds"] = round(time.time() - t0, 1)
    json.dump(log, open(f"{ROOT}/train-log.json", "w"), indent=2)
    print(json.dumps({k: v for k, v in log.items() if k != "steps"}, indent=2))


if __name__ == "__main__":
    main()
