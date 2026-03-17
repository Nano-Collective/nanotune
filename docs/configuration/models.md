---
title: "Recommended Models"
description: "HuggingFace models tested and recommended for use with Nanotune"
sidebar_order: 1
---

# Recommended Models

These HuggingFace models have been tested and work well with Nanotune on Apple Silicon.

## Tested Models

| Model | Size | Use Case |
|-------|------|----------|
| `Qwen/Qwen2.5-Coder-0.5B-Instruct` | 0.5B | Quick experiments, rapid iteration |
| `Qwen/Qwen2.5-Coder-1.5B-Instruct` | 1.5B | Balanced performance for code tasks |
| `Qwen/Qwen2.5-0.5B-Instruct` | 0.5B | General purpose, small footprint |
| `Qwen/Qwen2.5-1.5B-Instruct` | 1.5B | General purpose, better quality |

## Choosing a Model

**For getting started:** Use a 0.5B model. They train faster, use less memory, and let you iterate quickly on your training data.

**For production use:** Use a 1.5B model. They produce higher quality output and generalize better from training examples.

**For code generation:** Use the Coder variants. They're pre-trained on code and produce better results for programming tasks.

## Using Other Models

Nanotune works with any HuggingFace model that supports MLX. When running `nanotune init`, enter any valid HuggingFace model ID as the base model.

> **Note:** Larger models (3B+) require more RAM and take significantly longer to train. Make sure you have at least 16GB RAM for models above 1.5B.
