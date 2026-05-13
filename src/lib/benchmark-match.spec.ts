import test from "ava";
import { checkPass, normalizeText } from "./benchmark-match.js";

// ── normalizeText ─────────────────────────────────────────────────────

test("normalizeText collapses runs of whitespace to a single space", (t) => {
  t.is(normalizeText("a   b\t\tc"), "a b c");
});

test("normalizeText canonicalizes quote characters to double quotes", (t) => {
  t.is(normalizeText("it's a `test`"), 'it"s a "test"');
});

test("normalizeText trims leading and trailing whitespace", (t) => {
  t.is(normalizeText("  hello  "), "hello");
});

// ── checkPass: exact ──────────────────────────────────────────────────

test("checkPass exact accepts an exact match (case-insensitive default)", (t) => {
  const result = checkPass(["LS"], "ls", "exact");
  t.true(result.passed);
  t.is(result.matchType, "exact");
});

test("checkPass exact rejects extra characters", (t) => {
  t.false(checkPass(["ls"], "ls -la", "exact").passed);
});

test("checkPass exact with caseSensitive=true rejects case mismatch", (t) => {
  t.false(checkPass(["ls"], "LS", "exact", true).passed);
});

// ── checkPass: contains ───────────────────────────────────────────────

test("checkPass contains finds expected anywhere in actual", (t) => {
  const result = checkPass(["paris"], "The capital is Paris.", "contains");
  t.true(result.passed);
  t.is(result.matchType, "contains");
});

test("checkPass contains rejects when expected is absent", (t) => {
  t.false(checkPass(["lyon"], "The capital is Paris.", "contains").passed);
});

// ── checkPass: startsWith ─────────────────────────────────────────────

test("checkPass startsWith accepts a prefix match", (t) => {
  t.true(checkPass(["ls"], "ls -la", "startsWith").passed);
});

test("checkPass startsWith rejects when expected appears later", (t) => {
  t.false(checkPass(["ls"], "/bin/ls -la", "startsWith").passed);
});

// ── checkPass: partial (opt-in bidirectional) ─────────────────────────

test("checkPass partial accepts actual that extends expected", (t) => {
  t.true(checkPass(["ls"], "ls -la", "partial").passed);
});

test("checkPass partial accepts actual that is a truncation of expected", (t) => {
  // This is what makes `partial` opt-in: it can inflate pass rates.
  const result = checkPass(["ls -la"], "ls", "partial");
  t.true(result.passed);
  t.is(result.matchType, "partial");
});

test("checkPass partial rejects unrelated strings", (t) => {
  t.false(checkPass(["ls"], "pwd", "partial").passed);
});

// ── checkPass: semantic (default — must NOT accept truncations) ───────

test("checkPass semantic accepts exact match", (t) => {
  t.true(checkPass(["ls"], "ls", "semantic").passed);
});

test("checkPass semantic accepts actual that extends expected with a space", (t) => {
  // "ls" + " -la" — expected appears in full, trailing content is fine.
  t.true(checkPass(["ls"], "ls -la", "semantic").passed);
});

test("checkPass semantic accepts trailing content separated by colon", (t) => {
  t.true(checkPass(["paris"], "paris: city of light", "semantic").passed);
});

test("checkPass semantic accepts trailing content separated by newline", (t) => {
  t.true(checkPass(["ls"], "ls\nfoo bar", "semantic").passed);
});

test(
  "checkPass semantic REJECTS actual that is a truncation of expected (regression)",
  (t) => {
    // v1.4.0 bug fix: the old `semantic` mode had a branch that accepted any
    // actual that was a prefix of expected. With `acceptable: ["ls -la"]` and
    // actual `"ls"`, the old code returned passed=true, inflating pass rates
    // wherever the model emitted a truncated answer. This test asserts the
    // bug is gone.
    const result = checkPass(["ls -la"], "ls", "semantic");
    t.false(result.passed);
    t.is(result.matchType, null);
  },
);

test("checkPass semantic rejects expected as a non-prefix substring of actual", (t) => {
  // Expected must appear at the start, not embedded mid-string.
  t.false(checkPass(["ls"], "echo ls", "semantic").passed);
});

// ── checkPass: edge cases ─────────────────────────────────────────────

test("checkPass returns the matched answer in the result", (t) => {
  const result = checkPass(["ls -la", "ls -a"], "ls -la", "semantic");
  t.true(result.passed);
  t.is(result.matchedAnswer, "ls -la");
});

test("checkPass returns the first matching acceptable", (t) => {
  // Both candidates would match; first one wins.
  const result = checkPass(["ls", "list"], "ls", "exact");
  t.is(result.matchedAnswer, "ls");
});

test("checkPass with no acceptable answers returns passed=false", (t) => {
  const result = checkPass([], "anything", "semantic");
  t.false(result.passed);
  t.is(result.matchedAnswer, null);
  t.is(result.matchType, null);
});

test("checkPass defaults to semantic mode when no mode is passed", (t) => {
  // The semantic regression must apply to the default too.
  t.false(checkPass(["ls -la"], "ls").passed);
});

test("checkPass semantic ignores quote-style differences via normalizeText", (t) => {
  // "she said 'hello'" should match acceptable `she said "hello"` because
  // normalizeText canonicalizes quote characters.
  t.true(
    checkPass(['she said "hello"'], "she said 'hello'", "semantic").passed,
  );
});
