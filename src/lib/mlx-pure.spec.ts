import test from 'ava';
import type {MLXTrainingOptions} from './mlx.js';
import {
	buildLoraConfigYaml,
	buildTrainingArgs,
	needsLoraConfig,
	shouldTreatAsStop,
} from './mlx.js';

/**
 * The pure half of the MLX boundary. `runTraining` itself spawns mlx_lm and
 * only runs on Apple Silicon, so CI can never execute it — which makes the
 * argv wiring and the YAML emitter the only parts a test can actually protect.
 * They are also where a mistake is silent: wrong flags train the wrong thing
 * for an hour and report success.
 */

function options(overrides: Partial<MLXTrainingOptions> = {}): MLXTrainingOptions {
	return {
		model: 'Qwen/Qwen2.5-Coder-1.5B-Instruct',
		dataPath: '/p/.nanotune/data',
		adapterPath: '/p/.nanotune/adapters',
		iterations: 150,
		learningRate: 5e-5,
		batchSize: 4,
		numLayers: 16,
		stepsPerEval: 50,
		saveEvery: 50,
		fineTuneType: 'lora',
		loraRank: 8,
		loraAlpha: 16,
		loraDropout: 0.05,
		maxSeqLength: 2048,
		gradCheckpoint: false,
		valBatches: 25,
		seed: 42,
		...overrides,
	};
}

/** The value following a flag in an argv array. */
function valueOf(args: string[], flag: string): string | undefined {
	const at = args.indexOf(flag);
	return at === -1 ? undefined : args[at + 1];
}

// --- buildTrainingArgs ------------------------------------------------------

test('every training option reaches the argv', t => {
	const args = buildTrainingArgs(options());
	t.deepEqual(args.slice(0, 3), ['-m', 'mlx_lm', 'lora']);
	t.true(args.includes('--train'));
	t.is(valueOf(args, '--model'), 'Qwen/Qwen2.5-Coder-1.5B-Instruct');
	t.is(valueOf(args, '--data'), '/p/.nanotune/data');
	t.is(valueOf(args, '--adapter-path'), '/p/.nanotune/adapters');
	t.is(valueOf(args, '--iters'), '150');
	t.is(valueOf(args, '--batch-size'), '4');
	t.is(valueOf(args, '--num-layers'), '16');
	t.is(valueOf(args, '--steps-per-eval'), '50');
	t.is(valueOf(args, '--save-every'), '50');
	t.is(valueOf(args, '--fine-tune-type'), 'lora');
	t.is(valueOf(args, '--max-seq-length'), '2048');
	t.is(valueOf(args, '--val-batches'), '25');
	t.is(valueOf(args, '--seed'), '42');
});

test('a small learning rate is not passed in exponent notation', t => {
	// String(5e-5) is "0.00005", but String(1e-7) is "1e-7". Whether mlx_lm
	// parses that is not something to find out an hour into a run.
	const args = buildTrainingArgs(options({learningRate: 5e-5}));
	t.is(valueOf(args, '--learning-rate'), '0.00005');
});

test('grad checkpointing is a flag, present only when enabled', t => {
	t.false(buildTrainingArgs(options({gradCheckpoint: false})).includes('--grad-checkpoint'));
	t.true(buildTrainingArgs(options({gradCheckpoint: true})).includes('--grad-checkpoint'));
});

test('the lora config is passed with -c only when supplied', t => {
	t.false(buildTrainingArgs(options()).includes('-c'));
	const args = buildTrainingArgs(options(), '/tmp/lora.yaml');
	t.is(valueOf(args, '-c'), '/tmp/lora.yaml');
});

test('resuming points at the adapter file inside the adapter path', t => {
	t.false(buildTrainingArgs(options()).includes('--resume-adapter-file'));
	const args = buildTrainingArgs(options({resume: true}));
	t.is(
		valueOf(args, '--resume-adapter-file'),
		'/p/.nanotune/adapters/adapters.safetensors',
	);
});

test('argv is flat, with no undefined or empty entries', t => {
	// A stray undefined becomes the string "undefined" once execa spawns it,
	// and mlx_lm would take it as a value for whatever flag preceded it.
	const args = buildTrainingArgs(options({resume: true}), '/tmp/lora.yaml');
	for (const arg of args) {
		t.is(typeof arg, 'string');
		t.not(arg, '');
		t.not(arg, 'undefined');
	}
});

// --- buildLoraConfigYaml ----------------------------------------------------

test('lora config emits the three parameters mlx_lm reads', t => {
	const yaml = buildLoraConfigYaml(8, 16, 0.05);
	t.true(yaml.startsWith('lora_parameters:\n'));
	t.true(yaml.includes('rank: 8'));
	t.true(yaml.includes('scale: 16'));
	t.true(yaml.includes('dropout: 0.05'));
	t.true(yaml.endsWith('\n'));
});

test('very small values are written in fixed notation, not exponent', t => {
	// PyYAML 1.1 resolves "1e-7" as a *string*, not a float, so mlx_lm would
	// silently receive a dropout it cannot use. This guard is the whole reason
	// yamlNumber exists.
	const yaml = buildLoraConfigYaml(8, 16, 1e-7);
	t.false(yaml.includes('e-'), `exponent leaked: ${yaml}`);
	t.true(/dropout: 0\.0000001/.test(yaml), yaml);
});

test('zero is written plainly rather than padded', t => {
	// 0 is below the 1e-6 threshold in magnitude but must not go through
	// toFixed(20), or the config gains a 20-decimal zero.
	const yaml = buildLoraConfigYaml(8, 16, 0);
	t.true(yaml.includes('dropout: 0\n'), yaml);
});

test('a negative small value keeps its sign', t => {
	const yaml = buildLoraConfigYaml(-1e-7, 16, 0.05);
	t.true(yaml.includes('rank: -0.0000001'), yaml);
});

// --- the small predicates ---------------------------------------------------

test('lora config is needed for everything except full fine-tuning', t => {
	t.true(needsLoraConfig('lora'));
	t.true(needsLoraConfig('dora'));
	t.false(needsLoraConfig('full'));
});

test('a stop is only a stop when the caller asked for one', t => {
	t.false(shouldTreatAsStop(undefined));
	t.false(shouldTreatAsStop(new AbortController().signal));

	const controller = new AbortController();
	controller.abort();
	t.true(shouldTreatAsStop(controller.signal));
});
