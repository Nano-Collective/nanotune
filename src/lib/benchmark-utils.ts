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
 * Build the full prompt string for llama-cli.
 *
 * Single-turn: `{context}\n\nUser: {prompt}\n\nAssistant:`
 * Multi-turn:  `{context}\n\nUser: {msg1}\n\nAssistant: {msg2}\n\nUser: {msg3}\n\nAssistant:`
 */
export function buildFullPrompt(
	test: BenchmarkTest,
	contextMsg: {role: string; content: string},
): string {
	if (test.prompt) {
		return `${contextMsg.content}\n\nUser: ${test.prompt}\n\nAssistant:`;
	}

	if (test.messages && test.messages.length > 0) {
		const parts = [contextMsg.content];
		for (const msg of test.messages) {
			const role = msg.role === 'user' ? 'User' : 'Assistant';
			parts.push(`${role}: ${msg.content}`);
		}
		// If the last message is from the user, add the trailing Assistant: prompt
		const lastMsg = test.messages[test.messages.length - 1];
		if (lastMsg.role === 'user') {
			parts.push('Assistant:');
		}
		return parts.join('\n\n');
	}

	return `${contextMsg.content}\n\nAssistant:`;
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
