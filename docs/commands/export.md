---
title: "nanotune export"
description: "Export your trained model to GGUF format"
sidebar_order: 4
---

# nanotune export

Export your fine-tuned model to GGUF format for inference with llama.cpp, Ollama, and other tools.

## Usage

```bash
nanotune export
```

## Options

| Flag | Description |
|------|-------------|
| `-q, --quantization <type>` | Quantization type: `f16`, `q8_0`, `q4_k_m`, `q4_k_s` |
| `-o, --output <name>` | Output filename |
| `--skip-fuse` | Skip adapter fusion — requires a `fused/` cache from a previous export |

## Examples

```bash
# Export with default settings from config
nanotune export

# Export with specific quantization
nanotune export -q q8_0

# Export with custom output name
nanotune export -o my-model

# Skip fusion step (if you've already fused)
nanotune export --skip-fuse
```

## What Happens During Export

1. **Adapter fusion** — Your LoRA adapter is fused with the base model weights
2. **GGUF conversion** — The fused model is converted to GGUF format using llama.cpp
3. **Quantization** — The model is quantized to reduce file size

Pre-built llama.cpp binaries are downloaded automatically — no compilation needed.

## Fused Model Cache

Fusing the LoRA adapter into the base model produces a full-precision copy, which is kept at `.nanotune/models/fused/` after export finishes — it's not deleted. Keeping it around lets `nanotune export --skip-fuse` reuse it to produce a different quantization without redoing the fusion step.

That directory can be multiple gigabytes. Its size is shown when export completes and in `nanotune status`. Run [`nanotune clean`](clean.md) to remove it and reclaim the space — the next export will simply re-fuse the adapter.

## Quantization Types

| Type | Description |
|------|-------------|
| `f16` | Full 16-bit precision, largest file size |
| `q8_0` | 8-bit quantization, good quality with smaller size |
| `q4_k_m` | 4-bit quantization (medium), balanced quality/size |
| `q4_k_s` | 4-bit quantization (small), smallest file size |

## See Also

- [Configuration](../configuration/index.md) — Set default quantization and output name
