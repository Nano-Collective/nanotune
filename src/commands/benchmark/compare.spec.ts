import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "ava";
import { orderByMtime, resolveComparisonPair } from "./compare.js";

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
