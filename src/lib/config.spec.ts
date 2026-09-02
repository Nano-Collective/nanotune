import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "ava";
import { ConfigSchema, TrainingConfigSchema } from "../types/index.js";
import {
  createDefaultConfig,
  ensureBenchmarksDir,
  findLatestGGUF,
  formatConfigIssues,
  listBenchmarks,
  resolveBenchmarkPath,
  findUnknownConfigKeys,
  loadConfig,
  resolveContextMessage,
  tryLoadConfig,
  writeFileAtomic,
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

test("TrainingConfigSchema rejects a non-positive loraRank", (t) => {
  const result = TrainingConfigSchema.safeParse({ loraRank: 0 });
  t.false(result.success);
});

test("TrainingConfigSchema rejects a negative valBatches", (t) => {
  const result = TrainingConfigSchema.safeParse({ valBatches: -1 });
  t.false(result.success);
});

test("TrainingConfigSchema rejects loraDropout of 1 or more", (t) => {
  t.false(TrainingConfigSchema.safeParse({ loraDropout: 1 }).success);
  t.true(TrainingConfigSchema.safeParse({ loraDropout: 0.99 }).success);
});

test("TrainingConfigSchema rejects an unknown fineTuneType", (t) => {
  const result = TrainingConfigSchema.safeParse({ fineTuneType: "bogus" });
  t.false(result.success);
});

test("formatConfigIssues names the offending path instead of dumping JSON", (t) => {
  const result = ConfigSchema.safeParse({
    name: "p",
    baseModel: "m",
    systemPrompt: "s",
    training: { loraRank: -4 },
    export: { outputName: "o" },
  });
  t.false(result.success);
  if (result.success) return;

  const message = formatConfigIssues(result.error);
  t.true(message.startsWith("Invalid config.json:"));
  t.regex(message, /training\.loraRank: .*>0/);
  // The raw ZodError message is a serialised issue array; that is the thing
  // this exists to avoid putting in front of a user.
  t.false(message.includes('"code"'));
});

test("TrainingConfigSchema rejects fractional counts", (t) => {
  // mlx_lm indexes and slices with these, so a float dies inside Python with
  // an opaque error instead of here with the field name attached.
  t.false(TrainingConfigSchema.safeParse({ loraRank: 2.5 }).success);
  t.false(TrainingConfigSchema.safeParse({ maxSeqLength: 1024.5 }).success);
  t.false(TrainingConfigSchema.safeParse({ valBatches: 2.5 }).success);
  t.false(TrainingConfigSchema.safeParse({ seed: 3.7 }).success);
});

test("TrainingConfigSchema still allows fractional loraAlpha and loraDropout", (t) => {
  const result = TrainingConfigSchema.safeParse({
    loraAlpha: 20.5,
    loraDropout: 0.05,
  });
  t.true(result.success);
});

test("TrainingConfigSchema rejects NaN from an unparseable flag", (t) => {
  // What `--lora-rank abc` becomes by the time it reaches validation.
  t.false(TrainingConfigSchema.safeParse({ loraRank: Number.NaN }).success);
  t.false(TrainingConfigSchema.safeParse({ iterations: Number.NaN }).success);
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
  t.is(config.training.fineTuneType, "lora");
  t.is(config.training.loraRank, 8);
  t.is(config.training.loraAlpha, 20);
  t.is(config.training.loraDropout, 0);
  t.is(config.training.maxSeqLength, 2048);
  t.is(config.training.gradCheckpoint, false);
  t.is(config.training.valBatches, 25);
  t.is(config.training.seed, 0);
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
      fineTuneType: "lora" as const,
      loraRank: 8,
      loraAlpha: 20,
      loraDropout: 0,
      maxSeqLength: 2048,
      gradCheckpoint: false,
      valBatches: 25,
      seed: 0,
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
      fineTuneType: "lora" as const,
      loraRank: 8,
      loraAlpha: 20,
      loraDropout: 0,
      maxSeqLength: 2048,
      gradCheckpoint: false,
      valBatches: 25,
      seed: 0,
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

// ── listBenchmarks / resolveBenchmarkPath ────────────────────────────

const BENCH_TEST_DIR = join(ORIG_CWD, ".test-config-benchmarks");
const BENCH_DIR = join(BENCH_TEST_DIR, ".nanotune", "benchmarks");

function setupBenchTest() {
  rmSync(BENCH_TEST_DIR, { recursive: true, force: true });
  mkdirSync(BENCH_TEST_DIR, { recursive: true });
  process.chdir(BENCH_TEST_DIR);
}

function teardownBenchTest() {
  process.chdir(ORIG_CWD);
  rmSync(BENCH_TEST_DIR, { recursive: true, force: true });
}

test.serial("listBenchmarks returns an empty array when the benchmarks directory is missing", (t) => {
  setupBenchTest();
  try {
    t.deepEqual(listBenchmarks(), []);
  } finally {
    teardownBenchTest();
  }
});

test.serial("listBenchmarks sorts by mtime, not filename, and ignores compare-* files", (t) => {
  setupBenchTest();
  try {
    mkdirSync(BENCH_DIR, { recursive: true });
    // Deliberately give the lexicographically-later filename the older mtime,
    // so a naive filename sort would get this backwards.
    const older = join(BENCH_DIR, "benchmark-z-older.json");
    const newer = join(BENCH_DIR, "benchmark-a-newer.json");
    const compareFile = join(BENCH_DIR, "compare-should-be-excluded.json");
    writeFileSync(older, "{}");
    writeFileSync(newer, "{}");
    writeFileSync(compareFile, "{}");

    const past = new Date(Date.now() - 60_000);
    utimesSync(older, past, past);

    const listed = listBenchmarks();
    t.is(listed.length, 2);
    t.is(listed[0].filename, "benchmark-a-newer.json");
    t.is(listed[1].filename, "benchmark-z-older.json");
  } finally {
    teardownBenchTest();
  }
});

test.serial("resolveBenchmarkPath resolves a literal path", (t) => {
  setupBenchTest();
  try {
    mkdirSync(BENCH_DIR, { recursive: true });
    const literal = join(BENCH_DIR, "benchmark-literal.json");
    writeFileSync(literal, "{}");
    t.is(resolveBenchmarkPath(literal), literal);
  } finally {
    teardownBenchTest();
  }
});

test.serial("resolveBenchmarkPath resolves a bare filename under the benchmarks dir", (t) => {
  setupBenchTest();
  try {
    mkdirSync(BENCH_DIR, { recursive: true });
    const target = join(BENCH_DIR, "benchmark-bare.json");
    writeFileSync(target, "{}");
    t.is(resolveBenchmarkPath("benchmark-bare.json"), target);
  } finally {
    teardownBenchTest();
  }
});

test.serial("resolveBenchmarkPath appends .json when missing", (t) => {
  setupBenchTest();
  try {
    mkdirSync(BENCH_DIR, { recursive: true });
    const target = join(BENCH_DIR, "benchmark-noext.json");
    writeFileSync(target, "{}");
    t.is(resolveBenchmarkPath("benchmark-noext"), target);
  } finally {
    teardownBenchTest();
  }
});

test.serial("resolveBenchmarkPath resolves a bare timestamp via the benchmark- prefix", (t) => {
  setupBenchTest();
  try {
    mkdirSync(BENCH_DIR, { recursive: true });
    const target = join(BENCH_DIR, "benchmark-2026-01-01T00-00-00-000Z.json");
    writeFileSync(target, "{}");
    t.is(
      resolveBenchmarkPath("2026-01-01T00-00-00-000Z"),
      target,
    );
  } finally {
    teardownBenchTest();
  }
});

test.serial("resolveBenchmarkPath throws with the list of available runs when nothing matches", (t) => {
  setupBenchTest();
  try {
    mkdirSync(BENCH_DIR, { recursive: true });
    const existing = join(BENCH_DIR, "benchmark-exists.json");
    writeFileSync(existing, "{}");

    const err = t.throws(() => resolveBenchmarkPath("does-not-exist"));
    t.truthy(err);
    t.true(err?.message.includes("benchmark-exists.json"));
  } finally {
    teardownBenchTest();
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
    training: { ...KNOWN_KEYS_CONFIG.training, optimizer: "adamw" },
  });

  t.deepEqual(warnings, [
    'unknown key "training.optimizer" in config.json — ignored.',
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
    training: {
      ...KNOWN_KEYS_CONFIG.training,
      loraLayers: 16,
      optimizer: "adamw",
    },
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

test("findUnknownConfigKeys reports keys that shadow Object.prototype", (t) => {
  const warnings = findUnknownConfigKeys({
    ...KNOWN_KEYS_CONFIG,
    training: { ...KNOWN_KEYS_CONFIG.training, toString: "noop" },
  });

  t.deepEqual(warnings, [
    'unknown key "training.toString" in config.json — ignored.',
  ]);
});

test("findUnknownConfigKeys reports a __proto__ key parsed out of JSON", (t) => {
  // JSON.parse gives __proto__ an own enumerable slot; a literal would not.
  const raw = JSON.parse(
    `{"__proto__": {"polluted": true}, ${JSON.stringify(KNOWN_KEYS_CONFIG).slice(1)}`,
  );

  t.deepEqual(findUnknownConfigKeys(raw), [
    'unknown key "__proto__" in config.json — ignored.',
  ]);
});

// ── loadConfig warnings ───────────────────────────────────────────────

const WARN_TEST_DIR = join(ORIG_CWD, ".test-config-warnings");

test.serial("loadConfig prints each unknown key once across loads", (t) => {
  rmSync(WARN_TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(WARN_TEST_DIR, ".nanotune"), { recursive: true });
  writeFileSync(
    join(WARN_TEST_DIR, ".nanotune", "config.json"),
    JSON.stringify({
      ...KNOWN_KEYS_CONFIG,
      training: { ...KNOWN_KEYS_CONFIG.training, loraLayers: 32 },
    }),
  );
  process.chdir(WARN_TEST_DIR);

  const printed: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    printed.push(args.join(" "));
  };

  try {
    const first = loadConfig();
    // A second load must not repeat the warning — warnedKeys dedupes it.
    const second = loadConfig();

    t.deepEqual(printed, [
      'Warning: unknown key "training.loraLayers" in config.json — ignored. Did you mean "numLayers"?',
    ]);
    t.false("loraLayers" in first.training);
    t.is(second.training.numLayers, 16);
  } finally {
    console.warn = originalWarn;
    process.chdir(ORIG_CWD);
    rmSync(WARN_TEST_DIR, { recursive: true, force: true });
  }
});


// ── malformed config.json ─────────────────────────────────────────────

const BAD_CONFIG_DIR = join(ORIG_CWD, ".test-config-malformed");

function withBadConfig(contents: string, run: () => void) {
  rmSync(BAD_CONFIG_DIR, { recursive: true, force: true });
  mkdirSync(join(BAD_CONFIG_DIR, ".nanotune"), { recursive: true });
  if (contents) {
    writeFileSync(join(BAD_CONFIG_DIR, ".nanotune", "config.json"), contents);
  }
  process.chdir(BAD_CONFIG_DIR);
  try {
    run();
  } finally {
    process.chdir(ORIG_CWD);
    rmSync(BAD_CONFIG_DIR, { recursive: true, force: true });
  }
}

test.serial("loadConfig names the file when it is not valid JSON", (t) => {
  withBadConfig('{"name":"v","baseMod', () => {
    const err = t.throws(() => loadConfig());
    // The bare parser message ("Unterminated string in JSON at position 20")
    // names neither the file nor the command that ran into it.
    t.true(err?.message.startsWith("Invalid config.json: not valid JSON"));
  });
});

test.serial("tryLoadConfig reports malformed JSON instead of throwing", (t) => {
  withBadConfig('{"name":"v","baseMod', () => {
    const { config, error } = tryLoadConfig();
    t.is(config, null);
    t.true(error?.startsWith("Invalid config.json: not valid JSON"));
  });
});

test.serial("tryLoadConfig reports a schema-invalid config", (t) => {
  withBadConfig(JSON.stringify({ name: "v", version: "1.0.0" }), () => {
    const { config, error } = tryLoadConfig();
    t.is(config, null);
    t.true(error?.includes("baseModel"));
  });
});

test.serial("tryLoadConfig reports a missing project", (t) => {
  withBadConfig("", () => {
    const { config, error } = tryLoadConfig();
    t.is(config, null);
    t.is(error, "Not a Nanotune project. Run `nanotune init` first.");
  });
});

test.serial("tryLoadConfig returns the config when it is valid", (t) => {
  withBadConfig(JSON.stringify(KNOWN_KEYS_CONFIG), () => {
    const { config, error } = tryLoadConfig();
    t.is(error, null);
    t.is(config?.name, KNOWN_KEYS_CONFIG.name);
  });
});

// ── ensureBenchmarksDir ───────────────────────────────────────────────
//
// setupBenchTest leaves a project with no benchmarks directory — exactly the
// state `git clone` produces, since .nanotune/.gitignore lists benchmarks/ and
// only `nanotune init` ever creates it.

test.serial("ensureBenchmarksDir creates the directory when it is missing", (t) => {
  setupBenchTest();
  try {
    t.false(existsSync(BENCH_DIR));
    const dir = ensureBenchmarksDir();
    t.is(dir, BENCH_DIR);
    t.true(existsSync(dir));
  } finally {
    teardownBenchTest();
  }
});

test.serial("ensureBenchmarksDir leaves an existing directory and its contents alone", (t) => {
  setupBenchTest();
  try {
    mkdirSync(BENCH_DIR, { recursive: true });
    writeFileSync(join(BENCH_DIR, "tests.json"), "[]");

    t.is(ensureBenchmarksDir(), BENCH_DIR);
    t.is(readFileSync(join(BENCH_DIR, "tests.json"), "utf-8"), "[]");
  } finally {
    teardownBenchTest();
  }
});

test.serial("results saved into a cloned project are discoverable afterwards", (t) => {
  setupBenchTest();
  try {
    // The tail of a real run: both reports land under a benchmarks directory
    // the clone never had, and `benchmark compare` still finds them there.
    const dir = ensureBenchmarksDir();
    const resultPath = join(dir, "benchmark-2026-01-01T00-00-00-000Z.json");
    writeFileAtomic(resultPath, JSON.stringify({ summary: { total: 2 } }));
    writeFileAtomic(resultPath.replace(".json", ".md"), "# Benchmark Report");

    t.deepEqual(
      listBenchmarks().map((b) => b.filename),
      ["benchmark-2026-01-01T00-00-00-000Z.json"],
    );
    t.is(resolveBenchmarkPath("2026-01-01T00-00-00-000Z"), resultPath);
  } finally {
    teardownBenchTest();
  }
});

// ── writeFileAtomic ───────────────────────────────────────────────────

test.serial("writeFileAtomic writes the contents and leaves no temp file behind", (t) => {
  setupBenchTest();
  try {
    const dir = ensureBenchmarksDir();
    const path = join(dir, "report.md");
    writeFileAtomic(path, "# Benchmark Report");

    t.is(readFileSync(path, "utf-8"), "# Benchmark Report");
    t.deepEqual(readdirSync(dir), ["report.md"]);
  } finally {
    teardownBenchTest();
  }
});

test.serial("writeFileAtomic replaces an existing file", (t) => {
  setupBenchTest();
  try {
    const dir = ensureBenchmarksDir();
    const path = join(dir, "tests.json");
    writeFileAtomic(path, "[1]");
    writeFileAtomic(path, "[1,2]");

    t.is(readFileSync(path, "utf-8"), "[1,2]");
    t.deepEqual(readdirSync(dir), ["tests.json"]);
  } finally {
    teardownBenchTest();
  }
});

test.serial("writeFileAtomic cleans up its temp file when the rename fails", (t) => {
  setupBenchTest();
  try {
    const dir = ensureBenchmarksDir();
    // Renaming onto a non-empty directory fails, so the write never lands.
    // The point is that it leaves no half-written sibling behind either — a
    // stray temp is how a partial write gets mistaken for a finished run.
    const blocked = join(dir, "blocked");
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, "keep.txt"), "keep");

    t.throws(() => writeFileAtomic(blocked, "should not land"));
    t.deepEqual(readdirSync(dir), ["blocked"]);
    t.is(readFileSync(join(blocked, "keep.txt"), "utf-8"), "keep");
  } finally {
    teardownBenchTest();
  }
});

test.serial("writeFileAtomic surfaces a missing parent rather than inventing one", (t) => {
  setupBenchTest();
  try {
    // `--dataset` can point anywhere, so a typo'd path must still fail loudly
    // instead of quietly creating directories outside the project.
    const missing = join(BENCH_TEST_DIR, "nope", "tests.json");
    t.throws(() => writeFileAtomic(missing, "[]"), { code: "ENOENT" });
    t.false(existsSync(join(BENCH_TEST_DIR, "nope")));
  } finally {
    teardownBenchTest();
  }
});
