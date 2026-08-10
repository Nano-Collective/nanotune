import {
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "ava";
import { ConfigSchema } from "../types/index.js";
import {
  createDefaultConfig,
  findLatestGGUF,
  findUnknownConfigKeys,
  resolveContextMessage,
} from "./config.js";

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

// ── findLatestGGUF ────────────────────────────────────────────────────

const ORIG_CWD = process.cwd();
const GGUF_TEST_DIR = join(ORIG_CWD, ".test-config-spec");
const GGUF_MODELS_DIR = join(GGUF_TEST_DIR, ".nanotune", "models");

function setupGGUFTest() {
  rmSync(GGUF_TEST_DIR, { recursive: true, force: true });
  mkdirSync(GGUF_TEST_DIR, { recursive: true });
  process.chdir(GGUF_TEST_DIR);
}

function teardownGGUFTest() {
  process.chdir(ORIG_CWD);
  rmSync(GGUF_TEST_DIR, { recursive: true, force: true });
}

test.serial(
  "findLatestGGUF returns null when models directory is missing",
  (t) => {
    setupGGUFTest();
    try {
      t.is(findLatestGGUF(), null);
    } finally {
      teardownGGUFTest();
    }
  },
);

test.serial(
  "findLatestGGUF returns null when models directory is empty",
  (t) => {
    setupGGUFTest();
    try {
      mkdirSync(GGUF_MODELS_DIR, { recursive: true });
      t.is(findLatestGGUF(), null);
    } finally {
      teardownGGUFTest();
    }
  },
);

test.serial(
  "findLatestGGUF returns null when models directory has no .gguf files",
  (t) => {
    setupGGUFTest();
    try {
      mkdirSync(GGUF_MODELS_DIR, { recursive: true });
      writeFileSync(join(GGUF_MODELS_DIR, "readme.txt"), "not a gguf");
      t.is(findLatestGGUF(), null);
    } finally {
      teardownGGUFTest();
    }
  },
);

test.serial(
  "findLatestGGUF returns the .gguf file with the newest mtime",
  (t) => {
    setupGGUFTest();
    try {
      mkdirSync(GGUF_MODELS_DIR, { recursive: true });
      const older = join(GGUF_MODELS_DIR, "old.gguf");
      const newer = join(GGUF_MODELS_DIR, "new.gguf");
      writeFileSync(older, "stub");
      writeFileSync(newer, "stub");

      // Force older to have an earlier mtime.
      const past = new Date(Date.now() - 60_000);
      utimesSync(older, past, past);

      t.is(findLatestGGUF(), newer);
    } finally {
      teardownGGUFTest();
    }
  },
);

test.serial("findLatestGGUF ignores non-.gguf siblings", (t) => {
  setupGGUFTest();
  try {
    mkdirSync(GGUF_MODELS_DIR, { recursive: true });
    const ggufFile = join(GGUF_MODELS_DIR, "model.gguf");
    const sidecar = join(GGUF_MODELS_DIR, "model.json");
    writeFileSync(ggufFile, "stub");
    writeFileSync(sidecar, "{}");

    // Make the .json *newer* so a naive impl that returned the newest file
    // regardless of extension would pick it. The GGUF should still win.
    const past = new Date(Date.now() - 60_000);
    utimesSync(ggufFile, past, past);

    t.is(findLatestGGUF(), ggufFile);
  } finally {
    teardownGGUFTest();
  }
});


// ── findUnknownConfigKeys ─────────────────────────────────────────────

const KNOWN_KEYS_CONFIG = {
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

test("findUnknownConfigKeys returns nothing for a valid config", (t) => {
  t.deepEqual(findUnknownConfigKeys(KNOWN_KEYS_CONFIG), []);
});

test("findUnknownConfigKeys names an unknown nested key and suggests the closest field", (t) => {
  const warnings = findUnknownConfigKeys({
    ...KNOWN_KEYS_CONFIG,
    training: { ...KNOWN_KEYS_CONFIG.training, loraLayers: 16 },
  });

  t.deepEqual(warnings, [
    'unknown key "training.loraLayers" in config.json — ignored. Did you mean "numLayers"?',
  ]);
});

test("findUnknownConfigKeys omits the suggestion when no valid field is close", (t) => {
  const warnings = findUnknownConfigKeys({
    ...KNOWN_KEYS_CONFIG,
    training: { ...KNOWN_KEYS_CONFIG.training, loraRank: 8 },
  });

  t.deepEqual(warnings, [
    'unknown key "training.loraRank" in config.json — ignored.',
  ]);
});

test("findUnknownConfigKeys names unknown top-level keys", (t) => {
  const warnings = findUnknownConfigKeys({
    ...KNOWN_KEYS_CONFIG,
    basemodel: "Qwen/Qwen2.5-Coder-0.5B-Instruct",
  });

  t.deepEqual(warnings, [
    'unknown key "basemodel" in config.json — ignored. Did you mean "baseModel"?',
  ]);
});

test("findUnknownConfigKeys walks every nested object", (t) => {
  const warnings = findUnknownConfigKeys({
    ...KNOWN_KEYS_CONFIG,
    contextMessage: { ...KNOWN_KEYS_CONFIG.contextMessage, text: "legacy" },
    export: { ...KNOWN_KEYS_CONFIG.export, outputname: "test" },
  });

  t.deepEqual(warnings, [
    'unknown key "contextMessage.text" in config.json — ignored.',
    'unknown key "export.outputname" in config.json — ignored. Did you mean "outputName"?',
  ]);
});

test("findUnknownConfigKeys reports every unknown key", (t) => {
  const warnings = findUnknownConfigKeys({
    ...KNOWN_KEYS_CONFIG,
    training: { ...KNOWN_KEYS_CONFIG.training, loraLayers: 16, loraRank: 8 },
  });

  t.is(warnings.length, 2);
});

test("findUnknownConfigKeys ignores a config that is not an object", (t) => {
  t.deepEqual(findUnknownConfigKeys(null), []);
  t.deepEqual(findUnknownConfigKeys([1, 2, 3]), []);
});

test("ConfigSchema still loads a config with unknown keys", (t) => {
  const config = ConfigSchema.parse({
    ...KNOWN_KEYS_CONFIG,
    training: { ...KNOWN_KEYS_CONFIG.training, loraLayers: 8 },
  });

  t.is(config.name, "test-project");
  t.is(config.training.numLayers, 16);
});
