---
title: "nanotune init"
description: "Initialize a new Nanotune fine-tuning project"
sidebar_order: 1
---

# nanotune init

Initialize a new fine-tuning project in the current directory.

## Usage

```bash
nanotune init
```

## What It Does

Creates a `.nanotune/` directory with configuration and data folders. You'll be prompted to enter:

- **Project name** — A name for your fine-tuning project
- **Base model** — Any HuggingFace model ID (e.g. `Qwen/Qwen2.5-Coder-1.5B-Instruct`)
- **Context message role** — The role for the first message in training examples (e.g. `system`, `developer`)
- **Context message content** — Instructions that define the model's behavior

## Project Structure

After running `nanotune init`, your directory will contain:

```
.nanotune/
├── config.json          # Project configuration
├── data/
│   └── train.jsonl      # Training data (empty initially)
└── benchmarks/          # Benchmark datasets and reports
```

## Configuration

The generated `config.json` contains your project settings. See [Configuration](../configuration/index.md) for details on all available options.

## See Also

- [Quick Start](../getting-started/quick-start.md) — Full walkthrough of your first project
- [Configuration](../configuration/index.md) — Customize training and export settings
