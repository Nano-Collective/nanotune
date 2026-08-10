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

export function resolveSamplingOptions(options: {
	temperature?: string;
	seed?: string;
	samples?: string;
}): {temperature: number; seed: number; samples: number} {
	const temperature = Number.parseFloat(options.temperature ?? '');
	const seed = Number.parseInt(options.seed ?? '', 10);
	const samples = Number.parseInt(options.samples ?? '', 10);

	return {
		temperature: Number.isFinite(temperature)
			? temperature
			: DEFAULT_BENCHMARK_TEMPERATURE,
		seed: Number.isFinite(seed) ? seed : DEFAULT_BENCHMARK_SEED,
		samples: Number.isFinite(samples) && samples > 0 ? samples : 1,
	};
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
		passed: passRate >= 0.5,
		passRate,
		variance: passRate * (1 - passRate),
	};
}
