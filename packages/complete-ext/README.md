# complete-ext: typing suggestions

A box extension for Agent Hub. While a person types, the website asks the Hub, and the Hub posts a `BoxCompleteBody`
to this service's `/complete`. It answers `{text}`: the next few words of the draft, or `""` when it has nothing good to
offer. Setup and privacy: [docs/right-pane.md](../../docs/right-pane.md#services-the-message-box-asks).

```sh
llama-server -m LFM3-1.7B-BF16.gguf --port 9962 -ngl 0
COMPLETE_PORT=7830 COMPLETE_LLAMA_URL=http://127.0.0.1:9962 COMPLETE_HEAL=0 bun run packages/complete-ext/src/server.ts
agent-bus serve … --ext complete=http://127.0.0.1:7830,box=complete
```

## How it decides what to show

- **Model:** any llama-server model. The reference Hub uses LFM3 1.7B (BF16, about 0.15–0.4 s per answer on a CPU).
  SmolLM2 1.7B base (Q8_0, about 0.2 s) was used before it and was right about as often in half the time.
- **Token healing (`COMPLETE_HEAL`):** a draft that ends mid-word ("Let's configur") is not sent as it is, since the
  model never saw " config" + "ur" and would go on with "ate". The half-typed word leaves the prompt and a grammar
  makes the answer begin with it, so the model picks the whole token " configure". LFM3's tokenizer spells a forced
  half word in odd pieces, so with LFM3 healing is off (`COMPLETE_HEAL=0`) and the website's word lists finish the
  word instead.
- **Confidence stopping:** words are kept only while the model is sure of them: log-probability at least -2.5 for
  each word and -5.0 for the whole (a forced half word only above -8). A doubtful suggestion ends early or is not
  shown.
- **Cut-offs:** at most eight words, up to the first punctuation mark that ends a word, nothing past a speaker label,
  nothing copied whole from an earlier message, and no Turkish drafts.

## Training on the Hub's own messages

`agent-bus train-suggestions` fine-tunes the model (a LoRA) on the Hub host and keeps it only when it beats the current
model on recent messages. The code is in `finetune/`; `finetune/weekly.sh` runs it once a week. What it reads and
saves: [INSTALL.md](../../INSTALL.md#typing-suggestions-trained-on-your-own-messages-optional).
