---
title: "nanotune benchmark"
description: "Run benchmarks against a test dataset with detailed reports"
sidebar_order: 5
---

# nanotune benchmark

Run benchmarks against a test dataset. Generates JSON and Markdown reports with pass rates, timing metrics, and detailed results.

## Usage

```bash
nanotune benchmark
```

## Hardware Presets

Use `--preset <name>` to quickly configure for your hardware:

| Preset | Description | Threads | GPU Layers | Context | Batch | Max Tokens |
|--------|-------------|---------|------------|---------|-------|------------|
| `low` | Older laptops | 4 | 0 (CPU only) | 2048 | 512 | 50 |
| `medium` | Modern laptops | 8 | 20 | 4096 | 1024 | 100 |
| `high` | Apple Silicon M1/M2/M3 | auto | max | 8192 | 2048 | 150 |
| `ultra` | Maximum performance | auto | max | 16384 | 4096 | 200 |

## Options

| Flag | Description |
|------|-------------|
| `--preset <name>` | Use a hardware profile: `low`, `medium`, `high`, `ultra` |
| `-m, --model <path>` | Path to model file |
| `-d, --dataset <path>` | Path to benchmark dataset |
| `-t, --timeout <ms>` | Timeout per test (default: 30000) |
| `--threads <n>` | CPU threads (default: auto) |
| `--gpu-layers <n>` | GPU layers to offload (default: max) |
| `--ctx-size <n>` | Context size in tokens (default: 4096) |
| `--batch-size <n>` | Batch size for processing (default: 2048) |
| `--cpu-only` | Disable GPU, use CPU only |
| `--max-tokens <n>` | Max tokens to generate (default: 50) |
| `--temperature <n>` | Sampling temperature (default: 0.8) |
| `--seed <n>` | Random seed for reproducibility |

## Examples

```bash
# Quick benchmark with preset
nanotune benchmark --preset medium

# CPU-only benchmark
nanotune benchmark --preset low

# Custom configuration
nanotune benchmark --threads 4 --gpu-layers 10 --ctx-size 2048

# Mix preset with overrides
nanotune benchmark --preset medium --temperature 0.5 --seed 42
```

## See Also

- [Benchmarking Guide](../guides/benchmarking.md) — Creating test datasets, match modes, and reports
- [LLM Judge](../guides/llm-judge.md) — Evaluating open-ended responses
