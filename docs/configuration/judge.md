---
title: "Judge Configuration"
description: "Reference for the .nanotune/judge.json configuration file"
sidebar_order: 2
---

# Judge Configuration

The LLM judge configuration is stored in `.nanotune/judge.json`. This file is created by `nanotune judge configure` and defines which LLM provider evaluates open-ended benchmark responses.

## judge.json Reference

```json
{
  "name": "OpenRouter",
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "${OPENROUTER_API_KEY}",
  "model": "anthropic/claude-haiku"
}
```

## Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Provider name (for display purposes) |
| `baseUrl` | string | API endpoint URL |
| `apiKey` | string | API key (supports environment variable substitution) |
| `model` | string | Model identifier for the provider |

## Environment Variable Substitution

API keys support `${ENV_VAR}` syntax to keep secrets out of config files:

```json
{
  "apiKey": "${OPENROUTER_API_KEY}"
}
```

Default values are also supported:

```json
{
  "apiKey": "${OPENROUTER_API_KEY:-sk-default-key}"
}
```

This resolves at runtime from your shell environment, so the actual key is never stored in the config file.

## Supported Providers

### Cloud Providers

| Provider | Base URL |
|----------|----------|
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Anthropic | `https://api.anthropic.com/v1` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Mistral | `https://api.mistral.ai/v1` |

### Local Providers

| Provider | Default Base URL |
|----------|-----------------|
| Ollama | `http://localhost:11434/v1` |
| llama.cpp | `http://localhost:8080/v1` |
| LM Studio | `http://localhost:1234/v1` |

## See Also

- [LLM Judge Guide](../guides/llm-judge.md) — How to use the judge in benchmarks
- [`nanotune judge`](../commands/judge.md) — Command reference
