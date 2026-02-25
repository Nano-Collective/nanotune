# 1.2.0

## Message-Structure-Agnostic Training

Nanotune is no longer locked into the `system/user/assistant` message structure. The hardcoded `systemPrompt` config field has been replaced with a flexible `contextMessage` that accepts any role (`system`, `developer`, or custom roles).

### What Changed
- **`nanotune init`** now asks for a context message role (defaulting to `system`) and content, instead of just a system prompt
- **Config format** uses `contextMessage: { role, content }` instead of `systemPrompt`
- **Validation** is relaxed: training examples require at least 2 messages with any role names, instead of exactly 3 with hardcoded roles
- **Backward compatible**: existing projects using `systemPrompt` in config.json continue to work without changes

### Why
Models like FunctionGemma use a `developer` role instead of `system`. This change lets you fine-tune for any chat message structure.

---

# 1.1.1

## Security Updates

- Fixed high severity vulnerabilities in transitive dependencies (`minimatch`, `tar`) via pnpm overrides

## Documentation

- Added basic documentation in `./docs` ahead of new documentation website
  - Getting started guide
  - Command reference
  - Training data formats
  - Benchmarking guide

# 1.1.0

## Enhanced Benchmarking

Added `--preset` flag for quick hardware profile selection:
- `low` - Low-end hardware (4 threads, CPU only, 2048 ctx)
- `medium` - Mid-range hardware (8 threads, 20 GPU layers, 4096 ctx)
- `high` - High-end hardware (auto threads, max GPU layers, 8192 ctx)
- `ultra` - Maximum performance (auto threads, max GPU layers, 16384 ctx)

### New CLI Flags
- `--threads <n>` - Number of CPU threads
- `--gpu-layers <n>` - GPU layers to offload
- `--ctx-size <n>` - Context size in tokens
- `--batch-size <n>` - Batch size for processing
- `--cpu-only` - Disable GPU, use CPU only
- `--max-tokens <n>` - Max tokens to generate
- `--temperature <n>` - Sampling temperature
- `--seed <n>` - Random seed for reproducibility

### Detailed Timing
Each query now reports:
- Total latency
- Time to first token (TTFT)
- Generation time
- Tokens generated
- Tokens per second

# 1.0.0

Initial release of Nanotune - a simple, interactive CLI for fine-tuning small language models on Apple Silicon.

## Features

- **Interactive TUI** - Built with React Ink for a smooth terminal experience
- **LoRA Fine-tuning** - Powered by MLX for efficient training on Apple Silicon
- **GGUF Export** - Automatic conversion using pre-built llama.cpp binaries (no compilation needed)
- **Flexible Benchmarking** - Test your models with configurable evaluation modes:
  - `semantic` - Normalized comparison with prefix matching (ideal for code/commands)
  - `contains` - Check if response contains expected answer (ideal for Q&A)
  - `startsWith` - Response must start with expected answer
  - `exact` - Exact match comparison (ideal for classification)
- **Detailed Reports** - JSON and Markdown benchmark reports with model responses and latency metrics
- **Data Management** - Import from JSONL, CSV, or JSON formats with validation

## Commands

- `nanotune init` - Initialize a new fine-tuning project
- `nanotune data add` - Interactively add training examples
- `nanotune data import` - Import training data from files
- `nanotune data list` - View and manage training data
- `nanotune data validate` - Validate training data
- `nanotune train` - Run LoRA fine-tuning with live progress
- `nanotune export` - Export to GGUF format with quantization options
- `nanotune benchmark` - Run benchmarks with detailed reporting
- `nanotune status` - Show project status

If there are any problems, feedback or thoughts please drop an issue or message us through Discord! Thank you for using Nanotune. 🙌