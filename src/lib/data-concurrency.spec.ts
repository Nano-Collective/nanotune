import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "ava";
import { execa } from "execa";
import type { TrainingExample } from "../types/index.js";
import { collectValidation, deleteExample, saveTrainingData, updateTrainingExample } from "./data.js";
import { getDataLockPath, withDataLock } from "./data-lock.js";
import { isProcessAlive } from "./model-cache.js";

const ORIG_CWD = process.cwd();
const TEST_DIR = join(ORIG_CWD, ".test-concurrency-spec");
const DATA_DIR = join(TEST_DIR, ".nanotune", "data");
const TRAIN_FILE = join(DATA_DIR, "train.jsonl");
const VALID_FILE = join(DATA_DIR, "valid.jsonl");
const STOP_FILE = join(TEST_DIR, "stop-appending");
const DATA_MODULE = pathToFileURL(join(ORIG_CWD, "src", "lib", "data.ts")).href;
const LOCK_MODULE = pathToFileURL(join(ORIG_CWD, "src", "lib", "data-lock.ts")).href;

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
 * whenever whatever it is racing finishes.
 */
function appenderCode(prefix: string): string {
  return `
process.chdir(${JSON.stringify(TEST_DIR)});
const {appendTrainingExample} = await import(${JSON.stringify(DATA_MODULE)});
const {existsSync} = await import("node:fs");
let written = 0;
for (let i = 0; i < 100000; i++) {
	appendTrainingExample(
		{
			messages: [
				{role: "user", content: ${JSON.stringify(prefix)} + i},
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

/** Appends a fixed number of rows and exits, for racing two of each other. */
function fixedAppenderCode(prefix: string, count: number): string {
  return `
process.chdir(${JSON.stringify(TEST_DIR)});
const {appendTrainingExample} = await import(${JSON.stringify(DATA_MODULE)});
for (let i = 0; i < ${count}; i++) {
	appendTrainingExample(
		{
			messages: [
				{role: "user", content: ${JSON.stringify(prefix)} + i},
				{role: "assistant", content: "reply-" + i},
			],
		},
		false,
	);
}
`;
}

/**
 * Rewrites the first example `count` times. It never removes a row, so every
 * row the other process appended must still be there afterwards - which is
 * exactly what an un-locked read-modify-write throws away.
 *
 * Bounded and paced rather than spinning. Each edit replaces the whole file,
 * so a tight loop does thousands of temp-file-and-rename cycles a second
 * against a file another process is appending to. That is far past anything a
 * user does by pressing `e` once, and on Windows each newly created temp file
 * draws a real-time scanner that opens it - which makes rename(2) fail with
 * EPERM, an outcome POSIX has no equivalent of.
 */
function editorCode(count: number): string {
  return `
process.chdir(${JSON.stringify(TEST_DIR)});
const {updateTrainingExample} = await import(${JSON.stringify(DATA_MODULE)});
const idle = new Int32Array(new SharedArrayBuffer(4));
let n = 0;
for (let i = 0; i < ${count}; i++) {
	updateTrainingExample(0, {messages: [
		{role: "user", content: "edited-" + i},
		{role: "assistant", content: "edited-reply-" + i},
	]}, false);
	n++;
	Atomics.wait(idle, 0, 0, 5);
}
console.log(String(n));
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

/** Takes the lock and holds it until killed, leaving it behind on exit. */
function holderCode(): string {
  return `
process.chdir(${JSON.stringify(TEST_DIR)});
const {withDataLock} = await import(${JSON.stringify(LOCK_MODULE)});
withDataLock(() => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
});
`;
}

/** Reports whether it can take the lock. Prints "acquired" or throws. */
function acquirerCode(): string {
  return `
process.chdir(${JSON.stringify(TEST_DIR)});
const {withDataLock} = await import(${JSON.stringify(LOCK_MODULE)});
console.log(withDataLock(() => "acquired", {timeoutMs: 15000}));
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

function bothFiles(): string[] {
  return [...userInputs(TRAIN_FILE), ...userInputs(VALID_FILE)];
}

/**
 * Waits for a lock to be fully claimed. The owner file rather than the bare
 * directory: killing a holder between mkdir and the write would leave a lock
 * nobody can identify, which is deliberately never taken over.
 */
async function waitForLock(timeoutMs = 15_000): Promise<boolean> {
  const ownerFile = join(getDataLockPath(), "owner.json");
  const started = Date.now();
  while (!existsSync(ownerFile) && Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return existsSync(ownerFile);
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
  const appender = runChild(appenderCode("appended-"));

  const split = await splitter;
  writeFileSync(STOP_FILE, "");
  const appended = await appender;

  t.is(split.exitCode, 0, `splitter failed: ${split.stderr}`);
  t.is(appended.exitCode, 0, `appender failed: ${appended.stderr}`);

  const written = Number(appended.stdout);
  t.true(written > 0, "the appender wrote nothing, so nothing was raced");

  // A split only moves examples between the two files, so one present in
  // neither was dropped outright.
  const present = new Set(bothFiles());
  const expected = [
    ...seedExamples(SEED_COUNT).map(ex => ex.messages[0].content),
    ...Array.from({ length: written }, (_, i) => `appended-${i}`),
  ];
  const lost = expected.filter(input => !present.has(input));

  t.is(present.size, expected.length, `${lost.length} examples lost, e.g. ${lost.slice(0, 5).join(", ")}`);
});

test.serial("two processes appending at once both keep every example", async (t) => {
  t.timeout(60_000);

  const left = runChild(fixedAppenderCode("left-", 300));
  const right = runChild(fixedAppenderCode("right-", 300));
  const [a, b] = await Promise.all([left, right]);

  t.is(a.exitCode, 0, a.stderr);
  t.is(b.exitCode, 0, b.stderr);

  const present = new Set(userInputs(TRAIN_FILE));
  const expected = [
    ...Array.from({ length: 300 }, (_, i) => `left-${i}`),
    ...Array.from({ length: 300 }, (_, i) => `right-${i}`),
  ];

  // O_APPEND already made this safe. Asserted so a future change to how an
  // append is written cannot quietly reintroduce the loss the issue reported.
  t.is(present.size, 600, `${600 - present.size} examples lost`);
});

test.serial("an edit loop running alongside an import discards nothing", async (t) => {
  t.timeout(60_000);

  saveTrainingData(seedExamples(5), false);
  const appender = runChild(appenderCode("imported-"));
  await new Promise(resolve => setTimeout(resolve, 100));
  const editor = runChild(editorCode(40));

  // The editor runs a bounded number of edits, so it finishes on its own. Only
  // then is the appender allowed to stop, which keeps it writing throughout.
  const edits = await editor;
  writeFileSync(STOP_FILE, "");
  const imported = await appender;

  t.is(imported.exitCode, 0, imported.stderr);
  t.is(edits.exitCode, 0, edits.stderr);
  t.true(Number(edits.stdout) > 0, "the editor never ran");

  const written = Number(imported.stdout);
  const present = new Set(bothFiles());
  // The editor only ever rewrote row 0, so every appended row and every other
  // seeded row must have survived its read-modify-write.
  const expected = [
    ...Array.from({ length: written }, (_, i) => `imported-${i}`),
    "seed-1",
    "seed-2",
    "seed-3",
    "seed-4",
  ];
  const lost = expected.filter(input => !present.has(input));

  t.is(present.size, expected.length + 1, `${lost.length} examples lost, e.g. ${lost.slice(0, 5).join(", ")}`);
});

test.serial("a lock left behind by a killed process is taken over", async (t) => {
  t.timeout(60_000);

  const victim = runChild(holderCode());
  if (victim.pid === undefined) throw new Error("execa reported no pid for the holder");
  const victimPid = victim.pid;
  t.true(await waitForLock(), "the child never took the lock");

  victim.kill("SIGKILL");
  await victim;
  t.true(existsSync(getDataLockPath()), "a killed holder should leave its lock behind");

  // A killed process is not gone until the OS says so, and under a loaded
  // machine that can take a moment. Waiting for it here keeps the test about
  // the lock's behaviour rather than the scheduler's.
  const reaped = Date.now();
  while (isProcessAlive(victimPid) && Date.now() - reaped < 20_000) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  t.false(isProcessAlive(victimPid), "the killed process still reads as alive");

  const next = runChild(acquirerCode());
  const result = await next;

  t.is(result.exitCode, 0, result.stderr);
  t.is(result.stdout.trim(), "acquired");
});

test.serial("a mutation nested inside a held lock does not wait on itself", (t) => {
  saveTrainingData(seedExamples(3), false);

  // deleteExample takes the lock itself. Inside another holder that must be the
  // re-entrant path, not a wait that never ends.
  withDataLock(() => {
    deleteExample(1, false);
  });

  const remaining = userInputs(TRAIN_FILE);
  t.deepEqual(remaining, ["seed-0", "seed-2"]);
});

test.serial("data validate --fix runs both repairs inside one lock", (t) => {
  writeFileSync(
    join(TEST_DIR, ".nanotune", "config.json"),
    JSON.stringify({
      name: "concurrency-spec",
      baseModel: "mlx-community/test",
      contextMessage: { role: "system", content: "You are helpful." },
      training: {},
      export: { outputName: "out" },
    }),
  );

  saveTrainingData(
    [
      { messages: [{ role: "developer", content: "Old prompt." }, { role: "user", content: "A" }, { role: "assistant", content: "1" }] },
      { messages: [{ role: "developer", content: "Old prompt." }, { role: "user", content: "A" }, { role: "assistant", content: "1" }] },
    ],
    false,
  );

  // collectValidation wraps fixContextMessages and dedupeExamples, so this
  // nests three deep. Deadlocking here would hang the whole suite.
  const report = collectValidation({ fix: true, rewriteContext: true });

  t.true(report.fixes !== null);
  t.is(report.fixes?.contextMessagesRewritten, 2);
  t.is(report.fixes?.duplicatesRemoved, 1);
  t.is(report.examples, 1);
  t.false(existsSync(getDataLockPath()));
});
