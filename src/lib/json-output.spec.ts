import test from "ava";
import { buildJsonOutcome } from "./json-output.js";

test("buildJsonOutcome puts the collected value on stdout and nothing on stderr", (t) => {
  const outcome = buildJsonOutcome(() => ({ passRate: 0.9, total: 50 }));

  t.is(outcome.stderr, null);
  t.is(outcome.exitCode, 0);
  t.deepEqual(JSON.parse(outcome.stdout ?? ""), { passRate: 0.9, total: 50 });
});

test("buildJsonOutcome ends the document with a newline", (t) => {
  const outcome = buildJsonOutcome(() => ({ ok: true }));

  t.true(outcome.stdout?.endsWith("\n"));
});

test("buildJsonOutcome keeps stdout empty when the collector throws", (t) => {
  const outcome = buildJsonOutcome(() => {
    throw new Error("Not a Nanotune project. Run `nanotune init` first.");
  });

  t.is(outcome.stdout, null);
  t.is(outcome.stderr, "Not a Nanotune project. Run `nanotune init` first.");
  t.is(outcome.exitCode, 1);
});

test("buildJsonOutcome stringifies a thrown non-Error", (t) => {
  const outcome = buildJsonOutcome(() => {
    throw "plain string failure";
  });

  t.is(outcome.stdout, null);
  t.is(outcome.stderr, "plain string failure");
  t.is(outcome.exitCode, 1);
});

test("buildJsonOutcome still prints the report when failed() is true", (t) => {
  const outcome = buildJsonOutcome(
    () => ({ valid: false }),
    (result) => !result.valid,
  );

  // The report is the useful part even when it describes a bad state — it
  // prints, and the exit code is what CI gates on.
  t.deepEqual(JSON.parse(outcome.stdout ?? ""), { valid: false });
  t.is(outcome.stderr, null);
  t.is(outcome.exitCode, 1);
});

test("buildJsonOutcome exits zero when failed() is false", (t) => {
  const outcome = buildJsonOutcome(
    () => ({ valid: true }),
    (result) => !result.valid,
  );

  t.is(outcome.exitCode, 0);
});

test("buildJsonOutcome writes no partial document for an unserialisable value", (t) => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  const outcome = buildJsonOutcome(() => circular);

  t.is(outcome.stdout, null);
  t.is(outcome.exitCode, 1);
  t.true((outcome.stderr ?? "").length > 0);
});
