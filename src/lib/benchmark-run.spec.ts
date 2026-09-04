import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "ava";
import type { ServerHandle } from "./llama-cpp.js";
import type {
  BenchmarkResult,
  BenchmarkTest,
  BenchmarkTestResult,
  ChatMessage,
} from "../types/index.js";
import {
  type BenchmarkDeps,
  type BenchmarkEvent,
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

test("summarizeResults reports a zero pass rate for an empty run", (t) => {
  // 0/0 is NaN, which JSON.stringify writes as null — a documented `number`
  // field must not arrive as null.
  const summary = summarizeResults([], {});

  t.is(summary.passRate, 0);
  t.is(JSON.parse(JSON.stringify(summary)).passRate, 0);
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

// ── runBenchmark: the scoring loop, against a fake server ─────────────

interface FakeSpec {
  /** Text the fake model returns for call `n` (0-based). */
  respond?: (call: number) => string;
  /** Calls that should throw, as a timeout or transport failure would. */
  failCalls?: number[];
  /** Settle the server's `exited` promise after this many completions. */
  dieAfterCalls?: number;
  /** Judge verdict, when a test uses llm-judge. */
  judge?: (response: string) => { pass: boolean; score: number };
}

interface FakeLog {
  seeds: number[];
  prompts: string[];
  completions: number;
  stopped: number;
}

function makeDeps(spec: FakeSpec = {}): { deps: BenchmarkDeps; log: FakeLog } {
  const log: FakeLog = { seeds: [], prompts: [], completions: 0, stopped: 0 };
  let settleExited: () => void = () => {};
  const exited = new Promise<unknown>((resolve) => {
    settleExited = () => resolve(undefined);
  });

  const deps = {
    startLlamaServer: async () =>
      ({ port: 1234, process: {}, exited }) as unknown as ServerHandle,
    chatCompletion: async (
      _handle: unknown,
      messages: ChatMessage[],
      options: { seed?: number },
    ) => {
      const call = log.completions++;
      log.seeds.push(options.seed ?? -1);
      log.prompts.push(messages.at(-1)?.content ?? "");
      if (spec.dieAfterCalls !== undefined && call + 1 >= spec.dieAfterCalls) {
        settleExited();
      }
      if (spec.failCalls?.includes(call)) {
        throw new Error("timeout");
      }
      return {
        text: spec.respond ? spec.respond(call) : "ls",
        ttftMs: 10,
        generationTimeMs: 90,
        tokensGenerated: 20,
        tokensPerSecond: 22.2,
      };
    },
    stopLlamaServer: async () => {
      log.stopped++;
    },
    callJudge: async (_p: string, response: string) => {
      const verdict = spec.judge?.(response) ?? { pass: true, score: 9 };
      return {
        pass: verdict.pass,
        score: verdict.score,
        reasoning: "because",
        criteriaScores: { helpful: verdict.score },
      };
    },
  } as unknown as BenchmarkDeps;

  return { deps, log };
}

function writeDataset(tests: BenchmarkTest[]) {
  writeFileSync(join(BENCHMARKS_DIR, "tests.json"), JSON.stringify(tests));
}

function writeModel(): string {
  const path = join(MODELS_DIR, "test.gguf");
  writeFileSync(path, "gguf");
  return path;
}

/** Run to completion, returning the final result and every event seen. */
async function collect(
  options: BenchmarkRunOptions,
  deps: BenchmarkDeps,
): Promise<{ result: BenchmarkResult; events: BenchmarkEvent[] }> {
  const events: BenchmarkEvent[] = [];
  let result: BenchmarkResult | null = null;
  for await (const event of runBenchmark(options, deps)) {
    events.push(event);
    if (event.type === "done") {
      result = event.result;
    }
  }
  if (!result) {
    throw new Error("run produced no result");
  }
  return { result, events };
}

test.serial("runBenchmark scores matching responses as passes", async (t) => {
  const model = writeModel();
  writeDataset([
    { id: 1, prompt: "list files", acceptable: ["ls"], category: "basic" },
    { id: 2, prompt: "where am I", acceptable: ["pwd"], category: "nav" },
  ]);
  const { deps } = makeDeps({ respond: (n) => (n === 0 ? "ls" : "pwd") });

  const { result } = await collect({ model }, deps);

  t.is(result.summary.total, 2);
  t.is(result.summary.passed, 2);
  t.is(result.summary.passRate, 1);
  t.deepEqual(result.categories, {
    basic: { passed: 1, total: 1 },
    nav: { passed: 1, total: 1 },
  });
  t.deepEqual(result.failures, []);
});

test.serial("runBenchmark records a non-matching response as a failure", async (t) => {
  const model = writeModel();
  writeDataset([
    { id: 7, prompt: "list files", acceptable: ["ls"], category: "basic" },
  ]);
  const { deps } = makeDeps({ respond: () => "rm -rf /" });

  const { result } = await collect({ model }, deps);

  t.is(result.summary.passed, 0);
  t.is(result.failures.length, 1);
  t.is(result.failures[0].id, 7);
  t.deepEqual(result.failures[0].expected, ["ls"]);
  t.is(result.failures[0].actual, "rm -rf /");
});

test.serial("runBenchmark carries per-test timings onto the result", async (t) => {
  const model = writeModel();
  writeDataset([{ id: 1, prompt: "p", acceptable: ["ls"], category: "basic" }]);
  const { deps } = makeDeps();

  const { result } = await collect({ model }, deps);

  t.is(result.results[0].ttftMs, 10);
  t.is(result.results[0].generationTimeMs, 90);
  t.is(result.results[0].tokensGenerated, 20);
  t.is(result.results[0].tokensPerSecond, 22.2);
  t.is(result.summary.avgTokensPerSecond, 22.2);
});

test.serial("runBenchmark turns a timed-out call into a failed test, not a crash", async (t) => {
  const model = writeModel();
  writeDataset([{ id: 1, prompt: "p", acceptable: ["ls"], category: "basic" }]);
  const { deps } = makeDeps({ failCalls: [0] });

  const { result } = await collect({ model }, deps);

  t.false(result.results[0].passed);
  t.true(result.results[0].actual.startsWith("Error:"));
  // A timeout's latency is not the model's speed, so it is left out.
  t.is(result.summary.avgTokensPerSecond, undefined);
});

test.serial("runBenchmark varies the seed per sample and records the spread", async (t) => {
  const model = writeModel();
  writeDataset([{ id: 1, prompt: "p", acceptable: ["ls"], category: "basic" }]);
  // Two of three samples match, so this is a flaky test, not a clean pass.
  const { deps, log } = makeDeps({
    respond: (n) => (n === 1 ? "nope" : "ls"),
  });

  const { result } = await collect(
    { model, samples: "3", temperature: "0.8", seed: "100" },
    deps,
  );

  t.deepEqual(log.seeds, [100, 101, 102]);
  t.is(result.results[0].samples, 3);
  t.is(Math.round((result.results[0].samplePassRate ?? 0) * 100), 67);
  t.true((result.results[0].sampleVariance ?? 0) > 0);
});

test.serial("runBenchmark omits sampling stats on a single-sample run", async (t) => {
  const model = writeModel();
  writeDataset([{ id: 1, prompt: "p", acceptable: ["ls"], category: "basic" }]);
  const { deps } = makeDeps();

  const { result } = await collect({ model }, deps);

  t.is(result.results[0].samples, undefined);
  t.is(result.results[0].samplePassRate, undefined);
});

test.serial("runBenchmark scores an llm-judge test through the judge", async (t) => {
  writeFileSync(
    join(NANOTUNE_DIR, "judge.json"),
    JSON.stringify({
      name: "Fake",
      baseUrl: "https://example.invalid",
      model: "fake/judge-1",
    }),
  );
  const model = writeModel();
  writeDataset([
    { id: 1, prompt: "explain recursion", category: "open", match: "llm-judge" },
  ]);
  const { deps } = makeDeps({ judge: () => ({ pass: true, score: 8 }) });

  const { result } = await collect({ model }, deps);

  t.true(result.results[0].passed);
  t.is(result.results[0].judgeScore, 8);
  t.is(result.results[0].judgeReasoning, "because");
  t.is(result.summary.avgJudgeScore, 8);
  t.is(result.summary.judgeModel, "fake/judge-1");
});

test.serial("runBenchmark saves partial results when the server dies mid-run", async (t) => {
  const model = writeModel();
  writeDataset([
    { id: 1, prompt: "a", acceptable: ["ls"], category: "basic" },
    { id: 2, prompt: "b", acceptable: ["ls"], category: "basic" },
    { id: 3, prompt: "c", acceptable: ["ls"], category: "basic" },
  ]);
  const { deps } = makeDeps({ dieAfterCalls: 1 });

  const { result, events } = await collect({ model }, deps);

  // Scored against what actually ran, not the dataset length.
  t.is(result.summary.total, 1);
  t.true(events.some((e) => e.type === "warning"));
  // Without this a saved partial run is indistinguishable from a complete one.
  t.true(result.warning?.includes("1 of 3 tests"));
});

test.serial("runBenchmark leaves warning unset on a complete run", async (t) => {
  const model = writeModel();
  writeDataset([{ id: 1, prompt: "p", acceptable: ["ls"], category: "basic" }]);
  const { deps } = makeDeps();

  const { result } = await collect({ model }, deps);

  t.is(result.warning, undefined);
});

test.serial("runBenchmark writes both the JSON result and the Markdown report", async (t) => {
  const model = writeModel();
  writeDataset([{ id: 1, prompt: "p", acceptable: ["ls"], category: "basic" }]);
  const { deps } = makeDeps();

  const { result } = await collect({ model }, deps);

  const written = readdirSync(BENCHMARKS_DIR);
  const json = written.find((f) => f.startsWith("benchmark-") && f.endsWith(".json"));
  const md = written.find((f) => f.startsWith("benchmark-") && f.endsWith(".md"));
  t.truthy(json);
  t.truthy(md);
  // The saved document is the same one --json prints.
  t.deepEqual(
    JSON.parse(readFileSync(join(BENCHMARKS_DIR, json as string), "utf-8")),
    JSON.parse(JSON.stringify(result)),
  );
});

test.serial("runBenchmark records the sampling config it ran under", async (t) => {
  const model = writeModel();
  writeDataset([{ id: 1, prompt: "p", acceptable: ["ls"], category: "basic" }]);
  const { deps } = makeDeps();

  const { result } = await collect(
    { model, temperature: "0.5", seed: "9", samples: "2" },
    deps,
  );

  t.deepEqual(result.config, { temperature: 0.5, seed: 9, samples: 2 });
  t.false(result.isBase);
});

test.serial("runBenchmark stops the server even when a test throws", async (t) => {
  const model = writeModel();
  writeDataset([{ id: 1, prompt: "p", acceptable: ["ls"], category: "basic" }]);
  const { deps, log } = makeDeps({ failCalls: [0] });

  await collect({ model }, deps);

  t.is(log.stopped, 1);
});

test.serial("runBenchmark emits a test-start and test-end for every test", async (t) => {
  const model = writeModel();
  writeDataset([
    { id: 1, prompt: "first", acceptable: ["ls"], category: "basic" },
    { id: 2, prompt: "second", acceptable: ["ls"], category: "basic" },
  ]);
  const { deps } = makeDeps();

  const { events } = await collect({ model }, deps);

  const starts = events.filter((e) => e.type === "test-start");
  t.is(starts.length, 2);
  t.deepEqual(
    starts.map((e) => (e.type === "test-start" ? e.prompt : "")),
    ["first", "second"],
  );
  t.is(events.filter((e) => e.type === "test-end").length, 2);
  t.is(events.at(-1)?.type, "done");
});

test.serial("runBenchmark sends multi-turn messages through to the model", async (t) => {
  const model = writeModel();
  writeDataset([
    {
      id: 1,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "and now?" },
      ],
      acceptable: ["ls"],
      category: "multi",
    },
  ]);
  const { deps, log } = makeDeps();

  await collect({ model }, deps);

  t.is(log.prompts[0], "and now?");
});
