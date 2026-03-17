---
title: "LLM Judge"
description: "Set up and use an LLM-as-a-judge for evaluating open-ended benchmark responses"
sidebar_order: 3
---

# LLM Judge

For responses that can't be evaluated with string matching — open-ended questions, creative output, conversational responses — you can use an LLM as a judge. The judge scores responses on configurable criteria and provides reasoning for its scores.

## Setup

```bash
nanotune judge configure
```

This walks you through selecting a provider and model. Supports cloud providers (OpenRouter, OpenAI, Anthropic, Google Gemini, Mistral) and local providers (Ollama, llama.cpp server, LM Studio).

After configuration, verify it's working:

```bash
nanotune judge test
```

This sends a known prompt/response pair and displays the judge's scores, criteria breakdown, and reasoning.

## Using the Judge in Benchmarks

Set `"match": "llm-judge"` on any test in your benchmark dataset:

```json
{
  "id": 1,
  "prompt": "Write a haiku about coding",
  "category": "creative",
  "match": "llm-judge",
  "criteria": ["relevant", "concise"],
  "passThreshold": 6
}
```

- `criteria` — Which criteria to score on (defaults to `["helpful", "accurate", "concise"]`)
- `passThreshold` — Minimum overall score to pass, 0–10 (defaults to `7`)
- `acceptable` — Optional reference answers to help calibrate the judge

## Built-in Criteria

These criteria can be referenced by name in your test definitions:

| Criterion | Description |
|-----------|-------------|
| `helpful` | Response addresses the user's needs and provides useful information |
| `accurate` | Response is factually correct and free of errors |
| `concise` | Response is appropriately brief without unnecessary verbosity |
| `safe` | Response avoids harmful, toxic, or inappropriate content |
| `relevant` | Response stays on topic and directly addresses the prompt |

You can also use custom criteria names — they'll be passed directly to the judge as-is.

## How Scoring Works

The judge evaluates the response on each criterion independently, scoring each from 0 to 10. The overall score is the average across all criteria. A test passes if the overall score meets or exceeds the `passThreshold`.

## Benchmark Reports

For `llm-judge` tests, benchmark reports include:

- The judge's overall score
- Per-criteria breakdown with individual scores
- The judge's reasoning for each criterion
- Standard timing metrics alongside the evaluation results

## See Also

- [Judge Configuration](../configuration/judge.md) — The `judge.json` config file format
- [`nanotune judge`](../commands/judge.md) — Command reference
- [Benchmarking](benchmarking.md) — Full benchmarking guide
