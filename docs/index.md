---
title: "Introduction"
description: "Nanotune is an interactive CLI for fine-tuning small language models on Apple Silicon"
sidebar_order: 1
---

# Nanotune

Nanotune is an interactive CLI for fine-tuning small language models on Apple Silicon. No YAML configs, no complex flags — just guided prompts that walk you through each step.

## What You Can Do

- **Fine-tune models** using LoRA with live progress display
- **Export to GGUF** for use with llama.cpp, Ollama, and other tools
- **Benchmark your model** with detailed timing metrics and pass/fail reports
- **Evaluate open-ended responses** using an LLM-as-a-judge

Nanotune works with any HuggingFace model and handles the MLX and llama.cpp tooling for you automatically.

## How It Works

```bash
nanotune init           # Set up a project
nanotune data add       # Add training examples
nanotune train          # Fine-tune with LoRA
nanotune export         # Convert to GGUF
nanotune benchmark      # Test your model
```

Each command launches an interactive TUI built with React Ink — no flags to memorize.

## Next Steps

- [Installation](getting-started/installation.md) — Requirements and setup
- [Quick Start](getting-started/quick-start.md) — Build your first fine-tuned model
- [Commands](commands/index.md) — Full command reference
- [Guides](guides/index.md) — In-depth walkthroughs for training data, benchmarking, and more
- [Community](community.md) — Get involved
