---
title: "Quick Start"
description: "Create your first fine-tuned model with Nanotune in five steps"
sidebar_order: 2
---

# Quick Start

This guide walks you through the full workflow: initialize a project, add training data, train, export, and benchmark.

## 1. Initialize a Project

```bash
nanotune init
```

You'll be prompted for:

- **Project name** — A name for your project
- **Base model** — Any HuggingFace model ID (e.g. `Qwen/Qwen2.5-Coder-1.5B-Instruct`)
- **Context message role** — Usually `system`, `user`, or `assistant`
- **Context message content** — Instructions for the model (e.g. "You are a helpful assistant")

This creates a `.nanotune/` directory with your configuration and data folders.

## 2. Add Training Data

Add examples interactively:

```bash
nanotune data add
```

Each example consists of a user input and expected output. You can also build multi-turn conversations by adding multiple exchanges to a single example.

Or import from a file:

```bash
nanotune data import examples.jsonl
```

Nanotune supports JSONL, CSV, and JSON formats. See the [Training Data](../guides/training-data.md) guide for format details and tips.

> **Tip:** For 0.5B–1.5B models, 100–500 quality examples typically work well.

## 3. Train Your Model

```bash
nanotune train
```

Training runs LoRA fine-tuning with a live progress display showing loss metrics in real time. The default settings (150 iterations, 5e-5 learning rate) are a good starting point.

See [Training Tips](../guides/training-tips.md) for guidance on tuning hyperparameters.

## 4. Export to GGUF

```bash
nanotune export
```

This fuses your LoRA adapter with the base model and converts it to GGUF format. Pre-built llama.cpp binaries are downloaded automatically — no compilation needed.

## 5. Benchmark Your Model

```bash
nanotune benchmark
```

Create a test dataset and run benchmarks to measure accuracy and performance. Nanotune generates both JSON and Markdown reports with pass rates, timing metrics, and detailed results.

See the [Benchmarking](../guides/benchmarking.md) guide for how to create test datasets and configure match modes.

## Optional: Set Up an LLM Judge

For open-ended responses that can't be evaluated with string matching:

```bash
nanotune judge configure
```

This sets up an LLM provider to score responses on criteria like helpfulness, accuracy, and conciseness. See the [LLM Judge](../guides/llm-judge.md) guide for details.

## Next Steps

- [Commands](../commands/index.md) — Full reference for all CLI commands
- [Training Data](../guides/training-data.md) — Supported formats and best practices
- [Benchmarking](../guides/benchmarking.md) — Test datasets and match modes
- [Configuration](../configuration/index.md) — Customize training and export settings
