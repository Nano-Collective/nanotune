import test from "ava";
import type { BenchmarkResult, BenchmarkTestResult } from "../types/index.js";
import {
  compareBenchmarks,
  deltaColor,
  generateComparisonMarkdown,
} from "./benchmark-compare.js";

function testResult(
  overrides: Partial<BenchmarkTestResult> & Pick<BenchmarkTestResult, "id" | "passed">,
): BenchmarkTestResult {
  return {
    prompt: `prompt ${overrides.id}`,
    expected: ["ok"],
    actual: "ok",
    category: "basic",
    ...overrides,
  };
}

function benchmarkResult(
  overrides: Partial<BenchmarkResult> & { results: BenchmarkTestResult[] },
): BenchmarkResult {
  const results = overrides.results;
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;

  const categories: Record<string, { passed: number; total: number }> = {};
  for (const r of results) {
    categories[r.category] ??= { passed: 0, total: 0 };
    categories[r.category].total += 1;
    if (r.passed) categories[r.category].passed += 1;
  }

  return {
    model: "test-model",
    timestamp: new Date().toISOString(),
    summary: { total, passed, failed: total - passed, passRate: total > 0 ? passed / total : 0 },
    categories,
    failures: [],
    ...overrides,
  };
}

// ── overall delta ────────────────────────────────────────────────────

test("compareBenchmarks computes overall pass rate delta", (t) => {
  const before = benchmarkResult({
    model: "base",
    results: [testResult({ id: 1, passed: true }), testResult({ id: 2, passed: false })],
  });
  const after = benchmarkResult({
    model: "fine-tuned",
    results: [testResult({ id: 1, passed: true }), testResult({ id: 2, passed: true })],
  });

  const comparison = compareBenchmarks(before, after);
  t.is(comparison.before.passRate, 0.5);
  t.is(comparison.after.passRate, 1);
  t.is(comparison.overallDelta, 0.5);
});

// ── per-category deltas ─────────────────────────────────────────────

test("compareBenchmarks computes per-category deltas", (t) => {
  const before = benchmarkResult({
    results: [
      testResult({ id: 1, passed: true, category: "math" }),
      testResult({ id: 2, passed: false, category: "code" }),
    ],
  });
  const after = benchmarkResult({
    results: [
      testResult({ id: 1, passed: true, category: "math" }),
      testResult({ id: 2, passed: true, category: "code" }),
    ],
  });

  const comparison = compareBenchmarks(before, after);
  const math = comparison.categories.find((c) => c.category === "math");
  const code = comparison.categories.find((c) => c.category === "code");

  t.truthy(math);
  t.is(math?.delta, 0);
  t.truthy(code);
  t.is(code?.delta, 1);
});

test("compareBenchmarks handles a category present in only one run", (t) => {
  const before = benchmarkResult({
    results: [testResult({ id: 1, passed: true, category: "math" })],
  });
  const after = benchmarkResult({
    results: [
      testResult({ id: 1, passed: true, category: "math" }),
      testResult({ id: 2, passed: true, category: "reasoning" }),
    ],
  });

  const comparison = compareBenchmarks(before, after);
  const reasoning = comparison.categories.find((c) => c.category === "reasoning");

  t.truthy(reasoning);
  t.is(reasoning?.before.total, 0);
  t.is(reasoning?.before.rate, 0);
  t.is(reasoning?.after.rate, 1);
});

// ── flips ────────────────────────────────────────────────────────────

test("compareBenchmarks reports a pass-to-fail flip as regressed", (t) => {
  const before = benchmarkResult({ results: [testResult({ id: 5, passed: true })] });
  const after = benchmarkResult({ results: [testResult({ id: 5, passed: false })] });

  const comparison = compareBenchmarks(before, after);
  t.is(comparison.flips.length, 1);
  t.like(comparison.flips[0], {
    id: 5,
    direction: "regressed",
    beforePassed: true,
    afterPassed: false,
  });
});

test("compareBenchmarks reports a fail-to-pass flip as fixed", (t) => {
  const before = benchmarkResult({ results: [testResult({ id: 5, passed: false })] });
  const after = benchmarkResult({ results: [testResult({ id: 5, passed: true })] });

  const comparison = compareBenchmarks(before, after);
  t.is(comparison.flips.length, 1);
  t.like(comparison.flips[0], {
    id: 5,
    direction: "fixed",
    beforePassed: false,
    afterPassed: true,
  });
});

test("compareBenchmarks does not report an unchanged test as a flip", (t) => {
  const before = benchmarkResult({ results: [testResult({ id: 1, passed: true })] });
  const after = benchmarkResult({ results: [testResult({ id: 1, passed: true })] });

  const comparison = compareBenchmarks(before, after);
  t.is(comparison.flips.length, 0);
});

test("compareBenchmarks surfaces flips even when the aggregate pass rate is unchanged", (t) => {
  // Test 1 regresses, test 2 gets fixed — passRate stays flat at 50% in both
  // runs, but two flips happened. This is the exact case the issue calls
  // out: an aggregate score can hide regressions.
  const before = benchmarkResult({
    results: [testResult({ id: 1, passed: true }), testResult({ id: 2, passed: false })],
  });
  const after = benchmarkResult({
    results: [testResult({ id: 1, passed: false }), testResult({ id: 2, passed: true })],
  });

  const comparison = compareBenchmarks(before, after);
  t.is(comparison.overallDelta, 0);
  t.is(comparison.flips.length, 2);
  t.true(comparison.flips.some((f) => f.id === 1 && f.direction === "regressed"));
  t.true(comparison.flips.some((f) => f.id === 2 && f.direction === "fixed"));
});

// ── mismatched test id sets ─────────────────────────────────────────

test("compareBenchmarks reports ids present in only one run without throwing", (t) => {
  const before = benchmarkResult({
    results: [testResult({ id: 1, passed: true }), testResult({ id: 2, passed: true })],
  });
  const after = benchmarkResult({
    results: [testResult({ id: 2, passed: true }), testResult({ id: 3, passed: true })],
  });

  const comparison = compareBenchmarks(before, after);
  t.deepEqual(comparison.onlyInBefore, [1]);
  t.deepEqual(comparison.onlyInAfter, [3]);
  t.is(comparison.flips.length, 0);
});

test("compareBenchmarks does not report a false flip when a reused id's prompt changed", (t) => {
  // tests.json was edited between runs: id 5 used to be a different prompt.
  // Reporting this as a "flip" would compare two unrelated tests.
  const before = benchmarkResult({
    results: [testResult({ id: 5, passed: true, prompt: "list all files" })],
  });
  const after = benchmarkResult({
    results: [testResult({ id: 5, passed: false, prompt: "show current directory" })],
  });

  const comparison = compareBenchmarks(before, after);
  t.is(comparison.flips.length, 0);
  t.deepEqual(comparison.onlyInBefore, [5]);
  t.deepEqual(comparison.onlyInAfter, [5]);
});

test("compareBenchmarks still reports a real flip when the prompt is unchanged", (t) => {
  const before = benchmarkResult({
    results: [testResult({ id: 5, passed: true, prompt: "list all files" })],
  });
  const after = benchmarkResult({
    results: [testResult({ id: 5, passed: false, prompt: "list all files" })],
  });

  const comparison = compareBenchmarks(before, after);
  t.is(comparison.flips.length, 1);
  t.is(comparison.onlyInBefore.length, 0);
  t.is(comparison.onlyInAfter.length, 0);
});

// ── isBase pass-through ──────────────────────────────────────────────

test("compareBenchmarks carries isBase through to before/after", (t) => {
  const before = benchmarkResult({
    isBase: true,
    results: [testResult({ id: 1, passed: true })],
  });
  const after = benchmarkResult({
    isBase: false,
    results: [testResult({ id: 1, passed: true })],
  });

  const comparison = compareBenchmarks(before, after);
  t.true(comparison.before.isBase);
  t.false(comparison.after.isBase);
});

// ── deltaColor ────────────────────────────────────────────────────────

test("deltaColor matches the rounded sign, not the raw sign", (t) => {
  t.is(deltaColor(0.004), undefined); // rounds to ±0%
  t.is(deltaColor(-0.004), undefined); // rounds to ±0%
  t.is(deltaColor(0.5), "green");
  t.is(deltaColor(-0.5), "red");
  t.is(deltaColor(0), undefined);
});

// ── markdown report ──────────────────────────────────────────────────

test("generateComparisonMarkdown includes overall delta, category table, and flips", (t) => {
  const before = benchmarkResult({
    model: "base-model",
    results: [testResult({ id: 1, passed: true, category: "math" }), testResult({ id: 2, passed: true, category: "code" })],
  });
  const after = benchmarkResult({
    model: "fine-tuned-model",
    results: [testResult({ id: 1, passed: false, category: "math" }), testResult({ id: 2, passed: true, category: "code" })],
  });

  const markdown = generateComparisonMarkdown(compareBenchmarks(before, after));

  t.true(markdown.includes("Overall Delta"));
  t.true(markdown.includes("Per-Category"));
  t.true(markdown.includes("math"));
  t.true(markdown.includes("Regressed"));
  t.true(markdown.includes("#1"));
});

test("generateComparisonMarkdown labels a base-model run", (t) => {
  const before = benchmarkResult({
    model: "base-model",
    isBase: true,
    results: [testResult({ id: 1, passed: true })],
  });
  const after = benchmarkResult({
    model: "fine-tuned-model",
    results: [testResult({ id: 1, passed: true })],
  });

  const markdown = generateComparisonMarkdown(compareBenchmarks(before, after));
  t.true(markdown.includes("base-model (base, control)"));
});

test("generateComparisonMarkdown notes when no tests flipped", (t) => {
  const before = benchmarkResult({ results: [testResult({ id: 1, passed: true })] });
  const after = benchmarkResult({ results: [testResult({ id: 1, passed: true })] });

  const markdown = generateComparisonMarkdown(compareBenchmarks(before, after));
  t.true(markdown.includes("No tests flipped between runs."));
});
