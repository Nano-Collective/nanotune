import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'ava';
import {
	ensureTrainingRunsDir,
	formatTrainingRuns,
	getTrainingRunsDir,
	listTrainingRuns,
	saveTrainingRun,
	type TrainingRunRecord,
} from './training-runs.js';

const ORIG_CWD = process.cwd();
const TEST_DIR = join(ORIG_CWD, '.test-training-runs-spec');
const NANOTUNE_DIR = join(TEST_DIR, '.nanotune');

function record(id: string, startedAt: string): TrainingRunRecord {
	return {
		id,
		startedAt,
		finishedAt: startedAt,
		status: 'completed',
		baseModel: 'mlx-community/Qwen2.5-0.5B-Instruct-4bit',
		training: {
			iterations: 20,
			learningRate: 0.00005,
			batchSize: 4,
			numLayers: 16,
			stepsPerEval: 5,
			saveEvery: 10,
			fineTuneType: 'lora',
			loraRank: 8,
			loraAlpha: 20,
			loraDropout: 0,
			maxSeqLength: 2048,
			gradCheckpoint: false,
			valBatches: 25,
			seed: 0,
			earlyStoppingPatience: 0,
			loadBestModelAtEnd: false,
		},
		examples: {train: 12, validation: 3},
		durationMs: 12000,
		lossHistory: [
			{iteration: 10, trainLoss: 1.25, valLoss: 1.4},
			{iteration: 20, trainLoss: 0.9, valLoss: 1.1},
		],
		finalTrainLoss: 0.9,
		finalValLoss: 1.1,
		resume: false,
		adapterPath: '.nanotune/adapters/adapters.safetensors',
		adapterModifiedAt: null,
	};
}

test.beforeEach(() => {
	rmSync(TEST_DIR, {recursive: true, force: true});
	mkdirSync(NANOTUNE_DIR, {recursive: true});
	process.chdir(TEST_DIR);
});

test.afterEach.always(() => {
	process.chdir(ORIG_CWD);
	rmSync(TEST_DIR, {recursive: true, force: true});
});

test.serial('ensureTrainingRunsDir creates the local runs directory', t => {
	const dir = ensureTrainingRunsDir();
	t.is(dir, getTrainingRunsDir());
	t.true(dir.endsWith(join('.nanotune', 'runs')));
});

test.serial('saveTrainingRun writes records atomically and lists newest first', t => {
	const olderId = 'a1000000-0000-4000-8000-000000000001';
	const newerId = 'a1000000-0000-4000-8000-000000000002';
	saveTrainingRun(record(olderId, '2026-08-01T10:00:00.000Z'));
	saveTrainingRun(record(newerId, '2026-08-02T10:00:00.000Z'));

	const runs = listTrainingRuns();
	t.deepEqual(runs.map(run => run.id), [newerId, olderId]);
	t.is(runs[0].finalTrainLoss, 0.9);
	t.true(readFileSync(join(NANOTUNE_DIR, '.gitignore'), 'utf8').includes('runs/'));
	t.deepEqual(
		JSON.parse(readFileSync(join(getTrainingRunsDir(), `${newerId}.json`), 'utf8')),
		record(newerId, '2026-08-02T10:00:00.000Z'),
	);
});

test.serial('listTrainingRuns skips corrupt and invalid records', t => {
	const dir = ensureTrainingRunsDir();
	writeFileSync(join(dir, 'broken.json'), '{');
	writeFileSync(join(dir, 'invalid.json'), JSON.stringify({id: 'missing-fields'}));
	saveTrainingRun(
		record('a1000000-0000-4000-8000-000000000003', '2026-08-02T10:00:00.000Z'),
	);

	t.deepEqual(listTrainingRuns().map(run => run.id), [
		'a1000000-0000-4000-8000-000000000003',
	]);
});

test('formatTrainingRuns reports an empty history clearly', t => {
	t.is(formatTrainingRuns([]), 'No training runs found.');
});

test('formatTrainingRuns includes the settings, data, duration, and final losses', t => {
	const output = formatTrainingRuns([
		record('a1000000-0000-4000-8000-000000000005', '2026-08-02T10:00:00.000Z'),
	]);
	t.true(output.includes('completed'));
	t.true(output.includes('20 iterations'));
	t.true(output.includes('12 train / 3 validation'));
	t.true(output.includes('12s'));
	t.true(output.includes('train 0.9000 / validation 1.1000'));
});
