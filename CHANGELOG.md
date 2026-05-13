# 1.4.0

## Correctness Fixes

### Chat-template-aware inference
- **Switched benchmark inference from `/completion` to `/v1/chat/completions`** — llama-server now applies the model's chat template (ChatML, Llama-3 tags, etc.) baked into the GGUF. Training (which feeds MLX a `messages: []` array) and benchmarking now use the same wire format end-to-end. Previously, benchmarks built raw `User:/Assistant:` strings, bypassing the chat template and systematically under-reporting fine-tuned model quality.
- **`llama-server` is now started once per benchmark run** instead of once per test. Cold-starting the server (which loads a multi-GB model) per test has been collapsed to a single startup.

### Data import
- **Fixed CSV parser** — replaced a regex that broke on any field containing a comma with a proper state-machine parser. Quoted fields with embedded commas, escaped quotes (`""`), and CRLF line endings are now handled correctly.
- **JSONL/JSON imports preserve `messages` arrays verbatim** — previously, examples with ≤3 messages had their embedded system prompts silently overwritten by the project's context message. Now any imported `messages` array is preserved as-is.

### Benchmark `semantic` match mode
- **No longer accepts truncated answers** — the old `semantic` mode treated `"ls"` as a pass for `acceptable: ["ls -la"]`, inflating pass rates. The truncation behaviour is now opt-in via a new `partial` match mode.

### Train/valid split
- **Seedable Fisher-Yates shuffle** — replaced the biased `sort(() => Math.random() - 0.5)` with Mulberry32 + Fisher-Yates. Pass a seed to `splitTrainValidation` for a reproducible split.

## Robustness & UX

- **CLI `--version` now reads from `package.json`** (was hardcoded to `1.0.0`).
- **`nanotune init` writes `.nanotune/.gitignore`** covering `judge.json` (API keys), `adapters/`, `models/`, and `benchmarks/` — protects users from committing keys or multi-GB binaries.
- **Upfront platform check** — non-arm64 / non-macOS systems now get a clear, actionable error before any download attempt.
- **Better `mlx-lm` install errors** — `installMLX` tries `--user` first and surfaces actionable guidance when stock macOS Python rejects pip with `externally-managed-environment`.
- **`nanotune train --resume` validates the checkpoint exists** before invoking MLX, replacing an opaque file-not-found with a clear message.
- **f16 intermediate cleanup moved to `finally`** — quantization failures no longer leak multi-GB intermediate files in `models/`.
- **Removed `console.error` in env-substitution** — was corrupting Ink TUI output when an env var was missing.
- **Removed CommonJS `require('node:fs')`** inside the ESM benchmark module.

## Cleanup

- Removed dead code: `runInference`, `parseDownloadProgress`, `runGGUFInferenceLegacy`.
- `InferenceOptions` is now a type alias for `ServerOptions & GenerateOptions` (was a duplicate interface).
- `chatCompletion` accepts an `AbortSignal` via `GenerateOptions.signal`; benchmarks pass one so a timed-out test actually cancels its in-flight `fetch` rather than letting the server keep generating into the void.
- `stopLlamaServer` escalates SIGTERM → SIGKILL after a 2s grace period so a hung server can't block the caller's `finally`.
- Updated spec files to match new behaviour. All 131 tests pass.

---

# 1.3.7

## Toolchain

- **Bumped to pnpm 11 and Node.js 22** — `packageManager` field pinned in `package.json` so CI and contributors stay in sync.
- **Regenerated `pnpm-lock.yaml`** under pnpm 11 to fix `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` on frozen installs.
- **Raised `engines.node` to `>=22.0.0`** and updated CONTRIBUTING and installation docs to match.

---

# 1.3.6

- Updated documentation to match guidelines.

---

# 1.3.5

## Auto-install llama-server

- **Auto-install `llama-server` for existing users** — if the `llama-server` binary is missing from an older llama.cpp installation, benchmarks now automatically re-download llama.cpp before proceeding. No manual steps needed.

---

# 1.3.4

## Benchmark Inference Fix

- **Switched from `llama-cli` to `llama-server`** — benchmarks now spin up a temporary `llama-server` instance and use the `/completion` HTTP API instead of invoking `llama-cli` directly. This avoids the interactive conversation mode that newer llama.cpp versions enter by default, and returns structured timing data (TTFT, tokens/sec, generation time) directly from the response instead of parsing stderr.

---

# 1.3.3

## Benchmark Inference Fix

- **Fixed ENOENT error when running benchmarks** — the inference runner referenced a non-existent `llama-completion` binary. Updated to use `llama-cli`, which is the actual binary name shipped in llama.cpp releases and already provisioned by `nanotune export`.

---

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