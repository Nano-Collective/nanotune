---
title: "nanotune chat"
description: "Talk to your fine-tuned model in an interactive REPL"
sidebar_order: 6
---

# nanotune chat

Chat with an exported model in an interactive REPL. This is the quickest way to get a feel for what fine-tuning actually changed — no benchmark dataset required.

Nanotune starts a `llama-server` process once, loads the model, and reuses that hot process for every turn, so there's no cold start between messages.

Replies stream token by token as the model generates them. While a reply is streaming, `Esc` cancels it: anything generated up to that point is kept in the transcript and stays in the conversation history, so the next turn picks up where the model left off.

## Usage

```bash
nanotune chat
```

With no flags, `chat` picks the most recently exported GGUF in `.nanotune/models/` and applies your project's context message as the system prompt.

## Requirements

You need an exported model first:

```bash
nanotune train
nanotune export
nanotune chat
```

`chat` needs an interactive terminal — it can't run in CI or with stdin redirected.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/reset`, `/clear` | Clear conversation history |
| `/system <text>` | Replace the system message and reset history |
| `/save [file] [--force]` | Save the transcript to JSON (default: `.nanotune/chats/<timestamp>.json`) |
| `/keep` | Append the last exchange to `train.jsonl` as a training example |
| `/stats` | Show session token statistics |
| `/exit`, `/quit` | Leave the chat (`Esc` exits when idle, cancels a reply while it streams) |

## Options

| Flag | Description |
|------|-------------|
| `-m, --model <path>` | Path to a GGUF file (default: latest export) |
| `-s, --system <text>` | Override the project's system message for this session |
| `--preset <name>` | Use a hardware profile: `low`, `medium`, `high`, `ultra` |
| `--threads <n>` | CPU threads (default: auto) |
| `--gpu-layers <n>` | GPU layers to offload (default: max) |
| `--ctx-size <n>` | Context size in tokens (default: 4096) |
| `--batch-size <n>` | Batch size for processing (default: 2048) |
| `--cpu-only` | Disable GPU, use CPU only |
| `--max-tokens <n>` | Max tokens to generate per reply (default: 256) |
| `--temperature <n>` | Sampling temperature (default: 0.8) |
| `--top-p <n>` | Top-p sampling (default: 0.9) |
| `--seed <n>` | Random seed for reproducibility |

Hardware flags are the same as [`nanotune benchmark`](benchmark.md), and a `--preset` overrides the individual flags.

Every numeric flag is rejected outright if it can't be parsed, rather than falling back to the default or being truncated: `--ctx-size 4096x` fails with a message naming the flag instead of quietly starting the server at 4096.

## Per-Turn Stats

Each assistant reply is followed by a dim stat line:

```
TTFT 142ms · 38.4 tok/s · 87 tokens
```

- **TTFT** — time to first token, i.e. prompt processing time
- **tok/s** — generation throughput
- **tokens** — tokens generated for that reply

## Saving Your Session

Chat is where you find failure modes — the prompt that drifts, the format the model keeps getting wrong. `/keep` and `/save` turn those moments into training data without leaving the REPL.

`/keep` appends the last user/assistant exchange to `.nanotune/data/train.jsonl` as a training example — the same shape [`nanotune data add`](data.md) produces — and confirms inline with the new total example count. When the session has a system message it becomes the example's first message; when there is none, the example is just the user/assistant pair. A common loop is to tighten the system message, retry the prompt, and keep the reply once it looks right:

```
> write a haiku about disk usage
Sure! Here's a haiku about disk usage for you: ...

> /system Reply with the poem and nothing else.
> write a haiku about disk usage
Blocks fill quietly / ...

> /keep
```

`/keep` reports `Nothing to keep yet.` when there is no completed exchange.

`/save` writes the full transcript — including the system message as its first message, when the session has one — to JSON. With no argument it goes to `.nanotune/chats/<timestamp>.json`, creating the directory if it is missing; `/save runs/terse-bash.json` writes to that path instead, relative to the current directory, creating parent directories. If nothing has been said yet it reports `Nothing to save yet.` and writes no file.

An existing file is never overwritten silently — transcripts are history you can't get back. `/save` refuses and tells you what to do instead:

```
> /save runs/terse-bash.json
Could not save: runs/terse-bash.json already exists — use "/save runs/terse-bash.json --force" to overwrite it.
```

Add `--force` (or `-f`) to overwrite deliberately.

The saved file is an array holding a single object with a `messages` array:

```json
[
  {
    "messages": [
      {"role": "system", "content": "You are a terse Bash command generator."},
      {"role": "user", "content": "list files by size"},
      {"role": "assistant", "content": "ls -lS"}
    ]
  }
]
```

That is exactly the shape [`nanotune data import`](data.md) accepts, so a saved session replays straight back into training data:

```bash
nanotune data import .nanotune/chats/2026-08-12T09-41-07-482Z.json
```

## Chat Template Handling

`chat` talks to `llama-server`'s OpenAI-compatible `/v1/chat/completions` endpoint, so the chat template baked into the GGUF (ChatML, Llama-3 tags, and so on) is applied automatically. This is the same wire format training uses, which means what you see in `chat` reflects what the model actually learned.

## Examples

```bash
# Chat with the latest export
nanotune chat

# Pick a specific model
nanotune chat -m .nanotune/models/my-model-q4_k_m.gguf

# Try a different system prompt without touching config.json
nanotune chat --system "You are a terse Bash command generator."

# Deterministic replies for comparing two models side by side
nanotune chat --temperature 0 --seed 42

# Run on a lower-powered machine
nanotune chat --preset low
```

## See Also

- [`nanotune export`](export.md) — Producing the GGUF that `chat` loads
- [`nanotune benchmark`](benchmark.md) — Scoring the model against a test dataset
- [Benchmarking Guide](../guides/benchmarking.md) — Turning what you find in chat into repeatable tests
- [`nanotune data`](data.md) — Importing a saved transcript back into your training set
