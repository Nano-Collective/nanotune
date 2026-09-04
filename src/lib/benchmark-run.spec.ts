import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "ava";
import type {
  BenchmarkResult,
  BenchmarkTest,
  BenchmarkTestResult,
} from "../types/index.js";
import {
  type BenchmarkRunOptions,
  type CategoryResult,
  formatEventForStderr,
  generateMarkdownReport,
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

// ── generateMarkdownReport ────────────────────────────────────────────

const CONTEXT = { role: "system", content: "You are helpful." };

function report(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    model: "/models/my-bot-q4_k_m.gguf",
    timestamp: "2026-09-03T19:40:02.113Z",
    summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 },
    categories: { basic: { passed: 1, total: 2 } },
    results: [],
    failures: [],
    ...over,
  };
}

test("generateMarkdownReport heads the report with the model and run type", (t) => {
  const md = generateMarkdownReport(report({ isBase: true }), CONTEXT);

  t.true(md.startsWith("# Benchmark Report"));
  // Only the basename — the full path is noise in a shared report.
  t.true(md.includes("**Model:** my-bot-q4_k_m.gguf"));
  t.true(md.includes("Base model (control)"));
});

test("generateMarkdownReport labels a fine-tuned run", (t) => {
  const md = generateMarkdownReport(report(), CONTEXT);

  t.true(md.includes("**Run Type:** Fine-tuned"));
});

test("generateMarkdownReport calls out a run that stopped early", (t) => {
  const md = generateMarkdownReport(
    report({ warning: "llama-server exited after 4 of 50 tests" }),
    CONTEXT,
  );

  t.true(md.includes("**Incomplete run:**"));
  t.true(md.includes("4 of 50 tests"));
});

test("generateMarkdownReport omits the incomplete notice on a clean run", (t) => {
  t.false(generateMarkdownReport(report(), CONTEXT).includes("Incomplete run"));
});

test("generateMarkdownReport records the sampling configuration", (t) => {
  const md = generateMarkdownReport(
    report({ config: { temperature: 0.8, seed: 7, samples: 5 } }),
    CONTEXT,
  );

  t.true(md.includes("- **Temperature:** 0.8"));
  t.true(md.includes("- **Seed:** 7"));
  t.true(md.includes("- **Samples per test:** 5"));
});

test("generateMarkdownReport omits the configuration section when absent", (t) => {
  t.false(generateMarkdownReport(report(), CONTEXT).includes("## Configuration"));
});

test("generateMarkdownReport reports the summary and per-category totals", (t) => {
  const md = generateMarkdownReport(
    report({
      summary: {
        total: 2,
        passed: 1,
        failed: 1,
        passRate: 0.5,
        avgLatencyMs: 120,
        avgTokensPerSecond: 42.5,
        avgTtftMs: 30,
        avgJudgeScore: 7.5,
        judgeModel: "openai/gpt-4o-mini",
      },
      categories: { basic: { passed: 1, total: 2 }, hard: { passed: 3, total: 3 } },
    }),
    CONTEXT,
  );

  t.true(md.includes("- **Pass Rate:** 50%"));
  t.true(md.includes("- **Avg Latency:** 120ms"));
  t.true(md.includes("- **Avg Tokens/sec:** 42.50"));
  t.true(md.includes("- **Avg TTFT:** 30ms"));
  t.true(md.includes("- **Avg Judge Score:** 7.5/10"));
  t.true(md.includes("- **Judge Model:** openai/gpt-4o-mini"));
  t.true(md.includes("- **basic:** 1/2 (50%)"));
  t.true(md.includes("- **hard:** 3/3 (100%)"));
});

test("generateMarkdownReport includes the context message and its role", (t) => {
  const md = generateMarkdownReport(report(), {
    role: "developer",
    content: "You are a code assistant.",
  });

  t.true(md.includes("## Context Message (developer)"));
  t.true(md.includes("You are a code assistant."));
});

test("generateMarkdownReport marks passing and failing tests", (t) => {
  const md = generateMarkdownReport(
    report({
      results: [
        result({ id: 1, prompt: "list files", passed: true }),
        result({ id: 2, prompt: "delete all", passed: false }),
      ],
    }),
    CONTEXT,
  );

  t.true(md.includes("### ✅ Test #1: list files"));
  t.true(md.includes("### ❌ Test #2: delete all"));
});

test("generateMarkdownReport writes a multi-turn test as a conversation", (t) => {
  const md = generateMarkdownReport(
    report({
      results: [
        result({
          id: 3,
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
          ],
        }),
      ],
    }),
    CONTEXT,
  );

  t.true(md.includes("Test #3: [2-msg conversation]"));
  t.true(md.includes("**Conversation:**"));
  t.true(md.includes("> **User:** hi"));
  t.true(md.includes("> **Assistant:** hello"));
});

test("generateMarkdownReport reports per-test timings and sampling stats", (t) => {
  const md = generateMarkdownReport(
    report({
      results: [
        result({
          latencyMs: 250,
          ttftMs: 40,
          generationTimeMs: 210,
          tokensGenerated: 33,
          tokensPerSecond: 15.5,
          samples: 5,
          samplePassRate: 0.6,
          sampleVariance: 0.24,
          expected: ["ls", "ls -la"],
        }),
      ],
    }),
    CONTEXT,
  );

  t.true(md.includes("**Total Latency:** 250ms"));
  t.true(md.includes("**Time to First Token:** 40ms"));
  t.true(md.includes("**Generation Time:** 210ms"));
  t.true(md.includes("**Tokens Generated:** 33"));
  t.true(md.includes("**Tokens/Second:** 15.50"));
  t.true(md.includes("**Samples:** 5"));
  t.true(md.includes("**Sample Pass Rate:** 60%"));
  t.true(md.includes("**Sample Variance:** 0.2400"));
  t.true(md.includes("- `ls -la`"));
});

test("generateMarkdownReport includes judge scores, criteria and reasoning", (t) => {
  const md = generateMarkdownReport(
    report({
      results: [
        result({
          judgeScore: 9,
          judgeCriteriaScores: { helpful: 9, accurate: 8 },
          judgeReasoning: "Answered directly.",
        }),
      ],
    }),
    CONTEXT,
  );

  t.true(md.includes("**Judge Score:** 9/10"));
  t.true(md.includes("- helpful: 9/10"));
  t.true(md.includes("- accurate: 8/10"));
  t.true(md.includes("**Judge Reasoning:** Answered directly."));
});

test("generateMarkdownReport tabulates failures and escapes the pipe separator", (t) => {
  const md = generateMarkdownReport(
    report({
      failures: [
        {
          id: 4,
          prompt: "list files",
          expected: ["ls", "ls -la"],
          actual: "rm -rf /\nsecond line",
        },
      ],
    }),
    CONTEXT,
  );

  t.true(md.includes("## Failed Tests Summary"));
  // A raw pipe would break the Markdown table.
  t.true(md.includes("ls \\| ls -la"));
  // Newlines are flattened so the row stays one line.
  t.true(md.includes("rm -rf / second line"));
});

test("generateMarkdownReport labels a multi-turn failure in the table", (t) => {
  const md = generateMarkdownReport(
    report({
      failures: [
        {
          id: 5,
          prompt: "unused",
          messages: [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
            { role: "user", content: "c" },
          ],
          expected: [],
          actual: "nope",
        },
      ],
    }),
    CONTEXT,
  );

  t.true(md.includes("| 5 | [3-msg conversation] |"));
});

test("generateMarkdownReport omits the failures table on a clean sweep", (t) => {
  t.false(
    generateMarkdownReport(report(), CONTEXT).includes("Failed Tests Summary"),
  );
});
