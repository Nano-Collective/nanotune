import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "ava";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useKeyInput } from "../components/index.js";
import { getFusedModelDir } from "../lib/config.js";
import { loadTrainingData } from "../lib/data.js";
import { CleanCommand } from "./clean.js";
import { ChatCommand, streamPreview } from "./chat.js";
import { DataExportCommand } from "./data/export.js";
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

function writeFusedModel() {
  const fusedDir = join(NANOTUNE_DIR, "models", "fused");
  mkdirSync(fusedDir, { recursive: true });
  writeFileSync(join(fusedDir, "model.safetensors"), "x".repeat(1024));
}

// Simulates an export interrupted before mlx_lm.fuse finished writing
// weights: the directory exists but has no .safetensors file yet.
function writeIncompleteFusedModel() {
  const fusedDir = join(NANOTUNE_DIR, "models", "fused");
  mkdirSync(fusedDir, { recursive: true });
  writeFileSync(join(fusedDir, "config.json"), "{}");
}

function writeEvalExamples(lines: object[]) {
  writeFileSync(
    join(DATA_DIR, "valid.jsonl"),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function userContent(example: { messages: { role: string; content: string }[] }) {
  return example.messages.find((m) => m.role === "user")?.content;
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

// ── clean ────────────────────────────────────────────────────────────

test.serial("CleanCommand renders its error state with no project", async (t) => {
  try {
    setupEmptyDir();
    const output = await renderCommand(
      <CleanCommand options={{}} />,
      "Not a Nanotune project",
    );
    t.true(output.includes("Not a Nanotune project"));
  } finally {
    teardown();
  }
});

test.serial("CleanCommand reports nothing to clean when fused/ is absent", async (t) => {
  try {
    setupProject();
    const output = await renderCommand(
      <CleanCommand options={{}} />,
      "Nothing to clean",
    );
    t.true(output.includes("Nothing to clean"));
  } finally {
    teardown();
  }
});

test.serial("CleanCommand with yes removes fused/ without prompting", async (t) => {
  try {
    setupProject();
    writeFusedModel();
    const fusedDir = getFusedModelDir();
    t.true(existsSync(fusedDir));
    const output = await renderCommand(
      <CleanCommand options={{ yes: true }} />,
      "Removed fused model cache",
    );
    t.false(output.includes("Remove it?"));
    t.true(output.includes("Removed fused model cache"));
    t.true(output.includes("Freed:"));
    t.false(existsSync(fusedDir));
  } finally {
    teardown();
  }
});

test.serial("CleanCommand without yes waits for confirmation before deleting", async (t) => {
  try {
    setupProject();
    writeFusedModel();
    const fusedDir = getFusedModelDir();
    const output = await renderCommand(
      <CleanCommand options={{}} />,
      "Remove it?",
    );
    t.true(output.includes("Remove it?"));
    t.false(output.includes("Removed fused model cache"));
    t.true(existsSync(fusedDir));
  } finally {
    teardown();
  }
});

test.serial("CleanCommand treats a leftover incomplete fused/ as nothing to clean", async (t) => {
  try {
    setupProject();
    writeIncompleteFusedModel();
    const fusedDir = getFusedModelDir();
    const output = await renderCommand(
      <CleanCommand options={{}} />,
      "Nothing to clean",
    );
    t.true(output.includes("Nothing to clean"));
    t.false(output.includes("Remove it?"));
    // The (non-safetensors) leftover directory is left alone, not deleted.
    t.true(existsSync(fusedDir));
  } finally {
    teardown();
  }
});

test.serial("CleanCommand deletes the cache on a confirming 'y' keypress", async (t) => {
  const originalIsTTY = process.stdin.isTTY;
  try {
    process.stdin.isTTY = true as true;
    setupProject();
    writeFusedModel();
    const fusedDir = getFusedModelDir();
    const instance = render(<CleanCommand options={{}} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    t.true(instance.frames.join("\n").includes("Remove it?"));

    instance.stdin.write("y");
    const timeout = 2000;
    const pollInterval = 10;
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (instance.frames.join("\n").includes("Removed fused model cache")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    const output = instance.frames.join("\n");
    instance.unmount();

    t.true(output.includes("Removed fused model cache"));
    t.true(output.includes("Freed:"));
    t.false(existsSync(fusedDir));
  } finally {
    process.stdin.isTTY = originalIsTTY;
    teardown();
  }
});

test.serial("CleanCommand leaves the cache in place on an 'n' keypress", async (t) => {
  const originalIsTTY = process.stdin.isTTY;
  try {
    process.stdin.isTTY = true as true;
    setupProject();
    writeFusedModel();
    const fusedDir = getFusedModelDir();
    const instance = render(<CleanCommand options={{}} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    t.true(instance.frames.join("\n").includes("Remove it?"));

    instance.stdin.write("n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = instance.frames.join("\n");
    instance.unmount();

    t.false(output.includes("Removed fused model cache"));
    t.true(existsSync(fusedDir));
  } finally {
    process.stdin.isTTY = originalIsTTY;
    teardown();
  }
});

test.serial("CleanCommand leaves the cache in place on Escape", async (t) => {
  const originalIsTTY = process.stdin.isTTY;
  try {
    process.stdin.isTTY = true as true;
    setupProject();
    writeFusedModel();
    const fusedDir = getFusedModelDir();
    const instance = render(<CleanCommand options={{}} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    t.true(instance.frames.join("\n").includes("Remove it?"));

    instance.stdin.write("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = instance.frames.join("\n");
    instance.unmount();

    t.false(output.includes("Removed fused model cache"));
    t.true(existsSync(fusedDir));
  } finally {
    process.stdin.isTTY = originalIsTTY;
    teardown();
  }
});

// ── status: fused model cache ───────────────────────────────────────

test.serial("StatusCommand shows the fused model cache when present", async (t) => {
  try {
    setupProject();
    writeFusedModel();
    const output = await renderCommand(<StatusCommand />, "Fused model cache");
    t.true(output.includes("Fused model cache"));
  } finally {
    teardown();
  }
});

test.serial("StatusCommand omits the fused model cache line when absent", async (t) => {
  try {
    setupProject();
    const output = await renderCommand(<StatusCommand />, "Exports:");
    t.false(output.includes("Fused model cache"));
  } finally {
    teardown();
  }
});

test.serial("StatusCommand omits the fused model cache line for a leftover incomplete fused/", async (t) => {
  // Regression: status used existsSync while clean used hasUsableFusedModel,
  // so an interrupted export made status report a cache that clean then
  // said didn't exist. Both must agree.
  try {
    setupProject();
    writeIncompleteFusedModel();
    const output = await renderCommand(<StatusCommand />, "Exports:");
    t.false(output.includes("Fused model cache"));
  } finally {
    teardown();
  }
});

// ── chat streaming preview ────────────────────────────────────────────

test("streamPreview passes short content through untouched", (t) => {
  const { text, truncated } = streamPreview("one\ntwo");
  t.is(text, "one\ntwo");
  t.false(truncated);
});

test("streamPreview keeps only the tail of a tall response", (t) => {
  // Ink cannot cleanly repaint a live block taller than the terminal, so the
  // preview shows the end of the reply while it streams.
  const content = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const { text, truncated } = streamPreview(content);

  t.true(truncated);
  t.is(text.split("\n").length, 12);
  t.true(text.endsWith("line 39"));
  t.false(text.includes("line 27"));
});

test("streamPreview clips a single very long line by characters", (t) => {
  // One unwrapped line can overflow the terminal on its own, so character
  // clipping runs before the line count is applied.
  const { text, truncated } = streamPreview("x".repeat(5000));
  t.true(truncated);
  t.is(text.length, 2000);
});

// ── malformed JSON is reported, not thrown ───────────────────────────
//
// A throw from a render body escapes the command's own try/catch and lands in
// Ink's error boundary. The render never completes, so useAutoExit never runs
// and the command dies with a reconciler trace while still exiting 0.

function writeRawConfig(contents: string) {
  writeFileSync(join(NANOTUNE_DIR, "config.json"), contents);
}

function writeRawTrain(contents: string) {
  writeFileSync(join(DATA_DIR, "train.jsonl"), contents);
}

test.serial("StatusCommand reports a malformed config and exits non-zero", async (t) => {
  try {
    setupProject();
    writeRawConfig('{"name":"v","baseMod');
    process.exitCode = 0;

    const output = await renderCommand(<StatusCommand />, "not valid JSON");
    t.true(output.includes("Invalid config.json: not valid JSON"));
    t.false(output.includes("react_stack_bottom_frame"));
    t.is(process.exitCode, 1);
  } finally {
    teardown();
  }
});

test.serial("DataValidateCommand reports a malformed config and exits non-zero", async (t) => {
  try {
    setupProject();
    writeRawConfig('{"name":"v","baseMod');
    process.exitCode = 0;

    const output = await renderCommand(<DataValidateCommand />, "not valid JSON");
    t.true(output.includes("Invalid config.json: not valid JSON"));
    t.is(process.exitCode, 1);
  } finally {
    teardown();
  }
});

test.serial("DataValidateCommand reports a malformed example and exits non-zero", async (t) => {
  try {
    setupProject();
    writeRawTrain(
      JSON.stringify(example("one")) + "\nnot json at all\n" +
        JSON.stringify(example("two")) + "\n",
    );
    process.exitCode = 0;

    // The command whose whole purpose is finding malformed training data has
    // to survive encountering some.
    const output = await renderCommand(<DataValidateCommand />, "invalid JSON");
    t.true(output.includes("Example 2: invalid JSON"));
    t.false(output.includes("react_stack_bottom_frame"));
    t.is(process.exitCode, 1);
  } finally {
    teardown();
  }
});

test.serial("DataValidateCommand --fix leaves a malformed file untouched", async (t) => {
  try {
    setupProject();
    const contents =
      JSON.stringify(example("one")) + "\n" +
      JSON.stringify(example("one")) + "\nnope\n";
    writeRawTrain(contents);

    // Dedupe rewrites the whole file, so running it here would silently drop
    // the line the report is meant to point at.
    await renderCommand(<DataValidateCommand fix />, "invalid JSON");
    t.is(readFileSync(join(DATA_DIR, "train.jsonl"), "utf-8"), contents);
  } finally {
    teardown();
  }
});

test.serial("DataListCommand renders the readable rows and flags the rest", async (t) => {
  const originalTTY = process.stdin.isTTY;
  try {
    setupProject();
    writeRawTrain(
      JSON.stringify(example("one")) + "\nnot json at all\n" +
        JSON.stringify(example("two")) + "\n",
    );
    process.stdin.isTTY = true;

    const output = await renderCommand(<DataListCommand />, "unreadable line");
    t.true(output.includes("one"));
    t.true(output.includes("two"));
    t.true(output.includes("1 unreadable line"));
    t.false(output.includes("react_stack_bottom_frame"));
  } finally {
    process.stdin.isTTY = originalTTY;
    teardown();
  }
});

// ── data list edits the set it was opened on ──────────────────────────

test.serial(
  "DataListCommand with --eval edits valid.jsonl and leaves train.jsonl alone",
  async (t) => {
    // Regression: the edit path called updateTrainingExample/loadTrainingData
    // without isEval, so editing a validation example overwrote the training
    // example at the same index instead.
    const originalTTY = process.stdin.isTTY;
    try {
      setupProject();
      writeExamples([example("train-one")]);
      writeEvalExamples([example("valid-one")]);
      process.stdin.isTTY = true;

      const instance = render(<DataListCommand isEval />);
      await settle();
      instance.stdin.write("e"); // enter edit mode
      await settle();
      instance.stdin.write("\r"); // submit user input unchanged
      await settle();
      instance.stdin.write("\r"); // submit assistant output unchanged
      await settle();
      instance.unmount();

      t.is(userContent(loadTrainingData(false)[0]), "train-one");
      t.is(userContent(loadTrainingData(true)[0]), "valid-one");
      t.is(loadTrainingData(false).length, 1);
      t.is(loadTrainingData(true).length, 1);
    } finally {
      process.stdin.isTTY = originalTTY;
      teardown();
    }
  },
);

// ── data export honours --eval ────────────────────────────────────────

test.serial("DataExportCommand exports training data by default", async (t) => {
  try {
    setupProject();
    writeExamples([example("train-one"), example("train-two")]);
    writeEvalExamples([example("valid-one")]);

    await renderCommand(
      <DataExportCommand file="out.jsonl" yes />,
      "Export complete!",
    );

    const written = readFileSync(join(TEST_DIR, "out.jsonl"), "utf-8").trim();
    t.is(written.split("\n").length, 2);
    t.true(written.includes("train-one"));
    t.false(written.includes("valid-one"));
  } finally {
    teardown();
  }
});

test.serial("DataExportCommand with --eval exports the validation set", async (t) => {
  try {
    setupProject();
    writeExamples([example("train-one"), example("train-two")]);
    writeEvalExamples([example("valid-one")]);

    const output = await renderCommand(
      <DataExportCommand file="out.jsonl" yes isEval />,
      "Export complete!",
    );

    t.true(output.includes("Export Validation Data"));
    const written = readFileSync(join(TEST_DIR, "out.jsonl"), "utf-8").trim();
    t.is(written.split("\n").length, 1);
    t.true(written.includes("valid-one"));
    t.false(written.includes("train-one"));
  } finally {
    teardown();
  }
});

// ── data list navigation ────────────────────────────────────────────

/**
 * The list is a paged, keyboard-driven table, and none of that behaviour is
 * reachable without a TTY — `useKeyInput` no-ops otherwise. These drive it the
 * way a user does: set isTTY, render, write the escape sequences.
 */
const KEY = {
  up: "\u001B[A",
  down: "\u001B[B",
  left: "\u001B[D",
  right: "\u001B[C",
  enter: "\r",
};

async function driveList(keys: string[], expected?: string) {
  const original = process.stdin.isTTY;
  process.stdin.isTTY = true as true;
  try {
    const instance = render(<DataListCommand />);
    await new Promise((resolve) => setTimeout(resolve, 60));
    for (const key of keys) {
      instance.stdin.write(key);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    if (expected) {
      const deadline = Date.now() + 1000;
      while (
        Date.now() < deadline &&
        !instance.frames.join("\n").includes(expected)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const output = instance.frames.join("\n");
    instance.unmount();
    return output;
  } finally {
    process.stdin.isTTY = original;
  }
}

/** Enough examples to fill more than one page. */
function manyExamples(count: number) {
  return Array.from({ length: count }, (_, i) => example(`prompt number ${i}`));
}

test.serial("DataListCommand pages forward and back", async (t) => {
  try {
    setupProject();
    writeExamples(manyExamples(25));

    // 25 examples at a page size of 10 is three pages.
    const first = await driveList([], "Page 1/3");
    t.true(first.includes("Page 1/3"), first.slice(0, 400));

    const second = await driveList([KEY.right], "Page 2/3");
    t.true(second.includes("Page 2/3"));

    const back = await driveList([KEY.right, KEY.left], "Page 1/3");
    t.true(back.includes("Page 1/3"));
  } finally {
    teardown();
  }
});

test.serial("DataListCommand will not page past either end", async (t) => {
  try {
    setupProject();
    writeExamples(manyExamples(12));

    // Two pages. Left on the first and right on the last must be no-ops rather
    // than rendering an empty page or running off the end of the data.
    const atStart = await driveList([KEY.left, KEY.left], "Page 1/2");
    t.true(atStart.includes("Page 1/2"));

    const atEnd = await driveList(
      [KEY.right, KEY.right, KEY.right],
      "Page 2/2",
    );
    t.true(atEnd.includes("Page 2/2"));
  } finally {
    teardown();
  }
});

test.serial(
  "DataListCommand moves the selection with the arrow keys",
  async (t) => {
    try {
      setupProject();
      writeExamples(manyExamples(5));

      // Down twice then up: the clamp at index 0 and at the last row are the
      // parts that would otherwise render an undefined example.
      const output = await driveList(
        [KEY.down, KEY.down, KEY.up],
        "Training Data",
      );
      t.true(output.includes("Training Data"));
      t.false(output.includes("undefined"), "no row rendered from a bad index");
    } finally {
      teardown();
    }
  },
);

test.serial("DataListCommand expands a row on Enter", async (t) => {
  try {
    setupProject();
    writeExamples([example("a distinctive prompt")]);

    const output = await driveList([KEY.enter], "a distinctive prompt");
    t.true(output.includes("a distinctive prompt"));
  } finally {
    teardown();
  }
});

test.serial(
  "DataListCommand handles an empty dataset without paging errors",
  async (t) => {
    try {
      setupProject();
      writeExamples([]);

      // totalPages is 0 here and the header falls back to `|| 1`. Arrowing
      // around an empty list must not produce "Page 1/0" or a negative index.
      const output = await driveList([KEY.down, KEY.right, KEY.enter]);
      t.false(output.includes("Page 1/0"), output.slice(0, 300));
      t.false(output.includes("NaN"));
    } finally {
      teardown();
    }
  },
);

// ── data export: the branches the happy paths miss ──────────────────

test.serial("DataExportCommand refuses to export outside a project", async (t) => {
  try {
    setupEmptyDir();
    process.exitCode = 0;
    const output = await renderCommand(
      <DataExportCommand file={join(TEST_DIR, "out.jsonl")} />,
      "Not a Nanotune project",
    );
    t.true(output.includes("Not a Nanotune project"));
    t.false(existsSync(join(TEST_DIR, "out.jsonl")), "must not write a file");
    process.exitCode = 0;
  } finally {
    teardown();
  }
});

test.serial("DataExportCommand rejects an unsupported extension", async (t) => {
  try {
    setupProject();
    writeExamples([example("hello")]);
    process.exitCode = 0;
    // .txt is not one of csv/jsonl/json. The command must say so rather than
    // writing a file the user cannot import back.
    const output = await renderCommand(
      <DataExportCommand file={join(TEST_DIR, "out.txt")} />,
      "Unsupported",
    );
    t.true(output.includes("Unsupported"));
    t.false(existsSync(join(TEST_DIR, "out.txt")));
    process.exitCode = 0;
  } finally {
    teardown();
  }
});

test.serial("DataExportCommand writes CSV when asked for CSV", async (t) => {
  try {
    setupProject();
    writeExamples([example("first"), example("second")]);
    const out = join(TEST_DIR, "out.csv");
    await renderCommand(<DataExportCommand file={out} />, "Exported");

    t.true(existsSync(out));
    const csv = readFileSync(out, "utf-8");
    t.true(csv.includes("first"), csv.slice(0, 200));
    t.true(csv.includes("second"));
  } finally {
    teardown();
  }
});

test.serial("DataExportCommand writes JSON when asked for JSON", async (t) => {
  try {
    setupProject();
    writeExamples([example("only one")]);
    const out = join(TEST_DIR, "out.json");
    await renderCommand(<DataExportCommand file={out} />, "Exported");

    const parsed = JSON.parse(readFileSync(out, "utf-8"));
    t.true(Array.isArray(parsed));
    t.is(parsed.length, 1);
  } finally {
    teardown();
  }
});

// ── data import: the branches the happy paths miss ──────────────────

test.serial("DataImportCommand reports a missing source file", async (t) => {
  try {
    setupProject();
    process.exitCode = 0;
    const output = await renderCommand(
      <DataImportCommand file={join(TEST_DIR, "nope.jsonl")} yes />,
      "not found",
    );
    t.regex(output, /not found|does not exist|No such/i);
    process.exitCode = 0;
  } finally {
    teardown();
  }
});

test.serial("DataImportCommand refuses to import outside a project", async (t) => {
  try {
    setupEmptyDir();
    const source = join(TEST_DIR, "in.jsonl");
    writeFileSync(source, `${JSON.stringify(example("x"))}\n`);
    process.exitCode = 0;

    const output = await renderCommand(
      <DataImportCommand file={source} yes />,
      "Not a Nanotune project",
    );
    t.true(output.includes("Not a Nanotune project"));
    process.exitCode = 0;
  } finally {
    teardown();
  }
});

test.serial("DataImportCommand appends to the training set", async (t) => {
  try {
    setupProject();
    writeExamples([example("existing")]);

    const source = join(TEST_DIR, "in.jsonl");
    writeFileSync(source, `${JSON.stringify(example("imported"))}\n`);

    await renderCommand(<DataImportCommand file={source} yes />, "Imported");

    // Importing must add to the dataset, not replace it — the failure mode
    // here is a user losing everything they had already collected.
    const rows = loadTrainingData();
    const prompts = rows.map((r) => userContent(r));
    t.true(prompts.includes("existing"), JSON.stringify(prompts));
    t.true(prompts.includes("imported"), JSON.stringify(prompts));
  } finally {
    teardown();
  }
});

test.serial("DataImportCommand with --eval appends to the validation set", async (t) => {
  try {
    setupProject();
    writeExamples([example("train row")]);

    const source = join(TEST_DIR, "in.jsonl");
    writeFileSync(source, `${JSON.stringify(example("eval row"))}\n`);

    await renderCommand(
      <DataImportCommand file={source} yes isEval />,
      "Imported",
    );

    t.deepEqual(
      loadTrainingData(true).map((r) => userContent(r)),
      ["eval row"],
    );
    // And the training set is untouched.
    t.deepEqual(
      loadTrainingData().map((r) => userContent(r)),
      ["train row"],
    );
  } finally {
    teardown();
  }
});

// ── chat startup failures ───────────────────────────────────────────

/**
 * These are the three ways `nanotune chat` refuses to start, and all three
 * short-circuit before `startLlamaServer` — so they are reachable in CI even
 * though the chat loop itself needs a real llama-server on Apple Silicon.
 *
 * They are also the errors a user actually meets: chatting is usually the
 * first thing tried after a fine-tune, and "no exported models" is what you
 * get if export has not run yet.
 */

test.serial("ChatCommand refuses to start outside a project", async (t) => {
  try {
    setupEmptyDir();
    process.exitCode = 0;
    const output = await renderCommand(
      <ChatCommand options={{}} />,
      "Not a Nanotune project",
    );
    t.true(output.includes("Not a Nanotune project"));
    t.true(output.includes("nanotune init"), "should say what to run");
    process.exitCode = 0;
  } finally {
    teardown();
  }
});

test.serial("ChatCommand says so when nothing has been exported", async (t) => {
  try {
    setupProject();
    process.exitCode = 0;
    // A project with no .gguf anywhere: findLatestGGUF returns nothing, and
    // the command must name the step that produces one.
    const output = await renderCommand(
      <ChatCommand options={{}} />,
      "No exported models",
    );
    t.true(output.includes("No exported models"));
    t.true(output.includes("nanotune export"), "should say what to run");
    process.exitCode = 0;
  } finally {
    teardown();
  }
});

test.serial("ChatCommand reports a model path that does not exist", async (t) => {
  try {
    setupProject();
    process.exitCode = 0;
    const missing = join(TEST_DIR, "definitely-not-here.gguf");
    // An explicit --model that is wrong should name the path, not fall back to
    // scanning: silently chatting to a different model than the one asked for
    // would be worse than failing.
    const output = await renderCommand(
      <ChatCommand options={{ model: missing }} />,
      "Model not found",
    );
    t.true(output.includes("Model not found"));
    t.true(output.includes("definitely-not-here.gguf"));
    process.exitCode = 0;
  } finally {
    teardown();
  }
});
