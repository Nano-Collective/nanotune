---
title: "nanotune clean"
description: "Remove the cached fused model to reclaim disk space"
sidebar_order: 9
---

# nanotune clean

Remove the fused model cache at `.nanotune/models/fused/`.

`nanotune export` keeps a full-precision copy of the fused model around after export so that `nanotune export --skip-fuse` can reuse it for a different quantization without redoing the fusion step. That directory can be multiple gigabytes — `nanotune clean` deletes it to reclaim the space.

## Usage

```bash
nanotune clean
```

## Options

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip the confirmation prompt (for scripts and CI) |

## Examples

```bash
# Interactively confirm before removing the fused model cache
nanotune clean

# Remove it without prompting
nanotune clean --yes
```

## What It Does

1. Checks `.nanotune/models/fused/` for a cached fused model.
2. If found, shows its size and asks for confirmation (unless `--yes` is passed).
3. Deletes the directory and reports how much space was freed.

If there's nothing to clean, it says so and exits without changes. Your exported `.gguf` files are never touched — only the intermediate fused model is removed. The next `nanotune export` will simply re-fuse the adapter.

## See Also

- [`nanotune export`](export.md) — See "Fused Model Cache" for why this directory exists
