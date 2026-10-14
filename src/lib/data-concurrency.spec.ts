import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "ava";
import { execa } from "execa";
import type { TrainingExample } from "../types/index.js";
import { saveTrainingData } from "./data.js";

const ORIG_CWD = process.cwd();
const TEST_DIR = join(ORIG_CWD, ".test-concurrency-spec");
const DATA_DIR = join(TEST_DIR, ".nanotune", "data");
const TRAIN_FILE = join(DATA_DIR, "train.jsonl");
const VALID_FILE = join(DATA_DIR, "valid.jsonl");
const STOP_FILE = join(TEST_DIR, "stop-appending");
// A URL, not a path: ESM resolves a Windows absolute path as a URL scheme.
const DATA_MODULE = pathToFileURL(join(ORIG_CWD, "src", "lib", "data.ts")).href;

const SEED_COUNT = 60;

// Two calls in one thread are strictly ordered, so nothing here can race
// itself: the interleaving needs two independent processes.
const runChild = (code: string) =>
  execa(process.execPath, ["--import=tsx", "--input-type=module", "-e", code], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // A child that dies must not reject here: the stop file is written after
    // the splitter is awaited, so a rejection would skip it and leave the
    // appender looping through its whole cap during teardown.
    reject: false,
  });

/**
 * Appends until the stop file appears. The cap keeps a missing stop file from
 * hanging the suite; the real work is that the appender is still mid-flight
 * whenever the split finishes.
 */
function appenderCode(): string {
  return `
process.chdir(${JSON.stringify(TEST_DIR)});
const {appendTrainingExample} = await import(${JSON.stringify(DATA_MODULE)});
const {existsSync} = await import("node:fs");
let written = 0;
for (let i = 0; i < 100000; i++) {
	appendTrainingExample(
		{
			messages: [
				{role: "user", content: "appended-" + i},
				{role: "assistant", content: "reply-" + i},
			],
		},
		false,
	);
	written = i + 1;
	if (i % 16 === 15 && existsSync(${JSON.stringify(STOP_FILE)})) break;
}
console.log(String(written));
`;
}

/**
 * Waits for the appender to grow train.jsonl. Splitting immediately instead
 * lets a fast appender finish first, and the test then passes against code that
 * is still broken.
 */
function splitterCode(seedSize: number): string {
  return `
process.chdir(${JSON.stringify(TEST_DIR)});
const {splitTrainValidation} = await import(${JSON.stringify(DATA_MODULE)});
const {statSync} = await import("node:fs");
const train = ${JSON.stringify(TRAIN_FILE)};
const idle = new Int32Array(new SharedArrayBuffer(4));
for (let i = 0; i < 4000; i++) {
	if (statSync(train).size > ${seedSize}) break;
	Atomics.wait(idle, 0, 0, 5);
}
splitTrainValidation(0.2, 12345);
`;
}

function seedExamples(count: number): TrainingExample[] {
  return Array.from({ length: count }, (_, i) => ({
    messages: [
      { role: "user", content: `seed-${i}` },
      { role: "assistant", content: `reply-${i}` },
    ],
  }));
}

/** Keyed on user content, so a lost example is a missing string. */
function userInputs(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(line => line.trim())
    .map(line => {
      const parsed = JSON.parse(line) as TrainingExample;
      return parsed.messages.find(m => m.role === "user")?.content ?? "";
    });
}

test.beforeEach(() => {
  // chdir first: Windows refuses to unlink a directory that is some process's
  // working directory, and this suite's cwd is inside the one being cleared.
  process.chdir(ORIG_CWD);
  rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(DATA_DIR, { recursive: true });
  process.chdir(TEST_DIR);
});

test.afterEach.always(() => {
  process.chdir(ORIG_CWD);
  rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 3 });
});

test.serial("a split running alongside appends loses none of the appended examples", async (t) => {
  t.timeout(60_000);

  saveTrainingData(seedExamples(SEED_COUNT), false);
  const seedSize = statSync(TRAIN_FILE).size;

  // The splitter parks on the size check before the appender starts. The other
  // order lets the appender finish before the split is ever scheduled.
  const splitter = runChild(splitterCode(seedSize));
  const appender = runChild(appenderCode());

  const split = await splitter;
  writeFileSync(STOP_FILE, "");
  const appended = await appender;

  t.is(split.exitCode, 0, `splitter failed: ${split.stderr}`);
  t.is(appended.exitCode, 0, `appender failed: ${appended.stderr}`);

  const written = Number(appended.stdout);
  t.true(written > 0, "the appender wrote nothing, so nothing was raced");

  // A split only moves examples between the two files, so one present in
  // neither was dropped outright.
  const present = new Set([...userInputs(TRAIN_FILE), ...userInputs(VALID_FILE)]);
  const expected = [
    ...seedExamples(SEED_COUNT).map(ex => ex.messages[0].content),
    ...Array.from({ length: written }, (_, i) => `appended-${i}`),
  ];
  const lost = expected.filter(input => !present.has(input));

  t.is(present.size, expected.length, `${lost.length} examples lost, e.g. ${lost.slice(0, 5).join(", ")}`);
});
