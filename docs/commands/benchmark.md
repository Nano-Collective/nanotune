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
| `low` | Older laptops | 4 | 0 (CPU only) | 2048 | 512 | 128 |
| `medium` | Modern laptops | 8 | 20 | 4096 | 1024 | 256 |
| `high` | Apple Silicon M1/M2/M3 | auto | max | 8192 | 2048 | 512 |
| `ultra` | Maximum performance | auto | max | 16384 | 4096 | 1024 |

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
| `--temperature <n>` | Sampling temperature (default: 0) |
| `--seed <n>` | Random seed for reproducibility (default: 42) |
| `--samples <n>` | Run each test n times, reporting pass rate and variance (default: 1) |
| `--json` | Print the benchmark result as JSON on stdout instead of the interactive report |

## Reproducibility

Benchmarks are deterministic by default: temperature is `0` and the seed is fixed at `42`. Running the same suite twice against the same model gives the same score, so a change in pass rate reflects a real change in the model rather than sampling noise.

To sample instead, pass a temperature explicitly:

```bash
nanotune benchmark --temperature 0.8
```

With sampling enabled, `--samples <n>` runs each test n times and records the per-test pass rate and variance in the reports, which is a more honest signal than a single draw. A test counts as passed when the majority of its samples pass. Each sample uses `seed + sample_index`, so repeated runs stay reproducible while the samples differ from one another.

```bash
nanotune benchmark --temperature 0.8 --samples 5
```

`--temperature`, `--seed`, and `--samples` are rejected outright if they can't be parsed, rather than falling back to the default. A typo like `--samples 5x` fails with a message naming the flag, so a run never reports a score under settings you didn't ask for.

## Examples

```bash
# Quick benchmark with preset
nanotune benchmark --preset medium

# CPU-only benchmark
nanotune benchmark --preset low

# Custom configuration
nanotune benchmark --threads 4 --gpu-layers 10 --ctx-size 2048

# Mix preset with overrides
nanotune benchmark --preset medium --temperature 0.5 --seed 7

# Measure variance under sampling
nanotune benchmark --temperature 0.8 --samples 5
```

## JSON Output

`--json` prints the finished run as a single JSON document on stdout — the same
document written to `.nanotune/benchmarks/benchmark-*.json`, so there is one
schema rather than two:

```bash
nanotune benchmark --json > run.json
nanotune benchmark --json | jq -e '.summary.passRate >= 0.9'
```

Progress is written to stderr while the suite runs, so stdout stays a single
parseable document. A completed run exits `0` whatever its pass rate — gate on
the score with `jq -e` rather than expecting a non-zero exit. See
[JSON Output](../guides/json-output.md) for the full schema.

## See Also

- [Benchmarking Guide](../guides/benchmarking.md) — Creating test datasets, match modes, and reports
- [LLM Judge](../guides/llm-judge.md) — Evaluating open-ended responses
