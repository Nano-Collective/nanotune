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
