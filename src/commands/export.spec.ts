import test from "ava";
import { skipFuseValidationError } from "./export.js";

test("skipFuseValidationError is null when --skip-fuse is not set", (t) => {
  t.is(skipFuseValidationError(false, false), null);
  t.is(skipFuseValidationError(undefined, false), null);
});

test("skipFuseValidationError is null when --skip-fuse is set and fused/ exists", (t) => {
  t.is(skipFuseValidationError(true, true), null);
});

test("skipFuseValidationError reports a clear error when --skip-fuse is set but fused/ is missing", (t) => {
  const message = skipFuseValidationError(true, false);
  t.truthy(message);
  t.true(message!.includes("--skip-fuse"));
  t.true(message!.includes("fused"));
});
