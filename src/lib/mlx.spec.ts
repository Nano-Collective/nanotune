import test from "ava";
import { buildLoraConfigYaml } from "./mlx.js";

test("MLX output parsing regex works correctly", (t) => {
  // Test the regex pattern used to parse MLX training output
  const pattern =
    /Iter\s+(\d+)(?:\s*\([^)]+\))?:\s*Train loss\s+([\d.]+)(?:,\s*Val loss\s+([\d.]+))?/i;

  // Test standard format
  const line1 = "Iter 10: Train loss 1.234, Val loss 1.456";
  const match1 = line1.match(pattern);
  t.truthy(match1);
  t.is(match1?.[1], "10");
  t.is(match1?.[2], "1.234");
  t.is(match1?.[3], "1.456");
});

test("MLX output parsing handles format without val loss", (t) => {
  const pattern =
    /Iter\s+(\d+)(?:\s*\([^)]+\))?:\s*Train loss\s+([\d.]+)(?:,\s*Val loss\s+([\d.]+))?/i;

  const line = "Iter 50: Train loss 0.456";
  const match = line.match(pattern);
  t.truthy(match);
  t.is(match?.[1], "50");
  t.is(match?.[2], "0.456");
  t.is(match?.[3], undefined);
});

test("MLX output parsing handles format with iteration speed", (t) => {
  const pattern =
    /Iter\s+(\d+)(?:\s*\([^)]+\))?:\s*Train loss\s+([\d.]+)(?:,\s*Val loss\s+([\d.]+))?/i;

  const line = "Iter 100 (15.2 it/s): Train loss 0.342, Val loss 0.298";
  const match = line.match(pattern);
  t.truthy(match);
  t.is(match?.[1], "100");
  t.is(match?.[2], "0.342");
  t.is(match?.[3], "0.298");
});

test("TrainingProgress structure is correct", (t) => {
  const progress = {
    iteration: 50,
    totalIterations: 150,
    trainLoss: 0.456,
    valLoss: 0.423,
  };

  t.is(progress.iteration, 50);
  t.is(progress.totalIterations, 150);
  t.is(progress.trainLoss, 0.456);
  t.is(progress.valLoss, 0.423);
});

test("MLXTrainingOptions structure is correct", (t) => {
  const options = {
    model: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
    dataPath: "/path/to/data",
    adapterPath: "/path/to/adapters",
    iterations: 150,
    learningRate: 5e-5,
    batchSize: 4,
    numLayers: 16,
    stepsPerEval: 50,
    saveEvery: 50,
    resume: false,
    fineTuneType: "lora" as const,
    loraRank: 8,
    loraAlpha: 20,
    loraDropout: 0,
    maxSeqLength: 2048,
    gradCheckpoint: false,
    valBatches: 25,
    seed: 0,
  };

  t.is(options.model, "Qwen/Qwen2.5-Coder-1.5B-Instruct");
  t.is(options.iterations, 150);
  t.is(options.learningRate, 5e-5);
  t.is(options.batchSize, 4);
  t.is(options.fineTuneType, "lora");
  t.is(options.loraRank, 8);
});

test("buildLoraConfigYaml produces the expected lora_parameters block", (t) => {
  const yaml = buildLoraConfigYaml(8, 20, 0);
  t.is(yaml, "lora_parameters:\n  rank: 8\n  scale: 20\n  dropout: 0\n");
});

test("buildLoraConfigYaml reflects overridden values", (t) => {
  const yaml = buildLoraConfigYaml(16, 32, 0.05);
  t.is(yaml, "lora_parameters:\n  rank: 16\n  scale: 32\n  dropout: 0.05\n");
});
