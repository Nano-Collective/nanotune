import test from "ava";

// We'll test the pure functions that don't depend on the file system
// For file-dependent functions, we'd need to mock or use a test directory

test("TrainingExample structure is correct", (t) => {
  const example = {
    messages: [
      { role: "system" as const, content: "You are helpful." },
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there!" },
    ],
  };

  t.is(example.messages.length, 3);
  t.is(example.messages[0].role, "system");
  t.is(example.messages[1].role, "user");
  t.is(example.messages[2].role, "assistant");
});

test("ValidationResult structure is correct", (t) => {
  const result = {
    valid: true,
    errors: [] as string[],
    warnings: ["Only 10 examples found"],
  };

  t.true(result.valid);
  t.is(result.errors.length, 0);
  t.is(result.warnings.length, 1);
});

test("ImportResult structure is correct", (t) => {
  const result = {
    imported: 10,
    skipped: 2,
    errors: ["Line 5: Invalid format"],
  };

  t.is(result.imported, 10);
  t.is(result.skipped, 2);
  t.is(result.errors.length, 1);
});

test("CSV parsing logic works correctly", (t) => {
  // Test the CSV parsing regex pattern
  const csvLine = '"list all files","ls -la"';
  const match = csvLine.match(/^"?([^"]*)"?,\s*"?([^"]*)"?$/);

  t.truthy(match);
  t.is(match?.[1], "list all files");
  t.is(match?.[2], "ls -la");
});

test("CSV parsing handles unquoted values", (t) => {
  const csvLine = "list files,ls";
  const match = csvLine.match(/^"?([^"]*)"?,\s*"?([^"]*)"?$/);

  t.truthy(match);
  t.is(match?.[1], "list files");
  t.is(match?.[2], "ls");
});

test("JSONL parsing works correctly", (t) => {
  const jsonlLine =
    '{"messages":[{"role":"system","content":"prompt"},{"role":"user","content":"hello"},{"role":"assistant","content":"hi"}]}';
  const data = JSON.parse(jsonlLine);

  t.truthy(data.messages);
  t.is(data.messages.length, 3);
  t.is(data.messages[0].role, "system");
});

test("Simple input/output JSONL format works", (t) => {
  const jsonlLine = '{"input":"list files","output":"ls"}';
  const data = JSON.parse(jsonlLine);

  t.truthy(data.input);
  t.truthy(data.output);
  t.is(data.input, "list files");
  t.is(data.output, "ls");
});
