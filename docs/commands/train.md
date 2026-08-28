---
title: "nanotune train"
description: "Run LoRA fine-tuning with live progress display"
sidebar_order: 3
---

# nanotune train

Run LoRA fine-tuning on your base model using the configured training data.

## Usage

```bash
nanotune train
```

## Options

| Flag | Description |
|------|-------------|
| `-i, --iterations <n>` | Override iteration count |
| `--lr <rate>` | Override learning rate |
| `--resume` | Resume from last checkpoint |
| `--dry-run` | Validate config without training |
| `--seed <n>` | Integer seed for a reproducible train/validation split |

`--seed` only affects the run that actually creates the split. Once `valid.jsonl`
exists the split is left alone, so passing a seed to an already-split project
does nothing and `train` says so — delete `valid.jsonl` first to re-split. A
non-integer seed is rejected rather than silently coerced.

## Examples

```bash
# Train with default settings from config
nanotune train

# Override iterations
nanotune train -i 200

# Override learning rate
nanotune train --lr 1e-4

# Resume from last checkpoint
nanotune train --resume

# Validate config without running training
nanotune train --dry-run
```

## What Happens During Training

Training runs LoRA (Low-Rank Adaptation) fine-tuning via MLX with a live progress display showing:

- Current iteration and total
- Training loss
- Validation loss (at evaluation intervals)
- Elapsed time

Training checkpoints are saved at regular intervals (configurable via `saveEvery` in your config). If training is interrupted, use `--resume` to continue from the last checkpoint.

## See Also

- [Training Tips](../guides/training-tips.md) — Hyperparameter guidance and signs of good training
- [Configuration](../configuration/index.md) — Customize training parameters
