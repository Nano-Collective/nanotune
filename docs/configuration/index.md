---
title: "Configuration"
description: "Reference for Nanotune's config.json and project settings"
sidebar_order: 6
---

# Configuration

Nanotune's project configuration is stored in `.nanotune/config.json`. This file is created by `nanotune init` and controls all aspects of training and export.

## In This Section

- [Recommended Models](models.md) — Tested models that work well with Nanotune
- [Judge Configuration](judge.md) — Setting up judge.json for LLM-as-a-judge evaluation

## config.json Reference

```json
{
  "name": "my-project",
  "version": "1.0.0",
  "baseModel": "Qwen/Qwen2.5-Coder-1.5B-Instruct",
  "contextMessage": {
    "role": "system",
    "content": "You are a helpful assistant."
  },
  "training": {
    "iterations": 150,
    "learningRate": 5e-5,
    "batchSize": 4,
    "numLayers": 16,
    "stepsPerEval": 50,
    "saveEvery": 50,
    "fineTuneType": "lora",
    "loraRank": 8,
    "loraAlpha": 20,
    "loraDropout": 0,
    "maxSeqLength": 2048,
    "gradCheckpoint": false,
    "valBatches": 25,
    "seed": 0
  },
  "export": {
    "quantization": "q4_k_m",
    "outputName": "my-model"
  }
}
```

## Fields

### Project

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Project name |
| `version` | string | Project version |
| `baseModel` | string | HuggingFace model ID to fine-tune |
| `contextMessage` | object | The context message applied to all training examples |
| `contextMessage.role` | string | Message role (e.g. `system`, `developer`) |
| `contextMessage.content` | string | Message content (instructions for the model) |

> **Note:** For backward compatibility, existing configs using `systemPrompt` (a plain string) will continue to work — it's treated as a `system`-role context message.

### Training

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `iterations` | number | 150 | Number of training steps |
| `learningRate` | number | 5e-5 | Learning rate for optimization |
| `batchSize` | number | 4 | Examples processed per step |
| `numLayers` | number | 16 | Number of LoRA layers to train |
| `stepsPerEval` | number | 50 | Run validation every N steps |
| `saveEvery` | number | 50 | Save a checkpoint every N steps |
| `fineTuneType` | string | `lora` | Fine-tuning type: `lora`, `dora`, or `full` |
| `loraRank` | number | 8 | LoRA rank |
| `loraAlpha` | number | 20 | LoRA alpha (scaling factor) |
| `loraDropout` | number | 0 | LoRA dropout |
| `maxSeqLength` | number | 2048 | Maximum sequence length |
| `gradCheckpoint` | boolean | false | Enable gradient checkpointing to reduce memory use |
| `valBatches` | number | 25 | Number of validation batches |
| `seed` | number | 0 | Random seed for training |

### Export

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `quantization` | string | `q4_k_m` | Quantization type: `f16`, `q8_0`, `q4_k_m`, `q4_k_s` |
| `outputName` | string | — | Output filename for the GGUF file |

## See Also

- [Training Tips](../guides/training-tips.md) — Guidance on tuning hyperparameters
- [`nanotune init`](../commands/init.md) — How the config is created
