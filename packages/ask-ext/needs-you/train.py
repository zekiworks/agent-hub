"""LoRA fine-tuning of LiquidAI d1-2B on the "needs you" proxy labels (Ümit #13719), on the prompt /v1/systemone serves.

The model, LoRA settings, prompt rendering and readout are the routing fine-tune's (../finetune/train.py, Ümit #13659):
d1's own engine renders the request's state and its one choice question and reads the options' code tokens at the answer
slot through the served temperature. The loss is minus the log-probability of the right option (needs_you or update);
half the items have the two options in the other order. After each epoch the dev sample's p(needs_you) gives F1 at 0.5
and at its best threshold; the adapter of the epoch with the best dev F1 (at its best threshold; fewer epochs on a tie)
is kept, saved and merged.

  python train.py --data DIR (train.jsonl, dev.jsonl from export.ts) --out DIR [--epochs 2] [--max-gib 8.5]

Writes OUT/lora, OUT/merged (the base checkpoint's files with the adapter merged into its weights, the same tensor
names, for convert_hf_to_gguf.py) and OUT/train-log.json.
"""

import argparse
import json
import math
import os
import random
import shutil
import sys
import time
from importlib import import_module

import torch
from peft import LoraConfig, get_peft_model
from safetensors.torch import load_file, save_file
from transformers import AutoModel

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../complete-ext/finetune"))
import lfm3  # noqa: E402,F401  (its patch lets transformers 5.17 read LFM3's config)

BASE = os.path.expanduser("~/.cache/huggingface/hub/models--LiquidAI--d1-2B/snapshots/10e7671d44e4b37700020b1eed3f594c5f2af0b4")
QUESTION = "needs"
NEEDS = "needs_you"
LR = 1e-4
BATCH = 8
WARMUP = 10
RANK = 16
ALPHA = 32
TARGETS = r"model\.language_model\.layers\.\d+\.(self_attn\.(q_proj|k_proj|v_proj|o_proj|gate_proj)|conv\.(in_proj|out_proj)|feed_forward\.(w1|w2|w3))"

args = argparse.ArgumentParser()
args.add_argument("--data", required=True)
args.add_argument("--out", required=True)
args.add_argument("--epochs", type=int, default=2)
args.add_argument("--max-gib", type=float)
ARGS = args.parse_args()


def option_log_probs(engine, state: str, q_json: dict) -> tuple[torch.Tensor, list[str]]:
    """Log-probabilities of the options at the answer slot, as the server reads them, with gradients (as
    ../finetune/train.py)."""
    prompt = import_module(type(engine).__module__.rsplit(".", 1)[0] + ".prompt")
    q = engine.ask(q_json)
    seqs = engine._sequences([(state, [q], [])])
    assert len(seqs) == 1 and len(seqs[0][5]) == 1 and len(seqs[0][5][0]) == 1
    slots = [(0, (0, 0), q, seqs[0][5][0][0])]
    logz, _ = engine._slot_logits(seqs, [0], slots, None)
    _, forms, tokens = prompt.readout_table(engine.tokenizer, q)
    values = logz[0, torch.from_numpy(tokens).to(logz.device)]
    scores = values[torch.from_numpy(forms).to(logz.device)].max(-1).values
    scores = scores / engine.calibration.temperature(q)
    return torch.log_softmax(scores, -1), list(q.criteria)


def best_f1(labels: list[bool], ps: list[float]) -> dict:
    """F1 of "needs you" at 0.5 and at the best threshold (0.05 … 0.95)."""
    def f1(t: float) -> float:
        tp = sum(p >= t and y for p, y in zip(ps, labels))
        fp = sum(p >= t and not y for p, y in zip(ps, labels))
        fn = sum(p < t and y for p, y in zip(ps, labels))
        return 2 * tp / (2 * tp + fp + fn) if tp else 0.0
    best = max((f1(t / 100), -abs(t - 50), t / 100) for t in range(5, 96))
    return {"f1_at_0.5": round(f1(0.5), 4), "best_f1": round(best[0], 4), "best_threshold": best[2]}


@torch.no_grad()
def dev_scores(model, engine, items: list[dict]) -> dict:
    model.eval()
    ps = []
    for it in items:
        logp, names = option_log_probs(engine, it["request"]["state"], it["request"]["questions"][QUESTION])
        ps.append(math.exp(float(logp[names.index(NEEDS)])))
    model.train()
    return best_f1([it["label"] for it in items], ps)


def main() -> None:
    t0 = time.time()
    random.seed(13719)
    torch.manual_seed(13719)
    device = torch.device("cuda")
    if ARGS.max_gib:
        torch.cuda.set_per_process_memory_fraction(ARGS.max_gib * 2**30 / torch.cuda.get_device_properties(device).total_memory)
    train = [json.loads(line) for line in open(f"{ARGS.data}/train.jsonl")]
    dev = [json.loads(line) for line in open(f"{ARGS.data}/dev.jsonl")]

    model = AutoModel.from_pretrained(BASE, trust_remote_code=True, dtype=torch.bfloat16)
    model.fuse_projections = lambda: None  # keep the checkpoint's own linears (LoRA targets, merged tensor names)
    model.to(device)
    engine = model.engine
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.enable_input_require_grads()
    model = get_peft_model(model, LoraConfig(r=RANK, lora_alpha=ALPHA, lora_dropout=0.05, target_modules=TARGETS))
    model.print_trainable_parameters()
    model.train()

    log = {"settings": {"lr": LR, "batch": BATCH, "warmup": WARMUP, "rank": RANK, "alpha": ALPHA, "dropout": 0.05,
                        "targets": TARGETS, "epochs": ARGS.epochs, "max_gib": ARGS.max_gib},
           "train": len(train), "train_needed": sum(x["label"] for x in train), "dev": len(dev),
           "dev_needed": sum(x["label"] for x in dev), "epochs": []}
    log["dev_before"] = dev_scores(model, engine, dev)
    print("dev before", log["dev_before"], flush=True)

    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=LR, weight_decay=0.0)
    total = math.ceil(len(train) / BATCH) * ARGS.epochs
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / WARMUP) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / total))))
    torch.cuda.reset_peak_memory_stats()
    step = 0
    best = None
    for epoch in range(ARGS.epochs):
        order = list(range(len(train)))
        random.shuffle(order)
        losses = []
        for b0 in range(0, len(order), BATCH):
            group = order[b0:b0 + BATCH]
            for i in group:
                it = train[i]
                q = it["request"]["questions"][QUESTION]
                if random.random() < 0.5:
                    q = {**q, "criteria": dict(reversed(q["criteria"].items()))}
                logp, names = option_log_probs(engine, it["request"]["state"], q)
                loss = -logp[names.index(NEEDS if it["label"] else next(n for n in names if n != NEEDS))]
                (loss / len(group)).backward()
                losses.append(loss.item())
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            step += 1
        entry = {"epoch": epoch + 1, "steps": step, "loss": round(sum(losses) / len(losses), 4), "elapsed_s": round(time.time() - t0, 1),
                 "dev": dev_scores(model, engine, dev)}
        log["epochs"].append(entry)
        print(entry, flush=True)
        if best is None or entry["dev"]["best_f1"] > best[0]:
            best = (entry["dev"]["best_f1"], epoch + 1, {n: p.detach().clone() for n, p in model.named_parameters() if p.requires_grad})
    log["chosen_epoch"] = best[1]
    with torch.no_grad():
        for n, p in model.named_parameters():
            if p.requires_grad:
                p.copy_(best[2][n])
    log["peak_memory_gib"] = round(torch.cuda.max_memory_allocated() / 2**30, 2)
    os.makedirs(ARGS.out, exist_ok=True)
    model.save_pretrained(f"{ARGS.out}/lora")

    merged = model.merge_and_unload()
    state = merged.state_dict()
    original = load_file(f"{BASE}/model.safetensors")
    changed = 0
    for name, tensor in original.items():
        new = state[name]
        assert new.shape == tensor.shape, name
        if not torch.equal(new.cpu(), tensor):
            original[name] = new.detach().to(tensor.dtype).cpu().contiguous()
            changed += 1
    out = f"{ARGS.out}/merged"
    os.makedirs(out, exist_ok=True)
    save_file(original, f"{out}/model.safetensors", metadata={"format": "pt"})
    for name in os.listdir(BASE):
        if name != "model.safetensors" and not name.startswith(".") and name != "__pycache__":
            src = os.path.join(BASE, name)
            (shutil.copytree if os.path.isdir(src) else shutil.copy)(src, os.path.join(out, name))
    log["merged_tensors_changed"] = changed
    log["total_seconds"] = round(time.time() - t0, 1)
    json.dump(log, open(f"{ARGS.out}/train-log.json", "w"), indent=2)
    print(json.dumps({k: v for k, v in log.items() if k != "settings"}, indent=2), flush=True)


if __name__ == "__main__":
    main()
