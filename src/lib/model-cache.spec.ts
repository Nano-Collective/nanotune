import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "ava";
import {
  getBaseModelCachePath,
  sanitizeModelId,
  sweepStaleCacheArtifacts,
} from "./model-cache.js";

test("sanitizeModelId replaces slashes with double dashes", (t) => {
  t.is(sanitizeModelId("Qwen/Qwen2.5-Coder-1.5B-Instruct"), "Qwen--Qwen2.5-Coder-1.5B-Instruct");
});

test("sanitizeModelId leaves ids without slashes unchanged", (t) => {
  t.is(sanitizeModelId("gpt2"), "gpt2");
});

test("sanitizeModelId replaces every slash in a nested id", (t) => {
  t.is(sanitizeModelId("org/team/model"), "org--team--model");
});

test("getBaseModelCachePath composes a deterministic path from model id and quantization", (t) => {
  const path = getBaseModelCachePath("Qwen/Qwen2.5-Coder-1.5B-Instruct", "q4_k_m");
  t.is(
    path,
    join(homedir(), ".nanotune", "models", "base-cache", "Qwen--Qwen2.5-Coder-1.5B-Instruct-q4_k_m.gguf"),
  );
});

test("getBaseModelCachePath varies with quantization", (t) => {
  const q4 = getBaseModelCachePath("org/model", "q4_k_m");
  const f16 = getBaseModelCachePath("org/model", "f16");
  t.not(q4, f16);
});

// ── sweepStaleCacheArtifacts ─────────────────────────────────────────

const SWEEP_TEST_DIR = join(process.cwd(), ".test-model-cache-sweep");

test.serial("sweepStaleCacheArtifacts is a no-op when the directory doesn't exist", (t) => {
  rmSync(SWEEP_TEST_DIR, { recursive: true, force: true });
  t.notThrows(() => sweepStaleCacheArtifacts(SWEEP_TEST_DIR));
});

test.serial("sweepStaleCacheArtifacts removes stale .tmp-<pid>.gguf and -f16.gguf leftovers", (t) => {
  rmSync(SWEEP_TEST_DIR, { recursive: true, force: true });
  mkdirSync(SWEEP_TEST_DIR, { recursive: true });
  try {
    const staleTemp = join(SWEEP_TEST_DIR, "model-q4_k_m.tmp-1234.gguf");
    const staleF16 = join(SWEEP_TEST_DIR, "model-q4_k_m.tmp-1234-f16.gguf");
    const validCache = join(SWEEP_TEST_DIR, "model-q4_k_m.gguf");
    writeFileSync(staleTemp, "stub");
    writeFileSync(staleF16, "stub");
    writeFileSync(validCache, "stub");

    sweepStaleCacheArtifacts(SWEEP_TEST_DIR);

    t.false(existsSync(staleTemp));
    t.false(existsSync(staleF16));
    t.true(existsSync(validCache));
  } finally {
    rmSync(SWEEP_TEST_DIR, { recursive: true, force: true });
  }
});
