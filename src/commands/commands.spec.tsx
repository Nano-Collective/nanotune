import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "ava";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useKeyInput } from "../components/index.js";
import { loadTrainingData } from "../lib/data.js";
import { DataImportCommand } from "./data/import.js";
import { DataListCommand } from "./data/list.js";
import { DataValidateCommand } from "./data/validate.js";
import { StatusCommand } from "./status.js";

const ORIG_CWD = process.cwd();
const TEST_DIR = join(ORIG_CWD, ".test-commands-spec");
const NANOTUNE_DIR = join(TEST_DIR, ".nanotune");
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

function setupEmptyDir() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.chdir(TEST_DIR);
}

function setupProject() {
  setupEmptyDir();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    join(NANOTUNE_DIR, "config.json"),
    JSON.stringify(CONFIG, null, 2),
  );
}

function teardown() {
  process.chdir(ORIG_CWD);
  rmSync(TEST_DIR, { recursive: true, force: true });
  process.exitCode = 0;
}

function writeExamples(lines: object[]) {
  writeFileSync(
    join(DATA_DIR, "train.jsonl"),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

function example(userInput: string) {
  return {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: userInput },
      { role: "assistant", content: `reply to ${userInput}` },
    ],
  };
}

async function renderCommand(node: React.ReactElement, expectedString?: string) {
  const instance = render(node);
  
  if (expectedString) {
    // Poll until expected string appears or timeout
    const timeout = 2000;
    const pollInterval = 10;
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const output = instance.frames.join("\n");
      if (output.includes(expectedString)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  } else {
    // Fallback to fixed delay for backwards compatibility
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  
  const output = instance.frames.join("\n");
  instance.unmount();
  return output;
}

// ── error state when no project exists ──────────────────────────────

test.serial("StatusCommand renders its error state with no project", async (t) => {
  try {
    setupEmptyDir();
    const output = await renderCommand(<StatusCommand />, "Not a Nanotune project");
    t.true(output.includes("Not a Nanotune project"));
  } finally {
    teardown();
  }
});

test.serial("DataValidateCommand renders its error state with no project", async (t) => {
  try {
    setupEmptyDir();
    const output = await renderCommand(<DataValidateCommand />, "Not a Nanotune project");
    t.true(output.includes("Not a Nanotune project"));
  } finally {
    teardown();
  }
});

test.serial("DataListCommand renders its error state with no project", async (t) => {
  try {
    setupEmptyDir();
    const output = await renderCommand(<DataListCommand />, "Not a Nanotune project");
    t.true(output.includes("Not a Nanotune project"));
  } finally {
    teardown();
  }
});

// ── useKeyInput no-ops without a TTY ────────────────────────────────

function KeyProbe({ onKey }: { onKey: () => void }) {
  useKeyInput(onKey);
  return <Text>probe</Text>;
}

async function pressKeyAgainstProbe(isTTY: boolean | undefined) {
  const original = process.stdin.isTTY;
  process.stdin.isTTY = isTTY as true;
  let presses = 0;
  try {
    const instance = render(<KeyProbe onKey={() => presses++} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.stdin.write("x");
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.unmount();
  } finally {
    process.stdin.isTTY = original;
  }
  return presses;
}

test.serial("useKeyInput ignores keypresses when stdin is not a TTY", async (t) => {
  t.is(await pressKeyAgainstProbe(undefined), 0);
});

test.serial("useKeyInput receives keypresses when stdin is a TTY", async (t) => {
  t.is(await pressKeyAgainstProbe(true), 1);
});

test.serial("commands using useKeyInput render without a TTY", async (t) => {
  try {
    setupProject();
    t.not(process.stdin.isTTY, true);
    const output = await renderCommand(<DataListCommand />, "Training Data");
    t.true(output.includes("Training Data"));
    // KeyProbe above is the real crash guard; this test just confirms the command renders.
  } finally {
    teardown();
  }
});

// ── useAutoExit exit codes ──────────────────────────────────────────

test.serial("useAutoExit sets a non-zero exit code on failure", async (t) => {
  try {
    setupEmptyDir();
    process.exitCode = 0;
    await renderCommand(<StatusCommand />, "Not a Nanotune project");
    t.is(process.exitCode, 1);
  } finally {
    teardown();
  }
});

test.serial("useAutoExit leaves the exit code alone on success", async (t) => {
  try {
    setupProject();
    writeExamples([example("hello")]);
    process.exitCode = 0;
    await renderCommand(<DataValidateCommand />, "Training data is valid");
    t.is(process.exitCode, 0);
  } finally {
    teardown();
  }
});

// ── data validate reporting ─────────────────────────────────────────

test.serial("DataValidateCommand reports a valid dataset", async (t) => {
  try {
    setupProject();
    writeExamples([example("hello"), example("goodbye")]);
    const output = await renderCommand(<DataValidateCommand />, "Training data is valid");
    t.true(output.includes("Training data is valid!"));
    t.true(output.includes("Examples:"));
  } finally {
    teardown();
  }
});

test.serial("DataValidateCommand reports errors and warnings", async (t) => {
  try {
    setupProject();
    writeExamples([
      { messages: [{ role: "user", content: "lonely" }] },
      example("hello"),
      example("hello"),
    ]);
    const output = await renderCommand(<DataValidateCommand />, "Training data has errors");
    t.true(output.includes("Training data has errors"));
    t.true(output.includes("Errors:"));
    t.true(output.includes("Expected at least 2 messages"));
    t.true(output.includes("Warnings:"));
    t.true(output.includes("duplicate user inputs"));
  } finally {
    teardown();
  }
});

// ── data import --yes ───────────────────────────────────────────────

test.serial("DataImportCommand with yes skips the confirmation step", async (t) => {
  try {
    setupProject();
    const source = join(TEST_DIR, "source.jsonl");
    writeFileSync(source, `${JSON.stringify({ input: "q", output: "a" })}\n`);
    const output = await renderCommand(
      <DataImportCommand file="source.jsonl" yes />,
      "Import complete",
    );
    t.false(output.includes("Import data from this file?"));
    t.true(output.includes("Import complete!"));
    t.true(output.includes("Imported:"));
    // Verify data actually hit disk
    t.is(loadTrainingData().length, 1);
  } finally {
    teardown();
  }
});

test.serial("DataImportCommand without yes waits for confirmation", async (t) => {
  try {
    setupProject();
    const source = join(TEST_DIR, "source.jsonl");
    writeFileSync(source, `${JSON.stringify({ input: "q", output: "a" })}\n`);
    const output = await renderCommand(
      <DataImportCommand file="source.jsonl" />,
      "Import data from this file",
    );
    t.true(output.includes("Import data from this file?"));
    t.false(output.includes("Import complete!"));
  } finally {
    teardown();
  }
});
