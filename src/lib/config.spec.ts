import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "ava";
import { ConfigSchema } from "../types/index.js";
import { createDefaultConfig } from "./config.js";

const TEST_DIR = join(process.cwd(), ".test-nanotune");

test.before(() => {
  // Clean up any existing test directory
  try {
    rmSync(TEST_DIR, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
});

test.after.always(() => {
  // Clean up test directory
  try {
    rmSync(TEST_DIR, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
});

test("ConfigSchema validates correct config", (t) => {
  const config = {
    name: "test-project",
    version: "1.0.0",
    baseModel: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
    systemPrompt: "You are a helpful assistant.",
    training: {
      iterations: 150,
      learningRate: 5e-5,
      batchSize: 4,
      loraLayers: 16,
      loraRank: 8,
      stepsPerEval: 50,
      saveEvery: 50,
    },
    export: {
      quantization: "q4_k_m",
      outputName: "test",
    },
  };

  const result = ConfigSchema.safeParse(config);
  t.true(result.success);
});

test("ConfigSchema rejects invalid config", (t) => {
  const config = { name: "test" }; // missing required fields
  const result = ConfigSchema.safeParse(config);
  t.false(result.success);
});

test("ConfigSchema rejects invalid quantization type", (t) => {
  const config = {
    name: "test-project",
    version: "1.0.0",
    baseModel: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
    systemPrompt: "You are a helpful assistant.",
    training: {
      iterations: 150,
      learningRate: 5e-5,
      batchSize: 4,
      loraLayers: 16,
      loraRank: 8,
      stepsPerEval: 50,
      saveEvery: 50,
    },
    export: {
      quantization: "invalid_quant",
      outputName: "test",
    },
  };

  const result = ConfigSchema.safeParse(config);
  t.false(result.success);
});

test("createDefaultConfig returns valid config", (t) => {
  const config = createDefaultConfig(
    "my-project",
    "Qwen/Qwen2.5-Coder-1.5B-Instruct",
    "You are helpful.",
  );

  const result = ConfigSchema.safeParse(config);
  t.true(result.success);
  t.is(config.name, "my-project");
  t.is(config.baseModel, "Qwen/Qwen2.5-Coder-1.5B-Instruct");
  t.is(config.systemPrompt, "You are helpful.");
  t.is(config.training.iterations, 150);
  t.is(config.export.quantization, "q4_k_m");
});

test("createDefaultConfig sets correct defaults", (t) => {
  const config = createDefaultConfig("test", "model", "prompt");

  t.is(config.version, "1.0.0");
  t.is(config.training.learningRate, 5e-5);
  t.is(config.training.batchSize, 4);
  t.is(config.training.numLayers, 16);
});
