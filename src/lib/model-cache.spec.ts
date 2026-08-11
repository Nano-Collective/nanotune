import { homedir } from "node:os";
import { join } from "node:path";
import test from "ava";
import { getBaseModelCachePath, sanitizeModelId } from "./model-cache.js";

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
