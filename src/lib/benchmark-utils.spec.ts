import test from "ava";
import type { BenchmarkTest } from "../types/index.js";
import {
  buildMessages,
  DEFAULT_BENCHMARK_SEED,
  DEFAULT_BENCHMARK_TEMPERATURE,
  formatConversationForJudge,
  getTestDisplayPrompt,
  resolveSamplingOptions,
  summarizeSamples,
} from "./benchmark-utils.js";

// ── getTestDisplayPrompt ────────────────────────────────────────────

test("getTestDisplayPrompt returns prompt for single-turn test", (t) => {
  const singleTurn: BenchmarkTest = {
    id: 1,
    prompt: "list all files",
    acceptable: ["ls"],
    category: "basic",
  };
  t.is(getTestDisplayPrompt(singleTurn), "list all files");
});

test("getTestDisplayPrompt returns last user message for multi-turn test", (t) => {
  const multiTurn: BenchmarkTest = {
    id: 2,
    messages: [
      { role: "user", content: "My name is Alice" },
      { role: "assistant", content: "Hello Alice!" },
      { role: "user", content: "What's my name?" },
    ],
    acceptable: ["Alice"],
    category: "memory",
  };
  t.is(getTestDisplayPrompt(multiTurn), "What's my name?");
});

test("getTestDisplayPrompt returns empty string for test with neither", (t) => {
  const empty: BenchmarkTest = { id: 3, category: "other" };
  t.is(getTestDisplayPrompt(empty), "");
});

// ── buildMessages ───────────────────────────────────────────────────

const ctx = { role: "system", content: "You are helpful." };

test("buildMessages single-turn prepends context and user message", (t) => {
  const singleTurn: BenchmarkTest = {
    id: 1,
    prompt: "list all files",
    acceptable: ["ls"],
    category: "basic",
  };
  t.deepEqual(buildMessages(singleTurn, ctx), [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "list all files" },
  ]);
});

test("buildMessages multi-turn preserves messages array verbatim", (t) => {
  const multiTurn: BenchmarkTest = {
    id: 2,
    messages: [
      { role: "user", content: "My name is Alice" },
      { role: "assistant", content: "Hello Alice!" },
      { role: "user", content: "What's my name?" },
    ],
    acceptable: ["Alice"],
    category: "memory",
  };
  t.deepEqual(buildMessages(multiTurn, ctx), [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "My name is Alice" },
    { role: "assistant", content: "Hello Alice!" },
    { role: "user", content: "What's my name?" },
  ]);
});

test("buildMessages omits empty context message", (t) => {
  const singleTurn: BenchmarkTest = {
    id: 1,
    prompt: "hi",
    acceptable: ["hello"],
    category: "basic",
  };
  t.deepEqual(buildMessages(singleTurn, { role: "system", content: "" }), [
    { role: "user", content: "hi" },
  ]);
});

test("buildMessages uses custom context role", (t) => {
  const singleTurn: BenchmarkTest = {
    id: 1,
    prompt: "hi",
    acceptable: ["hello"],
    category: "basic",
  };
  const devCtx = { role: "developer", content: "code rules" };
  t.deepEqual(buildMessages(singleTurn, devCtx), [
    { role: "developer", content: "code rules" },
    { role: "user", content: "hi" },
  ]);
});

// ── formatConversationForJudge ──────────────────────────────────────

test("formatConversationForJudge includes context and labeled turns", (t) => {
  const messages = [
    { role: "user", content: "My name is Alice" },
    { role: "assistant", content: "Hello Alice!" },
    { role: "user", content: "What's my name?" },
  ];
  const result = formatConversationForJudge(messages, ctx);
  t.is(
    result,
    "[Context (system)]: You are helpful.\n[User]: My name is Alice\n[Assistant]: Hello Alice!\n[User]: What's my name?",
  );
});

test("formatConversationForJudge omits context line when content is empty", (t) => {
  const messages = [{ role: "user", content: "Hello" }];
  const result = formatConversationForJudge(messages, {
    role: "system",
    content: "",
  });
  t.is(result, "[User]: Hello");
});

// ── resolveSamplingOptions ──────────────────────────────────────────

test("resolveSamplingOptions defaults to a deterministic temperature and seed", (t) => {
  const resolved = resolveSamplingOptions({});

  t.is(resolved.temperature, 0);
  t.is(resolved.temperature, DEFAULT_BENCHMARK_TEMPERATURE);
  t.is(resolved.seed, DEFAULT_BENCHMARK_SEED);
  t.is(resolved.samples, 1);
});

test("resolveSamplingOptions is stable across calls with the same input", (t) => {
  t.deepEqual(resolveSamplingOptions({}), resolveSamplingOptions({}));
});

test("resolveSamplingOptions honours an explicit temperature", (t) => {
  t.is(resolveSamplingOptions({ temperature: "0.8" }).temperature, 0.8);
  t.is(resolveSamplingOptions({ temperature: "1" }).temperature, 1);
});

test("resolveSamplingOptions honours an explicit temperature of zero", (t) => {
  t.is(resolveSamplingOptions({ temperature: "0" }).temperature, 0);
});

test("resolveSamplingOptions honours an explicit seed, including zero", (t) => {
  t.is(resolveSamplingOptions({ seed: "123" }).seed, 123);
  t.is(resolveSamplingOptions({ seed: "0" }).seed, 0);
});

test("resolveSamplingOptions reports an error for each unparseable value", (t) => {
  // Silently defaulting would run a greedy suite under a --temperature the
  // user believed had enabled sampling, and record settings they never typed.
  const resolved = resolveSamplingOptions({
    temperature: "hot",
    seed: "later",
    samples: "many",
  });

  t.is(resolved.errors.length, 3);
  t.true(resolved.errors[0].includes("--temperature"));
  t.true(resolved.errors[1].includes("--seed"));
  t.true(resolved.errors[2].includes("--samples"));
});

test("resolveSamplingOptions rejects trailing garbage rather than truncating it", (t) => {
  t.is(resolveSamplingOptions({ samples: "5abc" }).errors.length, 1);
  t.is(resolveSamplingOptions({ seed: "42abc" }).errors.length, 1);
  t.is(resolveSamplingOptions({ temperature: "0.8xyz" }).errors.length, 1);
});

test("resolveSamplingOptions rejects a blank value", (t) => {
  t.is(resolveSamplingOptions({ seed: "   " }).errors.length, 1);
});

test("resolveSamplingOptions parses samples and rejects non-positive counts", (t) => {
  t.is(resolveSamplingOptions({ samples: "5" }).samples, 5);
  t.is(resolveSamplingOptions({ samples: "5" }).errors.length, 0);
  t.is(resolveSamplingOptions({ samples: "0" }).errors.length, 1);
  t.is(resolveSamplingOptions({ samples: "-3" }).errors.length, 1);
  t.is(resolveSamplingOptions({ samples: "2.5" }).errors.length, 1);
});

test("resolveSamplingOptions rejects a negative temperature but allows zero", (t) => {
  t.is(resolveSamplingOptions({ temperature: "-1" }).errors.length, 1);
  t.is(resolveSamplingOptions({ temperature: "0" }).errors.length, 0);
});

test("resolveSamplingOptions rejects a fractional seed", (t) => {
  t.is(resolveSamplingOptions({ seed: "3.7" }).errors.length, 1);
});

test("resolveSamplingOptions reports no errors when every flag is absent", (t) => {
  t.deepEqual(resolveSamplingOptions({}).errors, []);
});

// ── summarizeSamples ────────────────────────────────────────────────

test("summarizeSamples reports a unanimous pass with no variance", (t) => {
  const summary = summarizeSamples([true, true, true, true]);

  t.true(summary.passed);
  t.is(summary.passRate, 1);
  t.is(summary.variance, 0);
});

test("summarizeSamples reports a unanimous failure with no variance", (t) => {
  const summary = summarizeSamples([false, false, false]);

  t.false(summary.passed);
  t.is(summary.passRate, 0);
  t.is(summary.variance, 0);
});

test("summarizeSamples reports pass rate and variance for a mixed run", (t) => {
  const summary = summarizeSamples([true, false, false, false]);

  t.false(summary.passed);
  t.is(summary.passRate, 0.25);
  t.is(summary.variance, 0.1875);
});

test("summarizeSamples treats a majority of passes as a pass", (t) => {
  t.true(summarizeSamples([true, true, false]).passed);
  t.false(summarizeSamples([true, false, false]).passed);
});

test("summarizeSamples treats an exact tie (2 of 4) as a failure", (t) => {
  const summary = summarizeSamples([true, false, true, false]);
  t.false(summary.passed); // 50% is not a majority
  t.is(summary.passRate, 0.5);
});

test("summarizeSamples reduces to the single outcome for one sample", (t) => {
  t.true(summarizeSamples([true]).passed);
  t.is(summarizeSamples([true]).passRate, 1);
  t.false(summarizeSamples([false]).passed);
  t.is(summarizeSamples([false]).passRate, 0);
});

test("summarizeSamples handles an empty sample list", (t) => {
  const summary = summarizeSamples([]);

  t.false(summary.passed);
  t.is(summary.passRate, 0);
  t.is(summary.variance, 0);
});
