import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "ava";
import type { BenchmarkTest, BenchmarkTestResult } from "../types/index.js";
import {
  type BenchmarkRunOptions,
  type CategoryResult,
  formatEventForStderr,
  resolveRunOptions,
  runBenchmark,
  summarizeResults,
  validateTests,
} from "./benchmark-run.js";

const SAMPLING = { temperature: 0.7, seed: 42 };

// ── resolveRunOptions ─────────────────────────────────────────────────

test("resolveRunOptions parses individual flags and applies defaults", (t) => {
  const { serverOptions, generateOptions } = resolveRunOptions(
    { threads: "6", gpuLayers: "12" },
    SAMPLING,
  );

  t.is(serverOptions.threads, 6);
  t.is(serverOptions.gpuLayers, 12);
  t.is(serverOptions.ctxSize, 4096);
  t.is(serverOptions.batchSize, 2048);
  t.is(generateOptions.maxTokens, 50);
});

test("resolveRunOptions leaves threads and gpuLayers undefined when unset", (t) => {
  const { serverOptions } = resolveRunOptions({}, SAMPLING);

  // undefined means "let llama-server decide", which is not the same as 0.
  t.is(serverOptions.threads, undefined);
  t.is(serverOptions.gpuLayers, undefined);
});

test("resolveRunOptions threads sampling temperature and seed through", (t) => {
  const { generateOptions } = resolveRunOptions({}, SAMPLING);

  t.is(generateOptions.temperature, 0.7);
  t.is(generateOptions.seed, 42);
});

test("resolveRunOptions applies a preset instead of the individual flags", (t) => {
  const { serverOptions, generateOptions } = resolveRunOptions(
    { preset: "low", threads: "99", ctxSize: "99999" },
    SAMPLING,
  );

  // The preset replaces the individual flags wholesale rather than merging.
  t.is(serverOptions.threads, 4);
  t.is(serverOptions.ctxSize, 2048);
  t.is(generateOptions.maxTokens, 128);
});

test("resolveRunOptions marks the low preset as CPU only", (t) => {
  const { serverOptions } = resolveRunOptions({ preset: "low" }, SAMPLING);

  t.is(serverOptions.gpuLayers, 0);
  t.true(serverOptions.cpuOnly);
});

test("resolveRunOptions leaves the high preset on auto and not CPU only", (t) => {
  const { serverOptions } = resolveRunOptions({ preset: "high" }, SAMPLING);

  t.is(serverOptions.gpuLayers, undefined);
  t.false(serverOptions.cpuOnly);
});

test("resolveRunOptions rejects an unknown preset and lists the valid ones", (t) => {
  const error = t.throws(() =>
    resolveRunOptions({ preset: "turbo" }, SAMPLING),
  );

  t.true(error?.message.includes("turbo"));
  t.true(error?.message.includes("low, medium, high, ultra"));
});

// ── validateTests ─────────────────────────────────────────────────────

test("validateTests accepts a single-turn prompt test", (t) => {
  t.notThrows(() =>
    validateTests([{ id: 1, prompt: "hi", category: "basic" }]),
  );
});

test("validateTests accepts a multi-turn messages test", (t) => {
  t.notThrows(() =>
    validateTests([
      {
        id: 1,
        messages: [{ role: "user", content: "hi" }],
        category: "basic",
      },
    ]),
  );
});

test("validateTests names the test that has neither prompt nor messages", (t) => {
  const tests: BenchmarkTest[] = [
    { id: 1, prompt: "ok", category: "basic" },
    { id: 7, category: "basic" },
  ];

  const error = t.throws(() => validateTests(tests));

  t.true(error?.message.includes("#7"));
});

test("validateTests rejects an empty messages array", (t) => {
  const error = t.throws(() =>
    validateTests([{ id: 2, messages: [], category: "basic" }]),
  );

  t.true(error?.message.includes("#2"));
});

// ── summarizeResults ──────────────────────────────────────────────────

function result(over: Partial<BenchmarkTestResult> = {}): BenchmarkTestResult {
  return {
    id: 1,
    prompt: "p",
    expected: [],
    actual: "ok",
    passed: true,
    category: "basic",
    ...over,
  };
}

test("summarizeResults totals passes from the category counts", (t) => {
  const categories: Record<string, CategoryResult> = {
    basic: { passed: 3, total: 4 },
    hard: { passed: 1, total: 2 },
  };

  const summary = summarizeResults(
    [result(), result(), result(), result(), result(), result()],
    categories,
  );

  t.is(summary.total, 6);
  t.is(summary.passed, 4);
  t.is(summary.failed, 2);
});

test("summarizeResults scores an aborted run against the tests that ran", (t) => {
  // The dataset had 50 tests; the server died after 4. Scoring against 50
  // would read as a catastrophic regression rather than a partial run.
  const summary = summarizeResults([result(), result(), result(), result()], {
    basic: { passed: 3, total: 4 },
  });

  t.is(summary.total, 4);
  t.is(summary.passRate, 0.75);
});

test("summarizeResults averages latency, tok/s and TTFT", (t) => {
  const summary = summarizeResults(
    [
      result({ latencyMs: 100, tokensPerSecond: 10, ttftMs: 20 }),
      result({ latencyMs: 200, tokensPerSecond: 20, ttftMs: 40 }),
    ],
    { basic: { passed: 2, total: 2 } },
  );

  t.is(summary.avgLatencyMs, 150);
  t.is(summary.avgTokensPerSecond, 15);
  t.is(summary.avgTtftMs, 30);
});

test("summarizeResults excludes errored tests from the timing averages", (t) => {
  const summary = summarizeResults(
    [
      result({ latencyMs: 100, ttftMs: 10 }),
      // A timeout's latency is how long we waited before giving up, not the
      // model's speed — including it would poison the average.
      result({ actual: "Error: timeout", latencyMs: 30000, ttftMs: 30000 }),
    ],
    { basic: { passed: 1, total: 2 } },
  );

  t.is(summary.avgLatencyMs, 100);
  t.is(summary.avgTtftMs, 10);
});

test("summarizeResults rounds tokens per second to two decimals", (t) => {
  const summary = summarizeResults(
    [
      result({ tokensPerSecond: 10 }),
      result({ tokensPerSecond: 11 }),
      result({ tokensPerSecond: 13 }),
    ],
    { basic: { passed: 3, total: 3 } },
  );

  t.is(summary.avgTokensPerSecond, 11.33);
});

test("summarizeResults leaves averages undefined when nothing reported them", (t) => {
  const summary = summarizeResults([result()], {
    basic: { passed: 1, total: 1 },
  });

  t.is(summary.avgLatencyMs, undefined);
  t.is(summary.avgTokensPerSecond, undefined);
  t.is(summary.avgTtftMs, undefined);
  t.is(summary.avgJudgeScore, undefined);
});

test("summarizeResults averages judge scores to one decimal", (t) => {
  const summary = summarizeResults(
    [
      result({ judgeScore: 8 }),
      result({ judgeScore: 7 }),
      result({ judgeScore: 6 }),
      result(),
    ],
    { basic: { passed: 3, total: 4 } },
  );

  t.is(summary.avgJudgeScore, 7);
});

test("summarizeResults keeps errored tests in the judge average", (t) => {
  // A judge that scored a failed response still produced a real score.
  const summary = summarizeResults(
    [result({ judgeScore: 8 }), result({ actual: "Error: x", judgeScore: 2 })],
    { basic: { passed: 1, total: 2 } },
  );

  t.is(summary.avgJudgeScore, 5);
});

test("summarizeResults records the judge model when one was used", (t) => {
  const summary = summarizeResults([result()], {}, "openai/gpt-4o-mini");

  t.is(summary.judgeModel, "openai/gpt-4o-mini");
});

// ── formatEventForStderr ──────────────────────────────────────────────

test("formatEventForStderr passes prep and warning messages through", (t) => {
  t.is(
    formatEventForStderr({ type: "prep", message: "Installing llama.cpp..." }),
    "Installing llama.cpp...",
  );
  t.is(
    formatEventForStderr({ type: "warning", message: "server died" }),
    "server died",
  );
});

test("formatEventForStderr numbers tests from one", (t) => {
  t.is(
    formatEventForStderr({
      type: "test-start",
      index: 0,
      total: 50,
      prompt: "list all files",
    }),
    "[1/50] list all files",
  );
});

test("formatEventForStderr returns null for events with no progress line", (t) => {
  t.is(formatEventForStderr({ type: "test-end", categories: {} }), null);
});

// ── runBenchmark: failure paths reached before llama-server starts ─────

const ORIG_CWD = process.cwd();
const TEST_DIR = join(ORIG_CWD, ".test-benchmark-run-spec");
const NANOTUNE_DIR = join(TEST_DIR, ".nanotune");
const MODELS_DIR = join(NANOTUNE_DIR, "models");
const BENCHMARKS_DIR = join(NANOTUNE_DIR, "benchmarks");

const CONFIG = {
  name: "test-project",
  version: "1.0.0",
  baseModel: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
  contextMessage: { role: "system", content: "You are helpful." },
  training: {},
  export: { quantization: "q4_k_m", outputName: "test" },
};

/** Drive the generator far enough to reach whichever guard fires first. */
async function drain(options: BenchmarkRunOptions): Promise<void> {
  for await (const event of runBenchmark(options)) {
    void event;
  }
}

test.beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(MODELS_DIR, { recursive: true });
  mkdirSync(BENCHMARKS_DIR, { recursive: true });
  writeFileSync(
    join(NANOTUNE_DIR, "config.json"),
    JSON.stringify(CONFIG, null, 2),
  );
  process.chdir(TEST_DIR);
});

test.afterEach.always(() => {
  process.chdir(ORIG_CWD);
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test.serial("runBenchmark throws the init hint outside a project", async (t) => {
  rmSync(join(NANOTUNE_DIR, "config.json"));

  const error = await t.throwsAsync(() => drain({}));

  t.true(error?.message.includes("Not a Nanotune project"));
});

test.serial("runBenchmark rejects --model together with --base", async (t) => {
  const error = await t.throwsAsync(() =>
    drain({ model: "x.gguf", base: true }),
  );

  t.true(error?.message.includes("mutually exclusive"));
});

test.serial("runBenchmark rejects a mistyped --samples", async (t) => {
  const error = await t.throwsAsync(() => drain({ samples: "abc" }));

  t.true(error?.message.includes("--samples"));
});

test.serial("runBenchmark rejects --samples above 1 at temperature 0", async (t) => {
  // Greedy decoding produces identical outputs, so sampling would measure
  // nothing at all.
  const error = await t.throwsAsync(() =>
    drain({ samples: "5", temperature: "0" }),
  );

  t.true(error?.message.includes("temperature 0"));
});

test.serial("runBenchmark rejects an unknown preset before resolving a model", async (t) => {
  // No GGUF exists here — reaching the preset error proves it is checked
  // before the expensive model resolution.
  const error = await t.throwsAsync(() => drain({ preset: "turbo" }));

  t.true(error?.message.includes("Invalid preset"));
});

test.serial("runBenchmark reports when there is no exported model", async (t) => {
  const error = await t.throwsAsync(() => drain({}));

  t.true(error?.message.includes("nanotune export"));
});

test.serial("runBenchmark reports a --model path that does not exist", async (t) => {
  const error = await t.throwsAsync(() => drain({ model: "nope.gguf" }));

  t.true(error?.message.includes("Model not found"));
});

test.serial("runBenchmark writes a starter dataset when none exists", async (t) => {
  const modelPath = join(MODELS_DIR, "test.gguf");
  writeFileSync(modelPath, "gguf");

  const error = await t.throwsAsync(() => drain({ model: modelPath }));

  t.true(error?.message.includes("Created sample at"));
  // Leaving a runnable starting point behind is the point of the error.
  t.true(existsSync(join(BENCHMARKS_DIR, "tests.json")));
});

test.serial("runBenchmark rejects a dataset test with neither prompt nor messages", async (t) => {
  const modelPath = join(MODELS_DIR, "test.gguf");
  writeFileSync(modelPath, "gguf");
  writeFileSync(
    join(BENCHMARKS_DIR, "tests.json"),
    JSON.stringify([{ id: 3, category: "basic" }]),
  );

  const error = await t.throwsAsync(() => drain({ model: modelPath }));

  t.true(error?.message.includes("#3"));
});

test.serial("runBenchmark requires a judge when a test uses llm-judge", async (t) => {
  const modelPath = join(MODELS_DIR, "test.gguf");
  writeFileSync(modelPath, "gguf");
  writeFileSync(
    join(BENCHMARKS_DIR, "tests.json"),
    JSON.stringify([
      { id: 1, prompt: "hi", category: "basic", match: "llm-judge" },
    ]),
  );

  const error = await t.throwsAsync(() => drain({ model: modelPath }));

  t.true(error?.message.includes("judge configure"));
});
