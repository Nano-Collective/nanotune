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