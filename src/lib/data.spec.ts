import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "ava";
import type { TrainingExample } from "../types/index.js";
import {
  appendToTrainingData,
  appendTrainingExample,
  countExamples,
  countTurns,
  deleteExample,
  importFromCSV,
  importFromJSON,
  importFromJSONL,
  importData,
  loadTrainingData,
  updateExample,
  updateTrainingExample,
  validateTrainingData,
} from "./data.js";

const ORIG_CWD = process.cwd();
const TEST_DIR = join(ORIG_CWD, ".test-data-spec");
const DATA_DIR = join(TEST_DIR, ".nanotune", "data");

const SYSTEM_CTX = { role: "system", content: "You are helpful." };
const DEV_CTX = { role: "developer", content: "You are a code assistant." };

test.beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  process.chdir(TEST_DIR);
});

test.afterEach.always(() => {
  process.chdir(ORIG_CWD);
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── appendToTrainingData ──────────────────────────────────────────────

test.serial("appendToTrainingData writes correct JSONL with system role", (t) => {
  appendToTrainingData({
    contextMessage: SYSTEM_CTX,
    userInput: "Hello",
    assistantOutput: "Hi there!",
  });

  const data = loadTrainingData();
  t.is(data.length, 1);
  t.is(data[0].messages[0].role, "system");
  t.is(data[0].messages[0].content, "You are helpful.");
  t.is(data[0].messages[1].role, "user");
  t.is(data[0].messages[1].content, "Hello");
  t.is(data[0].messages[2].role, "assistant");
  t.is(data[0].messages[2].content, "Hi there!");
});

test.serial("appendToTrainingData writes correct JSONL with developer role", (t) => {
  appendToTrainingData({
    contextMessage: DEV_CTX,
    userInput: "Write a function",
    assistantOutput: "function foo() {}",
  });

  const data = loadTrainingData();
  t.is(data.length, 1);
  t.is(data[0].messages[0].role, "developer");
  t.is(data[0].messages[0].content, "You are a code assistant.");
});

test.serial("appendToTrainingData appends multiple examples", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" });
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "C", assistantOutput: "D" });

  t.is(countExamples(), 2);
  const data = loadTrainingData();
  t.is(data[0].messages[1].content, "A");
  t.is(data[1].messages[1].content, "C");
});

test.serial("appendToTrainingData writes to eval file when isEval is true", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" }, true);

  t.is(countExamples(false), 0);
  t.is(countExamples(true), 1);
});

// ── updateExample ─────────────────────────────────────────────────────

test.serial("updateExample replaces an existing example", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "old", assistantOutput: "old-out" });
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "keep", assistantOutput: "keep-out" });

  updateExample(0, { contextMessage: DEV_CTX, userInput: "new", assistantOutput: "new-out" });

  const data = loadTrainingData();
  t.is(data.length, 2);
  t.is(data[0].messages[0].role, "developer");
  t.is(data[0].messages[1].content, "new");
  t.is(data[1].messages[1].content, "keep");
});

test.serial("updateExample does nothing for out-of-bounds index", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" });

  updateExample(5, { contextMessage: SYSTEM_CTX, userInput: "X", assistantOutput: "Y" });

  const data = loadTrainingData();
  t.is(data.length, 1);
  t.is(data[0].messages[1].content, "A");
});

// ── deleteExample ─────────────────────────────────────────────────────

test.serial("deleteExample removes the correct example", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "1" });
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "B", assistantOutput: "2" });
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "C", assistantOutput: "3" });

  deleteExample(1);

  const data = loadTrainingData();
  t.is(data.length, 2);
  t.is(data[0].messages[1].content, "A");
  t.is(data[1].messages[1].content, "C");
});

// ── validateTrainingData ──────────────────────────────────────────────

test.serial("validateTrainingData returns error when no data exists", (t) => {
  // empty data dir, no train.jsonl
  rmSync(join(DATA_DIR, "train.jsonl"), { force: true });

  const result = validateTrainingData(SYSTEM_CTX);
  t.false(result.valid);
  t.true(result.errors.some((e) => e.includes("No training data")));
});

test.serial("validateTrainingData passes for valid data", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "Hello", assistantOutput: "Hi" });

  const result = validateTrainingData(SYSTEM_CTX);
  t.true(result.valid);
  t.is(result.errors.length, 0);
});

test.serial("validateTrainingData warns about inconsistent context messages", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" });
  // Write a second example with a different context message directly
  appendToTrainingData({ contextMessage: { role: "system", content: "Different prompt" }, userInput: "C", assistantOutput: "D" });

  const result = validateTrainingData(SYSTEM_CTX);
  t.true(result.valid); // inconsistency is a warning, not an error
  t.true(result.warnings.some((w) => w.includes("context messages")));
});

test.serial("validateTrainingData warns about inconsistent context role", (t) => {
  appendToTrainingData({ contextMessage: DEV_CTX, userInput: "A", assistantOutput: "B" });

  // validate against system context — role mismatch
  const result = validateTrainingData(SYSTEM_CTX);
  t.true(result.warnings.some((w) => w.includes("context messages")));
});

test.serial("validateTrainingData warns about duplicate user inputs", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "same", assistantOutput: "A" });
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "same", assistantOutput: "B" });

  const result = validateTrainingData(SYSTEM_CTX);
  t.true(result.warnings.some((w) => w.includes("duplicate")));
});

test.serial("validateTrainingData errors on example with fewer than 2 messages", (t) => {
  // Manually write a malformed example
  const bad: TrainingExample = { messages: [{ role: "user", content: "lonely" }] };
  writeFileSync(join(DATA_DIR, "train.jsonl"), JSON.stringify(bad) + "\n");

  const result = validateTrainingData(SYSTEM_CTX);
  t.false(result.valid);
  t.true(result.errors.some((e) => e.includes("at least 2 messages")));
});

test.serial("validateTrainingData errors on empty content", (t) => {
  const bad: TrainingExample = {
    messages: [
      { role: "system", content: "ok" },
      { role: "user", content: "  " },
      { role: "assistant", content: "reply" },
    ],
  };
  writeFileSync(join(DATA_DIR, "train.jsonl"), JSON.stringify(bad) + "\n");

  const result = validateTrainingData(SYSTEM_CTX);
  t.false(result.valid);
  t.true(result.errors.some((e) => e.includes("Empty content")));
});

test.serial("validateTrainingData warns when under 50 examples", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" });

  const result = validateTrainingData(SYSTEM_CTX);
  t.true(result.warnings.some((w) => w.includes("Recommend at least 50")));
});

// ── importFromCSV ─────────────────────────────────────────────────────

test.serial("importFromCSV imports valid rows with context message role", (t) => {
  const csvPath = join(TEST_DIR, "data.csv");
  writeFileSync(csvPath, "input,output\n\"list files\",\"ls\"\n\"show dir\",\"pwd\"\n");

  const result = importFromCSV(csvPath, DEV_CTX);
  t.is(result.imported, 2);
  t.is(result.skipped, 0);

  const data = loadTrainingData();
  t.is(data.length, 2);
  t.is(data[0].messages[0].role, "developer");
  t.is(data[0].messages[1].content, "list files");
  t.is(data[0].messages[2].content, "ls");
});

test.serial("importFromCSV skips invalid lines", (t) => {
  const csvPath = join(TEST_DIR, "bad.csv");
  writeFileSync(csvPath, "\"good\",\"data\"\nthis has no comma separation at all really\n");

  const result = importFromCSV(csvPath, SYSTEM_CTX);
  t.is(result.imported, 1);
  t.is(result.skipped, 1);
  t.is(result.errors.length, 1);
});

// ── importFromJSONL ───────────────────────────────────────────────────

test.serial("importFromJSONL imports messages format", (t) => {
  const jsonlPath = join(TEST_DIR, "data.jsonl");
  const line = JSON.stringify({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
  });
  writeFileSync(jsonlPath, line + "\n");

  const result = importFromJSONL(jsonlPath, DEV_CTX);
  t.is(result.imported, 1);

  const data = loadTrainingData();
  // Import uses the provided contextMessage, extracting user/assistant from source
  t.is(data[0].messages[0].role, "developer");
  t.is(data[0].messages[1].content, "hello");
  t.is(data[0].messages[2].content, "hi");
});

test.serial("importFromJSONL imports input/output format", (t) => {
  const jsonlPath = join(TEST_DIR, "simple.jsonl");
  writeFileSync(jsonlPath, '{"input":"list files","output":"ls"}\n');

  const result = importFromJSONL(jsonlPath, SYSTEM_CTX);
  t.is(result.imported, 1);

  const data = loadTrainingData();
  t.is(data[0].messages[1].content, "list files");
  t.is(data[0].messages[2].content, "ls");
});

test.serial("importFromJSONL skips invalid JSON", (t) => {
  const jsonlPath = join(TEST_DIR, "bad.jsonl");
  writeFileSync(jsonlPath, "not json\n");

  const result = importFromJSONL(jsonlPath, SYSTEM_CTX);
  t.is(result.imported, 0);
  t.is(result.skipped, 1);
  t.true(result.errors[0].includes("Invalid JSON"));
});

// ── importFromJSON ────────────────────────────────────────────────────

test.serial("importFromJSON imports array of messages format", (t) => {
  const jsonPath = join(TEST_DIR, "data.json");
  writeFileSync(
    jsonPath,
    JSON.stringify([
      {
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
        ],
      },
      { input: "q2", output: "a2" },
    ]),
  );

  const result = importFromJSON(jsonPath, DEV_CTX);
  t.is(result.imported, 2);

  const data = loadTrainingData();
  t.is(data[0].messages[0].role, "developer");
  t.is(data[0].messages[1].content, "q1");
  t.is(data[1].messages[1].content, "q2");
});

test.serial("importFromJSON rejects non-array JSON", (t) => {
  const jsonPath = join(TEST_DIR, "obj.json");
  writeFileSync(jsonPath, '{"not": "an array"}');

  const result = importFromJSON(jsonPath, SYSTEM_CTX);
  t.is(result.imported, 0);
  t.true(result.errors[0].includes("Expected JSON array"));
});

// ── importData ────────────────────────────────────────────────────────

test.serial("importData dispatches to correct importer by extension", (t) => {
  const csvPath = join(TEST_DIR, "test.csv");
  writeFileSync(csvPath, "\"a\",\"b\"\n");

  const result = importData(csvPath, SYSTEM_CTX);
  t.is(result.imported, 1);
});

test.serial("importData returns error for missing file", (t) => {
  const result = importData("/nonexistent/file.csv", SYSTEM_CTX);
  t.is(result.imported, 0);
  t.true(result.errors[0].includes("File not found"));
});

test.serial("importData returns error for unsupported format", (t) => {
  const txtPath = join(TEST_DIR, "data.txt");
  writeFileSync(txtPath, "stuff");

  const result = importData(txtPath, SYSTEM_CTX);
  t.is(result.imported, 0);
  t.true(result.errors[0].includes("Unsupported file format"));
});

// ── countExamples / loadTrainingData edge cases ───────────────────────

test.serial("countExamples returns 0 when file does not exist", (t) => {
  rmSync(join(DATA_DIR, "train.jsonl"), { force: true });
  t.is(countExamples(), 0);
});

test.serial("loadTrainingData returns empty array when file does not exist", (t) => {
  rmSync(join(DATA_DIR, "train.jsonl"), { force: true });
  t.deepEqual(loadTrainingData(), []);
});

// ── Multi-turn support ────────────────────────────────────────────────

test.serial("appendTrainingExample writes multi-turn examples", (t) => {
  const multiTurn: TrainingExample = {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "How are you?" },
      { role: "assistant", content: "I'm doing well, thanks!" },
    ],
  };
  appendTrainingExample(multiTurn);

  const data = loadTrainingData();
  t.is(data.length, 1);
  t.is(data[0].messages.length, 5);
  t.is(data[0].messages[3].role, "user");
  t.is(data[0].messages[3].content, "How are you?");
  t.is(data[0].messages[4].role, "assistant");
  t.is(data[0].messages[4].content, "I'm doing well, thanks!");
});

test.serial("updateTrainingExample replaces with multi-turn example", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "old", assistantOutput: "old-out" });

  const multiTurn: TrainingExample = {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Turn 1" },
      { role: "assistant", content: "Response 1" },
      { role: "user", content: "Turn 2" },
      { role: "assistant", content: "Response 2" },
    ],
  };
  updateTrainingExample(0, multiTurn);

  const data = loadTrainingData();
  t.is(data.length, 1);
  t.is(data[0].messages.length, 5);
  t.is(data[0].messages[3].content, "Turn 2");
});

test.serial("countTurns counts user messages as turns", (t) => {
  t.is(countTurns({ messages: [
    { role: "system", content: "ctx" },
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
  ] }), 1);

  t.is(countTurns({ messages: [
    { role: "system", content: "ctx" },
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ] }), 2);

  t.is(countTurns({ messages: [
    { role: "system", content: "ctx" },
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "q3" },
    { role: "assistant", content: "a3" },
  ] }), 3);
});

test.serial("importFromJSONL preserves multi-turn messages", (t) => {
  const jsonlPath = join(TEST_DIR, "multi.jsonl");
  const multiTurn = {
    messages: [
      { role: "system", content: "original system" },
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "response 1" },
      { role: "user", content: "turn 2" },
      { role: "assistant", content: "response 2" },
    ],
  };
  writeFileSync(jsonlPath, JSON.stringify(multiTurn) + "\n");

  const result = importFromJSONL(jsonlPath, DEV_CTX);
  t.is(result.imported, 1);

  const data = loadTrainingData();
  t.is(data[0].messages.length, 5);
  // Multi-turn preserves original messages, including original context
  t.is(data[0].messages[0].role, "system");
  t.is(data[0].messages[0].content, "original system");
  t.is(data[0].messages[3].content, "turn 2");
  t.is(data[0].messages[4].content, "response 2");
});

test.serial("importFromJSON preserves multi-turn messages", (t) => {
  const jsonPath = join(TEST_DIR, "multi.json");
  const multiTurn = [
    {
      messages: [
        { role: "system", content: "original system" },
        { role: "user", content: "turn 1" },
        { role: "assistant", content: "response 1" },
        { role: "user", content: "turn 2" },
        { role: "assistant", content: "response 2" },
      ],
    },
  ];
  writeFileSync(jsonPath, JSON.stringify(multiTurn));

  const result = importFromJSON(jsonPath, DEV_CTX);
  t.is(result.imported, 1);

  const data = loadTrainingData();
  t.is(data[0].messages.length, 5);
  t.is(data[0].messages[0].role, "system");
  t.is(data[0].messages[0].content, "original system");
  t.is(data[0].messages[3].content, "turn 2");
});

test.serial("validateTrainingData warns on consecutive same-role messages", (t) => {
  const broken: TrainingExample = {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "user", content: "Are you there?" },
      { role: "assistant", content: "Hi!" },
    ],
  };
  writeFileSync(join(DATA_DIR, "train.jsonl"), JSON.stringify(broken) + "\n");

  const result = validateTrainingData(SYSTEM_CTX);
  t.true(result.valid); // broken alternation is a warning, not an error
  t.true(result.warnings.some((w) => w.includes("Consecutive")));
});

test.serial("validateTrainingData passes multi-turn with correct alternation", (t) => {
  const good: TrainingExample = {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "How are you?" },
      { role: "assistant", content: "Good!" },
    ],
  };
  writeFileSync(join(DATA_DIR, "train.jsonl"), JSON.stringify(good) + "\n");

  const result = validateTrainingData(SYSTEM_CTX);
  t.true(result.valid);
  t.false(result.warnings.some((w) => w.includes("Consecutive")));
});

test.serial("appendToTrainingData backward compat still creates 3-message examples", (t) => {
  appendToTrainingData({
    contextMessage: SYSTEM_CTX,
    userInput: "Hello",
    assistantOutput: "Hi!",
  });

  const data = loadTrainingData();
  t.is(data.length, 1);
  t.is(data[0].messages.length, 3);
  t.is(data[0].messages[0].role, "system");
  t.is(data[0].messages[1].role, "user");
  t.is(data[0].messages[2].role, "assistant");
});
