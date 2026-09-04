import test from "ava";
import { buildJsonOutcome } from "./json-output.js";

test("buildJsonOutcome puts the collected value on stdout and nothing on stderr", async (t) => {
  const outcome = await buildJsonOutcome(() => ({ passRate: 0.9, total: 50 }));

  t.is(outcome.stderr, null);
  t.is(outcome.exitCode, 0);
  t.deepEqual(JSON.parse(outcome.stdout ?? ""), { passRate: 0.9, total: 50 });
});

test("buildJsonOutcome ends the document with a newline", async (t) => {
  const outcome = await buildJsonOutcome(() => ({ ok: true }));

  t.true(outcome.stdout?.endsWith("\n"));
});

test("buildJsonOutcome keeps stdout empty when the collector throws", async (t) => {
  const outcome = await buildJsonOutcome(() => {
    throw new Error("Not a Nanotune project. Run `nanotune init` first.");
  });

  t.is(outcome.stdout, null);
  t.is(outcome.stderr, "Not a Nanotune project. Run `nanotune init` first.");
  t.is(outcome.exitCode, 1);
});

test("buildJsonOutcome stringifies a thrown non-Error", async (t) => {
  const outcome = await buildJsonOutcome(() => {
    throw "plain string failure";
  });

  t.is(outcome.stdout, null);
  t.is(outcome.stderr, "plain string failure");
  t.is(outcome.exitCode, 1);
});

test("buildJsonOutcome still prints the report when failed() is true", async (t) => {
  const outcome = await buildJsonOutcome(
    () => ({ valid: false }),
    (result) => !result.valid,
  );

  // The report is the useful part even when it describes a bad state — it
  // prints, and the exit code is what CI gates on.
  t.deepEqual(JSON.parse(outcome.stdout ?? ""), { valid: false });
  t.is(outcome.stderr, null);
  t.is(outcome.exitCode, 1);
});

test("buildJsonOutcome exits zero when failed() is false", async (t) => {
  const outcome = await buildJsonOutcome(
    () => ({ valid: true }),
    (result) => !result.valid,
  );

  t.is(outcome.exitCode, 0);
});

test("buildJsonOutcome writes no partial document for an unserialisable value", async (t) => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  const outcome = await buildJsonOutcome(() => circular);

  t.is(outcome.stdout, null);
  t.is(outcome.exitCode, 1);
  t.true((outcome.stderr ?? "").length > 0);
});

test("buildJsonOutcome awaits an async collector", async (t) => {
  const outcome = await buildJsonOutcome(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { summary: { passRate: 0.5 } };
  });

  t.is(outcome.exitCode, 0);
  t.deepEqual(JSON.parse(outcome.stdout ?? ""), { summary: { passRate: 0.5 } });
});

test("buildJsonOutcome reports a rejected async collector on stderr", async (t) => {
  const outcome = await buildJsonOutcome(async () => {
    throw new Error("llama-server exited before any test completed");
  });

  t.is(outcome.stdout, null);
  t.is(outcome.stderr, "llama-server exited before any test completed");
  t.is(outcome.exitCode, 1);
});
