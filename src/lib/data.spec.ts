import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "ava";
import type { TrainingExample } from "../types/index.js";
import {
  appendToTrainingData,
  appendTrainingExample,
  countExamples,
  countTurns,
  dedupeExamples,
  deleteExample,
  exportData,
  exportToCSV,
  exportToJSON,
  exportToJSONL,
  fixContextMessages,
  importFromCSV,
  importFromJSON,
  importFromJSONL,
  importData,
  loadTrainingData,
  parseCSV,
  splitTrainValidation,
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

// ── dedupeExamples ────────────────────────────────────────────────────

test.serial("dedupeExamples removes an exact-duplicate example", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" });
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" });
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "C", assistantOutput: "D" });

  const result = dedupeExamples();
  t.is(result.removedCount, 1);
  t.deepEqual(result.removedIndexes, [2]);

  const data = loadTrainingData();
  t.is(data.length, 2);
  t.is(data[0].messages[1].content, "A");
  t.is(data[1].messages[1].content, "C");
});

test.serial("dedupeExamples does nothing when no duplicates exist", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" });
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "C", assistantOutput: "D" });

  const result = dedupeExamples();
  t.is(result.removedCount, 0);
  t.deepEqual(result.removedIndexes, []);
  t.is(loadTrainingData().length, 2);
});

test.serial("dedupeExamples keeps examples with the same input but different output", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "same", assistantOutput: "A" });
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "same", assistantOutput: "B" });

  const result = dedupeExamples();
  t.is(result.removedCount, 0);
  t.is(loadTrainingData().length, 2);
});

test.serial("dedupeExamples keeps identical turns with different context messages", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" });
  appendToTrainingData({ contextMessage: DEV_CTX, userInput: "A", assistantOutput: "B" });

  const result = dedupeExamples();
  t.is(result.removedCount, 0);
  t.is(loadTrainingData().length, 2);
});

test.serial("dedupeExamples operates on valid.jsonl independently when isEval is true", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" }, true);
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" }, true);
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "X", assistantOutput: "Y" });

  const result = dedupeExamples(true);
  t.is(result.removedCount, 1);
  t.is(loadTrainingData(true).length, 1);
  t.is(loadTrainingData(false).length, 1);
});

// ── fixContextMessages ────────────────────────────────────────────────

test.serial("fixContextMessages rewrites a mismatched context message", (t) => {
  appendToTrainingData({ contextMessage: DEV_CTX, userInput: "A", assistantOutput: "B" });

  const result = fixContextMessages(SYSTEM_CTX);
  t.is(result.fixedCount, 1);

  const data = loadTrainingData();
  t.is(data[0].messages[0].role, "system");
  t.is(data[0].messages[0].content, "You are helpful.");
  t.is(data[0].messages[1].content, "A");
  t.is(data[0].messages[2].content, "B");
});

test.serial("fixContextMessages does nothing when already matching", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" });

  const result = fixContextMessages(SYSTEM_CTX);
  t.is(result.fixedCount, 0);
});

test.serial("fixContextMessages does not insert a context message when none exists", (t) => {
  const bare: TrainingExample = {
    messages: [
      { role: "user", content: "A" },
      { role: "assistant", content: "B" },
    ],
  };
  writeFileSync(join(DATA_DIR, "train.jsonl"), JSON.stringify(bare) + "\n");

  const result = fixContextMessages(SYSTEM_CTX);
  t.is(result.fixedCount, 0);
  t.is(loadTrainingData()[0].messages[0].role, "user");
});

test.serial("fixContextMessages only rewrites index 0 on a multi-turn example", (t) => {
  const multiTurn: TrainingExample = {
    messages: [
      DEV_CTX,
      { role: "user", content: "turn1 user" },
      { role: "assistant", content: "turn1 assistant" },
      { role: "user", content: "turn2 user" },
      { role: "assistant", content: "turn2 assistant" },
    ],
  };
  writeFileSync(join(DATA_DIR, "train.jsonl"), JSON.stringify(multiTurn) + "\n");

  const result = fixContextMessages(SYSTEM_CTX);
  t.is(result.fixedCount, 1);

  const data = loadTrainingData();
  t.is(data[0].messages.length, 5);
  t.is(data[0].messages[0].role, "system");
  t.is(data[0].messages[1].content, "turn1 user");
  t.is(data[0].messages[2].content, "turn1 assistant");
  t.is(data[0].messages[3].content, "turn2 user");
  t.is(data[0].messages[4].content, "turn2 assistant");
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

test.serial("importFromJSONL preserves imported messages array verbatim", (t) => {
  const jsonlPath = join(TEST_DIR, "data.jsonl");
  const line = JSON.stringify({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
  });
  writeFileSync(jsonlPath, line + "\n");

  // Even though DEV_CTX is passed, the imported messages array must be
  // preserved — silently overwriting embedded system prompts would corrupt
  // user-curated datasets.
  const result = importFromJSONL(jsonlPath, DEV_CTX);
  t.is(result.imported, 1);

  const data = loadTrainingData();
  t.is(data[0].messages[0].role, "system");
  t.is(data[0].messages[0].content, "sys");
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
  // First item used the messages format → preserved verbatim.
  t.is(data[0].messages[0].role, "system");
  t.is(data[0].messages[0].content, "sys");
  t.is(data[0].messages[1].content, "q1");
  // Second item used {input, output} → wrapped with DEV_CTX.
  t.is(data[1].messages[0].role, "developer");
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

// ── exportToJSONL / exportToJSON / exportToCSV / exportData ───────────

test.serial("exportToJSONL round-trips through importFromJSONL", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" });
  appendToTrainingData({ contextMessage: DEV_CTX, userInput: "C", assistantOutput: "D" });

  const outPath = join(TEST_DIR, "out.jsonl");
  const exportResult = exportToJSONL(outPath);
  t.is(exportResult.exported, 2);

  const original = loadTrainingData();
  rmSync(join(DATA_DIR, "train.jsonl"));
  const importResult = importFromJSONL(outPath, SYSTEM_CTX);
  t.is(importResult.imported, 2);
  t.deepEqual(loadTrainingData(), original);
});

test.serial("exportToJSON round-trips through importFromJSON", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" });
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "C", assistantOutput: "D" });

  const outPath = join(TEST_DIR, "out.json");
  const exportResult = exportToJSON(outPath);
  t.is(exportResult.exported, 2);

  const original = loadTrainingData();
  rmSync(join(DATA_DIR, "train.jsonl"));
  const importResult = importFromJSON(outPath, SYSTEM_CTX);
  t.is(importResult.imported, 2);
  t.deepEqual(loadTrainingData(), original);
});

test.serial("exportToCSV round-trips single-turn data through importFromCSV", (t) => {
  appendToTrainingData({ contextMessage: DEV_CTX, userInput: "list files", assistantOutput: "ls" });
  appendToTrainingData({ contextMessage: DEV_CTX, userInput: "show dir", assistantOutput: "pwd" });

  const outPath = join(TEST_DIR, "out.csv");
  const exportResult = exportToCSV(outPath);
  t.is(exportResult.exported, 2);
  t.is(exportResult.skipped, 0);

  const content = readFileSync(outPath, "utf-8");
  t.true(content.startsWith("input,output\n"));

  rmSync(join(DATA_DIR, "train.jsonl"));
  const importResult = importFromCSV(outPath, DEV_CTX);
  t.is(importResult.imported, 2);
  const data = loadTrainingData();
  t.is(data[0].messages[1].content, "list files");
  t.is(data[0].messages[2].content, "ls");
  t.is(data[1].messages[1].content, "show dir");
  t.is(data[1].messages[2].content, "pwd");
});

test.serial("exportToCSV skips multi-turn examples instead of truncating them", (t) => {
  const multiTurn: TrainingExample = {
    messages: [
      SYSTEM_CTX,
      { role: "user", content: "turn1" },
      { role: "assistant", content: "reply1" },
      { role: "user", content: "turn2" },
      { role: "assistant", content: "reply2" },
    ],
  };
  appendTrainingExample(multiTurn);
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "single", assistantOutput: "turn" });

  const outPath = join(TEST_DIR, "out.csv");
  const result = exportToCSV(outPath);
  t.is(result.exported, 1);
  t.is(result.skipped, 1);
  t.true(result.errors[0].includes("multi-turn"));
});

test.serial("exportToCSV escapes commas, quotes, and newlines and round-trips through parseCSV", (t) => {
  appendToTrainingData({
    contextMessage: SYSTEM_CTX,
    userInput: 'say "hi", then leave\nplease',
    assistantOutput: "ok",
  });

  const outPath = join(TEST_DIR, "out.csv");
  exportToCSV(outPath);

  const content = readFileSync(outPath, "utf-8");
  const rows = parseCSV(content);
  t.is(rows[1][0], 'say "hi", then leave\nplease');
  t.is(rows[1][1], "ok");
});

test.serial("exportData dispatches to correct writer by extension", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "A", assistantOutput: "B" });

  const jsonlResult = exportData(join(TEST_DIR, "out.jsonl"));
  t.is(jsonlResult.exported, 1);
  const jsonResult = exportData(join(TEST_DIR, "out.json"));
  t.is(jsonResult.exported, 1);
  const csvResult = exportData(join(TEST_DIR, "out.csv"));
  t.is(csvResult.exported, 1);
});

test.serial("exportData returns error for unsupported format", (t) => {
  const result = exportData(join(TEST_DIR, "out.txt"));
  t.is(result.exported, 0);
  t.true(result.errors[0].includes("Unsupported file format"));
});

test.serial("export writers operate on valid.jsonl independently when isEval is true", (t) => {
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "eval-a", assistantOutput: "eval-b" }, true);
  appendToTrainingData({ contextMessage: SYSTEM_CTX, userInput: "train-a", assistantOutput: "train-b" });

  const outPath = join(TEST_DIR, "out-eval.jsonl");
  const result = exportToJSONL(outPath, true);
  t.is(result.exported, 1);

  const content = JSON.parse(readFileSync(outPath, "utf-8").trim());
  t.is(content.messages[1].content, "eval-a");
});

test.serial("export writers produce a valid, parseable empty file with zero examples", (t) => {
  const jsonlPath = join(TEST_DIR, "empty.jsonl");
  exportToJSONL(jsonlPath);
  t.is(readFileSync(jsonlPath, "utf-8"), "");

  const jsonPath = join(TEST_DIR, "empty.json");
  exportToJSON(jsonPath);
  t.deepEqual(JSON.parse(readFileSync(jsonPath, "utf-8")), []);

  const csvPath = join(TEST_DIR, "empty.csv");
  exportToCSV(csvPath);
  t.is(readFileSync(csvPath, "utf-8"), "input,output\n");
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

// ── parseCSV ──────────────────────────────────────────────────────────

test("parseCSV returns empty array for empty input", (t) => {
  t.deepEqual(parseCSV(""), []);
});

test("parseCSV parses a simple two-column row", (t) => {
  t.deepEqual(parseCSV("a,b"), [["a", "b"]]);
});

test("parseCSV trims trailing newline rather than emitting a blank row", (t) => {
  t.deepEqual(parseCSV("a,b\n"), [["a", "b"]]);
});

test("parseCSV handles multiple rows with LF endings", (t) => {
  t.deepEqual(parseCSV("a,b\nc,d\n"), [
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("parseCSV handles CRLF line endings", (t) => {
  t.deepEqual(parseCSV("a,b\r\nc,d\r\n"), [
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("parseCSV handles bare CR line endings", (t) => {
  t.deepEqual(parseCSV("a,b\rc,d"), [
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("parseCSV preserves commas inside quoted fields", (t) => {
  // This is the case the old regex failed on.
  t.deepEqual(parseCSV('"hello, world","answer"'), [["hello, world", "answer"]]);
});

test("parseCSV unescapes doubled quotes inside quoted fields", (t) => {
  t.deepEqual(parseCSV('"she said ""hi""","ok"'), [
    ['she said "hi"', "ok"],
  ]);
});

test("parseCSV preserves newlines inside quoted fields", (t) => {
  t.deepEqual(parseCSV('"line one\nline two","x"'), [
    ["line one\nline two", "x"],
  ]);
});

test("parseCSV handles a mix of quoted and unquoted fields", (t) => {
  t.deepEqual(parseCSV('a,"b, with comma",c'), [["a", "b, with comma", "c"]]);
});

test("parseCSV handles empty fields", (t) => {
  t.deepEqual(parseCSV("a,,c"), [["a", "", "c"]]);
});

test("parseCSV handles a single-field row", (t) => {
  t.deepEqual(parseCSV("only-one"), [["only-one"]]);
});

test("parseCSV gracefully terminates an unclosed quote at EOF", (t) => {
  // Better than throwing — the row is preserved up to where the user got to.
  t.deepEqual(parseCSV('"unclosed'), [["unclosed"]]);
});

test("parseCSV drops only trailing entirely-empty rows", (t) => {
  // A real blank middle row should survive; only the synthetic trailing blank
  // from a final newline is stripped.
  const rows = parseCSV("a,b\n\nc,d\n");
  t.deepEqual(rows, [
    ["a", "b"],
    [""],
    ["c", "d"],
  ]);
});

test("importFromCSV correctly imports a row with an embedded comma", (t) => {
  const csvPath = join(TEST_DIR, "embed.csv");
  // Regression test: the old regex rejected this; the new state-machine
  // parser must round-trip it as one example.
  writeFileSync(csvPath, '"please list files, recursively","find ."\n');

  const result = importFromCSV(csvPath, SYSTEM_CTX);
  t.is(result.imported, 1);
  t.is(result.skipped, 0);

  const data = loadTrainingData();
  t.is(data[0].messages[1].content, "please list files, recursively");
  t.is(data[0].messages[2].content, "find .");
});

// ── splitTrainValidation seedability ──────────────────────────────────

function seedExamples(count: number) {
  for (let i = 0; i < count; i++) {
    appendToTrainingData({
      contextMessage: SYSTEM_CTX,
      userInput: `q${i}`,
      assistantOutput: `a${i}`,
    });
  }
}

test.serial(
  "splitTrainValidation produces the same split for the same seed",
  (t) => {
    seedExamples(20);
    splitTrainValidation(0.2, 42);
    const firstTrain = loadTrainingData(false).map(
      (ex) => ex.messages[1].content,
    );
    const firstValid = loadTrainingData(true).map(
      (ex) => ex.messages[1].content,
    );

    // Reset training data and rerun with the same seed.
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    seedExamples(20);
    splitTrainValidation(0.2, 42);
    const secondTrain = loadTrainingData(false).map(
      (ex) => ex.messages[1].content,
    );
    const secondValid = loadTrainingData(true).map(
      (ex) => ex.messages[1].content,
    );

    t.deepEqual(firstTrain, secondTrain);
    t.deepEqual(firstValid, secondValid);
  },
);

test.serial(
  "splitTrainValidation produces a full permutation (no duplicates, no drops)",
  (t) => {
    seedExamples(10);
    splitTrainValidation(0.2, 7);
    const train = loadTrainingData(false).map((ex) => ex.messages[1].content);
    const valid = loadTrainingData(true).map((ex) => ex.messages[1].content);

    const all = [...train, ...valid].sort();
    const expected = Array.from({ length: 10 }, (_, i) => `q${i}`).sort();
    t.deepEqual(all, expected);
    // 10 examples, 20% → 2 in valid, 8 in train
    t.is(train.length, 8);
    t.is(valid.length, 2);
  },
);

test.serial(
  "splitTrainValidation with different seeds produces different splits",
  (t) => {
    seedExamples(20);
    splitTrainValidation(0.5, 1);
    const splitA = loadTrainingData(false).map(
      (ex) => ex.messages[1].content,
    );

    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    seedExamples(20);
    splitTrainValidation(0.5, 999);
    const splitB = loadTrainingData(false).map(
      (ex) => ex.messages[1].content,
    );

    // 20 examples, 50% split — two different seeds should almost certainly
    // produce a different train half. (Mathematically possible to collide,
    // but with mulberry32 + these seeds it doesn't.)
    t.notDeepEqual(splitA, splitB);
  },
);

test.serial("splitTrainValidation with zero examples returns zero counts", (t) => {
  const result = splitTrainValidation(0.1, 1);
  t.deepEqual(result, { trainCount: 0, validCount: 0 });
});

test.serial(
  "splitTrainValidation guarantees at least one validation example when count >= 2",
  (t) => {
    seedExamples(2);
    // 10% of 2 = 0.2 → floor = 0, but the function forces at least 1.
    const result = splitTrainValidation(0.1, 1);
    t.is(result.validCount, 1);
    t.is(result.trainCount, 1);
  },
);
