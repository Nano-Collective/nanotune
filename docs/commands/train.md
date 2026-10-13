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
| `--batch-size <n>` | Override batch size |
| `--num-layers <n>` | Override number of layers to fine-tune |
| `--steps-per-eval <n>` | Override validation interval (steps) |
| `--save-every <n>` | Override checkpoint save interval (steps) |
| `--fine-tune-type <type>` | Fine-tuning type: `lora`, `dora`, or `full` |
| `--lora-rank <n>` | LoRA rank |
| `--lora-alpha <n>` | LoRA alpha (scaling factor) |
| `--lora-dropout <n>` | LoRA dropout |
| `--max-seq-length <n>` | Maximum sequence length |
| `--grad-checkpoint` / `--no-grad-checkpoint` | Enable or disable gradient checkpointing |
| `--val-batches <n>` | Number of validation batches |
| `--resume` | Resume from last checkpoint |
| `--dry-run` | Validate config without training |
| `--seed <n>` | Integer seed for a reproducible train/validation split |
| `--validation-ratio <n>` | Portion of the data to hold out for validation (default `0.1`) |
| `--stratify <mode>` | Split by the categories in each example's tags: `auto`, `on`, or `off` |
| `--train-seed <n>` | Random seed for mlx_lm's training run |

Every flag above overrides the matching field under `training` in
`.nanotune/config.json`, and each is validated against the same rules as that
file, before the MLX install and data checks, so a typo fails immediately rather
than several minutes in.

### The two seeds

`--seed` and `--train-seed` are separate knobs:

- `--seed` seeds Nanotune's train/validation split. It only affects the run that
  actually creates the split. Once `valid.jsonl` exists the split is left alone,
  so passing a seed to an already-split project does nothing and `train` says so.
  Delete `valid.jsonl` first to re-split.
- `--train-seed` seeds mlx_lm's training run itself (shuffling, dropout, LoRA
  init) and applies on every run.

Both reject a non-integer value rather than silently coercing it.

## How the split is chosen

When `valid.jsonl` does not exist, `train` creates it from `train.jsonl`:

- **By category.** Examples are grouped by the first tag in their `tags` array
  (see [Training Data](/guides/training-data)), and each category contributes
  roughly the same share of the validation set. A category with one example
  among two hundred still gets a validation slot, which a purely random 10%
  split would drop about nine times in ten.
- **By whole duplicate groups.** Two examples that differ only in case,
  punctuation or whitespace are the same example as far as evaluation goes, so
  they are held out together. A copy on both sides would make the validation
  loss measure memorization rather than generalization. `nanotune data validate`
  reports any overlap that already exists.
- **By shuffle** when there is nothing to stratify on, which is every dataset
  without tags.

`--stratify off` restores the original shuffle, duplicate leakage included.
`--validation-ratio` changes the share held out; it must be at least 0 and less
than 1, and is rejected before anything is written rather than part-way through.

The split never drops or duplicates an example: both files together are checked
against the input before either is written. If the split cannot cover every
category at the requested ratio — twenty categories and room for ten examples —
the ones left out are named rather than quietly omitted.

## Examples

```bash
# Train with default settings from config
nanotune train

# Override iterations
nanotune train -i 200

# Override learning rate
nanotune train --lr 1e-4

# Override batch size, layers, eval and save intervals
nanotune train --batch-size 8 --num-layers 8 --steps-per-eval 25 --save-every 25

# Use DoRA instead of LoRA, with a higher rank
nanotune train --fine-tune-type dora --lora-rank 16 --lora-alpha 32

# Trade compute for memory on a long-context run
nanotune train --grad-checkpoint --max-seq-length 4096

# Fully reproducible run: fixed split and fixed training seed
nanotune train --seed 42 --train-seed 42

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

Training checkpoints are saved at regular intervals (configurable via `saveEvery` in your config, or overridden per-run with `--save-every`). If training is interrupted, use `--resume` to continue from the last checkpoint.

## See Also

- [Training Tips](../guides/training-tips.md) — Hyperparameter guidance and signs of good training
- [Configuration](../configuration/index.md) — Customize training parameters
