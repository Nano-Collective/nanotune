import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "ava";
import { collectStatus } from "./status.js";

const ORIG_CWD = process.cwd();
const TEST_DIR = join(ORIG_CWD, ".test-status-spec");
const NANOTUNE_DIR = join(TEST_DIR, ".nanotune");
const DATA_DIR = join(NANOTUNE_DIR, "data");
const MODELS_DIR = join(NANOTUNE_DIR, "models");
const ADAPTERS_DIR = join(NANOTUNE_DIR, "adapters");
const BENCHMARKS_DIR = join(NANOTUNE_DIR, "benchmarks");

const CONFIG = {
  name: "test-project",
  version: "1.0.0",
  baseModel: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
  contextMessage: { role: "system", content: "You are helpful." },
  training: {},
  export: { quantization: "q4_k_m", outputName: "test" },
};

function writeExamples(path: string, count: number) {
  const lines = Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: `q${i}` },
        { role: "assistant", content: `a${i}` },
      ],
    }),
  );
  writeFileSync(path, `${lines.join("\n")}\n`);
}

/** Write a GGUF of `size` bytes with an explicit mtime, so ordering is deterministic. */
function writeModel(name: string, size: number, mtime: Date) {
  const path = join(MODELS_DIR, name);
  writeFileSync(path, "x".repeat(size));
  utimesSync(path, mtime, mtime);
}

test.beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  for (const dir of [DATA_DIR, MODELS_DIR, ADAPTERS_DIR, BENCHMARKS_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    join(NANOTUNE_DIR, "config.json"),
    JSON.stringify(CONFIG, null, 2),
  );
  process.chdir(TEST_DIR);
});

test.afterEach.always(() => {
  process.chdir(ORIG_CWD);
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test.serial("collectStatus reports project metadata from config", (t) => {
  const report = collectStatus();

  t.deepEqual(report.project, {
    name: "test-project",
    version: "1.0.0",
    baseModel: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
  });
});

test.serial("collectStatus counts training and validation examples", (t) => {
  writeExamples(join(DATA_DIR, "train.jsonl"), 12);
  writeExamples(join(DATA_DIR, "valid.jsonl"), 3);

  const report = collectStatus();

  t.is(report.data.trainExamples, 12);
  t.is(report.data.validExamples, 3);
  t.is(typeof report.data.trainLastModified, "string");
});

test.serial("collectStatus nulls absent timestamps rather than omitting them", (t) => {
  const report = collectStatus();

  // A consumer should never have to tell a missing key from a null one.
  t.true("trainLastModified" in report.data);
  t.is(report.data.trainLastModified, null);
  t.is(report.training.lastRun, null);
  t.false(report.training.hasTrained);
  t.is(report.benchmarks.latest, null);
  t.deepEqual(report.exports, []);
});

test.serial("collectStatus reports training once an adapter exists", (t) => {
  writeFileSync(join(ADAPTERS_DIR, "adapters.safetensors"), "weights");

  const report = collectStatus();

  t.true(report.training.hasTrained);
  t.is(typeof report.training.lastRun, "string");
});

test.serial("collectStatus lists GGUF exports newest first with raw byte sizes", (t) => {
  writeModel("old.gguf", 100, new Date("2026-01-01T00:00:00Z"));
  writeModel("newest.gguf", 250, new Date("2026-03-01T00:00:00Z"));
  writeModel("middle.gguf", 175, new Date("2026-02-01T00:00:00Z"));

  const report = collectStatus();

  t.deepEqual(
    report.exports.map((e) => e.name),
    ["newest.gguf", "middle.gguf", "old.gguf"],
  );
  t.is(report.exports[0].sizeBytes, 250);
  t.is(report.exports[0].modified, "2026-03-01T00:00:00.000Z");
});

test.serial("collectStatus ignores non-GGUF files in the models directory", (t) => {
  writeModel("real.gguf", 10, new Date("2026-01-01T00:00:00Z"));
  writeFileSync(join(MODELS_DIR, "notes.txt"), "ignore me");

  const report = collectStatus();

  t.deepEqual(
    report.exports.map((e) => e.name),
    ["real.gguf"],
  );
});

test.serial("collectStatus summarises the latest benchmark run", (t) => {
  writeFileSync(
    join(BENCHMARKS_DIR, "benchmark-2026-03-01T10-00-00-000Z.json"),
    JSON.stringify({
      model: "test.gguf",
      timestamp: "2026-03-01T10:00:00.000Z",
      isBase: true,
      summary: { total: 50, passed: 45, failed: 5, passRate: 0.9 },
      categories: {},
      results: [],
      failures: [],
    }),
  );

  const report = collectStatus();

  t.deepEqual(report.benchmarks.latest, {
    file: "benchmark-2026-03-01T10-00-00-000Z.json",
    timestamp: "2026-03-01T10:00:00.000Z",
    passed: 45,
    total: 50,
    passRate: 0.9,
    isBase: true,
  });
});

test.serial("collectStatus reports no benchmark when the saved run is corrupt", (t) => {
  writeFileSync(
    join(BENCHMARKS_DIR, "benchmark-broken.json"),
    "{ not valid json",
  );

  // A half-written run must not take the whole status report down with it.
  const report = collectStatus();

  t.is(report.benchmarks.latest, null);
  t.is(report.project.name, "test-project");
});

test.serial("collectStatus throws the init hint outside a project", (t) => {
  rmSync(join(NANOTUNE_DIR, "config.json"));

  const error = t.throws(() => collectStatus());

  t.true(error?.message.includes("Not a Nanotune project"));
});
