"""Exports a hub's messages for fine-tuning its typing-suggestion model (LFM3 1.7B; Ümit #13289, #13513).

Only shared conversations: the ones ALL the people (--people, the hub's humans) are members of, and #all; never DMs
(Main, after #13289). A model trained on a DM could put one person's private words in another's suggestions.

Reads the database read-only. Each kept conversation's non-deleted messages with text, created before the cutoff, as
production prompts (promptOf in ../src/server.ts): a header line, then "@from: text" lines in seq order, chunked per
conversation into windows of consecutive messages. A leading "🎤 " (voice transcript) is dropped, the words kept.
Agents' lines are cut to 300 characters as promptOf cuts every context line; the people's lines stay whole, since their
drafts are what the model continues. 2% of the windows (fixed seed) are held out for eval loss. The test messages
(after the cutoff) are picked by eval.ts from the database.

  python export.py --db DATA_DIR/message-bus.sqlite --people carol,uma --cutoff 2026-11-16T04:00:00Z --out DIR

--cutoff: an ISO time; one without an offset is this machine's local time. train-suggestions.ts runs it.
"""

import argparse
import json
import os
import random
import re
import sqlite3
from datetime import datetime

import lfm3

args = argparse.ArgumentParser()
args.add_argument("--db", required=True)
args.add_argument("--people", required=True, help="comma-separated ids")
args.add_argument("--cutoff", required=True)
args.add_argument("--out", required=True)
ARGS = args.parse_args()

PEOPLE = {p for p in ARGS.people.split(",") if p}
OUT = ARGS.out
CUTOFF_MS = int(datetime.fromisoformat(ARGS.cutoff).astimezone().timestamp() * 1000)
PROMPT_MESSAGE_CHARS = 300
WINDOW_TOKENS = 1536
MAX_TOKENS = 2048
HELDOUT = 0.02


def clean(text: str) -> str:
    return re.sub(r"^🎤 ", "", text)


def line_of(from_id: str, text: str) -> str:
    text = re.sub(r"\s+", " ", clean(text))
    if from_id not in PEOPLE:
        text = text[:PROMPT_MESSAGE_CHARS]
    return f"@{from_id}: {text}"


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    db = sqlite3.connect(f"file:{ARGS.db}?mode=ro", uri=True)
    tok = lfm3.tokenizer()
    convs = {}
    for cid, kind, name, title in db.execute("SELECT id, kind, name, title FROM conversations"):
        members = [r[0] for r in db.execute(
            "SELECT participant_id FROM conversation_members WHERE conversation_id = ? ORDER BY participant_id", (cid,))]
        where = title or (f"#{name}" if name else f"a conversation of {', '.join(members)}")
        if kind == "all" or (kind != "dm" and PEOPLE <= set(members)):
            convs[cid] = f"Conversation in {where}."
    rows = db.execute(
        "SELECT conversation_id, seq, from_id, text FROM messages WHERE deleted_at IS NULL AND created_at < ? "
        "AND trim(text) <> '' ORDER BY conversation_id, seq", (CUTOFF_MS,)).fetchall()
    rows = [r for r in rows if r[0] in convs]
    by_conv: dict[str, list[tuple[str, str]]] = {}
    for cid, _seq, from_id, text in rows:
        by_conv.setdefault(cid, []).append((from_id, line_of(from_id, text)))

    windows = []
    for cid, lines in by_conv.items():
        header = convs[cid]
        cur, cur_tokens, people = [], len(tok(header).input_ids) + 1, 0
        for from_id, line in lines:
            n = len(tok(line).input_ids) + 1
            if cur and cur_tokens + n > WINDOW_TOKENS:
                windows.append({"conversation": cid, "text": header + "\n" + "\n".join(cur) + "\n", "people": people})
                cur, cur_tokens, people = [], len(tok(header).input_ids) + 1, 0
            cur.append(line)
            cur_tokens += n
            people += from_id in PEOPLE
        if cur:
            windows.append({"conversation": cid, "text": header + "\n" + "\n".join(cur) + "\n", "people": people})
    if len(windows) < 2:
        raise SystemExit(f"Only {len(windows)} window(s) of shared messages before the cutoff: too little to train on")

    random.Random(13289).shuffle(windows)
    n_held = max(1, round(len(windows) * HELDOUT))
    held, train = windows[:n_held], windows[n_held:]
    tokens = 0
    for split, items in (("train", train), ("heldout", held)):
        with open(f"{OUT}/{split}.jsonl", "w") as f:
            for w in items:
                ids = tok(w["text"]).input_ids
                w["tokens"] = min(len(ids), MAX_TOKENS)
                tokens += w["tokens"] if split == "train" else 0
                f.write(json.dumps(w, ensure_ascii=False) + "\n")
    stats = {
        "cutoff_ms": CUTOFF_MS,
        "people": sorted(PEOPLE),
        "messages": len(rows),
        "people_messages": sum(1 for r in rows if r[2] in PEOPLE),
        "conversations": len(by_conv),
        "windows_train": len(train),
        "windows_heldout": len(held),
        "tokens_train": tokens,
        "tokens_heldout": sum(w["tokens"] for w in held),
    }
    with open(f"{OUT}/stats.json", "w") as f:
        json.dump(stats, f, indent=2)
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
