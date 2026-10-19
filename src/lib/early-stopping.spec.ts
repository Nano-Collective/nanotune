import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {parseSelectionEvent} from './early-stopping.js';
import {createDefaultConfig} from './config.js';
import {runTraining} from './mlx.js';
import {listTrainingRuns, startTrainingRun} from './training-runs.js';
import type {TrainingProgress} from '../types/index.js';

// Execute the real Python selection wrapper with minimal MLX substitutes. The
// trainer evaluates the previous weights, then updates and saves new weights:
// this is the ordering that console-log based checkpoint selection got wrong.
const python = String.raw`#!/usr/bin/python3
import sys, types, json, time, os
from pathlib import Path
script = sys.argv[2]
sys.argv = ["wrapper"] + sys.argv[3:]
selected_path = Path(sys.argv[3])
scenario = os.environ["NANOTUNE_TEST_SCENARIO"]
for name in ["mlx", "mlx.core", "mlx.utils", "mlx_lm", "mlx_lm.lora", "mlx_lm.tuner", "mlx_lm.tuner.callbacks"]:
    module = types.ModuleType(name)
    module.__path__ = []
    sys.modules[name] = module
mx = sys.modules["mlx.core"]
def save(path, weights):
    Path(path).write_text(str(weights["weights"]))
mx.save_safetensors = save
sys.modules["mlx.utils"].tree_flatten = lambda weights: list(weights.items())
sys.modules["mlx_lm.tuner.callbacks"].TrainingCallback = type("TrainingCallback", (), {})
lora = sys.modules["mlx_lm.lora"]
class Model:
    weights = 0
    def trainable_parameters(self):
        return {"weights": self.weights}
def train(*args, **kwargs):
    model = kwargs["model"]
    cb = kwargs["training_callback"]
    adapter = Path(os.environ["NANOTUNE_TEST_ADAPTER"])
    if scenario == "no-validation":
        model.weights = 10
        save(adapter, model.trainable_parameters())
        return
    losses = [1.0, 0.5, 0.8, 0.9]
    if scenario == "final-better": losses = [1.0, 0.8, 0.6, 0.4]
    if scenario == "nonfinite": losses = [1.0, float("nan"), float("inf"), 2.0]
    if scenario == "all-nonfinite": losses = [float("nan"), float("inf"), float("nan"), float("nan")]
    if scenario == "failure": losses = [1.0, 0.5]
    for it, loss in enumerate(losses, 1):
        cb.on_val_loss_report({"iteration": it - 1, "val_loss": loss})
        if scenario == "user-abort":
            print("Iter 1: Train loss 1.234", flush=True)
            try:
                while True: time.sleep(0.05)
            except KeyboardInterrupt:
                save(adapter, {"weights": 99})
                sys.exit(130)
        model.weights = it
        save(adapter, model.trainable_parameters())
        save(adapter.parent / ("%07d_adapters.safetensors" % it), model.trainable_parameters())
        print("Iter %d: Train loss 1.234e-2" % it, flush=True)
        cb.on_train_loss_report({"iteration": it, "train_loss": 1.234e-2})
    if scenario == "failure":
        raise RuntimeError("trainer failed after checkpoint")
    if scenario == "missing-best":
        selected_path.unlink()
    # Successful runs write the final, post-update weights. The selected
    # snapshot is necessarily pre-update, so even the last evaluation must
    # not be assigned to this final file.
    save(adapter, model.trainable_parameters())
lora.train = train
def main():
    assert sys.argv[1] == "--model", sys.argv
    model = Model()
    lora.train(model=model, training_callback=None)
    if scenario == "final-no-newline":
        sys.stdout.write("Iter 9: Train loss 2.5e-3")
        sys.stdout.flush()
lora.main = main
exec(script)
`;

for (const scenario of ['plateau', 'final-better', 'nonfinite', 'all-nonfinite', 'failure', 'missing-best', 'user-abort', 'final-no-newline', 'no-validation']) {
	test.serial(`selection through Python/MLX boundary: ${scenario}`, async t => {
		const cwd = process.cwd();
		const path = process.env.PATH;
		const dir = mkdtempSync(join(tmpdir(), 'nanotune-early-stop-'));
		try {
			process.chdir(dir);
			process.env.PATH = `${dir}:${path}`;
			process.env.NANOTUNE_TEST_SCENARIO = scenario;
			const adapter = join(dir, 'adapters.safetensors');
			process.env.NANOTUNE_TEST_ADAPTER = adapter;
			writeFileSync(adapter, 'original');
			writeFileSync(join(dir, '0000001_adapters.safetensors'), 'STALE CHECKPOINT');
			writeFileSync(join(dir, 'python3'), python, {mode: 0o755});
			const config = createDefaultConfig('test', 'test-model', {role: 'system', content: 'Helpful.'});
			const history = startTrainingRun({baseModel: config.baseModel, training: config.training, examples: {train: 12, validation: 4}, adapterFile: adapter, resume: false});
			const controller = new AbortController();
			const updates: TrainingProgress[] = [];
			const run = async () => {
				let status: 'completed' | 'stopped' | 'failed' = 'failed';
				try {
					for await (const update of runTraining({
						...config.training,
						model: config.baseModel, dataPath: dir, adapterPath: dir,
						iterations: 4, saveEvery: 1,
						earlyStoppingPatience: ['plateau', 'nonfinite', 'all-nonfinite'].includes(scenario) ? 2 : 0,
						loadBestModelAtEnd: true,
						signal: controller.signal,
						onLoss: point => history.update(point),
						onCheckpoint: () => history.checkpoint(),
						onSelection: summary => history.selection(summary),
					})) {
						updates.push(update);
						if (scenario === 'user-abort') controller.abort();
					}
					status = controller.signal.aborted || updates.at(-1)?.earlyStopped ? 'stopped' : 'completed';
				} finally {history.finish(status);}
			};
			if (scenario === 'failure' || scenario === 'missing-best') {
				await t.throwsAsync(run(), {message: scenario === 'missing-best' ? /evaluated best checkpoint is missing/ : /trainer failed after checkpoint/});
				t.is(readFileSync(adapter, 'utf8'), scenario === 'failure' ? '2' : '4');
			} else {
				await run();
				const last = updates.at(-1);
				if (scenario === 'plateau') {
					t.true(last?.earlyStopped);
					t.true(last?.restoredBest);
					t.is(last?.bestIteration, 1);
					t.is(last?.bestValLoss, 0.5);
					t.is(readFileSync(adapter, 'utf8'), '1', 'restores the evaluated weights, not step 2');
				} else if (scenario === 'final-better') {
					t.is(last?.bestIteration, 3);
					t.is(readFileSync(adapter, 'utf8'), '3', 'the last evaluation scores weights before the final update');
				} else if (scenario === 'nonfinite') {
					t.true(last?.earlyStopped);
					t.is(last?.bestIteration, 0);
					t.is(readFileSync(adapter, 'utf8'), '0', 'initial evaluation snapshot is a valid best model');
				} else if (scenario === 'all-nonfinite') {
					t.true(last?.earlyStopped);
					t.false(last?.restoredBest);
					t.is(readFileSync(adapter, 'utf8'), '1', 'keeps the last checkpoint and reports that honestly');
				} else if (scenario === 'user-abort') {
					t.is(readFileSync(adapter, 'utf8'), '99', 'Ctrl+C does not restore the best model');
				} else if (scenario === 'no-validation') {
					t.false(last?.restoredBest);
					t.is(readFileSync(adapter, 'utf8'), '10');
				} else if (scenario === 'final-no-newline') {
					t.true(updates.some(update => update.iteration === 9 && update.trainLoss === 0.0025));
				}
			}
			const saved = listTrainingRuns()[0];
			t.is(saved.earlyStopped, updates.at(-1)?.earlyStopped);
			t.is(saved.restoredBest, updates.at(-1)?.restoredBest);
			t.false(readdirSync(dir).some(name => name.includes('.restore-')));
			t.true(existsSync(adapter));
		} finally {
			process.chdir(cwd);
			process.env.PATH = path;
			delete process.env.NANOTUNE_TEST_SCENARIO;
			delete process.env.NANOTUNE_TEST_ADAPTER;
			rmSync(dir, {recursive: true, force: true});
		}
	});
}

test('parseSelectionEvent rejects malformed or incomplete events', t => {
	for (const line of ['ordinary output', 'NANOTUNE_EVENT {', 'NANOTUNE_EVENT null', 'NANOTUNE_EVENT {"type":"selection"}']) t.is(parseSelectionEvent(line), null);
	t.deepEqual(parseSelectionEvent('NANOTUNE_EVENT {"type":"validation","iteration":4,"valLoss":null}'), {type: 'validation', iteration: 4, valLoss: null});
});
