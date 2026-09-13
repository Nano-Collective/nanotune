import {mkdirSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'ava';
import {render} from 'ink-testing-library';
import {StatusCommand} from './status.js';

/**
 * `status` is the report a user reads to work out where their project is: how
 * much data they have, whether training has run, what has been exported, how
 * the last benchmark went. It is synchronous, so the whole report is on screen
 * as soon as it renders — which makes every branch reachable from a fixture.
 */

const ORIG_CWD = process.cwd();
const TEST_DIR = join(ORIG_CWD, '.test-status-spec');
const NANOTUNE_DIR = join(TEST_DIR, '.nanotune');
const DATA_DIR = join(NANOTUNE_DIR, 'data');
const ADAPTERS_DIR = join(NANOTUNE_DIR, 'adapters');
const MODELS_DIR = join(NANOTUNE_DIR, 'models');
const BENCH_DIR = join(NANOTUNE_DIR, 'benchmarks');

const CONFIG = {
	name: 'status-project',
	version: '1.0.0',
	baseModel: 'Qwen/Qwen2.5-Coder-1.5B-Instruct',
	contextMessage: {role: 'system', content: 'You are helpful.'},
	training: {
		iterations: 150,
		learningRate: 5e-5,
		batchSize: 4,
		numLayers: 16,
		stepsPerEval: 50,
		saveEvery: 50,
	},
	export: {quantization: 'q4_k_m', outputName: 'status-project'},
};

function bare(): void {
	rmSync(TEST_DIR, {recursive: true, force: true});
	mkdirSync(TEST_DIR, {recursive: true});
	process.chdir(TEST_DIR);
}

/** A project with a config and nothing else done yet. */
function project(): void {
	bare();
	mkdirSync(DATA_DIR, {recursive: true});
	writeFileSync(
		join(NANOTUNE_DIR, 'config.json'),
		JSON.stringify(CONFIG, null, 2),
	);
}

/**
 * Training and validation live in separate files — train.jsonl and valid.jsonl
 * — rather than as a flag on each row, so a count is a line count per file.
 */
function writeExamples(train: number, valid: number): void {
	const row = (prefix: string, i: number) =>
		JSON.stringify({
			messages: [
				{role: 'user', content: `${prefix}${i}`},
				{role: 'assistant', content: `reply ${prefix}${i}`},
			],
		});
	const lines = (prefix: string, n: number) =>
		Array.from({length: n}, (_, i) => row(prefix, i)).join('\n');

	writeFileSync(join(DATA_DIR, 'train.jsonl'), `${lines('q', train)}\n`);
	if (valid > 0) {
		writeFileSync(join(DATA_DIR, 'valid.jsonl'), `${lines('v', valid)}\n`);
	}
}

/** Age a file by the given number of seconds, so relative times are testable. */
function age(path: string, secondsAgo: number): void {
	const when = Date.now() / 1000 - secondsAgo;
	utimesSync(path, when, when);
}

/**
 * Every frame joined, not `lastFrame()`. `StatusCommand` calls `useAutoExit`,
 * which unmounts as soon as the report is on screen — so the final frame is
 * blank and only the accumulated frames hold the output. Whitespace is
 * collapsed because Ink wraps and pads to the terminal width.
 */
/**
 * Ink emits colour when the environment reports terminal support, and CI sets
 * FORCE_COLOR — so the same frame carries ANSI escapes there and none locally.
 * Matching a coloured value without stripping passes on a laptop and fails in
 * CI, which is the worst way round.
 */
function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI.
	return text.replace(/\u001B\[[0-9;]*m/g, '');
}

function frameOf(): string {
	const instance = render(<StatusCommand />);
	const output = instance.frames.join('\n');
	instance.unmount();
	return stripAnsi(output).replace(/\s+/g, ' ');
}

test.afterEach(() => {
	process.chdir(ORIG_CWD);
	rmSync(TEST_DIR, {recursive: true, force: true});
	// useAutoExit sets process.exitCode on the error path, and that is global —
	// leaving it set fails the whole worker regardless of the assertions.
	process.exitCode = 0;
});

// --- not a project ----------------------------------------------------------

test.serial('a directory with no config says so rather than crashing', t => {
	bare();
	process.exitCode = 0;
	const frame = frameOf();
	t.true(frame.includes('Not a Nanotune project'));
	t.true(frame.includes('nanotune init'), 'should say what to do next');
	// A CLI that prints an error and exits 0 is invisible to a shell script.
	t.is(process.exitCode, 1);
});

// --- a fresh project --------------------------------------------------------

test.serial('a fresh project reports nothing done yet', t => {
	project();
	process.exitCode = 0;
	const frame = frameOf();
	t.is(process.exitCode, 0, 'a healthy project is not a failure');
	t.true(frame.includes('status-project'));
	t.true(frame.includes('Qwen/Qwen2.5-Coder-1.5B-Instruct'));
	t.true(frame.includes('Not started'), 'training');
	t.true(frame.includes('No exported models yet'));
	t.true(frame.includes('No benchmarks run yet'));
});

// --- training data ----------------------------------------------------------

test.serial('training and validation examples are counted separately', t => {
	project();
	writeExamples(7, 3);
	const frame = frameOf();
	t.regex(frame, /Training Examples: 7/);
	t.regex(frame, /Validation Examples: 3/);
});

test.serial('a just-written dataset reads as "just now"', t => {
	project();
	writeExamples(1, 0);
	t.regex(frameOf(), /Last Modified: just now/);
});

test.serial('dataset age is reported in the largest sensible unit', t => {
	project();
	writeExamples(1, 0);
	const trainFile = join(DATA_DIR, 'train.jsonl');

	age(trainFile, 5 * 60);
	t.regex(frameOf(), /Last Modified: 5 minutes ago/);

	age(trainFile, 60 * 60);
	t.regex(frameOf(), /Last Modified: 1 hour ago/, 'singular, not "1 hours"');

	age(trainFile, 3 * 24 * 60 * 60);
	t.regex(frameOf(), /Last Modified: 3 days ago/);
});

// --- training ---------------------------------------------------------------

test.serial('an adapter file marks training as completed', t => {
	project();
	mkdirSync(ADAPTERS_DIR, {recursive: true});
	const adapter = join(ADAPTERS_DIR, 'adapters.safetensors');
	writeFileSync(adapter, 'weights');
	age(adapter, 2 * 60 * 60);

	const frame = frameOf();
	t.true(frame.includes('Completed'));
	t.false(frame.includes('Not started'));
	t.regex(frame, /Last Run: 2 hours ago/);
});

// --- exports ----------------------------------------------------------------

test.serial('exported models are listed newest first, with the latest marked', t => {
	project();
	mkdirSync(MODELS_DIR, {recursive: true});
	const older = join(MODELS_DIR, 'old.gguf');
	const newer = join(MODELS_DIR, 'new.gguf');
	writeFileSync(older, 'x');
	writeFileSync(newer, 'y');
	age(older, 10_000);
	age(newer, 10);

	const frame = frameOf();
	t.true(frame.includes('new.gguf'));
	t.true(frame.includes('old.gguf'));
	t.true(frame.indexOf('new.gguf') < frame.indexOf('old.gguf'), 'newest first');
	t.true(frame.includes('<- latest'));
});

test.serial('only .gguf files count as exports', t => {
	project();
	mkdirSync(MODELS_DIR, {recursive: true});
	writeFileSync(join(MODELS_DIR, 'model.gguf'), 'x');
	writeFileSync(join(MODELS_DIR, 'notes.txt'), 'x');
	writeFileSync(join(MODELS_DIR, 'adapter.safetensors'), 'x');

	const frame = frameOf();
	t.true(frame.includes('model.gguf'));
	t.false(frame.includes('notes.txt'));
	t.false(frame.includes('adapter.safetensors'));
});

test.serial('export sizes are scaled to a readable unit', t => {
	project();
	mkdirSync(MODELS_DIR, {recursive: true});
	writeFileSync(join(MODELS_DIR, 'tiny.gguf'), 'x'.repeat(512));
	writeFileSync(join(MODELS_DIR, 'small.gguf'), 'x'.repeat(2 * 1024));
	writeFileSync(join(MODELS_DIR, 'big.gguf'), 'x'.repeat(3 * 1024 * 1024));

	const frame = frameOf();
	t.true(frame.includes('(512 B)'), frame);
	t.true(frame.includes('(2.0 KB)'), frame);
	t.true(frame.includes('(3.0 MB)'), frame);
});

// --- benchmarks -------------------------------------------------------------

function writeBenchmark(passed: number, total: number, extra = {}): void {
	mkdirSync(BENCH_DIR, {recursive: true});
	writeFileSync(
		join(BENCH_DIR, 'benchmark-1.json'),
		JSON.stringify({
			model: 'status-project',
			timestamp: '2026-03-04T00:00:00.000Z',
			summary: {total, passed, failed: total - passed, passRate: passed / total},
			categories: {},
			results: [],
			failures: [],
			...extra,
		}),
	);
}

test.serial('the latest benchmark is summarised as a pass rate', t => {
	project();
	writeBenchmark(9, 10);
	t.regex(frameOf(), /Latest: 9\/10 \(90%\)/);
});

test.serial('a base-model run is labelled as the control', t => {
	project();
	writeBenchmark(4, 10, {isBase: true});
	const frame = frameOf();
	t.regex(frame, /Latest: 4\/10 \(40%\)/);
	t.true(frame.includes('base model, control'));
});

test.serial('an unreadable benchmark is ignored, not fatal', t => {
	project();
	mkdirSync(BENCH_DIR, {recursive: true});
	writeFileSync(join(BENCH_DIR, 'benchmark-1.json'), '{ not json');

	// The status report exists to tell you where you are. A corrupt benchmark
	// file must not be the reason you cannot find out.
	const frame = frameOf();
	t.true(frame.includes('No benchmarks run yet'));
	t.true(frame.includes('status-project'), 'the rest of the report survives');
});
