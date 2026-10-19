---
title: "nanotune runs"
description: "List saved training runs and inspect their loss histories"
sidebar_order: 9
---

# nanotune runs

List recent training runs, including the model, settings, dataset counts,
duration, outcome, and final losses. Run records are stored locally in
`.nanotune/runs/` and are excluded from Git.

## Usage

```bash
nanotune runs
nanotune runs --limit 1
```

Use `--json` to get the complete records, including per-iteration train and
validation loss points:

```bash
nanotune runs --json | jq '.[0].lossHistory'
```

Records are written before downloading/training, refreshed for loss and
checkpoint reports, and finalized as `completed`, `stopped`, or `failed`.
A `running` record with `finishedAt: null` may belong to a live run or one
interrupted before it could finalize. Train and validation reports are separate
loss points; each has an iteration and the loss values reported at that step.
Resumed runs include `resumedFromRunId` when their source adapter has a record.

## Options

| Flag | Description |
|------|-------------|
| `--limit <count>` | Maximum number of recent runs to show (default: `10`) |
| `--json` | Print complete run records as JSON on stdout |

The command requires a Nanotune project. Outside one, it writes the reason to
stderr and exits with status `1`.
