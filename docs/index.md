# Nanotune

Nanotune is an interactive CLI for fine-tuning small language models on Apple Silicon. No YAML configs, no complex flags — just guided prompts that walk you through each step.

## What You Can Do

- **Fine-tune models** using LoRA with live progress display
- **Export to GGUF** for use with llama.cpp, Ollama, and other tools
- **Benchmark your model** with detailed timing metrics and pass/fail reports
- **Evaluate open-ended responses** using an LLM-as-a-judge

Nanotune works with any HuggingFace model and handles the MLX and llama.cpp tooling for you automatically.

## Requirements

- macOS with Apple Silicon (M1/M2/M3/M4)
- Node.js 18+
- Python 3.10+
- 8GB RAM minimum (16GB recommended)

## Installation

Install globally via npm:

```bash
npm install -g @nanocollective/nanotune
```

Or run directly with npx:

```bash
npx @nanocollective/nanotune init
```

## Quick Start

### 1. Initialize a Project

```bash
nanotune init
```

You'll be prompted for a project name, base model, and system prompt. This creates a `.nanotune/` directory with your configuration.

### 2. Add Training Data

Add examples interactively:

```bash
nanotune data add
```

Or import from a file:

```bash
nanotune data import examples.jsonl
```

Nanotune supports JSONL, CSV, and JSON formats. See [Training Data](training-data.md) for format details.

### 3. Train Your Model

```bash
nanotune train
```

Training runs with a live progress display showing loss metrics in real time.

### 4. Export to GGUF

```bash
nanotune export
```

This fuses your LoRA adapter with the base model and converts it to GGUF format. Pre-built llama.cpp binaries are downloaded automatically.

### 5. Benchmark

```bash
nanotune benchmark
```

Generates JSON and Markdown reports with pass rates, timing metrics, and detailed results per test.

## Recommended Models

These models work well with Nanotune:

| Model | Size | Use Case |
|-------|------|----------|
| `Qwen/Qwen2.5-Coder-0.5B-Instruct` | 0.5B | Quick experiments |
| `Qwen/Qwen2.5-Coder-1.5B-Instruct` | 1.5B | Balanced performance |
| `Qwen/Qwen2.5-0.5B-Instruct` | 0.5B | General purpose |
| `Qwen/Qwen2.5-1.5B-Instruct` | 1.5B | General purpose |

## Next Steps

- [Commands](commands.md) — Full command reference
- [Training Data](training-data.md) — Supported formats and tips
- [Benchmarking](benchmarking.md) — Test datasets, match modes, and LLM-as-a-judge

## Community

Join our [Discord server](https://discord.gg/ktPDV6rekE) to connect with other users and get help. Contributions are welcome — see [CONTRIBUTING.md](https://github.com/Nano-Collective/nanotune/blob/main/CONTRIBUTING.md) on GitHub.
