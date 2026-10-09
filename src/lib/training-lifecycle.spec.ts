import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {createDefaultConfig} from './config.js';
import {parseTrainingLoss, runTraining, type TrainingLossPoint} from './mlx.js';
import {collectStatus} from './status.js';
import {listTrainingRuns, startTrainingRun} from './training-runs.js';

test('parseTrainingLoss reads separate evaluations, combined reports, and exponents', t => {
	t.deepEqual(parseTrainingLoss('Iter 1: Val loss 1.456, Val took 0.1s'), {iteration: 1, valLoss: 1.456});
	t.deepEqual(parseTrainingLoss('Iter 10 (15 it/s): Train loss 1.2e-3, Val loss 0'), {iteration: 10, trainLoss: 0.0012, valLoss: 0});
	t.is(parseTrainingLoss('Saved adapter weights'), null);
});

for (const outcome of ['completed', 'stopped', 'failed'] as const) {
	test.serial(`training lifecycle persists ${outcome} runs and their checkpoint provenance`, async t => {
		const cwd = process.cwd();
		const path = process.env.PATH;
		const dir = mkdtempSync(join(tmpdir(), 'nanotune-lifecycle-'));
		try {
			process.chdir(dir);
			process.env.PATH = `${dir}:${path}`;
			const config = createDefaultConfig('test', 'test-model', {role: 'system', content: 'Helpful.'});
			mkdirSync(join(dir, '.nanotune', 'adapters'), {recursive: true});
			writeFileSync(join(dir, '.nanotune', 'config.json'), JSON.stringify(config));
			const adapterFile = join(dir, '.nanotune', 'adapters', 'adapters.safetensors');
			// Stand in for Python/MLX at the real subprocess boundary. It writes
			// separate loss reports and a checkpoint before finishing or failing.
			writeFileSync(join(dir, 'python3'), `#!${process.execPath}
import {writeFileSync} from 'node:fs';
process.stdout.write('Iter 1: Val loss 1.456, Val took 0.1s\\n');
writeFileSync(${JSON.stringify(adapterFile)}, 'checkpoint');
process.stdout.write('Iter 10: Saved adapter weights to adapter.\\nIter 10: Train loss 1.234, Learning Rate 5e-5\\n');
${outcome === 'stopped' ? "process.on('SIGINT', () => process.exit(0)); setInterval(() => {}, 1000);" : `setTimeout(() => {process.stdout.write('Iter 20: Val loss 0.987, Val took 0.1s'); process.exit(${outcome === 'failed' ? 1 : 0});}, 20);`}
`, {mode: 0o755});
			const history = startTrainingRun({baseModel: config.baseModel, training: config.training, examples: {train: 12, validation: 4}, adapterFile, resume: false});
			t.is(listTrainingRuns()[0].status, 'running', 'initial record precedes the subprocess');
			t.is(listTrainingRuns()[0].finishedAt, null);
			const points: TrainingLossPoint[] = [];
			const controller = new AbortController();
			const run = async () => {
				try {
					for await (const progress of runTraining({
						...config.training, model: config.baseModel, dataPath: dir, adapterPath: join(dir, '.nanotune', 'adapters'), signal: controller.signal,
						onCheckpoint: () => history.checkpoint(),
						onLoss: point => {points.push(point); history.update(point);},
					})) {
						t.is(progress.valLoss, 1.456);
						const saved = listTrainingRuns()[0];
						t.is(saved.status, 'running');
						t.is(saved.finalTrainLoss, 1.234);
						t.is(saved.finalValLoss, 1.456);
						t.truthy(saved.adapterModifiedAt);
						if (outcome === 'stopped') controller.abort();
					}
				} finally {history.finish(outcome, outcome === 'failed' ? 'trainer failure' : undefined);}
			};
			if (outcome === 'failed') await t.throwsAsync(run());
			else await run();
			const saved = listTrainingRuns()[0];
			t.is(saved.status, outcome);
			t.truthy(saved.finishedAt);
			t.deepEqual(saved.lossHistory, points);
			t.is(saved.finalValLoss, outcome === 'stopped' ? 1.456 : 0.987);
			t.is(saved.finalTrainLoss, 1.234, 'a later evaluation does not clear train loss');
			t.is(collectStatus().training.adapterRun?.status, outcome);
			t.is(readFileSync(adapterFile, 'utf8'), 'checkpoint');
			const resumed = startTrainingRun({baseModel: config.baseModel, training: config.training, examples: {train: 12, validation: 4}, adapterFile, resume: true});
			t.is(listTrainingRuns()[0].resumedFromRunId, saved.id);
			resumed.finish('failed', 'failed before changing adapter');
			t.is(collectStatus().training.adapterRun?.status, outcome, 'an unchanged adapter retains its original provenance');
		} finally {
			process.chdir(cwd);
			process.env.PATH = path;
			rmSync(dir, {recursive: true, force: true});
		}
	});
}

test.serial('an abandoned running record retains loss points and settings on disk', t => {
	const cwd = process.cwd();
	const dir = mkdtempSync(join(tmpdir(), 'nanotune-abandoned-'));
	try {
		process.chdir(dir);
		const config = createDefaultConfig('test', 'test-model', {role: 'system', content: 'Helpful.'});
		const run = startTrainingRun({baseModel: config.baseModel, training: {...config.training, learningRate: 0.0001}, examples: {train: 12, validation: 4}, adapterFile: join(dir, 'adapter'), resume: false});
		run.update({iteration: 1, valLoss: 2});
		run.update({iteration: 10, trainLoss: 1});
		// No finish call: another invocation can still inspect this record.
		const saved = listTrainingRuns()[0];
		t.is(saved.status, 'running');
		t.is(saved.training.learningRate, 0.0001);
		t.deepEqual(saved.lossHistory, [{iteration: 1, valLoss: 2}, {iteration: 10, trainLoss: 1}]);
	} finally {process.chdir(cwd); rmSync(dir, {recursive: true, force: true});}
});
