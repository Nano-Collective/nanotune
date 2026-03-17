---
title: "nanotune judge"
description: "Configure and test an LLM judge for evaluating open-ended responses"
sidebar_order: 6
---

# nanotune judge

Set up and test an LLM provider for evaluating open-ended responses during benchmarking.

## nanotune judge configure

```bash
nanotune judge configure
```

Interactively set up an LLM judge. You'll be prompted to:

1. **Select a provider** — Supports both cloud and local providers:
   - **Cloud:** OpenRouter, OpenAI, Anthropic, Google Gemini, Mistral
   - **Local:** Ollama, llama.cpp server, LM Studio
2. **Enter connection details** — Base URL, API key (if required), model name
3. **Test the connection** — Verify the judge responds correctly

The configuration is saved to `.nanotune/judge.json`. See [Judge Configuration](../configuration/judge.md) for details on the config format.

## nanotune judge test

```bash
nanotune judge test
```

Run a sample evaluation against the configured judge to verify it's working correctly. Sends a known prompt/response pair and displays:

- The judge's overall score
- Per-criteria breakdown
- Reasoning for each criterion

## See Also

- [LLM Judge Guide](../guides/llm-judge.md) — How to use LLM-as-a-judge in benchmarks
- [Judge Configuration](../configuration/judge.md) — Configure judge.json
