# Nanotune

A simple, interactive CLI for fine-tuning small language models on Apple Silicon. No YAML configs, no complex flags - just an interactive CLI that guides you through the process.

## Features

- Interactive TUI built with React Ink
- LoRA fine-tuning via MLX
- GGUF export via llama.cpp (pre-built binaries, no compilation needed)
- Flexible benchmark testing with detailed reports
- Support for any HuggingFace model
- Configurable evaluation modes for different use cases

## Requirements

- macOS with Apple Silicon (M1/M2/M3/M4)
- Node.js 18+
- Python 3.10+
- ~8GB RAM minimum (16GB recommended)

## Installation

```bash
npm install -g @nanocollective/nanotune
```

Or run directly with npx:

```bash
npx @nanocollective/nanotune init
```

## Quick Start

```bash
# 1. Initialize a new project
nanotune init

# 2. Add training data interactively
nanotune data add

# Or import from a file
nanotune data import examples.jsonl

# 3. Train the model
nanotune train

# 4. Export to GGUF
nanotune export

# 5. Benchmark your model
nanotune benchmark
```

## Commands

### `nanotune init`

Initialize a new fine-tuning project. You'll be prompted to enter:
- Project name
- Base model (any HuggingFace model ID)
- System prompt

Creates a `.nanotune/` directory with configuration and data folders.

### `nanotune data add`

Interactively add training examples one at a time. Each example consists of:
- User input (the prompt)
- Expected output (the model's response)

### `nanotune data import <file>`

Import training data from external files. Supported formats:
- **JSONL** - Chat format with messages array
- **CSV** - Simple input,output columns
- **JSON** - Array of examples

### `nanotune data list`

View and manage your training data with pagination, search, and delete.

### `nanotune data validate`

Validate your training data for:
- Valid JSON structure
- Required fields present
- No duplicate examples
- System prompt consistency
- Minimum example count

### `nanotune train`

Run LoRA fine-tuning with live progress display.

Options:
- `-i, --iterations <n>` - Override iteration count
- `--lr <rate>` - Override learning rate
- `--resume` - Resume from last checkpoint
- `--dry-run` - Validate config without training

### `nanotune export`

Export your trained model to GGUF format for inference. Downloads pre-built llama.cpp binaries automatically.

Options:
- `-q, --quantization <type>` - Quantization type (f16, q8_0, q4_k_m, q4_k_s)
- `-o, --output <name>` - Output filename
- `--skip-fuse` - Skip adapter fusion if already fused

### `nanotune benchmark`

Run benchmarks against a test dataset. Generates both JSON and Markdown reports.

Options:
- `-m, --model <path>` - Path to model file
- `-d, --dataset <path>` - Path to benchmark dataset
- `-t, --timeout <ms>` - Timeout per test (default: 30000)

### `nanotune status`

Show current project status including training data count, training status, exports, and benchmark results.

## Training Data Format

### JSONL (Recommended)

```jsonl
{"messages":[{"role":"system","content":"You are helpful."},{"role":"user","content":"Hello"},{"role":"assistant","content":"Hi!"}]}
```

### CSV

```csv
input,output
"list all files","ls -la"
"show disk usage","df -h"
```

### Simple JSON

```json
[
  {"input": "list all files", "output": "ls -la"},
  {"input": "show disk usage", "output": "df -h"}
]
```

## Benchmark Dataset Format

Create a `tests.json` file in `.nanotune/benchmarks/`:

```json
[
  {
    "id": 1,
    "prompt": "list all files",
    "acceptable": ["ls", "ls -la", "ls -a"],
    "category": "basic",
    "match": "semantic"
  },
  {
    "id": 2,
    "prompt": "What is the capital of France?",
    "acceptable": ["Paris"],
    "category": "geography",
    "match": "contains"
  },
  {
    "id": 3,
    "prompt": "Is this spam? Yes or No",
    "acceptable": ["Yes", "No"],
    "category": "classification",
    "match": "exact"
  }
]
```

### Match Modes

Each test can specify a `match` mode to control how responses are evaluated:

| Mode | Description | Best For |
|------|-------------|----------|
| `semantic` | Normalized comparison with prefix matching (default) | Code generation, CLI commands |
| `startsWith` | Response must start with acceptable answer | Code output, short answers |
| `contains` | Response must contain acceptable answer anywhere | Q&A, explanations, chatbots |
| `exact` | Must match exactly (case-insensitive by default) | Classification, yes/no, labels |

### Match Options

- `caseSensitive`: Set to `true` for case-sensitive matching (default: `false`)

### Examples by Use Case

**Code/Command Generation** (use `semantic`):
```json
{
  "prompt": "how do I list files",
  "acceptable": ["ls", "dir"],
  "match": "semantic"
}
```
Passes if response starts with `ls` or `dir`, even with additional flags.

**Question Answering** (use `contains`):
```json
{
  "prompt": "What year did WW2 end?",
  "acceptable": ["1945"],
  "match": "contains"
}
```
Passes if `1945` appears anywhere in the response.

**Classification** (use `exact`):
```json
{
  "prompt": "Classify: 'I love this product'",
  "acceptable": ["positive", "Positive", "POSITIVE"],
  "match": "exact"
}
```
Passes only if response exactly matches one of the options.

### Benchmark Reports

After running `nanotune benchmark`, two files are generated in `.nanotune/benchmarks/`:

1. **JSON report** (`benchmark-{timestamp}.json`) - Machine-readable with full results
2. **Markdown report** (`benchmark-{timestamp}.md`) - Human-readable with:
   - Summary statistics
   - Pass rate by category
   - Detailed results for every test
   - Failed tests table

## Configuration

The project configuration is stored in `.nanotune/config.json`:

```json
{
  "name": "my-project",
  "version": "1.0.0",
  "baseModel": "Qwen/Qwen2.5-Coder-1.5B-Instruct",
  "systemPrompt": "You are a helpful assistant.",
  "training": {
    "iterations": 150,
    "learningRate": 5e-5,
    "batchSize": 4,
    "numLayers": 16,
    "stepsPerEval": 50,
    "saveEvery": 50
  },
  "export": {
    "quantization": "q4_k_m",
    "outputName": "my-model"
  }
}
```

## Recommended Models

These models have been tested and work well with Nanotune:

| Model | Size | Use Case |
|-------|------|----------|
| `Qwen/Qwen2.5-Coder-0.5B-Instruct` | 0.5B | Quick experiments |
| `Qwen/Qwen2.5-Coder-1.5B-Instruct` | 1.5B | Balanced performance |
| `Qwen/Qwen2.5-0.5B-Instruct` | 0.5B | General purpose |
| `Qwen/Qwen2.5-1.5B-Instruct` | 1.5B | General purpose |

## Tips

### Training Data

- **Quantity**: 100-500 examples for 0.5B-1.5B models
- **Quality**: Ensure consistency in system prompts
- **Variety**: Cover edge cases and variations

### Hyperparameters

Starting point:
- Iterations: 150
- Learning rate: 5e-5
- Batch size: 4

If underfitting (low accuracy):
- Increase iterations: 150 → 200 → 300
- Increase learning rate: 5e-5 → 1e-4

If overfitting (garbage output):
- Decrease iterations: 150 → 100 → 75
- Decrease learning rate: 5e-5 → 2e-5

### Signs of Good Training

- Loss decreases smoothly
- Validation loss tracks training loss
- Final loss around 0.1-0.3

### Iterative Fine-tuning

Use benchmark results to improve your training data:

1. Run `nanotune benchmark`
2. Review the markdown report for failed tests
3. Add similar examples to your training data
4. Re-train and benchmark again

## Development

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Build
pnpm build

# Run tests
pnpm test:all

# Format code
pnpm format
```

## Community

We're a small community-led team building Nanotune and would love your help! Whether you're interested in contributing code, documentation, or just being part of our community, there are several ways to get involved.

**If you want to contribute to the code:**

- Read our detailed [CONTRIBUTING.md](CONTRIBUTING.md) guide for information on development setup, coding standards, and how to submit your changes.

**If you want to be part of our community or help with other aspects like design or marketing:**

- Join our Discord server to connect with other users, ask questions, share ideas, and get help: [Join our Discord server](https://discord.gg/ktPDV6rekE)

- Head to our GitHub issues or discussions to open and join current conversations with others in the community.

All contributions and community participation are welcome!
