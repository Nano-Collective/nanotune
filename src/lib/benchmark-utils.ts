import type {BenchmarkTest, ChatMessage} from '../types/index.js';

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
