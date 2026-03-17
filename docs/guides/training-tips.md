---
title: "Training Tips"
description: "Hyperparameter guidance, signs of good training, and iterative improvement strategies"
sidebar_order: 4
---

# Training Tips

Practical guidance for getting the best results from LoRA fine-tuning with Nanotune.

## Recommended Starting Point

| Parameter | Default | Description |
|-----------|---------|-------------|
| Iterations | 150 | Number of training steps |
| Learning rate | 5e-5 | How aggressively the model learns |
| Batch size | 4 | Examples processed per step |

These defaults work well for most 0.5B–1.5B models with 100–500 training examples.

## Adjusting Hyperparameters

### If Underfitting (Low Accuracy)

The model isn't learning enough from the training data:

- Increase iterations: `150 → 200 → 300`
- Increase learning rate: `5e-5 → 1e-4`

### If Overfitting (Garbage Output)

The model has memorized the training data too closely and produces poor results on new inputs:

- Decrease iterations: `150 → 100 → 75`
- Decrease learning rate: `5e-5 → 2e-5`

## Signs of Good Training

Watch the training progress display for these indicators:

- **Loss decreases smoothly** — No sudden spikes or plateaus
- **Validation loss tracks training loss** — They should decrease together
- **Final loss around 0.1–0.3** — This range typically produces good results

> **Tip:** If validation loss starts increasing while training loss continues to decrease, the model is overfitting. Stop training earlier or reduce iterations.

## Iterative Improvement

The most effective approach is an iterative cycle of training and benchmarking:

1. **Train** your model with the current dataset
2. **Benchmark** to measure accuracy and identify failures
3. **Review** the markdown report — focus on failed tests
4. **Add training examples** that address the specific failures
5. **Re-train and benchmark** again

```bash
nanotune train
nanotune benchmark --preset medium
# Review .nanotune/benchmarks/benchmark-*.md
nanotune data add    # Add examples for failures
nanotune train
nanotune benchmark --preset medium
```

Each iteration should improve your model's performance on the areas where it was weakest.

## Training Data Quality

The quality of your training data matters more than quantity:

- **Consistency** — Use the same context message across all examples
- **Accuracy** — Make sure outputs are exactly what you want the model to produce
- **Variety** — Include different phrasings of similar inputs
- **Edge cases** — Cover unusual inputs the model might encounter

See the [Training Data](training-data.md) guide for more on data formats and best practices.
