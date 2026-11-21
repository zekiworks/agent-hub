"""LoRA fine-tuning of LiquidAI d1-2B on the bus's routing labels (Ümit #13659), on the prompt /v1/systemone serves.

The prompt and the readout are d1's own (the checkpoint's runner.py/prompt.py, through `model.engine`): the request's
state and its one choice question rendered as the server renders them (checked: the HF engine and llama-server give
the same token count and probabilities within 0.002 on our requests), read at the answer slot as a softmax over the
options' code tokens, through the served temperature (calibration.json). The loss is minus the log of the probability
of the right agents (an item may have several). Half the items keep the "none" option (never the answer), half are
forced (no "none"); half have their agents in a shuffled order.

  python train.py --data DIR/train.jsonl --out DIR [--dev-share 0.15] [--epochs 3] [--merge] [--max-gib 8.5]

--dev-share: hold out the latest share of the labelled items (by time) and report HF accuracy on them after each
epoch (to choose --epochs); 0 trains on everything. --merge: write OUT/merged (the base checkpoint's files with the
adapter merged into its weights, the same tensor names) for convert_hf_to_gguf.py.
"""

import argparse
import json
import math
import os
import random
import shutil
import sys
import time

import torch
from peft import LoraConfig, get_peft_model
from safetensors.torch import load_file, save_file
from transformers import AutoModel

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../complete-ext/finetune"))
import lfm3  # noqa: E402,F401  (its patch lets transformers 5.17 read LFM3's config)

BASE = os.path.expanduser("~/.cache/huggingface/hub/models--LiquidAI--d1-2B/snapshots/10e7671d44e4b37700020b1eed3f594c5f2af0b4")
NONE = "none"
LR = 1e-4
BATCH = 8
WARMUP = 10
RANK = 16
ALPHA = 32
TARGETS = r"model\.language_model\.layers\.\d+\.(self_attn\.(q_proj|k_proj|v_proj|o_proj|gate_proj)|conv\.(in_proj|out_proj)|feed_forward\.(w1|w2|w3))"

args = argparse.ArgumentParser()
args.add_argument("--data", required=True)
args.add_argument("--out", required=True)
args.add_argument("--epochs", type=int, default=3)
args.add_argument("--dev-share", type=float, default=0.0)
args.add_argument("--max-gib", type=float)
args.add_argument("--merge", action="store_true")
ARGS = args.parse_args()


def question(request: dict, with_none: bool, order: list[str] | None = None) -> dict:
    """The request's choice question, with or without "none", its agents in `order` if given."""
    q = request["questions"]["recipient"]
    criteria = q["criteria"]
    agents = order or [k for k in criteria if k != NONE]
    out = {a: criteria[a] for a in agents}
    if with_none:
        out[NONE] = criteria[NONE]
    return {"type": "choice", "instructions": q["instructions"], "criteria": out}


def option_log_probs(engine, state: str, q_json: dict) -> tuple[torch.Tensor, list[str]]:
    """Log-probabilities of the options at the answer slot, as the server reads them (best form of each option's
    code, through the served temperature), with gradients."""
    from importlib import import_module

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


@torch.no_grad()
def accuracy(model, engine, items: list[dict]) -> dict:
    model.eval()
    out = {}
    for with_none in (False, True):
        right = 0
        for it in items:
            logp, names = option_log_probs(engine, it["request"]["state"], question(it["request"], with_none))
            right += names[int(logp.argmax())] in it["right"]
        out["with_none" if with_none else "forced"] = round(right / len(items), 4) if items else None
    model.train()
    return out


def main() -> None:
    t0 = time.time()
    random.seed(13659)
    torch.manual_seed(13659)
    device = torch.device("cuda")
    if ARGS.max_gib:
        torch.cuda.set_per_process_memory_fraction(ARGS.max_gib * 2**30 / torch.cuda.get_device_properties(device).total_memory)
    items = [json.loads(line) for line in open(ARGS.data)]
    labelled = sorted((x for x in items if x["source"] == "labelled"), key=lambda x: x["at"])
    n_dev = round(len(labelled) * ARGS.dev_share)
    dev = labelled[len(labelled) - n_dev:] if n_dev else []
    dev_start = dev[0]["at"] if dev else math.inf
    # Nothing from the dev window or after it trains when there is a dev set.
    train = [x for x in items if x["at"] < dev_start]

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
                        "targets": TARGETS, "epochs": ARGS.epochs, "dev_share": ARGS.dev_share, "max_gib": ARGS.max_gib},
           "train": len(train), "train_labelled": sum(x["source"] == "labelled" for x in train),
           "train_named": sum(x["source"] == "named" for x in train), "dev": len(dev), "epochs": []}
    if dev:
        log["dev_before"] = accuracy(model, engine, dev)
        print("dev before", log["dev_before"], flush=True)

    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=LR, weight_decay=0.0)
    total = math.ceil(len(train) / BATCH) * ARGS.epochs
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / WARMUP) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / total))))
    torch.cuda.reset_peak_memory_stats()
    step = 0
    for epoch in range(ARGS.epochs):
        order = list(range(len(train)))
        random.shuffle(order)
        losses = []
        for b0 in range(0, len(order), BATCH):
            group = order[b0:b0 + BATCH]
            for i in group:
                it = train[i]
                agents = [k for k in it["request"]["questions"]["recipient"]["criteria"] if k != NONE]
                if random.random() < 0.5:
                    random.shuffle(agents)
                logp, names = option_log_probs(engine, it["request"]["state"], question(it["request"], random.random() < 0.5, agents))
                right = torch.tensor([n in it["right"] for n in names], device=logp.device)
                loss = -torch.logsumexp(logp[right], -1)
                (loss / len(group)).backward()
                losses.append(loss.item())
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            step += 1
        entry = {"epoch": epoch + 1, "steps": step, "loss": round(sum(losses) / len(losses), 4), "elapsed_s": round(time.time() - t0, 1)}
        if dev:
            entry["dev"] = accuracy(model, engine, dev)
        log["epochs"].append(entry)
        print(entry, flush=True)
    log["peak_memory_gib"] = round(torch.cuda.max_memory_allocated() / 2**30, 2)
    os.makedirs(ARGS.out, exist_ok=True)
    model.save_pretrained(f"{ARGS.out}/lora")

    if ARGS.merge:
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
