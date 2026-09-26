import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "ava";
import { render } from "ink-testing-library";
import { loadTrainingData } from "../../lib/data.js";
import type { BenchmarkResult } from "../../types/index.js";
import { BenchmarkReviewCommand } from "./review.js";

const ORIG_CWD = process.cwd();
const TEST_DIR = join(ORIG_CWD, ".test-review-spec");
const NANOTUNE_DIR = join(TEST_DIR, ".nanotune");
const BENCH_DIR = join(NANOTUNE_DIR, "benchmarks");
const DATA_DIR = join(NANOTUNE_DIR, "data");

const CONFIG = {
  name: "test-project",
  version: "1.0.0",
  baseModel: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
  contextMessage: { role: "system", content: "You are helpful." },
  training: {
    iterations: 150,
    learningRate: 5e-5,
    batchSize: 4,
    numLayers: 16,
    stepsPerEval: 50,
    saveEvery: 50,
  },
  export: { quantization: "q4_k_m", outputName: "test" },
};

function setupProject() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(BENCH_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    join(NANOTUNE_DIR, "config.json"),
    JSON.stringify(CONFIG, null, 2),
  );
  process.chdir(TEST_DIR);
}

function setupEmptyDir() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.chdir(TEST_DIR);
}

function teardown() {
  process.chdir(ORIG_CWD);
  rmSync(TEST_DIR, { recursive: true, force: true });
  process.exitCode = 0;
}

function writeRun(
  filename: string,
  overrides: Partial<BenchmarkResult> = {},
): string {
  const path = join(BENCH_DIR, filename);
  const body: BenchmarkResult = {
    model: "test-model",
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: { total: 2, passed: 0, failed: 2, passRate: 0 },
    categories: {},
    results: [],
    failures: [],
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

async function waitFor(
  getOutput: () => string,
  expected: string,
  timeout = 2000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (getOutput().includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

// ── error states ──────────────────────────────────────────────────────

test.serial("refuses to run outside a project", async (t) => {
  try {
    setupEmptyDir();
    process.exitCode = 0;
    const instance = render(<BenchmarkReviewCommand />);
    const output = () => instance.frames.join("\n");
    await waitFor(output, "Not a Nanotune project");
    instance.unmount();
    t.true(output().includes("Not a Nanotune project"));
  } finally {
    teardown();
  }
});

test.serial("reports when no saved benchmark runs exist", async (t) => {
  try {
    setupProject();
    process.exitCode = 0;
    const instance = render(<BenchmarkReviewCommand />);
    const output = () => instance.frames.join("\n");
    await waitFor(output, "No saved benchmark runs found");
    instance.unmount();
    t.true(output().includes("No saved benchmark runs found"));
  } finally {
    teardown();
  }
});

test.serial("reports an error for an unknown report name", async (t) => {
  try {
    setupProject();
    process.exitCode = 0;
    const instance = render(
      <BenchmarkReviewCommand report="does-not-exist" />,
    );
    const output = () => instance.frames.join("\n");
    await waitFor(output, "Could not find a benchmark run");
    instance.unmount();
    t.true(output().includes("Could not find a benchmark run"));
  } finally {
    teardown();
  }
});

// ── zero failures ─────────────────────────────────────────────────────

test.serial(
  "a report with no failures says so and does not enter the review loop",
  async (t) => {
    try {
      setupProject();
      writeRun("benchmark-clean.json", {
        summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
        failures: [],
      });
      const instance = render(<BenchmarkReviewCommand />);
      const output = () => instance.frames.join("\n");
      await waitFor(output, "nothing to review");
      instance.unmount();
      t.true(output().includes("nothing to review"));
    } finally {
      teardown();
    }
  },
);

// ── the review loop ───────────────────────────────────────────────────

test.serial(
  "typing a correction appends it to train.jsonl and advances to the next failure",
  async (t) => {
    const original = process.stdin.isTTY;
    try {
      setupProject();
      writeRun("benchmark-run.json", {
        failures: [
          { id: 1, prompt: "list files", expected: ["ls"], actual: "dir" },
          { id: 2, prompt: "show pwd", expected: ["pwd"], actual: "cd" },
        ],
      });
      process.stdin.isTTY = true;

      const instance = render(<BenchmarkReviewCommand />);
      const output = () => instance.frames.join("\n");
      await waitFor(output, "Failure 1/2");
      await settle();
      instance.stdin.write("ls");
      await settle();
      instance.stdin.write("\r");
      await waitFor(output, "Failure 2/2");
      instance.unmount();

      const data = loadTrainingData();
      t.is(data.length, 1, output());
      const messages = data[0].messages;
      t.true(
        messages.some((m) => m.role === "user" && m.content === "list files"),
      );
      t.true(
        messages.some((m) => m.role === "assistant" && m.content === "ls"),
      );
      // The project's context message travels with the example, same as
      // chat's /keep.
      t.true(
        messages.some(
          (m) => m.role === "system" && m.content === "You are helpful.",
        ),
      );
    } finally {
      process.stdin.isTTY = original;
      teardown();
    }
  },
);

test.serial(
  "an empty submission skips without writing, and the final tally reports it",
  async (t) => {
    const original = process.stdin.isTTY;
    try {
      setupProject();
      writeRun("benchmark-run.json", {
        failures: [
          { id: 1, prompt: "list files", expected: ["ls"], actual: "dir" },
        ],
      });
      process.stdin.isTTY = true;

      const instance = render(<BenchmarkReviewCommand />);
      const output = () => instance.frames.join("\n");
      await waitFor(output, "Failure 1/1");
      await settle();
      instance.stdin.write("\r");
      await waitFor(output, "skipped");
      instance.unmount();

      t.is(loadTrainingData().length, 0);
      t.true(output().includes("1 skipped"), output());
    } finally {
      process.stdin.isTTY = original;
      teardown();
    }
  },
);

test.serial(
  "a multi-turn failure's correction preserves the earlier turns",
  async (t) => {
    const original = process.stdin.isTTY;
    try {
      setupProject();
      writeRun("benchmark-run.json", {
        failures: [
          {
            id: 3,
            prompt: "follow-up question",
            messages: [
              { role: "user", content: "turn one" },
              { role: "assistant", content: "reply one" },
              { role: "user", content: "follow-up question" },
            ],
            expected: ["expected answer"],
            actual: "wrong answer",
          },
        ],
      });
      process.stdin.isTTY = true;

      const instance = render(<BenchmarkReviewCommand />);
      const output = () => instance.frames.join("\n");
      await waitFor(output, "Conversation:");
      await settle();
      instance.stdin.write("expected answer");
      await settle();
      instance.stdin.write("\r");
      await waitFor(output, "Reviewed 1/1");
      instance.unmount();

      const data = loadTrainingData();
      t.is(data.length, 1, output());
      t.deepEqual(
        data[0].messages.map((m) => `${m.role}:${m.content}`),
        [
          "system:You are helpful.",
          "user:turn one",
          "assistant:reply one",
          "user:follow-up question",
          "assistant:expected answer",
        ],
      );
    } finally {
      process.stdin.isTTY = original;
      teardown();
    }
  },
);

test.serial(
  "Esc stops the review early and reports partial progress",
  async (t) => {
    const original = process.stdin.isTTY;
    try {
      setupProject();
      writeRun("benchmark-run.json", {
        failures: [
          { id: 1, prompt: "a", expected: ["x"], actual: "y" },
          { id: 2, prompt: "b", expected: ["x"], actual: "y" },
        ],
      });
      process.stdin.isTTY = true;

      const instance = render(<BenchmarkReviewCommand />);
      const output = () => instance.frames.join("\n");
      await waitFor(output, "Failure 1/2");
      await settle();
      instance.stdin.write("");
      await waitFor(output, "Reviewed 0/2");
      instance.unmount();

      t.true(output().includes("Reviewed 0/2"));
    } finally {
      process.stdin.isTTY = original;
      teardown();
    }
  },
);
