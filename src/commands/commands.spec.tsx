import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "ava";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useKeyInput } from "../components/index.js";
import { loadTrainingData } from "../lib/data.js";
import { streamPreview } from "./chat.js";
import { DataExportCommand } from "./data/export.js";
import { DataImportCommand } from "./data/import.js";
import { DataListCommand } from "./data/list.js";
import { DataValidateCommand } from "./data/validate.js";
import { PROVIDER_TEMPLATES } from "../lib/judge-templates.js";
import { JudgeConfigureCommand, JudgeTestCommand } from "./judge.js";
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

test.serial("JudgeConfigureCommand renders its error state with no project", async (t) => {
  try {
    setupEmptyDir();
    // The guard has to come before the provider prompt: the save lands in
    // .nanotune/, so without it the key is asked for, tested, and discarded.
    const output = await renderCommand(<JudgeConfigureCommand />, "Not a Nanotune project");
    t.true(output.includes("Not a Nanotune project"));
    t.false(output.includes("Select a provider"));
  } finally {
    teardown();
  }
});

test.serial("JudgeConfigureCommand prompts for a provider inside a project", async (t) => {
  try {
    setupProject();
    const output = await renderCommand(<JudgeConfigureCommand />, "Select a provider");
    t.true(output.includes("Select a provider"));
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

// ── judge test: the states it reaches without a live judge ──────────

test.serial("JudgeTestCommand renders its error state with no project", async (t) => {
  try {
    setupEmptyDir();
    const output = await renderCommand(<JudgeTestCommand />, "Not a Nanotune project");
    t.true(output.includes("Not a Nanotune project"));
  } finally {
    teardown();
  }
});

test.serial("JudgeTestCommand reports an unconfigured judge inside a project", async (t) => {
  try {
    setupProject();
    const output = await renderCommand(
      <JudgeTestCommand />,
      "LLM judge is not configured",
    );
    t.true(output.includes("nanotune judge configure"));
  } finally {
    teardown();
  }
});

// ── driving the interactive judge configure flow ────────────────────
//
// @inkjs/ui swallows the first keypress that lands on a freshly mounted
// TextInput, so these helpers drive the form by watching the rendered frame
// rather than by counting keystrokes.

const ENTER = "\r";
const DOWN = "\x1B[B";

type Rendered = ReturnType<typeof render>;

async function withTTY<T>(run: () => Promise<T>): Promise<T> {
  const original = process.stdin.isTTY;
  process.stdin.isTTY = true as true;
  try {
    return await run();
  } finally {
    process.stdin.isTTY = original;
  }
}

async function write(instance: Rendered, text: string) {
  instance.stdin.write(text);
  await settle();
}

/** Wait for `text` to show up in any frame rendered so far. */
async function waitForFrame(instance: Rendered, text: string) {
  for (let i = 0; i < 50; i++) {
    if (instance.frames.join("\n").includes(text)) return true;
    await settle();
  }
  return false;
}

async function selectProvider(instance: Rendered, id: string) {
  const index = PROVIDER_TEMPLATES.findIndex((template) => template.id === id);
  for (let i = 0; i < index; i++) await write(instance, DOWN);
  await write(instance, ENTER);
}

/** Fill in the field whose prompt is on screen, then submit it. */
async function answer(instance: Rendered, prompt: string, value = "") {
  for (let i = 0; i < 30 && !instance.lastFrame()?.includes(prompt); i++) {
    await settle();
  }
  for (let i = 0; i < 5 && value && !instance.lastFrame()?.includes(value); i++) {
    await write(instance, value);
  }
  for (let i = 0; i < 5; i++) {
    await write(instance, ENTER);
    if (!instance.lastFrame()?.includes(prompt)) return;
  }
}

async function confirmSave(instance: Rendered) {
  for (let i = 0; i < 5; i++) {
    await write(instance, "y");
    if (!instance.lastFrame()?.includes("Save and test connection?")) return;
  }
}

test.serial("JudgeConfigureCommand walks a templated provider to the summary", async (t) => {
  try {
    setupProject();
    await withTTY(async () => {
      const instance = render(<JudgeConfigureCommand />);
      await settle();
      // Ollama defaults both the provider name and the base URL; the model
      // has no default and is required.
      await selectProvider(instance, "ollama");
      await answer(instance, "Provider name");
      await answer(instance, "Base URL");

      // An empty required field must not advance the form.
      await write(instance, ENTER);
      await write(instance, ENTER);
      t.true(instance.lastFrame()?.includes("Model name"));

      await answer(instance, "Model name", "qwen2.5:0.5b");

      const summary = instance.lastFrame() ?? "";
      instance.unmount();
      t.true(summary.includes("Configuration Summary"));
      t.true(summary.includes("qwen2.5:0.5b"));
      t.true(summary.includes("http://localhost:11434/v1"));
      // Ollama needs no key, so the summary says so rather than masking.
      t.true(summary.includes("(none)"));
      t.true(summary.includes("Save and test connection?"));
    });
  } finally {
    teardown();
  }
});

test.serial("JudgeConfigureCommand masks the API key on the summary", async (t) => {
  try {
    setupProject();
    await withTTY(async () => {
      const instance = render(<JudgeConfigureCommand />);
      await settle();
      await selectProvider(instance, "gemini");
      await answer(instance, "API Key", "sk-should-not-be-shown");
      await answer(instance, "Model name");
      await answer(instance, "Provider name");

      const summary = instance.lastFrame() ?? "";
      instance.unmount();
      t.true(summary.includes("Configuration Summary"));
      t.false(summary.includes("sk-should-not-be-shown"));
      t.true(summary.includes("API Key: ***"));
      t.true(summary.includes("SDK Provider: google"));
    });
  } finally {
    teardown();
  }
});

test.serial("JudgeConfigureCommand rejects a malformed base URL", async (t) => {
  try {
    setupProject();
    await withTTY(async () => {
      // The custom template leaves the base URL empty, so what is typed is
      // exactly what the validator sees.
      const instance = render(<JudgeConfigureCommand />);
      await settle();
      await selectProvider(instance, "custom");
      await answer(instance, "Provider name", "stub");
      await answer(instance, "Base URL", "not-a-url");

      const frame = instance.lastFrame() ?? "";
      instance.unmount();
      t.true(frame.includes("Invalid URL format"));
      t.false(frame.includes("Configuration Summary"));
    });
  } finally {
    teardown();
  }
});

test.serial("JudgeConfigureCommand writes nothing when the answer is n", async (t) => {
  try {
    setupProject();
    await withTTY(async () => {
      const instance = render(<JudgeConfigureCommand />);
      await settle();
      await selectProvider(instance, "ollama");
      await answer(instance, "Provider name");
      await answer(instance, "Base URL");
      await answer(instance, "Model name", "some-model");
      t.true(instance.lastFrame()?.includes("Configuration Summary"));

      await write(instance, "n");
      instance.unmount();
    });
    t.false(existsSync(join(NANOTUNE_DIR, "judge.json")));
  } finally {
    teardown();
  }
});

// ── judge configure: connection test vs. save ───────────────────────
//
// The save used to sit inside the connection-test try block, so an ENOENT
// from the write surfaced as "Connection test failed". These two pin each
// failure to its own message, against a stub judge on localhost.

interface StubJudge {
  url: string;
  close: () => Promise<void>;
}

async function startStubJudge(
  respond: (res: ServerResponse) => void,
): Promise<StubJudge> {
  const server = createServer((_req, res) => respond(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function chatCompletion(res: ServerResponse) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "stub",
      object: "chat.completion",
      created: 0,
      model: "stub-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              '{"scores":{"helpful":9},"overall":9,"reasoning":"fine","pass":true}',
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

async function configureAgainst(baseUrl: string) {
  const instance = render(<JudgeConfigureCommand />);
  await settle();
  await selectProvider(instance, "custom");
  await answer(instance, "Provider name", "stub");
  await answer(instance, "Base URL", baseUrl);
  await answer(instance, "API Key (optional)");
  await answer(instance, "Model name", "stub-model");
  return instance;
}

test.serial("JudgeConfigureCommand reports a failed connection as a connection failure", async (t) => {
  const judge = await startStubJudge((res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "nope" } }));
  });
  try {
    setupProject();
    await withTTY(async () => {
      const instance = await configureAgainst(judge.url);
      t.true(instance.lastFrame()?.includes("Configuration Summary"));

      await confirmSave(instance);
      t.true(await waitForFrame(instance, "Connection test failed"));

      const frame = instance.lastFrame() ?? "";
      instance.unmount();
      t.false(frame.includes("Failed to save judge config"));
    });
    // A connection that never worked must not leave a config behind.
    t.false(existsSync(join(NANOTUNE_DIR, "judge.json")));
  } finally {
    await judge.close();
    teardown();
  }
});

test.serial("JudgeConfigureCommand reports a failed save as a save failure", async (t) => {
  const judge = await startStubJudge(chatCompletion);
  try {
    setupProject();
    // A non-empty directory where judge.json belongs: the connection test
    // passes and only the rename fails, which is the case that used to be
    // reported as a connection failure.
    mkdirSync(join(NANOTUNE_DIR, "judge.json", "blocker"), { recursive: true });

    await withTTY(async () => {
      const instance = await configureAgainst(judge.url);
      t.true(instance.lastFrame()?.includes("Configuration Summary"));

      await confirmSave(instance);
      t.true(await waitForFrame(instance, "Failed to save judge config"));

      const frame = instance.lastFrame() ?? "";
      instance.unmount();
      t.false(frame.includes("Connection test failed"));
    });
  } finally {
    await judge.close();
    teardown();
  }
});
