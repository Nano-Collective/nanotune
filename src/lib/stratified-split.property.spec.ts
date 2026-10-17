import test from "ava";
import type { TrainingExample } from "../types/index.js";
import {
  apportionValid,
  buildLeakGroups,
  contentFingerprint,
  stratifyGroups,
  validTarget,
} from "./stratified-split.js";

/**
 * The arithmetic decides what happens to a user's training data, so the only
 * way to be sure an allocation is safe across every shape is to assert the
 * invariants over the whole space rather than over the handful of cases that
 * came to mind. Every bug this work uncovered was invisible to the hand-written
 * cases: a split that ignored its seed, a comparator that undid its own shuffle,
 * a group-ownership assumption that pointed at the wrong examples, and a design
 * that returned no validation set at all.
 */

const RATIOS = [0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.9, 0.99];

/** Bucket-size shapes with the properties real datasets have and bad ones lack. */
const SHAPES: Array<{name: string; gen: (n: number) => number[]}> = [
  { name: "all singletons", gen: n => Array(n).fill(1) },
  { name: "all pairs", gen: n => Array(Math.ceil(n / 2)).fill(2).slice(0, n) },
  { name: "one huge bucket", gen: n => [n, ...Array(Math.max(0, n - 1)).fill(1)] },
  { name: "one huge + one singleton", gen: () => [1000, 1] },
  {
    name: "power-of-two spread",
    gen: n => {
      const out: number[] = [];
      let shift = 0;
      while (out.length < n) {
        out.push(2 ** shift);
        shift = (shift + 1) % 7;
      }
      return out.slice(0, n);
    },
  },
  {
    name: "one dominant category",
    gen: n => [Math.max(1, n - 2), 1, 1],
  },
  { name: "sizes 1..7 cycling", gen: n => Array.from({length: n}, (_, i) => (i % 7) + 1) },
];

// ── apportionValid invariants ──────────────────────────────────────────

test("apportionValid hits the exact global target for every shape and ratio", (t) => {
  for (const shape of SHAPES) {
    for (let n = 1; n <= 40; n++) {
      const sizes = shape.gen(n).filter(size => size > 0);
      if (sizes.length === 0) continue;
      const total = sizes.reduce((a, b) => a + b, 0);

      for (const ratio of RATIOS) {
        const allocation = apportionValid(sizes, ratio);
        const sum = allocation.reduce((a, b) => a + b, 0);
        t.is(
          sum,
          validTarget(total, ratio),
          `${shape.name} n=${n} ratio=${ratio}: allocated ${sum}`,
        );
      }
    }
  }
});

test("apportionValid never allocates more than a bucket holds", (t) => {
  for (const shape of SHAPES) {
    for (let n = 1; n <= 40; n++) {
      const sizes = shape.gen(n).filter(size => size > 0);
      if (sizes.length === 0) continue;

      for (const ratio of RATIOS) {
        apportionValid(sizes, ratio).forEach((allocated, index) => {
          t.true(allocated >= 0, `${shape.name} n=${n} r=${ratio}: negative at ${index}`);
          t.true(
            allocated <= sizes[index],
            `${shape.name} n=${n} r=${ratio}: ${allocated} from a bucket of ${sizes[index]}`,
          );
        });
      }
    }
  }
});

test("apportionValid is a pure function of its input", (t) => {
  for (const shape of SHAPES) {
    for (let n = 1; n <= 20; n++) {
      const sizes = shape.gen(n).filter(size => size > 0);
      if (sizes.length === 0) continue;
      for (const ratio of RATIOS) {
        t.deepEqual(
          apportionValid(sizes, ratio),
          apportionValid(sizes, ratio),
          `${shape.name} n=${n} r=${ratio}`,
        );
      }
    }
  }
});

// ── stratifyGroups invariants ──────────────────────────────────────────

/** One group per example, grouped into buckets of the given sizes. */
function layout(sizes: number[]): [number[][], string[]] {
  const groups: number[][] = [];
  const buckets: string[] = [];
  let next = 0;
  for (const [index, size] of sizes.entries()) {
    for (let k = 0; k < size; k++) {
      groups.push([next]);
      buckets.push(`cat-${index}`);
      next++;
    }
  }
  return [groups, buckets];
}

test("stratifyGroups loses and duplicates nothing, for every shape and ratio", (t) => {
  for (const shape of SHAPES) {
    for (let n = 2; n <= 40; n++) {
      const sizes = shape.gen(n).filter(size => size > 0);
      if (sizes.length === 0) continue;
      const total = sizes.reduce((a, b) => a + b, 0);

      for (const ratio of RATIOS) {
        const [groups, buckets] = layout(sizes);
        const result = stratifyGroups(groups, buckets, ratio);
        if (result.fallback) continue;

        const label = `${shape.name} n=${n} r=${ratio}`;
        t.is(
          result.validIndexes.length + result.trainIndexes.length,
          total,
          `${label}: examples went missing`,
        );

        const seen = new Set<number>();
        for (const index of [...result.validIndexes, ...result.trainIndexes]) {
          t.false(seen.has(index), `${label}: index ${index} on both sides`);
          seen.add(index);
        }
        t.true(result.trainIndexes.length > 0, `${label}: nothing left to train on`);
      }
    }
  }
});

test("stratifyGroups covers every category the budget can reach", (t) => {
  for (const shape of SHAPES) {
    for (let n = 2; n <= 30; n++) {
      const sizes = shape.gen(n).filter(size => size > 0);
      if (sizes.length === 0) continue;

      for (const ratio of RATIOS) {
        const [groups, buckets] = layout(sizes);
        const result = stratifyGroups(groups, buckets, ratio);
        if (result.fallback) continue;

        // With single-example groups the target is always reachable, so every
        // category should be covered once the budget allows it. With coarser
        // groups the subset sums may simply not contain the target, which is
        // what `shortfall` reports.
        const everyGroupIsOne = groups.every(group => group.length === 1);
        if (!everyGroupIsOne) continue;
        if (result.validIndexes.length < result.buckets.length) continue;

        t.deepEqual(
          result.unrepresentedBuckets,
          [],
          `${shape.name} n=${n} r=${ratio}: unrepresented despite budget`,
        );
      }
    }
  }
});

test("stratifyGroups reports realized counts that match the indexes it returned", (t) => {
  for (const shape of SHAPES) {
    for (let n = 2; n <= 25; n++) {
      const sizes = shape.gen(n).filter(size => size > 0);
      if (sizes.length === 0) continue;

      for (const ratio of RATIOS) {
        const [groups, buckets] = layout(sizes);
        const result = stratifyGroups(groups, buckets, ratio);
        if (result.fallback) continue;

        // The per-bucket report is what `nanotune train` prints. If it drifts
        // from what actually landed in valid.jsonl the user is told something
        // untrue about their split.
        const reported = result.buckets.reduce((sum, b) => sum + b.valid, 0);
        t.is(
          reported,
          result.validIndexes.length,
          `${shape.name} n=${n} r=${ratio}: report says ${reported}, got ${result.validIndexes.length}`,
        );
        const reportedTotal = result.buckets.reduce((sum, b) => sum + b.size, 0);
        t.is(reportedTotal, sizes.reduce((a, b) => a + b, 0), `${shape.name} n=${n}: bucket totals`);
      }
    }
  }
});

test("stratifyGroups is reproducible for a seed and varies across seeds", (t) => {
  const sizes = [30, 25, 20, 15, 10];
  const [groups, buckets] = layout(sizes);

  const withSeed = (seed: number): number[] => {
    // A tiny stand-in for mulberry32: this test is about the wiring, and the
    // generator itself has its own tests.
    let a = seed >>> 0;
    const rng = (): number => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return stratifyGroups(groups, buckets, 0.2, rng).validIndexes;
  };

  t.deepEqual(withSeed(42), withSeed(42));
  t.notDeepEqual(withSeed(42), withSeed(999));
});

// ── leak groups ────────────────────────────────────────────────────────

test("near-duplicates never straddle the split, for arbitrary datasets", (t) => {
  // Deterministic pseudo-random datasets rather than Math.random, so a failure
  // is reproducible from the seed alone.
  for (let seed = 1; seed <= 200; seed++) {
    let state = seed;
    const next = (bound: number): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % bound;
    };

    const size = 2 + next(30);
    const categories = ["math", "code", "prose", "sql"].slice(0, 2 + next(3));
    // next() is used for the question text too, so the same small pool of
    // prompts and answers is reused across examples and duplicates are
    // guaranteed rather than merely likely.
    const promptPool = Math.max(1, Math.floor(size / 3));
    const examples: TrainingExample[] = Array.from({length: size}, (_, i) => ({
      messages: [
        {role: "system", content: "s"},
        {role: "user", content: `q${next(promptPool)}`},
        {role: "assistant", content: `a${next(3)}`},
      ],
      tags: [categories[i % categories.length]],
    }));

    const groups = buildLeakGroups(examples.map(contentFingerprint));
    const bucketOfGroup = groups.map(indexes => {
      const tally = new Map<string, number>();
      for (const i of indexes) {
        const tag = String(examples[i].tags?.[0] ?? "untagged").toLowerCase();
        tally.set(tag, (tally.get(tag) ?? 0) + 1);
      }
      return [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    });

    const result = stratifyGroups(groups, bucketOfGroup, 0.1);
    if (result.fallback) continue;

    for (const validIndex of result.validIndexes) {
      for (const trainIndex of result.trainIndexes) {
        t.not(
          contentFingerprint(examples[validIndex]),
          contentFingerprint(examples[trainIndex]),
          `seed ${seed}: an example and its twin landed on opposite sides`,
        );
      }
    }
  }
});

test("buildLeakGroups covers every example exactly once, for arbitrary input", (t) => {
  for (let seed = 1; seed <= 100; seed++) {
    let state = seed;
    const next = (bound: number): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % bound;
    };
    const fingerprints = Array.from({length: next(50)}, () => `fp-${next(4)}`);
    const flattened = buildLeakGroups(fingerprints).flat();
    t.deepEqual(
      [...flattened].sort((a, b) => a - b),
      fingerprints.map((_, index) => index),
      `seed ${seed}`,
    );
  }
});
