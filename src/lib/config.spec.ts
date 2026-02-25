import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "ava";
import { ConfigSchema } from "../types/index.js";
import { createDefaultConfig, resolveContextMessage } from "./config.js";

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

test("ConfigSchema validates config with contextMessage", (t) => {
  const config = {
    name: "test-project",
    version: "1.0.0",
    baseModel: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
    contextMessage: { role: "system", content: "You are a helpful assistant." },
    training: {
      iterations: 150,
      learningRate: 5e-5,
      batchSize: 4,
      numLayers: 16,
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

test("ConfigSchema validates legacy config with systemPrompt", (t) => {
  const config = {
    name: "test-project",
    version: "1.0.0",
    baseModel: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
    systemPrompt: "You are a helpful assistant.",
    training: {
      iterations: 150,
      learningRate: 5e-5,
      batchSize: 4,
      numLayers: 16,
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

test("ConfigSchema rejects config with neither contextMessage nor systemPrompt", (t) => {
  const config = {
    name: "test-project",
    version: "1.0.0",
    baseModel: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
    training: {
      iterations: 150,
      learningRate: 5e-5,
      batchSize: 4,
      numLayers: 16,
      stepsPerEval: 50,
      saveEvery: 50,
    },
    export: {
      quantization: "q4_k_m",
      outputName: "test",
    },
  };

  const result = ConfigSchema.safeParse(config);
  t.false(result.success);
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
    contextMessage: { role: "system", content: "You are a helpful assistant." },
    training: {
      iterations: 150,
      learningRate: 5e-5,
      batchSize: 4,
      numLayers: 16,
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
    { role: "system", content: "You are helpful." },
  );

  const result = ConfigSchema.safeParse(config);
  t.true(result.success);
  t.is(config.name, "my-project");
  t.is(config.baseModel, "Qwen/Qwen2.5-Coder-1.5B-Instruct");
  t.deepEqual(config.contextMessage, { role: "system", content: "You are helpful." });
  t.is(config.training.iterations, 150);
  t.is(config.export.quantization, "q4_k_m");
});

test("createDefaultConfig sets correct defaults", (t) => {
  const config = createDefaultConfig("test", "model", { role: "developer", content: "prompt" });

  t.is(config.version, "1.0.0");
  t.is(config.training.learningRate, 5e-5);
  t.is(config.training.batchSize, 4);
  t.is(config.training.numLayers, 16);
});

test("resolveContextMessage prefers contextMessage over systemPrompt", (t) => {
  const config = {
    name: "test",
    version: "1.0.0",
    baseModel: "model",
    contextMessage: { role: "developer", content: "Dev prompt" },
    systemPrompt: "System prompt",
    training: {
      iterations: 150,
      learningRate: 5e-5,
      batchSize: 4,
      numLayers: 16,
      stepsPerEval: 50,
      saveEvery: 50,
    },
    export: {
      quantization: "q4_k_m" as const,
      outputName: "test",
    },
  };

  const result = resolveContextMessage(config);
  t.is(result.role, "developer");
  t.is(result.content, "Dev prompt");
});

test("resolveContextMessage falls back to systemPrompt", (t) => {
  const config = {
    name: "test",
    version: "1.0.0",
    baseModel: "model",
    systemPrompt: "System prompt",
    training: {
      iterations: 150,
      learningRate: 5e-5,
      batchSize: 4,
      numLayers: 16,
      stepsPerEval: 50,
      saveEvery: 50,
    },
    export: {
      quantization: "q4_k_m" as const,
      outputName: "test",
    },
  };

  const result = resolveContextMessage(config);
  t.is(result.role, "system");
  t.is(result.content, "System prompt");
});
