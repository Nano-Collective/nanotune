import {
	BENCHMARK_PRESETS,
	type BenchmarkPreset,
	type BenchmarkTest,
	type ChatMessage,
} from '../types/index.js';
import {buildServerOptions, parseNumericFlag} from './chat-helpers.js';
import type {GenerateOptions, ServerOptions} from './llama-cpp.js';

/**
 * Get the display prompt for a benchmark test.
 * Returns the single-turn prompt, or the last user message from a multi-turn conversation.
 */
export function getTestDisplayPrompt(test: BenchmarkTest): string {
	if (test.prompt) {
		return test.prompt;
	}
	if (test.messages && test.messages.length > 0) {
		for (let i = test.messages.length - 1; i >= 0; i--) {
			if (test.messages[i].role === 'user') {
				return test.messages[i].content;
			}
		}
		return test.messages[test.messages.length - 1].content;
	}
	return '';
}

/**
 * Build a messages array for the chat-completions inference endpoint.
 * Mirrors the format MLX trained on so the model's chat template applies
 * end-to-end (vs. the old hand-built `User:/Assistant:` text).
 *
 * - Prepends the project context message when present and non-empty.
 * - Single-turn tests: appends `{role: 'user', content: test.prompt}`.
 * - Multi-turn tests: appends the test's messages verbatim.
 */
export function buildMessages(
	test: BenchmarkTest,
	contextMsg: {role: string; content: string},
): ChatMessage[] {
	const messages: ChatMessage[] = [];
	if (contextMsg.content) {
		messages.push({role: contextMsg.role, content: contextMsg.content});
	}

	if (test.prompt) {
		messages.push({role: 'user', content: test.prompt});
		return messages;
	}

	if (test.messages && test.messages.length > 0) {
		messages.push(...test.messages);
	}
	return messages;
}

/**
 * Format a multi-turn conversation for the LLM judge prompt.
 * Includes the context message and labeled turns so the judge has full context.
 */
export function formatConversationForJudge(
	messages: ChatMessage[],
	contextMsg: {role: string; content: string},
): string {
	const parts: string[] = [];
	if (contextMsg.content) {
		parts.push(`[Context (${contextMsg.role})]: ${contextMsg.content}`);
	}
	for (const msg of messages) {
		const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
		parts.push(`[${role}]: ${msg.content}`);
	}
	return parts.join('\n');
}

export const DEFAULT_BENCHMARK_TEMPERATURE = 0;
export const DEFAULT_BENCHMARK_SEED = 42;

export interface SamplingOptions {
	temperature: number;
	seed: number;
	samples: number;
	/** One message per rejected flag; empty when everything parsed. */
	errors: string[];
}

// Number() rather than parseFloat/parseInt so trailing garbage ("5abc") is
// rejected instead of silently truncated to a plausible-looking value. A blank
// value is screened out first because Number('') is 0.
function parseFlag(raw: string | undefined): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed === '' ? Number.NaN : Number(trimmed);
}

/**
 * Resolve the sampling flags, defaulting anything the user didn't pass.
 *
 * An unparseable value is an error rather than a silent fall back to the
 * default: `--temperature abc` quietly becoming 0 would report a greedy run
 * under a flag the user believed had enabled sampling, and the recorded
 * `config` block in the saved report would disagree with what they typed.
 */
export function resolveSamplingOptions(options: {
	temperature?: string;
	seed?: string;
	samples?: string;
}): SamplingOptions {
	const errors: string[] = [];

	let temperature = DEFAULT_BENCHMARK_TEMPERATURE;
	const rawTemperature = parseFlag(options.temperature);
	if (rawTemperature !== undefined) {
		if (!Number.isFinite(rawTemperature) || rawTemperature < 0) {
			errors.push(
				`Invalid --temperature "${options.temperature}": expected a non-negative number.`,
			);
		} else {
			temperature = rawTemperature;
		}
	}

	let seed = DEFAULT_BENCHMARK_SEED;
	const rawSeed = parseFlag(options.seed);
	if (rawSeed !== undefined) {
		if (!Number.isInteger(rawSeed)) {
			errors.push(`Invalid --seed "${options.seed}": expected an integer.`);
		} else {
			seed = rawSeed;
		}
	}

	let samples = 1;
	const rawSamples = parseFlag(options.samples);
	if (rawSamples !== undefined) {
		if (!Number.isInteger(rawSamples) || rawSamples < 1) {
			errors.push(
				`Invalid --samples "${options.samples}": expected a positive integer.`,
			);
		} else {
			samples = rawSamples;
		}
	}

	return {temperature, seed, samples, errors};
}

export function summarizeSamples(passes: boolean[]): {
	passed: boolean;
	passRate: number;
	variance: number;
} {
	if (passes.length === 0) {
		return {passed: false, passRate: 0, variance: 0};
	}
	const passRate = passes.filter(Boolean).length / passes.length;
	return {
		passed: passRate > 0.5, // Strict majority: more than half must pass
		passRate,
		variance: passRate * (1 - passRate),
	};
}

const VALID_PRESETS: BenchmarkPreset[] = ['low', 'medium', 'high', 'ultra'];

/** Everything a benchmark run needs from the llama-server/generation flags. */
export interface BenchmarkFlags {
	serverOptions: ServerOptions;
	generateOptions: GenerateOptions;
	/** Per-test timeout in milliseconds. */
	timeout: number;
	/** One message per rejected flag; empty when everything parsed. */
	errors: string[];
}

/**
 * Resolve the llama-server and generation flags, defaulting anything the user
 * didn't pass. Sampling (`--temperature`/`--seed`) is resolved separately by
 * `resolveSamplingOptions` and passed in.
 *
 * Like the sampling flags, an unparseable value is an error rather than
 * something to pass on: `Number.parseInt` would have accepted `--ctx-size
 * 4096x` as 4096, and `--gpu-layers abc` would have reached llama-server as
 * the literal argument `-ngl NaN` (or, for `--max-tokens`, as a null field in
 * the completion body that llama-server quietly replaces with its own
 * default). Callers report the first error and stop, before the download and
 * the server spawn.
 */
export function resolveBenchmarkFlags(
	options: {
		preset?: string;
		threads?: string;
		gpuLayers?: string;
		ctxSize?: string;
		batchSize?: string;
		cpuOnly?: boolean;
		maxTokens?: string;
		timeout?: string;
	},
	sampling: {temperature: number; seed: number},
): BenchmarkFlags {
	const errors: string[] = [];
	if (
		options.preset &&
		!VALID_PRESETS.includes(options.preset as BenchmarkPreset)
	) {
		errors.push(
			`Invalid preset: ${options.preset}. Valid presets: ${VALID_PRESETS.join(', ')}`,
		);
	}

	const server = buildServerOptions({
		preset: options.preset,
		threads: options.threads,
		gpuLayers: options.gpuLayers,
		ctxSize: options.ctxSize,
		batchSize: options.batchSize,
		cpuOnly: options.cpuOnly,
	});
	errors.push(...server.errors);

	const maxTokens = parseNumericFlag(
		options.maxTokens,
		'--max-tokens',
		errors,
		true,
	);
	// setTimeout(fn, NaN) fires immediately, so an unparseable --timeout would
	// abort every test the moment it started rather than failing here.
	const timeout =
		parseNumericFlag(options.timeout, '--timeout', errors, true) ?? 30000;

	const preset = options.preset
		? BENCHMARK_PRESETS[options.preset as BenchmarkPreset]
		: undefined;
	return {
		serverOptions: server.options,
		generateOptions: {
			// A preset sets the whole profile, so it wins over --max-tokens.
			maxTokens: preset?.maxTokens ?? maxTokens ?? 50,
			temperature: sampling.temperature,
			seed: sampling.seed,
		},
		timeout,
		errors,
	};
}
