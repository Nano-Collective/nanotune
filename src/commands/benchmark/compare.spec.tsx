import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "ava";
import { render } from "ink-testing-library";
import type { BenchmarkResult } from "../../types/index.js";
import {
  BenchmarkCompareCommand,
  orderByMtime,
  resolveComparisonPair,
} from "./compare.js";

const ORIG_CWD = process.cwd();
const TEST_DIR = join(ORIG_CWD, ".test-compare-spec");
const BENCH_DIR = join(TEST_DIR, ".nanotune", "benchmarks");

function setup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(BENCH_DIR, { recursive: true });
  process.chdir(TEST_DIR);
}

function teardown() {
  process.chdir(ORIG_CWD);
  rmSync(TEST_DIR, { recursive: true, force: true });
}

function writeBenchmark(filename: string, ageMs: number): string {
  const path = join(BENCH_DIR, filename);
  writeFileSync(path, "{}");
  const mtime = new Date(Date.now() - ageMs);
  utimesSync(path, mtime, mtime);
  return path;
}

/** A parseable benchmark, for the cases that load rather than just list. */
function writeRun(
  filename: string,
  ageMs: number,
  overrides: Partial<BenchmarkResult> = {},
): string {
  const path = join(BENCH_DIR, filename);
  const body: BenchmarkResult = {
    model: "test-model",
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: { total: 10, passed: 5, failed: 5, passRate: 0.5 },
    categories: {},
    results: [],
    failures: [],
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(body, null, 2));
  const mtime = new Date(Date.now() - ageMs);
  utimesSync(path, mtime, mtime);
  return path;
}

// ── orderByMtime ──────────────────────────────────────────────────────

test.serial("orderByMtime puts the older file first regardless of argument order", (t) => {
  setup();
  try {
    const older = writeBenchmark("benchmark-older.json", 60_000);
    const newer = writeBenchmark("benchmark-newer.json", 0);

    t.deepEqual(orderByMtime(older, newer), { beforePath: older, afterPath: newer });
    t.deepEqual(orderByMtime(newer, older), { beforePath: older, afterPath: newer });
  } finally {
    teardown();
  }
});

// ── resolveComparisonPair ─────────────────────────────────────────────

test.serial("resolveComparisonPair with 0 args picks the two most recent runs", (t) => {
  setup();
  try {
    writeBenchmark("benchmark-oldest.json", 120_000);
    const middle = writeBenchmark("benchmark-middle.json", 60_000);
    const newest = writeBenchmark("benchmark-newest.json", 0);

    const { beforePath, afterPath } = resolveComparisonPair(undefined, undefined);
    t.is(beforePath, middle);
    t.is(afterPath, newest);
  } finally {
    teardown();
  }
});

test.serial("resolveComparisonPair with 0 args throws when fewer than two runs exist", (t) => {
  setup();
  try {
    writeBenchmark("benchmark-only.json", 0);
    t.throws(() => resolveComparisonPair(undefined, undefined));
  } finally {
    teardown();
  }
});

test.serial("resolveComparisonPair with 1 arg compares it against the latest run", (t) => {
  setup();
  try {
    const older = writeBenchmark("benchmark-older.json", 60_000);
    const latest = writeBenchmark("benchmark-latest.json", 0);

    const { beforePath, afterPath } = resolveComparisonPair("benchmark-older.json", undefined);
    t.is(beforePath, older);
    t.is(afterPath, latest);
  } finally {
    teardown();
  }
});

test.serial("resolveComparisonPair with 1 arg falls back to the second-latest when the named run IS the latest", (t) => {
  setup();
  try {
    const secondLatest = writeBenchmark("benchmark-second.json", 60_000);
    const latest = writeBenchmark("benchmark-latest.json", 0);

    const { beforePath, afterPath } = resolveComparisonPair("benchmark-latest.json", undefined);
    t.is(beforePath, secondLatest);
    t.is(afterPath, latest);
  } finally {
    teardown();
  }
});

test.serial("resolveComparisonPair with 1 arg throws when no other run exists to compare against", (t) => {
  setup();
  try {
    writeBenchmark("benchmark-only.json", 0);
    t.throws(() => resolveComparisonPair("benchmark-only.json", undefined));
  } finally {
    teardown();
  }
});

test.serial("resolveComparisonPair with 2 args preserves the given before/after order", (t) => {
  setup();
  try {
    // Give the "after" arg the older mtime to prove explicit args aren't
    // reordered by orderByMtime the way the 0/1-arg forms are.
    const afterArg = writeBenchmark("benchmark-a.json", 60_000);
    const beforeArg = writeBenchmark("benchmark-b.json", 0);

    const { beforePath, afterPath } = resolveComparisonPair(
      "benchmark-b.json",
      "benchmark-a.json",
    );
    t.is(beforePath, beforeArg);
    t.is(afterPath, afterArg);
  } finally {
    teardown();
  }
});

// ── cases the resolution logic can get subtly wrong ────────────────────

test.serial("orderByMtime keeps the caller's order when mtimes are equal", (t) => {
  setup();
  try {
    const first = writeBenchmark("benchmark-a.json", 0);
    const second = writeBenchmark("benchmark-b.json", 0);
    // `<=` rather than `<`, so equal timestamps do not swap arbitrarily.
    t.deepEqual(orderByMtime(first, second), {
      beforePath: first,
      afterPath: second,
    });
  } finally {
    teardown();
  }
});

test.serial("the latest-run check survives a differently spelled path", (t) => {
  setup();
  try {
    const previous = writeBenchmark("benchmark-previous.json", 60_000);
    writeBenchmark("benchmark-latest.json", 0);

    // Same file, named by a relative path rather than a bare filename.
    // Comparing raw strings instead of real paths would miss the match and
    // silently compare the latest run against itself, reporting every delta
    // as zero — a confidently useless report.
    const relative = join(".nanotune", "benchmarks", "benchmark-latest.json");
    const { beforePath, afterPath } = resolveComparisonPair(relative, undefined);
    t.is(beforePath, previous);
    t.true(afterPath.endsWith("benchmark-latest.json"));
  } finally {
    teardown();
  }
});

test.serial("a bare timestamp resolves to its benchmark file", (t) => {
  setup();
  try {
    writeBenchmark("benchmark-2026-01-01.json", 60_000);
    const latest = writeBenchmark("benchmark-2026-02-02.json", 0);

    const { beforePath, afterPath } = resolveComparisonPair(
      "2026-01-01",
      undefined,
    );
    t.true(beforePath.endsWith("benchmark-2026-01-01.json"));
    t.is(afterPath, latest);
  } finally {
    teardown();
  }
});

test.serial("no saved runs at all is reported, not crashed on", (t) => {
  setup();
  try {
    const error = t.throws(() => resolveComparisonPair(undefined, undefined));
    t.true(error?.message.includes("found 0"));
  } finally {
    teardown();
  }
});

// ── the command itself ────────────────────────────────────────────────

test.serial("the command writes both reports to the benchmarks directory", async (t) => {
  setup();
  try {
    writeRun("benchmark-before.json", 60_000, {
      summary: { total: 10, passed: 4, failed: 6, passRate: 0.4 },
    });
    writeRun("benchmark-after.json", 0, {
      summary: { total: 10, passed: 8, failed: 2, passRate: 0.8 },
    });

    const instance = render(<BenchmarkCompareCommand />);
    // The work happens in a useEffect, so it has to be allowed to finish and be
    // unmounted *inside* the test. Left running, the effect fires after
    // teardown has removed the fixture, fails, and sets process.exitCode after
    // the reset below — an intermittent red build with no failing assertion to
    // explain it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    instance.unmount();

    t.true(instance.frames.join("\n").includes("Benchmark Compare"));

    // The reports are the deliverable: the rendered table is scrollback, the
    // files are what a user keeps.
    const written = readdirSync(BENCH_DIR);
    t.true(
      written.some((f) => f.startsWith("compare-") && f.endsWith(".json")),
      `expected a compare JSON, got: ${written.join(", ")}`,
    );
    t.true(
      written.some((f) => f.startsWith("compare-") && f.endsWith(".md")),
      `expected a compare Markdown, got: ${written.join(", ")}`,
    );

    const report = written.find(
      (f) => f.startsWith("compare-") && f.endsWith(".json"),
    );
    const parsed = JSON.parse(
      readFileSync(join(BENCH_DIR, report ?? ""), "utf8"),
    );
    // Ordered oldest-first, so an improvement reads as an improvement. Inverted,
    // this would report a 40-point regression and look entirely credible.
    t.is(parsed.before.passRate, 0.4);
    t.is(parsed.after.passRate, 0.8);
    t.true(parsed.overallDelta > 0);
  } finally {
    teardown();
    process.exitCode = 0;
  }
});
