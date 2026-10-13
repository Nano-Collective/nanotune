import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "ava";
import type { TrainingExample } from "../types/index.js";
import {
  appendToTrainingData,
  appendTrainingExample,
  collectValidation,
  countExamples,
  countTrainValidOverlap,
  ensureValidationSet,
  exportToCSV,
  exportToJSONL,
  importFromCSV,
  importFromJSON,
  importFromJSONL,
  loadTrainingData,
  splitTrainValidation,
} from "./data.js";
import { mulberry32, shuffleInPlace, validTarget } from "./stratified-split.js";

const ORIG_CWD = process.cwd();
const TEST_DIR = join(ORIG_CWD, ".test-split-spec");
const DATA_DIR = join(TEST_DIR, ".nanotune", "data");
const SYSTEM_CTX = { role: "system", content: "You are helpful." };

test.beforeEach(() => {
  // Step out of the directory before removing it. Windows refuses to unlink a
  // directory that is some process's working directory (EBUSY), and this
  // suite's own cwd is inside the one being cleared.
  process.chdir(ORIG_CWD);
  rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(DATA_DIR, { recursive: true });
  // collectValidation reads the project config itself and throws outside a
  // project, so these tests need one.
  writeFileSync(
    join(TEST_DIR, ".nanotune", "config.json"),
    JSON.stringify({
      name: "split-spec",
      baseModel: "mlx-community/test",
      contextMessage: SYSTEM_CTX,
      training: {},
      export: {outputName: "out"},
    }),
  );
  process.chdir(TEST_DIR);
});

test.afterEach.always(() => {
  process.chdir(ORIG_CWD);
  rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 3 });
});

function seed(count: number, tagFor?: (index: number) => string[] | undefined): void {
  for (let i = 0; i < count; i++) {
    appendToTrainingData(
      {
        contextMessage: SYSTEM_CTX,
        userInput: `q${i}`,
        assistantOutput: `a${i}`,
        tags: tagFor?.(i),
      },
      false,
    );
  }
}

function contentsOf(isEval: boolean): string[] {
  return loadTrainingData(isEval).map(ex => ex.messages[1].content);
}

function categoriesOf(isEval: boolean): string[] {
  return loadTrainingData(isEval).map(ex => ex.tags?.[0] ?? "untagged");
}

/** The pre-#211 implementation, reproduced to pin the back-compat contract. */
function legacyValidSelection(examples: TrainingExample[], ratio: number, seed: number): string[] {
  const shuffled = shuffleInPlace([...examples], mulberry32(seed));
  const validCount = validTarget(examples.length, ratio);
  return shuffled.slice(shuffled.length - validCount).map(ex => ex.messages[1].content);
}

// ── back-compat with the unstratified split (#211 acceptance criterion) ──

test.serial("an untagged dataset splits exactly as it did before #211", (t) => {
  seed(200);
  const before = loadTrainingData(false);
  const expected = legacyValidSelection(before, 0.1, 42);

  splitTrainValidation(0.1, 42);

  t.deepEqual(contentsOf(true).sort(), [...expected].sort());
});

test.serial("an untagged dataset reports a random strategy, not a stratified one", (t) => {
  seed(50);
  const result = splitTrainValidation(0.1, 42);
  t.is(result.strategy, "random");
  t.deepEqual(result.buckets, []);
});

test.serial("a tagged dataset splits exactly as it did before #211 when stratify is off", (t) => {
  seed(100, (i) => [i % 2 === 0 ? "even" : "odd"]);
  const before = loadTrainingData(false);
  const expected = legacyValidSelection(before, 0.1, 7);

  splitTrainValidation(0.1, 7, "off");

  t.deepEqual(contentsOf(true).sort(), [...expected].sort());
});

// ── the issue itself ───────────────────────────────────────────────────

test.serial("a one-example category reaches validation instead of being dropped", (t) => {
  // The complaint in #211: a random 10% split misses a category with one
  // example in 199 roughly nine times in ten.
  seed(199);
  appendToTrainingData(
    {
      contextMessage: SYSTEM_CTX,
      userInput: "rare-question",
      assistantOutput: "rare-answer",
      tags: ["sql-edge-cases"],
    },
    false,
  );

  const result = splitTrainValidation(0.1, 1);

  t.is(result.strategy, "stratified");
  t.true(categoriesOf(true).includes("sql-edge-cases"));
  t.deepEqual(result.unrepresentedCategories, []);
});

test.serial("a stratified split covers every category it can", (t) => {
  seed(200, (i) => [i < 100 ? "common" : i < 190 ? "medium" : "rare"]);
  // Every example unique, so nothing is held out as a group.
  appendToTrainingData(
    { contextMessage: SYSTEM_CTX, userInput: "x", assistantOutput: "y", tags: ["rare"] },
    false,
  );

  const result = splitTrainValidation(0.1, 3);

  t.deepEqual(result.unrepresentedCategories, []);
  const seen = new Set(categoriesOf(true));
  for (const bucket of result.buckets) {
    t.true(seen.has(bucket.category), `category ${bucket.category} missing from validation`);
  }
});

test.serial("the stratified split still returns the requested ratio", (t) => {
  seed(300, (i) => [i % 3 === 0 ? "a" : i % 3 === 1 ? "b" : "c"]);
  const result = splitTrainValidation(0.1, 5);
  t.is(result.validCount, 30);
  t.is(result.trainCount, 270);
  t.is(result.shortfall, 0);
});

test.serial("a category too small for the ratio is named, not silently dropped", (t) => {
  seed(50, () => ["one-category"]);
  // Force many categories against a tiny budget.
  for (let i = 0; i < 20; i++) {
    appendToTrainingData(
      { contextMessage: SYSTEM_CTX, userInput: `c${i}`, assistantOutput: `d${i}`, tags: [`cat-${i}`] },
      false,
    );
  }

  const result = splitTrainValidation(0.05, 2);

  t.is(result.validCount, 3);
  t.true(result.unrepresentedCategories.length > 0);
  t.is(result.unrepresentedCategories.length, result.buckets.filter(b => b.validation === 0).length);
});

// ── nothing is ever lost or duplicated ─────────────────────────────────

test.serial("a stratified split is a permutation of the input", (t) => {
  seed(120, (i) => [i % 4 === 0 ? "w" : i % 4 === 1 ? "x" : i % 4 === 2 ? "y" : "z"]);

  splitTrainValidation(0.1, 11);

  t.is(countExamples(false) + countExamples(true), 120);
  const all = [...contentsOf(false), ...contentsOf(true)].sort();
  t.deepEqual(all, Array.from({ length: 120 }, (_, i) => `q${i}`).sort());
});

test.serial("a near-duplicate never lands on both sides of the split", (t) => {
  // The point of grouping: a twin in validation while the original trains
  // makes the validation loss measure memorization of a string already seen.
  for (let i = 0; i < 40; i++) {
    appendToTrainingData(
      { contextMessage: SYSTEM_CTX, userInput: `q${i}`, assistantOutput: `a${i}`, tags: ["topic"] },
      false,
    );
  }
  // Punctuation-only and case-only twins of q0.
  for (const twin of ["Q0!", " q0 ", "q0?"]) {
    appendToTrainingData(
      { contextMessage: SYSTEM_CTX, userInput: twin, assistantOutput: "a0", tags: ["topic"] },
      false,
    );
  }

  splitTrainValidation(0.25, 9);

  const valid = contentsOf(true);
  const train = contentsOf(false);
  const group = ["q0", "Q0!", " q0 ", "q0?"];
  // The property is co-location, not direction: whichever side the group lands
  // on, all four of its members land there together.
  const sides = group.map(member => ({
    member,
    inValid: valid.includes(member),
    inTrain: train.includes(member),
  }));
  for (const {member, inValid, inTrain} of sides) {
    t.false(inValid && inTrain, `${member} appears in both train and valid`);
  }
  t.is(new Set(sides.map(s => s.inValid)).size, 1, "the group was split across the two files");
});

test.serial("a scattered duplicate group is kept whole", (t) => {
  // The duplicate pair sits at indexes 0 and 2 with unrelated examples
  // between them, so anything assuming a group's members are adjacent would
  // split them across the two files.
  const plan: Array<[string, string, string]> = [
    ["identical", "same", "dupes"],
    ["q1", "a1", "other"],
    ["identical", "same", "dupes"],
    ["q3", "a3", "other"],
    ["q4", "a4", "other"],
    ["q5", "a5", "other"],
    ["q6", "a6", "other"],
    ["q7", "a7", "other"],
    ["q8", "a8", "other"],
    ["q9", "a9", "other"],
    ["q10", "a10", "other"],
    ["q11", "a11", "other"],
  ];
  for (const [user, assistant, tag] of plan) {
    appendToTrainingData(
      { contextMessage: SYSTEM_CTX, userInput: user, assistantOutput: assistant, tags: [tag] },
      false,
    );
  }

  // 12 examples at 75% gives "dupes" a budget of 2, which its pair fits into
  // exactly. Below that the budget is 1 and the pair cannot be held out whole,
  // which is a real and reported shortfall rather than something to paper over.
  splitTrainValidation(0.75, 4);

  t.is(countExamples(false) + countExamples(true), 12);
  t.is(contentsOf(true).filter(c => c === "identical").length, 2);
  t.is(contentsOf(false).filter(c => c === "identical").length, 0);
});

// ── the ratio guard ────────────────────────────────────────────────────

test.serial("a NaN ratio is rejected before anything is written", (t) => {
  seed(20);
  // Math.max(1, NaN) is NaN and slice(0, NaN) is empty, which is how
  // train.jsonl ends up written empty.
  t.throws(() => splitTrainValidation(Number.NaN, 1), { message: /finite/ });
  t.is(countExamples(false), 20);
  t.is(countExamples(true), 0);
});

test.serial("a ratio of 1 is rejected before anything is written", (t) => {
  seed(20);
  // validCount would exceed the dataset, trainCount would go negative, and
  // slice(0, -1) would drop one example more than intended.
  t.throws(() => splitTrainValidation(1, 1), { message: /less than 1/ });
  t.throws(() => splitTrainValidation(1.5, 1), { message: /less than 1/ });
  t.is(countExamples(false), 20);
  t.is(countExamples(true), 0);
});

test.serial("a negative ratio is rejected before anything is written", (t) => {
  seed(20);
  t.throws(() => splitTrainValidation(-0.5, 1), { message: /0 or greater/ });
  t.is(countExamples(false), 20);
});

test.serial("a ratio of zero still yields the minimum validation set", (t) => {
  seed(20);
  const result = splitTrainValidation(0, 1);
  t.is(result.validCount, 1);
  t.is(result.trainCount, 19);
});

// ── reproducibility ────────────────────────────────────────────────────

test.serial("the same seed produces the same stratified split", (t) => {
  seed(80, (i) => [i % 3 === 0 ? "a" : i % 3 === 1 ? "b" : "c"]);
  splitTrainValidation(0.2, 42);
  const first = contentsOf(true).sort();

  rmSync(join(DATA_DIR, "valid.jsonl"), { force: true });
  rmSync(join(DATA_DIR, "train.jsonl"), { force: true });
  seed(80, (i) => [i % 3 === 0 ? "a" : i % 3 === 1 ? "b" : "c"]);

  splitTrainValidation(0.2, 42);

  t.deepEqual(contentsOf(true).sort(), first);
});

test.serial("different seeds produce different stratified splits", (t) => {
  seed(80, (i) => [i % 3 === 0 ? "a" : i % 3 === 1 ? "b" : "c"]);
  splitTrainValidation(0.2, 1);
  const first = contentsOf(true).sort();

  rmSync(join(DATA_DIR, "valid.jsonl"), { force: true });
  rmSync(join(DATA_DIR, "train.jsonl"), { force: true });
  seed(80, (i) => [i % 3 === 0 ? "a" : i % 3 === 1 ? "b" : "c"]);

  splitTrainValidation(0.2, 999);

  t.notDeepEqual(contentsOf(true).sort(), first);
});

// ── tags survive the dataset ───────────────────────────────────────────

test.serial("tags survive an untagged dataset's bytes", (t) => {
  // Nothing about an example that never had tags may change, or every
  // untagged user's dataset would show up in git diff for no reason.
  seed(3);
  const raw = readFileSync(join(DATA_DIR, "train.jsonl"), "utf8");
  t.false(raw.includes("tags"));
});

test.serial("tags round-trip through JSONL", (t) => {
  seed(3, (i) => [`cat-${i}`]);
  const out = join(TEST_DIR, "out.jsonl");
  exportToJSONL(out, false);

  const raw = JSON.parse(readFileSync(out, "utf8").trim().split("\n")[1]);
  t.deepEqual(raw.tags, ["cat-1"]);
});

test.serial("tags round-trip through a CSV third column", (t) => {
  seed(3, (i) => [`cat-${i}`]);
  const out = join(TEST_DIR, "out.csv");
  exportToCSV(out, false);
  t.true(readFileSync(out, "utf8").startsWith("input,output,tags"));

  rmSync(join(DATA_DIR, "train.jsonl"), { force: true });
  importFromCSV(out, SYSTEM_CTX, false);
  t.deepEqual(loadTrainingData(false)[1].tags, ["cat-1"]);
});

test.serial("a CSV with no tags exports the same two columns it always did", (t) => {
  seed(3);
  const out = join(TEST_DIR, "out.csv");
  exportToCSV(out, false);
  const lines = readFileSync(out, "utf8").trim().split("\n");
  t.is(lines[0], "input,output");
  t.is(lines.length, 4);
});

test.serial("tags round-trip through JSON", (t) => {
  const out = join(TEST_DIR, "out.json");
  writeFileSync(
    out,
    JSON.stringify([
      { messages: [{ role: "user", content: "u" }, { role: "assistant", content: "a" }], tags: ["x"] },
      { input: "i", output: "o", tags: ["y", "z"] },
    ]),
  );

  importFromJSON(out, SYSTEM_CTX, false);

  // The import appends, so start from an empty file rather than seeded rows.
  t.deepEqual(loadTrainingData(false)[0].tags, ["x"]);
  t.deepEqual(loadTrainingData(false)[1].tags, ["y", "z"]);
});

test.serial("a hostile tags value cannot break the split", (t) => {
  // parseTrainingData casts each line straight to TrainingExample, so `tags`
  // can be anything the JSON held.
  const path = join(DATA_DIR, "train.jsonl");
  const lines = [
    JSON.stringify({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], tags: "math" }),
    JSON.stringify({ messages: [{ role: "user", content: "c" }, { role: "assistant", content: "d" }], tags: [1, null, {}, "science"] }),
    JSON.stringify({ messages: [{ role: "user", content: "e" }, { role: "assistant", content: "f" }], tags: ["__proto__"] }),
    JSON.stringify({ messages: [{ role: "user", content: "g" }, { role: "assistant", content: "h" }] }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);

  const result = splitTrainValidation(0.25, 1);

  t.is(result.trainCount + result.validCount, 4);
  t.is(countExamples(false) + countExamples(true), 4);
});

// ── category normalization ─────────────────────────────────────────────

test.serial("tags differing only in case land in one category", (t) => {
  for (let i = 0; i < 10; i++) {
    appendToTrainingData(
      { contextMessage: SYSTEM_CTX, userInput: `a${i}`, assistantOutput: `b${i}`, tags: ["Math"] },
      false,
    );
    appendToTrainingData(
      { contextMessage: SYSTEM_CTX, userInput: `c${i}`, assistantOutput: `d${i}`, tags: ["  math "] },
      false,
    );
    // A second category, or there is nothing to stratify and the report would
    // be empty for the right reason at the wrong moment.
    appendToTrainingData(
      { contextMessage: SYSTEM_CTX, userInput: `e${i}`, assistantOutput: `f${i}`, tags: ["Physics"] },
      false,
    );
  }

  const result = splitTrainValidation(0.5, 3);

  t.deepEqual(result.buckets.map(b => b.category), ["math", "physics"]);
  t.is(result.buckets[0].total, 20);
});

test.serial("a category named __proto__ is treated as an ordinary category", (t) => {
  for (let i = 0; i < 10; i++) {
    appendToTrainingData(
      { contextMessage: SYSTEM_CTX, userInput: `p${i}`, assistantOutput: `q${i}`, tags: ["__proto__"] },
      false,
    );
    appendToTrainingData(
      { contextMessage: SYSTEM_CTX, userInput: `r${i}`, assistantOutput: `s${i}`, tags: ["real"] },
      false,
    );
  }

  const result = splitTrainValidation(0.2, 3);

  t.deepEqual(result.buckets.map(b => b.category).sort(), ["__proto__", "real"]);
  t.is(({} as Record<string, unknown>).category, undefined);
});

test.serial("one category per example falls back instead of pretending to stratify", (t) => {
  seed(100, (i) => [`unique-${i}`]);
  const result = splitTrainValidation(0.1, 1);
  t.is(result.strategy, "random");
  t.is(result.validCount, 10);
});

// ── ensureValidationSet ────────────────────────────────────────────────

test.serial("ensureValidationSet forwards the stratify mode", (t) => {
  seed(60, (i) => [i % 2 === 0 ? "even" : "odd"]);
  const stratified = ensureValidationSet(21, "on");
  t.is(stratified.strategy, "stratified");
  t.true(stratified.didSplit);

  rmSync(join(DATA_DIR, "valid.jsonl"), { force: true });
  rmSync(join(DATA_DIR, "train.jsonl"), { force: true });
  seed(60, (i) => [i % 2 === 0 ? "even" : "odd"]);
  const random = ensureValidationSet(21, "off");
  t.is(random.strategy, "random");
});

test.serial("ensureValidationSet leaves an existing validation set alone", (t) => {
  seed(60, (i) => [i % 2 === 0 ? "even" : "odd"]);
  ensureValidationSet(1, "on");
  const second = ensureValidationSet(1, "on");
  t.false(second.didSplit);
  t.is(second.validCount, 6);
});

// ── data validate reports a train/validation overlap (#211 leakage) ─────

test.serial("countTrainValidOverlap finds nothing in a clean split", (t) => {
  seed(60, (i) => [i % 2 === 0 ? "even" : "odd"]);
  splitTrainValidation(0.2, 3);
  t.is(countTrainValidOverlap(), 0);
});

test.serial("countTrainValidOverlap spots a duplicated example", (t) => {
  seed(10);
  splitTrainValidation(0.2, 3);
  const leaked = loadTrainingData(true)[0];
  appendTrainingExample(leaked, false);
  t.is(countTrainValidOverlap(), 1);
});

test.serial("countTrainValidOverlap catches a pair differing only in punctuation", (t) => {
  // The validation loss for such a pair measures memorization of a string the
  // model has already been shown, which is why the split groups by fingerprint.
  seed(10);
  splitTrainValidation(0.2, 3);
  const original = loadTrainingData(true)[0];
  appendTrainingExample(
    {
      ...original,
      messages: original.messages.map(m => ({...m, content: `${m.content}!`})),
    },
    false,
  );
  t.is(countTrainValidOverlap(), 1);
});

test.serial("countTrainValidOverlap counts distinct examples, not repeats", (t) => {
  seed(10);
  splitTrainValidation(0.2, 3);
  const leaked = loadTrainingData(true)[0];
  appendTrainingExample(leaked, false);
  appendTrainingExample(leaked, false);
  t.is(countTrainValidOverlap(), 1);
});

test.serial("data validate reports the overlap as a warning and a failed check", (t) => {
  seed(60, (i) => [i % 2 === 0 ? "even" : "odd"]);
  splitTrainValidation(0.2, 3);
  appendTrainingExample(loadTrainingData(true)[0], false);

  const report = collectValidation();
  t.false(report.checks.noTrainValidOverlap);
  t.true(report.warnings.some(w => /both train\.jsonl and valid\.jsonl/.test(w)));
});

test.serial("data validate passes the overlap check on a clean split", (t) => {
  seed(60, (i) => [i % 2 === 0 ? "even" : "odd"]);
  splitTrainValidation(0.2, 3);

  const report = collectValidation();
  t.true(report.checks.noTrainValidOverlap);
});

// ── golden: the exact split a seed produces (#211) ────────────────────
//
// Reproducibility tests prove a seed gives the same answer twice. They do not
// prove the answer survived a refactor of the allocation, which is how every
// user's published evaluation numbers would silently shift. This pins it.

/**
 * A deliberately lopsided fixture: 380 common examples and 20 rare ones. A
 * random 10% split would put 10% of the rare ones in validation — two on
 * average, and nothing at all about a tenth of the time.
 */
const GOLDEN_TOTAL = 400;
const GOLDEN_RARE_FROM = 380;

function seedGoldenFixture(): void {
  for (let i = 0; i < GOLDEN_TOTAL; i++) {
    appendToTrainingData(
      {
        contextMessage: SYSTEM_CTX,
        userInput: `golden-q${i}`,
        assistantOutput: `golden-a${i}`,
        tags: [i >= GOLDEN_RARE_FROM ? "rare" : "common"],
      },
      false,
    );
  }
}

test.serial("the seeded split matches the golden fixture", (t) => {
  const golden = JSON.parse(
    readFileSync(
      join(ORIG_CWD, "src", "lib", "fixtures", "stratified-split.golden.json"),
      "utf-8",
    ),
  ) as {
    seed: number;
    ratio: number;
    strategy: "random" | "stratified" | "unstratifiable";
    categories: Record<string, number[]>;
  };

  seedGoldenFixture();
  const result = splitTrainValidation(golden.ratio, golden.seed, "on");

  const heldOut = contentsOf(true).map(content =>
    Number(content.replace("golden-q", "")),
  );
  const byCategory = new Map<string, number[]>();
  for (const index of heldOut) {
    const category = index >= GOLDEN_RARE_FROM ? "rare" : "common";
    byCategory.set(category, [...(byCategory.get(category) ?? []), index]);
  }

  t.is(result.strategy, golden.strategy);
  t.deepEqual(Object.fromEntries(byCategory), golden.categories);
  t.is(heldOut.length, 40);
});

test.serial("the golden fixture is still balanced the way stratification promises", (t) => {
  seedGoldenFixture();
  const result = splitTrainValidation(0.1, 4242, "on");

  t.is(result.strategy, "stratified");
  t.is(result.validCount, 40);
  // Both categories represented, and the rare one is not squeezed to nothing.
  const rare = result.buckets.find(b => b.category === "rare");
  t.truthy(rare, "no rare bucket reported");
  t.true((rare as {validation: number}).validation >= 2);
  t.deepEqual(result.unrepresentedCategories, []);
});

// ── crash safety, preserved from #162 ──────────────────────────────────

test.serial("a failed validation write leaves train.jsonl intact", (t) => {
  seed(20, (i) => [i % 2 === 0 ? "even" : "odd"]);
  // Occupy valid.jsonl's path with a non-empty directory so the atomic
  // rename inside saveTrainingData fails the way an interrupted write would.
  const validPath = join(DATA_DIR, "valid.jsonl");
  mkdirSync(validPath, { recursive: true });
  writeFileSync(join(validPath, "keep.txt"), "keep");

  t.throws(() => splitTrainValidation(0.1, 1));

  t.is(countExamples(false), 20);
  // No countExamples(true) here: valid.jsonl's path is a directory for this
  // test, and reading it would fail for a reason unrelated to the split.
});
