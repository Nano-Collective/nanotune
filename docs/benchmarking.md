# Benchmarking

Nanotune's benchmark system tests your model against a dataset and generates detailed reports.

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

## Multi-Turn Tests

Use `messages` instead of `prompt` to test multi-turn conversations. The model is evaluated on its response to the final user message, given the prior conversation history.

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

Each test must have either `prompt` or `messages`, not both. The `messages` array should end with a `user` message — the model generates the next assistant response. All match modes (semantic, contains, exact, llm-judge) work with multi-turn tests.

## Match Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `semantic` | Normalized comparison with prefix matching | Code generation, CLI commands |
| `startsWith` | Response must start with acceptable answer | Short answers, code output |
| `contains` | Response must contain acceptable answer | Q&A, explanations |
| `exact` | Must match exactly (case-insensitive) | Classification, yes/no |
| `llm-judge` | LLM evaluates response quality | Open-ended, creative responses |

### Examples

**Code generation** — Use `semantic`:

```json
{
  "prompt": "how do I list files",
  "acceptable": ["ls", "dir"],
  "match": "semantic"
}
```

**Q&A** — Use `contains`:

```json
{
  "prompt": "What year did WW2 end?",
  "acceptable": ["1945"],
  "match": "contains"
}
```

**Classification** — Use `exact`:

```json
{
  "prompt": "Classify: 'I love this product'",
  "acceptable": ["positive"],
  "match": "exact"
}
```

## LLM-as-a-Judge

For open-ended responses that can't be evaluated with string matching, use an LLM judge.

### Setup

```bash
nanotune judge configure
```

This walks you through selecting a provider (Ollama, OpenRouter, OpenAI, Anthropic, etc.) and model.

### Test Format

```json
{
  "id": 1,
  "prompt": "Explain how to reset your password",
  "category": "support",
  "match": "llm-judge",
  "criteria": ["helpful", "accurate", "concise"],
  "passThreshold": 7
}
```

- `criteria` — What to score on (defaults to helpful, accurate, concise)
- `passThreshold` — Minimum score to pass (0–10, defaults to 7)

### Built-in Criteria

| Criterion | Description |
|-----------|-------------|
| `helpful` | Addresses user needs and provides useful information |
| `accurate` | Factually correct and free of errors |
| `concise` | Brief without unnecessary verbosity |
| `safe` | Avoids harmful or inappropriate content |
| `relevant` | Stays on topic and addresses the prompt |

You can also use custom criteria names.

## Running Benchmarks

```bash
nanotune benchmark
```

Use a hardware preset:

```bash
nanotune benchmark --preset medium
```

Or customize:

```bash
nanotune benchmark --threads 4 --gpu-layers 10 --ctx-size 2048
```

## Reports

After running, two files are generated in `.nanotune/benchmarks/`:

- **JSON report** — Machine-readable with full results
- **Markdown report** — Human-readable with summary stats, pass rates by category, and a table of failed tests

### Timing Metrics

Each test reports:

- **Total Latency** — Complete response time
- **Time to First Token** — Initial response latency
- **Generation Time** — Token generation duration
- **Tokens/Second** — Generation throughput
