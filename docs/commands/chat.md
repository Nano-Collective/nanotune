---
title: "nanotune chat"
description: "Talk to your fine-tuned model in an interactive REPL"
sidebar_order: 6
---

# nanotune chat

Chat with an exported model in an interactive REPL. This is the quickest way to get a feel for what fine-tuning actually changed — no benchmark dataset required.

Nanotune starts a `llama-server` process once, loads the model, and reuses that hot process for every turn, so there's no cold start between messages.

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
| `/stats` | Show session token statistics |
| `/exit`, `/quit` | Leave the chat (`Esc` also exits when idle) |

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

## Per-Turn Stats

Each assistant reply is followed by a dim stat line:

```
TTFT 142ms · 38.4 tok/s · 87 tokens
```

- **TTFT** — time to first token, i.e. prompt processing time
- **tok/s** — generation throughput
- **tokens** — tokens generated for that reply

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
