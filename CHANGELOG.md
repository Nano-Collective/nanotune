# 1.3.1

## Benchmark Timing Fixes

- **Fixed tokens/sec parsing** — now matches llama.cpp's actual `llama_perf_context_print` output format instead of the old `tok/s` pattern
- **Fixed TTFT** — extracted from `prompt eval time` in llama.cpp stderr instead of estimating as 10% of total time
- **Fixed generation time and token count** — parsed from `eval time` stderr line
- **Added `--verbose` flag** to llama-cli invocation to ensure timing output is always emitted
- **Added summary averages** — benchmark results now include `avgTokensPerSecond` and `avgTtftMs` in the summary, displayed in both the terminal UI and markdown reports
- **Backward compatible** — old `tok/s` and `tokens generated` patterns kept as fallback for older llama.cpp versions

---

# 1.3.0

## Multi-Turn Training & Benchmarking

Nanotune now supports multi-turn conversations in both training data and benchmarks, enabling fine-tuning for dialogue and multi-step interactions.

### Multi-Turn Training
- **`nanotune data add`** supports building multi-turn examples interactively — add as many user/assistant exchanges as needed per example
- **Import** preserves multi-turn conversations from JSONL and JSON sources (4+ messages kept as-is)
- **`nanotune data list`** shows turn count per example
- **Validation** warns on consecutive same-role messages (broken alternation)

### Multi-Turn Benchmarking
- **Benchmark tests** accept a `messages` array as an alternative to `prompt` for multi-turn evaluation
- **LLM judge** receives full conversation context when evaluating multi-turn tests
- **Reports** label multi-turn tests with turn count for clarity

### Model Download Progress
- **`nanotune train`** now shows download progress when fetching a model for the first time, with percentage, file size, and elapsed time
- Downloads are tracked by polling the HuggingFace cache directory, avoiding tqdm/pipe issues

### Improved Benchmark Presets
- **`maxTokens`** values updated to sensible defaults: `low` 128, `medium` 256, `high` 512, `ultra` 1024 (previously 50–200, which was too small for meaningful responses)

---

# 1.2.1

## Bug Fix

- **Benchmark command** now works with minimal config files from external tools. Previously, `nanotune benchmark` required a full project config (with `name`, `baseModel`, `training`, `export` fields). Now it gracefully falls back to an empty context message when the config doesn't match the full schema, enabling benchmark-only workflows.

---

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