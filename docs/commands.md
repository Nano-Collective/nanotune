# Commands

A reference for all Nanotune CLI commands.

## Project

### `nanotune init`

Initialize a new fine-tuning project. You'll be prompted for:

- Project name
- Base model (any HuggingFace model ID)
- System prompt

Creates a `.nanotune/` directory with configuration and data folders.

### `nanotune status`

Show current project status including training data count, training progress, exports, and benchmark results.

## Data

### `nanotune data add`

Interactively add training examples one at a time. Each example consists of a user input and expected output.

### `nanotune data import <file>`

Import training data from a file. Supported formats:

- **JSONL** — Chat format with messages array
- **CSV** — Simple input/output columns
- **JSON** — Array of examples

### `nanotune data list`

View and manage your training data with pagination, search, and delete.

### `nanotune data validate`

Validate your training data for:

- Valid JSON structure
- Required fields present
- No duplicate examples
- System prompt consistency
- Minimum example count

## Training

### `nanotune train`

Run LoRA fine-tuning with live progress display.

**Options:**

| Flag | Description |
|------|-------------|
| `-i, --iterations <n>` | Override iteration count |
| `--lr <rate>` | Override learning rate |
| `--resume` | Resume from last checkpoint |
| `--dry-run` | Validate config without training |

## Export

### `nanotune export`

Export your trained model to GGUF format. Downloads pre-built llama.cpp binaries automatically.

**Options:**

| Flag | Description |
|------|-------------|
| `-q, --quantization <type>` | Quantization type: `f16`, `q8_0`, `q4_k_m`, `q4_k_s` |
| `-o, --output <name>` | Output filename |
| `--skip-fuse` | Skip adapter fusion if already fused |

## Benchmarking

### `nanotune benchmark`

Run benchmarks against a test dataset. Generates JSON and Markdown reports.

**Hardware Presets:**

Use `--preset <name>` to quickly configure for your hardware:

| Preset | Description |
|--------|-------------|
| `low` | Older laptops, CPU only |
| `medium` | Modern laptops |
| `high` | Apple Silicon M1/M2/M3 |
| `ultra` | Maximum performance |

**Options:**

| Flag | Description |
|------|-------------|
| `-m, --model <path>` | Path to model file |
| `-d, --dataset <path>` | Path to benchmark dataset |
| `-t, --timeout <ms>` | Timeout per test (default: 30000) |
| `--threads <n>` | CPU threads (default: auto) |
| `--gpu-layers <n>` | GPU layers to offload (default: max) |
| `--ctx-size <n>` | Context size in tokens |
| `--batch-size <n>` | Batch size for processing |
| `--cpu-only` | Disable GPU |
| `--max-tokens <n>` | Max tokens to generate |
| `--temperature <n>` | Sampling temperature |
| `--seed <n>` | Random seed for reproducibility |

### `nanotune judge configure`

Set up an LLM provider to evaluate open-ended responses during benchmarking. Supports both cloud providers (OpenRouter, OpenAI, Anthropic, etc.) and local providers (Ollama, llama.cpp, LM Studio).

### `nanotune judge test`

Run a sample evaluation against the configured judge to verify it's working.
