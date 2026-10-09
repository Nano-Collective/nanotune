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
| `--early-stopping-patience <n>` | Stop after N validation checks with no improvement (`0` disables) |
| `--load-best-model-at-end` / `--no-load-best-model-at-end` | Restore the lowest-validation checkpoint when the run finishes, or keep the final one |
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

# Stop once validation loss stalls, and keep that checkpoint
nanotune train --early-stopping-patience 3 --load-best-model-at-end

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

`earlyStoppingPatience` counts validation checks, not optimizer steps. `0` (the default) trains for the full iteration count. With early stopping or `loadBestModelAtEnd` enabled, Nanotune snapshots the exact weights inside MLX's validation callback whenever finite validation loss improves. Validation occurs before the next optimizer update, so its reported best iteration is the number of completed updates (the initial model is iteration `0`). Selection does not depend on `saveEvery` or numbered checkpoints from earlier runs.

When patience is exhausted, MLX stops before the next update and the evaluated best snapshot atomically replaces `adapters.safetensors`. `loadBestModelAtEnd` also restores that snapshot at normal completion: the last validation evaluates weights before the final update, so the final weights are not assumed to have that same score. If no finite evaluation exists, no snapshot is selected and the last saved adapter is kept; the done screen does not offer export after such an early stop. NaN/infinite evaluations count toward patience but never become the best model. Ctrl+C skips restoration and leaves the checkpoint you interrupted on.

Training history records `earlyStopped`, `restoredBest`, `bestIteration`, and `bestValLoss` alongside the loss curve and effective settings. Early-stopped runs have outcome `stopped`.

## See Also

- [Training Tips](../guides/training-tips.md) — Hyperparameter guidance and signs of good training
- [Configuration](../configuration/index.md) — Customize training parameters
