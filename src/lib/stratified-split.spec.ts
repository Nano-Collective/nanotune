import test from "ava";
import type { TrainingExample } from "../types/index.js";
import {
  apportionValid,
  assertValidRatio,
  buildLeakGroups,
  contentFingerprint,
  displayBucketKey,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_EXAMPLE,
  mulberry32,
  normalizeBucketKey,
  normalizeTags,
  shuffleInPlace,
  stratifyGroups,
  UNTAGGED_BUCKET,
  validTarget,
} from "./stratified-split.js";

// ── assertValidRatio ───────────────────────────────────────────────────
// These guard a live data-loss bug: Math.max(1, NaN) is NaN, slice(0, NaN)
// is the empty array, and train.jsonl gets written empty.

test("assertValidRatio accepts a ratio in [0, 1)", (t) => {
  t.is(assertValidRatio(0), 0);
  t.is(assertValidRatio(0.1), 0.1);
  t.is(assertValidRatio(0.999), 0.999);
});

test("assertValidRatio rejects NaN before it can empty train.jsonl", (t) => {
  t.throws(() => assertValidRatio(Number.NaN), { message: /finite number/ });
});

test("assertValidRatio rejects Infinity and -Infinity", (t) => {
  t.throws(() => assertValidRatio(Number.POSITIVE_INFINITY), { message: /finite/ });
  t.throws(() => assertValidRatio(Number.NEGATIVE_INFINITY), { message: /finite/ });
});

test("assertValidRatio rejects 1 and above, which would eat training data", (t) => {
  t.throws(() => assertValidRatio(1), { message: /less than 1/ });
  t.throws(() => assertValidRatio(1.5), { message: /less than 1/ });
});

test("assertValidRatio rejects a negative ratio", (t) => {
  t.throws(() => assertValidRatio(-0.1), { message: /0 or greater/ });
});

test("assertValidRatio rejects a non-number", (t) => {
  t.throws(() => assertValidRatio("0.1" as unknown as number), { message: /finite/ });
});

// ── validTarget ────────────────────────────────────────────────────────

test("validTarget holds out at least one example from two or more", (t) => {
  t.is(validTarget(2, 0), 1);
  t.is(validTarget(2, 0.01), 1);
  t.is(validTarget(100, 0.01), 1);
});

test("validTarget holds out nothing from a single example", (t) => {
  t.is(validTarget(1, 0.5), 0);
  t.is(validTarget(0, 0.5), 0);
});

test("validTarget never leaves the training set empty", (t) => {
  // A ratio of 1 used to make validCount exceed the dataset, trainCount go
  // negative, and slice(0, -1) drop one example more than intended.
  t.is(validTarget(10, 1), 9);
  t.is(validTarget(10, 5), 9);
  t.is(validTarget(2, 0.9), 1);
});

test("validTarget floors the requested ratio", (t) => {
  t.is(validTarget(200, 0.1), 20);
  t.is(validTarget(200, 0.105), 21);
});

// ── normalizeBucketKey ─────────────────────────────────────────────────

test("normalizeBucketKey folds case and whitespace into one category", (t) => {
  t.is(normalizeBucketKey("Math"), normalizeBucketKey("math"));
  t.is(normalizeBucketKey("  math  "), normalizeBucketKey("math"));
  t.is(normalizeBucketKey("machine   learning"), "machine learning");
});

test("normalizeBucketKey folds composed and decomposed accents together", (t) => {
  // U+00E9 against U+0065 U+0301: the same word typed two ways, which would
  // otherwise stratify a dataset against itself.
  t.is(normalizeBucketKey("café"), normalizeBucketKey("café"));
});

test("normalizeBucketKey rejects anything that cannot be a category", (t) => {
  t.is(normalizeBucketKey(""), null);
  t.is(normalizeBucketKey("   "), null);
  t.is(normalizeBucketKey(42), null);
  t.is(normalizeBucketKey(null), null);
  t.is(normalizeBucketKey(undefined), null);
  t.is(normalizeBucketKey({}), null);
  t.is(normalizeBucketKey([]), null);
});

test("normalizeBucketKey strips control characters", (t) => {
	// A tag carrying a control character would otherwise be able to
	// impersonate the untagged sentinel and merge itself with every
	// unlabelled example.
	const nul = String.fromCharCode(0);
	const tab = String.fromCharCode(9);
	const del = String.fromCharCode(127);
	t.is(normalizeBucketKey(`ma${nul}th`), "ma th");
	t.is(normalizeBucketKey(`ma${del}th`), "ma th");
	t.is(normalizeBucketKey(`ma${tab}th`), "ma th");
	t.is(normalizeBucketKey("ma\nth"), "ma th");
});

test("normalizeBucketKey cannot be forged into the untagged sentinel", (t) => {
  for (const attempt of ["untagged", "UNTAGGED", "  untagged  "]) {
    t.not(normalizeBucketKey(attempt), UNTAGGED_BUCKET);
  }
});

test("normalizeBucketKey truncates an absurdly long tag", (t) => {
  t.is(normalizeBucketKey("x".repeat(10_000))?.length, MAX_TAG_LENGTH);
});

// ── normalizeTags ──────────────────────────────────────────────────────
// parseTrainingData casts each line straight to TrainingExample, so `tags`
// arrives as whatever the JSON happened to hold. Nothing here may throw.

test("normalizeTags reads a well-formed tag list", (t) => {
  const result = normalizeTags(["Math", "geometry"]);
  t.deepEqual(result.display, ["Math", "geometry"]);
  t.is(result.bucket, "math");
  t.false(result.adjusted);
});

test("normalizeTags buckets an untagged example as untagged", (t) => {
  t.is(normalizeTags(undefined).bucket, UNTAGGED_BUCKET);
  t.is(normalizeTags([]).bucket, UNTAGGED_BUCKET);
  t.is(normalizeTags(["", "   "]).bucket, UNTAGGED_BUCKET);
});

test("normalizeTags survives every shape a hand-written file can hold", (t) => {
  const hostile = ["math", 42, null, { a: 1 }, [1, 2, 3], true, { tags: ["x"] }];
  for (const input of hostile) {
    const result = normalizeTags(input);
    t.is(typeof result.bucket, "string", `bucket for ${JSON.stringify(input)}`);
    t.true(Array.isArray(result.display));
    t.true(result.adjusted, `${JSON.stringify(input)} should be reported as adjusted`);
  }
});

test("normalizeTags falls back to untagged when tags is not an array", (t) => {
  // The shape most likely to throw mid-split if it reached `.map()` directly.
  const result = normalizeTags("math");
  t.is(result.bucket, UNTAGGED_BUCKET);
  t.true(result.adjusted);
});

test("normalizeTags drops non-string entries without losing the good ones", (t) => {
  const result = normalizeTags([42, "Math", null, "geometry"]);
  t.deepEqual(result.display, ["Math", "geometry"]);
  t.is(result.bucket, "math");
  t.true(result.adjusted);
});

test("normalizeTags uses only the first tag as the bucket", (t) => {
  // Counting one example in two buckets makes the bucket sizes sum to more than
  // the dataset, and every "did we keep every example?" check depends on that.
  t.is(normalizeTags(["Math", "Geometry"]).bucket, "math");
});

test("normalizeTags collapses tags that normalize to the same key", (t) => {
  const result = normalizeTags(["Math", "math", " MATH "]);
  t.deepEqual(result.display, ["Math"]);
  t.true(result.adjusted);
});

test("normalizeTags caps the number of tags per example", (t) => {
  const many = Array.from({ length: 200 }, (_, i) => `tag-${i}`);
  const result = normalizeTags(many);
  t.is(result.display.length, MAX_TAGS_PER_EXAMPLE);
  t.true(result.adjusted);
});

test("normalizeTags truncates an oversized tag", (t) => {
  const result = normalizeTags(["x".repeat(10_000)]);
  t.is(result.display[0].length, MAX_TAG_LENGTH);
  t.true(result.adjusted);
});

test("normalizeTags keeps tags verbatim so exports round-trip", (t) => {
  t.deepEqual(normalizeTags(["Machine Learning", "Math"]).display, [
    "Machine Learning",
    "Math",
  ]);
});

// ── contentFingerprint ────────────────────────────────────────────────

function example(user: string, assistant: string): TrainingExample {
  return {
    messages: [
      { role: "user", content: user },
      { role: "assistant", content: assistant },
    ],
  };
}

test("contentFingerprint is stable for the same example", (t) => {
  t.is(
    contentFingerprint(example("hi", "hello")),
    contentFingerprint(example("hi", "hello")),
  );
});

test("contentFingerprint ignores case, punctuation and spacing", (t) => {
  t.is(
    contentFingerprint(example("What's 2 + 2?", "Four")),
    contentFingerprint(example("what's  2+2 ?", "four")),
  );
});

test("contentFingerprint ignores accents", (t) => {
  t.is(
    contentFingerprint(example("café", "yes")),
    contentFingerprint(example("café", "yes")),
  );
});

test("contentFingerprint separates genuinely different examples", (t) => {
  t.not(
    contentFingerprint(example("What is 2+2?", "Four")),
    contentFingerprint(example("What is 3+3?", "Six")),
  );
});

test("contentFingerprint keeps messages from bleeding into each other", (t) => {
  // Without a separator that normalized text cannot contain, one message's
  // content could run into the next message's role.
  const two: TrainingExample = {
    messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ],
  };
  const reshaped: TrainingExample = {
    messages: [
      { role: "user", content: "a assistant" },
      { role: "b", content: "" },
    ],
  };
  t.not(contentFingerprint(two), contentFingerprint(reshaped));
});

test("contentFingerprint distinguishes role order", (t) => {
  const forward: TrainingExample = {
    messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ],
  };
  const backward: TrainingExample = {
    messages: [
      { role: "assistant", content: "b" },
      { role: "user", content: "a" },
    ],
  };
  t.not(contentFingerprint(forward), contentFingerprint(backward));
});

test("contentFingerprint does not throw on a malformed example", (t) => {
  t.is(typeof contentFingerprint({} as TrainingExample), "string");
  t.is(
    typeof contentFingerprint({ messages: "nope" } as unknown as TrainingExample),
    "string",
  );
  t.is(typeof contentFingerprint(null as unknown as TrainingExample), "string");
});

// ── buildLeakGroups ────────────────────────────────────────────────────

test("buildLeakGroups puts near-duplicates together", (t) => {
  t.deepEqual(buildLeakGroups(["a", "b", "a", "c"]), [[0, 2], [1], [3]]);
});

test("buildLeakGroups returns real indexes, not a contiguous assumption", (t) => {
  // Group 0 owns indexes 0 and 2, which is not a run. Anything inferring
  // "group g owns a contiguous block" from sizes alone would point at the
  // wrong examples and leak a near-duplicate onto both sides.
  const [first] = buildLeakGroups(["a", "b", "a"]);
  t.deepEqual(first, [0, 2]);
});

test("buildLeakGroups gives every example exactly one group", (t) => {
  const flattened = buildLeakGroups(["a", "a", "b", "c", "b"]).flat();
  t.deepEqual([...flattened].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

// ── apportionValid ─────────────────────────────────────────────────────

const RATIOS = [0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.9, 0.99];

test("apportionValid hits the global target exactly across many buckets", (t) => {
  // Summing a per-bucket floor loses up to one example per bucket, which is how
  // a "10% validation" split quietly returns 17 examples out of 200.
  const shapes = [[10, 10, 10], [100, 5, 1], [7, 7, 7, 7, 7], [50, 50], [1, 1, 1, 1]];
  for (const sizes of shapes) {
    for (const ratio of RATIOS) {
      const total = sizes.reduce((a, b) => a + b, 0);
      const sum = apportionValid(sizes, ratio).reduce((a, b) => a + b, 0);
      t.is(sum, validTarget(total, ratio), `sizes=${sizes} ratio=${ratio}`);
    }
  }
});

test("apportionValid never returns more than a bucket holds", (t) => {
  for (const sizes of [[10, 10, 10], [100, 5, 1], [1, 1, 1], [3, 1]]) {
    for (const ratio of RATIOS) {
      apportionValid(sizes, ratio).forEach((allocated, index) => {
        t.true(allocated >= 0, `negative for ${sizes} @ ${ratio}`);
        t.true(allocated <= sizes[index], `over-allocated ${sizes} @ ${ratio}`);
      });
    }
  }
});

test("apportionValid gives a one-example category a validation slot", (t) => {
  // The issue in one assertion: floor(1 * 0.1) is 0, so a proportional
  // per-bucket split drops a rare category out of validation entirely.
  t.deepEqual(apportionValid([199, 1], 0.1), [19, 1]);
});

test("apportionValid takes slots back from the largest buckets first", (t) => {
  // 20 categories cannot each have one at a 10% budget over 100 examples, and
  // the ones that lose theirs should be the ones that can most afford it.
  const sizes = [80, 4, 4, 4, 4, 1, 1, 1, 1];
  const allocation = apportionValid(sizes, 0.1);
  t.is(allocation.reduce((a, b) => a + b, 0), 10);
  // The rare single-example categories keep their slots over the 80-example one.
  for (const index of [5, 6, 7, 8]) {
    t.true(allocation[index] >= 1, `bucket ${index} (size ${sizes[index]}) lost its slot`);
  }
});

test("apportionValid still fills the budget when every bucket is a singleton", (t) => {
  // Refusing to ever empty a category would return no validation set at all,
  // and a training run with no validation set does not train.
  t.is(apportionValid([1, 1, 1], 0.5).reduce((a, b) => a + b, 0), 1);
  t.is(apportionValid([1, 1, 1], 0.9).reduce((a, b) => a + b, 0), 2);
});

test("apportionValid is deterministic for the same input order", (t) => {
  t.deepEqual(apportionValid([30, 20, 10], 0.25), apportionValid([30, 20, 10], 0.25));
});

test("apportionValid handles the empty and zero cases", (t) => {
  t.deepEqual(apportionValid([], 0.1), []);
  t.deepEqual(apportionValid([0, 0], 0.1), [0, 0]);
});

test("apportionValid rejects an invalid ratio", (t) => {
  t.throws(() => apportionValid([1, 1], Number.NaN), { message: /finite/ });
  t.throws(() => apportionValid([1, 1], 1), { message: /less than 1/ });
});

// ── stratifyGroups ─────────────────────────────────────────────────────

/**
 * One group per example — what any dataset without duplicates looks like —
 * with each group's category given by the bucket it falls in.
 */
function splitByBucket(
  sizes: number[],
  keys: string[] = sizes.map((_, index) => `cat-${index}`),
): [number[][], string[]] {
  const groups: number[][] = [];
  const buckets: string[] = [];
  let next = 0;
  for (const [index, size] of sizes.entries()) {
    for (let k = 0; k < size; k++) {
      groups.push([next]);
      buckets.push(keys[index]);
      next++;
    }
  }
  return [groups, buckets];
}

function stratify(sizes: number[], ratio: number) {
  return stratifyGroups(...splitByBucket(sizes), ratio);
}

test("stratifyGroups loses and duplicates nothing", (t) => {
  for (const sizes of [[5, 5, 5], [20, 3, 1], [2, 2, 2], [10, 10]]) {
    for (const ratio of RATIOS) {
      const result = stratify(sizes, ratio);
      const total = sizes.reduce((a, b) => a + b, 0);
      t.is(
        result.validIndexes.length + result.trainIndexes.length,
        total,
        `sizes=${sizes} ratio=${ratio}`,
      );
      const seen = new Set<number>();
      for (const index of [...result.validIndexes, ...result.trainIndexes]) {
        t.false(
          seen.has(index),
          `index ${index} used twice at sizes=${sizes} ratio=${ratio}`,
        );
        seen.add(index);
      }
    }
  }
});

test("stratifyGroups always leaves a training set", (t) => {
  for (const sizes of [[1, 1, 1], [2, 2], [50, 1]]) {
    for (const ratio of [0, 0.1, 0.5, 0.99]) {
      t.true(stratify(sizes, ratio).trainIndexes.length > 0, `sizes=${sizes} r=${ratio}`);
    }
  }
});

test("stratifyGroups reports the realized per-bucket counts", (t) => {
  const result = stratify([40, 60], 0.2);
  t.deepEqual(result.buckets.map((b) => b.key), ["cat-0", "cat-1"]);
  t.is(result.buckets[0].valid + result.buckets[1].valid, result.validIndexes.length);
  t.is(result.buckets[0].size + result.buckets[1].size, 100);
});

test("stratifyGroups sorts buckets by key so two runs diff cleanly", (t) => {
  const result = stratifyGroups(...splitByBucket([5, 5, 5], ["zebra", "alpha", "Mid"]), 0.2);
  t.deepEqual(result.buckets.map((b) => b.key), ["Mid", "alpha", "zebra"]);
});

test("stratifyGroups never puts a near-duplicate on both sides", (t) => {
  // A paraphrased twin in validation while the original trains makes the
  // validation loss measure memorization of a string the model already saw.
  const groups = [[0, 3], [1], [2], [4]];
  const result = stratifyGroups(groups, ["a", "a", "b", "b"], 0.5);
  const valid = new Set(result.validIndexes);
  t.deepEqual(result.trainIndexes.filter((index) => valid.has(index)), []);
  // 0 and 3 moved together, in the same direction.
  t.is(valid.has(0), valid.has(3));
});

test("stratifyGroups keeps scattered duplicates together", (t) => {
  // Group members are interleaved through the file, not adjacent.
  const groups = [[0, 2, 4], [1, 3], [5]];
  const result = stratifyGroups(groups, ["a", "b", "b"], 0.34);
  const valid = new Set(result.validIndexes);
  t.deepEqual(result.trainIndexes.filter((index) => valid.has(index)), []);
  t.is(valid.has(0), valid.has(2));
  t.is(valid.has(0), valid.has(4));
});

test("stratifyGroups names the categories it could not cover", (t) => {
  const result = stratify([2, 2, 2, 2, 2], 0.1);
  t.true(result.unrepresentedBuckets.length > 0);
  for (const key of result.unrepresentedBuckets) {
    t.true(key.startsWith("cat-"));
  }
});

test("stratifyGroups reports a shortfall when groups cannot fill the budget", (t) => {
  // Three groups of two can only yield 0, 2, 4 or 6 examples - never 5.
  const result = stratifyGroups([[0, 1], [2, 3], [4, 5]], ["a", "b", "c"], 0.9);
  t.is(result.shortfall, 1);
  t.true(result.validIndexes.length < 6);
});

test("stratifyGroups reports no shortfall when groups are single examples", (t) => {
  for (const ratio of RATIOS) {
    t.is(stratify([40, 60, 100], ratio).shortfall, 0, `ratio=${ratio}`);
  }
});

test("stratifyGroups falls back when there is nothing to stratify on", (t) => {
  const untagged = stratifyGroups(...splitByBucket([10, 10], [UNTAGGED_BUCKET, UNTAGGED_BUCKET]), 0.1);
  t.is(untagged.fallback, "no-categories");
  t.deepEqual(untagged.validIndexes, []);
});

test("stratifyGroups falls back when the categories are all noise", (t) => {
  // One example per category is as many categories as examples; stratifying
  // that is indistinguishable from shuffling, and reporting it as meaningful
  // would be a lie a reviewer would not catch.
  const result = stratify(Array.from({ length: 200 }, () => 1), 0.1);
  t.is(result.fallback, "too-many-categories");
});

test("stratifyGroups stratifies a genuinely imbalanced dataset", (t) => {
  // One rare example among 199 common ones, which a random 10% split drops
  // from validation roughly nine times in ten.
  const result = stratifyGroups(...splitByBucket([199, 1], ["common", "rare"]), 0.1);
  t.is(result.fallback, undefined);
  t.is(result.validIndexes.length, 20);
  t.is(result.buckets.find((b) => b.key === "rare")?.valid, 1);
  t.deepEqual(result.unrepresentedBuckets, []);
});

test("stratifyGroups handles the degenerate sizes", (t) => {
  t.deepEqual(stratifyGroups([], [], 0.1).validIndexes, []);
  t.is(stratifyGroups([[0]], ["a"], 0.1).fallback, "too-few-examples");
});

test("stratifyGroups rejects mismatched bucket metadata", (t) => {
  t.throws(() => stratifyGroups([[0], [1]], ["a"], 0.1), { message: /one entry per group/ });
});

// ── category keys as attacker-controlled input ─────────────────────────

test("prototype-named categories stay ordinary categories", (t) => {
  // These keys come out of a user-supplied file. As object keys they would
  // reach Object.prototype instead of storing a category.
  const hostile = ["__proto__", "constructor", "toString", "hasOwnProperty"];
  const result = stratifyGroups(...splitByBucket(hostile.map(() => 20), hostile), 0.2);
  t.deepEqual(result.buckets.map((b) => b.key).sort(), [...hostile].sort());
  t.is(result.validIndexes.length, 16);
  t.is(result.trainIndexes.length, 64);
  t.is(({} as Record<string, unknown>).valid, undefined);
});

// ── seeded shuffling ───────────────────────────────────────────────────

test("mulberry32 is reproducible for a seed", (t) => {
  t.deepEqual(
    Array.from({ length: 20 }, mulberry32(42)),
    Array.from({ length: 20 }, mulberry32(42)),
  );
});

test("mulberry32 differs across seeds", (t) => {
  t.notDeepEqual(
    Array.from({ length: 20 }, mulberry32(1)),
    Array.from({ length: 20 }, mulberry32(2)),
  );
});

test("shuffleInPlace is a full permutation", (t) => {
  const input = Array.from({ length: 100 }, (_, i) => i);
  t.deepEqual([...shuffleInPlace([...input], mulberry32(7))].sort((a, b) => a - b), input);
});

test("shuffleInPlace is deterministic for a seed", (t) => {
  t.deepEqual(
    shuffleInPlace([1, 2, 3, 4, 5], mulberry32(9)),
    shuffleInPlace([1, 2, 3, 4, 5], mulberry32(9)),
  );
});

// ── display ────────────────────────────────────────────────────────────

test("displayBucketKey keeps the sentinel out of user-facing output", (t) => {
  t.is(displayBucketKey(UNTAGGED_BUCKET), "untagged");
  t.is(displayBucketKey("math"), "math");
});
