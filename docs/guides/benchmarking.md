---
title: "Benchmarking"
description: "Create test datasets, configure match modes, run multi-turn tests, and read benchmark reports"
sidebar_order: 2
---

# Benchmarking

Nanotune's benchmark system tests your model against a dataset and generates detailed reports with pass rates, timing metrics, and per-test results.

## Creating a Test Dataset

Create a `tests.json` file in `.nanotune/benchmarks/`:

```json
[
  {
    "id": 1,
    "prompt": "list all files",
    "acceptable": ["ls", "ls -la"],
    "category": "basic",
    "match": "semantic"
  },
  {
    "id": 2,
    "prompt": "What is the capital of France?",
    "acceptable": ["Paris"],
    "category": "geography",
    "match": "contains"
  }
]
```

Each test needs:

- `id` — Unique identifier
- `prompt` — The input to send to the model (single-turn), **or** `messages` for multi-turn
- `acceptable` — One or more acceptable responses
- `category` — For grouping in reports (optional)
- `match` — How to compare responses

## Match Modes

| Mode | Description | Best For |
|------|-------------|----------|
| `semantic` | Normalized comparison with prefix matching (default) | Code generation, CLI commands |
| `startsWith` | Response must start with acceptable answer | Short answers, code output |
| `contains` | Response must contain acceptable answer anywhere | Q&A, explanations, chatbots |
| `exact` | Must match exactly (case-insensitive by default) | Classification, yes/no, labels |
| `llm-judge` | LLM evaluates response quality on configurable criteria | Open-ended, creative, conversational |

### Match Options

- `caseSensitive` — Set to `true` for case-sensitive matching (default: `false`)

### Examples by Use Case

**Code/Command generation** — Use `semantic`:

```json
{
  "prompt": "how do I list files",
  "acceptable": ["ls", "dir"],
  "match": "semantic"
}
```

Passes if response starts with `ls` or `dir`, even with additional flags.

**Question Answering** — Use `contains`:

```json
{
  "prompt": "What year did WW2 end?",
  "acceptable": ["1945"],
  "match": "contains"
}
```

Passes if `1945` appears anywhere in the response.

**Classification** — Use `exact`:

```json
{
  "prompt": "Classify: 'I love this product'",
  "acceptable": ["positive", "Positive", "POSITIVE"],
  "match": "exact"
}
```

Passes only if response exactly matches one of the options.

**Open-ended** — Use `llm-judge`:

```json
{
  "prompt": "Explain how to reset your password",
  "category": "support",
  "match": "llm-judge",
  "criteria": ["helpful", "accurate", "concise"],
  "passThreshold": 7
}
```

See the [LLM Judge](llm-judge.md) guide for details on criteria and scoring.

## Multi-Turn Tests

Use `messages` instead of `prompt` to test multi-turn conversations. The model is evaluated on its response to the final user message, given the prior conversation history.

```json
[
  {
    "id": 1,
    "messages": [
      {"role": "user", "content": "My name is Alice"},
      {"role": "assistant", "content": "Hello Alice!"},
      {"role": "user", "content": "What's my name?"}
    ],
    "acceptable": ["Alice"],
    "category": "memory",
    "match": "contains"
  }
]
```

Each test must have either `prompt` or `messages`, not both. The `messages` array should end with a `user` message — the model generates the next assistant response. All match modes work with multi-turn tests.

## Running Benchmarks

```bash
nanotune benchmark
```

Use a hardware preset for quick setup:

```bash
nanotune benchmark --preset medium
```

Or customize individual settings:

```bash
nanotune benchmark --threads 4 --gpu-layers 10 --ctx-size 2048
```

See [`nanotune benchmark`](../commands/benchmark.md) for all available options and presets.

## Reports

After running, two files are generated in `.nanotune/benchmarks/`:

- **JSON report** (`benchmark-{timestamp}.json`) — Machine-readable with full results
- **Markdown report** (`benchmark-{timestamp}.md`) — Human-readable summary

### What's in the Markdown Report

- Summary statistics (total tests, pass rate)
- Pass rate by category
- Detailed results for every test
- Failed tests table

### Timing Metrics

Each test reports:

| Metric | Description |
|--------|-------------|
| **Total Latency** | Complete response time |
| **Time to First Token (TTFT)** | Initial response latency |
| **Generation Time** | Token generation duration |
| **Tokens Generated** | Total tokens produced |
| **Tokens/Second** | Generation throughput |
