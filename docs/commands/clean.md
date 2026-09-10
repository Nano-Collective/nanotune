---
title: "nanotune clean"
description: "Remove cached models to reclaim disk space"
sidebar_order: 9
---

# nanotune clean

Remove cached models that build up outside your project's tracked files.

By default this targets the fused model cache at `.nanotune/models/fused/`: `nanotune export` keeps a full-precision copy of the fused model around after export so that `nanotune export --skip-fuse` can reuse it for a different quantization without redoing the fusion step. That directory can be multiple gigabytes.

There's also a base-model cache at `~/.nanotune/models/base-cache/`, shared across every project on this machine: `nanotune benchmark --base` keeps a quantized copy of the base model there so repeat control runs skip the download/convert/quantize step. Pass `--target base` (or `--target all`) to clean that too.

## Usage

```bash
nanotune clean
```

## Options

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip the confirmation prompt (for scripts and CI) |
| `--target <fused\|base\|all>` | Which cache to clean (default: `fused`) |

## Examples

```bash
# Interactively confirm before removing the fused model cache
nanotune clean

# Remove it without prompting
nanotune clean --yes

# Clean the shared base-model cache instead (works from any directory,
# not just inside a project)
nanotune clean --target base

# Clean both caches in one pass
nanotune clean --target all --yes
```

## What It Does

1. Checks whichever cache(s) `--target` selects — `.nanotune/models/fused/` for `fused`, `~/.nanotune/models/base-cache/` for `base`, or both for `all`.
2. If anything's found, shows its size (and a combined total for `all`) and asks for confirmation (unless `--yes` is passed).
3. Deletes each cache directory found and reports how much space was freed.

If there's nothing to clean for the requested target, it says so and exits without changes. `--target fused` (the default) still requires being inside a Nanotune project; `--target base` doesn't, since that cache isn't project-scoped. `--target all` outside a project simply skips the fused half rather than erroring.

Your exported `.gguf` files are never touched — only the intermediate caches are removed. The next `nanotune export` will simply re-fuse the adapter, and the next `nanotune benchmark --base` will re-download and requantize the base model.

## See Also

- [`nanotune export`](export.md) — See "Fused Model Cache" for why the fused cache exists
- [`nanotune benchmark`](benchmark.md) — See `--base` for why the base-model cache exists
