import test from "ava";
import { parseDownloadProgress } from "./mlx.js";

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
    loraLayers: 16,
    loraRank: 8,
    stepsPerEval: 50,
    saveEvery: 50,
    resume: false,
  };

  t.is(options.model, "Qwen/Qwen2.5-Coder-1.5B-Instruct");
  t.is(options.iterations, 150);
  t.is(options.learningRate, 5e-5);
  t.is(options.batchSize, 4);
});

// parseDownloadProgress tests

test("parseDownloadProgress parses single file tqdm output", (t) => {
  const line =
    "model.safetensors: 45%|██▍   |1.2G/2.7G [00:30<00:37, 40.5MB/s]";
  const result = parseDownloadProgress(line);
  t.not(result, null);
  t.is(result!.type, "download");
  t.is(result!.fileName, "model.safetensors");
  t.is(result!.percent, 45);
  t.is(result!.sizeInfo, "1.2G/2.7G");
});

test("parseDownloadProgress parses multi-file fetch output", (t) => {
  const line = "Fetching 12 files: 75%|██████▊  |9/12";
  const result = parseDownloadProgress(line);
  t.not(result, null);
  t.is(result!.type, "download");
  t.is(result!.percent, 75);
  t.is(result!.fileName, undefined);
});

test("parseDownloadProgress parses generic tqdm fallback", (t) => {
  const line = "  33%|███▎      | 1/3 [00:02<00:04]";
  const result = parseDownloadProgress(line);
  t.not(result, null);
  t.is(result!.type, "download");
  t.is(result!.percent, 33);
});

test("parseDownloadProgress returns null for non-download output", (t) => {
  const line = "Loading model configuration...";
  const result = parseDownloadProgress(line);
  t.is(result, null);
});

test("parseDownloadProgress returns null for training output", (t) => {
  const line = "Iter 10: Train loss 1.234, Val loss 1.456";
  const result = parseDownloadProgress(line);
  t.is(result, null);
});

test("parseDownloadProgress handles 100% completion", (t) => {
  const line =
    "model.safetensors: 100%|██████████|2.7G/2.7G [01:07<00:00, 40.5MB/s]";
  const result = parseDownloadProgress(line);
  t.not(result, null);
  t.is(result!.percent, 100);
  t.is(result!.fileName, "model.safetensors");
  t.is(result!.sizeInfo, "2.7G/2.7G");
});
