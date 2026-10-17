import test from "ava";
import {mulberry32, shuffleInPlace} from "./random.js";

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
