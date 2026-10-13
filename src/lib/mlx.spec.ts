import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {execa, type ResultPromise} from 'execa';
import {
	abortTraining,
	buildLoraConfigYaml,
	buildTrainingArgs,
	needsLoraConfig,
	parseTrainingLogLine,
	restoreAdapterFile,
	shouldTreatAsStop,
	stopOnAbort,
	type MLXTrainingOptions,
} from './mlx.js';

for (const [line, expected] of [
	['Iter 10: Train loss 1.234, Val loss 1.456', {iteration: 10, trainLoss: 1.234, valLoss: 1.456}],
	['Iter 50: Train loss 0.456', {iteration: 50, trainLoss: 0.456}],
	['Iter 100 (15.2 it/s): Train loss 0.342, Val loss 0.298', {iteration: 100, trainLoss: 0.342, valLoss: 0.298}],
	['Iter 50: Val loss 0.456, Val took 1.230s', {iteration: 50, valLoss: 0.456}],
	['Iter 50: Val loss 1e-3', {iteration: 50, valLoss: 0.001}],
	['Iter 50: Val loss nan', null],
	[' \u001b[38;5;244m  50\u001b[0m \u001b[1;35mval\u001b[0m \u001b[1m0.456\u001b[0m 1.23s', {iteration: 50, valLoss: 0.456}],
	['   10 1.234 ▼ 1,234  12.3k', {iteration: 10, trainLoss: 1.234}],
	['Iter 50: Saved adapter weights to adapters.safetensors.', null],
] as const) {
	test(`parseTrainingLogLine: ${line}`, t => t.deepEqual(parseTrainingLogLine(line), expected));
}

test('restoring an evaluated snapshot atomically replaces the active adapter', t => {
	const dir = mkdtempSync(join(tmpdir(), 'nanotune-restore-'));
	try {
		const src = join(dir, 'best.safetensors');
		const dest = join(dir, 'adapters.safetensors');
		writeFileSync(src, 'best');
		writeFileSync(dest, 'last');
		restoreAdapterFile(src, dest);
		t.is(readFileSync(dest, 'utf8'), 'best');
		t.throws(() => restoreAdapterFile(join(dir, 'missing'), dest));
		t.is(readFileSync(dest, 'utf8'), 'best');
		t.deepEqual(readdirSync(dir).sort(), ['adapters.safetensors', 'best.safetensors']);
	} finally {rmSync(dir, {recursive: true, force: true});}
});

function trainingOptions(overrides: Partial<MLXTrainingOptions> = {}): MLXTrainingOptions {
	return {
		model: 'model', dataPath: '/data', adapterPath: '/adapters', iterations: 150,
		learningRate: 5e-5, batchSize: 4, numLayers: 16, stepsPerEval: 50, saveEvery: 50,
		resume: false, fineTuneType: 'lora', loraRank: 8, loraAlpha: 20, loraDropout: 0,
		maxSeqLength: 2048, gradCheckpoint: false, valBatches: 25, seed: 0,
		earlyStoppingPatience: 0, loadBestModelAtEnd: false, ...overrides,
	};
}

test('buildTrainingArgs passes hyperparameters, optional YAML, and resume path', t => {
	const args = buildTrainingArgs(trainingOptions({fineTuneType: 'dora', maxSeqLength: 1024, valBatches: 10, seed: 42, resume: true}), '/tmp/lora.yaml');
	const value = (flag: string) => args[args.indexOf(flag) + 1];
	t.is(value('--fine-tune-type'), 'dora');
	t.is(value('--max-seq-length'), '1024');
	t.is(value('--val-batches'), '10');
	t.is(value('--seed'), '42');
	t.is(value('-c'), '/tmp/lora.yaml');
	t.is(value('--resume-adapter-file'), '/adapters/adapters.safetensors');
	t.false(buildTrainingArgs(trainingOptions()).includes('-c'));
	t.false(buildTrainingArgs(trainingOptions()).includes('--resume-adapter-file'));
});

test('buildTrainingArgs adds --grad-checkpoint only when enabled', t => {
	t.false(buildTrainingArgs(trainingOptions()).includes('--grad-checkpoint'));
	t.true(buildTrainingArgs(trainingOptions({gradCheckpoint: true})).includes('--grad-checkpoint'));
});

test('LoRA configuration is only needed for lora and dora', t => {
	t.true(needsLoraConfig('lora'));
	t.true(needsLoraConfig('dora'));
	t.false(needsLoraConfig('full'));
});

test('LoRA YAML reflects settings without exponent notation', t => {
	t.is(buildLoraConfigYaml(8, 20, 0), 'lora_parameters:\n  rank: 8\n  scale: 20\n  dropout: 0\n');
	t.is(buildLoraConfigYaml(16, 32, 0.05), 'lora_parameters:\n  rank: 16\n  scale: 32\n  dropout: 0.05\n');
	t.regex(buildLoraConfigYaml(8, 20, 1e-7), /dropout: 0\.0000001/);
	t.false(buildLoraConfigYaml(8, 20, 1e-7).includes('e-'));
});

function fakeSubprocess() {
	const signals: string[] = [];
	const subprocess = {kill(signal: string) {signals.push(signal); return true;}} as unknown as ResultPromise;
	return {subprocess, signals};
}

test('abortTraining sends SIGINT', t => {
	const {subprocess, signals} = fakeSubprocess();
	abortTraining(subprocess);
	t.deepEqual(signals, ['SIGINT']);
});

test('stopOnAbort signals once and detaches safely before or after cancellation', t => {
	const {subprocess, signals} = fakeSubprocess();
	const controller = new AbortController();
	const detach = stopOnAbort(subprocess, controller.signal);
	t.deepEqual(signals, []);
	controller.abort(); controller.abort(); detach(); detach();
	t.deepEqual(signals, ['SIGINT']);
	const other = new AbortController();
	const detached = stopOnAbort(subprocess, other.signal);
	detached(); other.abort();
	t.deepEqual(signals, ['SIGINT']);
});

test('stopOnAbort handles already aborted signals and absent signals', t => {
	const {subprocess, signals} = fakeSubprocess();
	stopOnAbort(subprocess, undefined)();
	t.deepEqual(signals, []);
	const controller = new AbortController(); controller.abort();
	stopOnAbort(subprocess, controller.signal)();
	t.deepEqual(signals, ['SIGINT']);
});

test('stopOnAbort terminates a real running child process', async t => {
	const child = execa(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
	const controller = new AbortController();
	stopOnAbort(child, controller.signal); controller.abort();
	t.truthy(await t.throwsAsync(child));
});

test('shouldTreatAsStop only accepts an aborted signal', t => {
	const controller = new AbortController();
	t.false(shouldTreatAsStop(undefined));
	t.false(shouldTreatAsStop(controller.signal));
	controller.abort();
	t.true(shouldTreatAsStop(controller.signal));
});
