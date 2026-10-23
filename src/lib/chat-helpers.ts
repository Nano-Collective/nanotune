import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {
	BENCHMARK_PRESETS,
	type BenchmarkPreset,
	type ChatMessage,
} from '../types/index.js';
import {FLAG_RULES, parseNumericFlag} from './cli-flags.js';
import {getChatsDir} from './config.js';
import type {GenerateOptions, ServerOptions} from './llama-cpp.js';

/** Raw option strings that come off commander; everything is a string until we
 *  parse it ourselves. */
export interface ChatRawOptions {
	preset?: string;
	threads?: string;
	gpuLayers?: string;
	ctxSize?: string;
	batchSize?: string;
	cpuOnly?: boolean;
	maxTokens?: string;
	temperature?: string;
	topP?: string;
	seed?: string;
}

/**
 * Build a `ServerOptions` for `startLlamaServer` from the chat command's CLI
 * flags. A `--preset` wins over individual flags when both are given (matching
 * the benchmark command's behaviour).
 */
export function buildServerOptions(options: ChatRawOptions): ServerOptions {
	// Validate everything that was typed, even what a `--preset` will replace:
	// an unparseable number must not reach llama-server as the text "NaN".
	const threads = parseNumericFlag(
		'--threads',
		options.threads,
		FLAG_RULES.positiveInteger,
	);
	const gpuLayers = parseNumericFlag(
		'--gpu-layers',
		options.gpuLayers,
		FLAG_RULES.integer,
	);
	// 0 is llama-server's "use the model's own context size".
	const ctxSize = parseNumericFlag(
		'--ctx-size',
		options.ctxSize,
		FLAG_RULES.nonNegativeInteger,
	);
	const batchSize = parseNumericFlag(
		'--batch-size',
		options.batchSize,
		FLAG_RULES.positiveInteger,
	);
	if (options.preset) {
		const preset = BENCHMARK_PRESETS[options.preset as BenchmarkPreset];
		if (!preset) {
			throw new Error(
				`Invalid preset: ${options.preset}. Valid presets: ${Object.keys(BENCHMARK_PRESETS).join(', ')}`,
			);
		}
		return {
			threads: preset.threads,
			gpuLayers: preset.gpuLayers,
			ctxSize: preset.ctxSize,
			batchSize: preset.batchSize,
			cpuOnly: preset.gpuLayers === 0,
		};
	}
	return {
		threads,
		gpuLayers,
		ctxSize: ctxSize ?? 4096,
		batchSize: batchSize ?? 2048,
		cpuOnly: options.cpuOnly,
	};
}

/**
 * Build `GenerateOptions` for `chatCompletion` from CLI flags. Defaults to
 * 256 max tokens for a chat REPL (vs benchmark's 50 — replies need to be
 * long enough to be useful); preset values override the default.
 */
export function buildGenerateOptions(options: ChatRawOptions): GenerateOptions {
	const presetMax = options.preset
		? BENCHMARK_PRESETS[options.preset as BenchmarkPreset]?.maxTokens
		: undefined;
	const maxTokens = parseNumericFlag(
		'--max-tokens',
		options.maxTokens,
		FLAG_RULES.positiveInteger,
	);
	const temperature = parseNumericFlag(
		'--temperature',
		options.temperature,
		FLAG_RULES.nonNegativeNumber,
	);
	const topP = parseNumericFlag(
		'--top-p',
		options.topP,
		FLAG_RULES.unitInterval,
	);
	const seed = parseNumericFlag('--seed', options.seed, FLAG_RULES.integer);
	return {
		maxTokens: maxTokens ?? presetMax ?? 256,
		temperature: temperature ?? 0.8,
		topP: topP ?? 0.9,
		seed,
	};
}

export type SlashCommand =
	| {kind: 'send'; text: string}
	| {kind: 'exit'}
	| {kind: 'reset'}
	| {kind: 'help'}
	| {kind: 'stats'}
	| {kind: 'system'; text: string}
	| {kind: 'system-missing'}
	| {kind: 'save'; path?: string; force?: true}
	| {kind: 'keep'}
	| {kind: 'unknown'; name: string}
	| {kind: 'noop'};

/**
 * Classify a line of user input in the chat REPL. Everything not starting
 * with `/` is a message to send. Slash commands are recognised by exact
 * names; unknown slash commands surface as `{kind: 'unknown'}` rather than
 * being sent as a message (so a typo doesn't accidentally get prompted into
 * the model).
 */
export function parseSlashCommand(input: string): SlashCommand {
	const trimmed = input.trim();
	if (!trimmed) {
		return {kind: 'noop'};
	}

	if (!trimmed.startsWith('/')) {
		return {kind: 'send', text: trimmed};
	}

	const [rawCmd, ...rest] = trimmed.split(/\s+/);
	const cmd = rawCmd.toLowerCase();
	const arg = rest.join(' ').trim();

	switch (cmd) {
		case '/exit':
		case '/quit':
			return {kind: 'exit'};
		case '/reset':
		case '/clear':
			return {kind: 'reset'};
		case '/help':
			return {kind: 'help'};
		case '/stats':
			return {kind: 'stats'};
		case '/system':
			return arg ? {kind: 'system', text: arg} : {kind: 'system-missing'};
		case '/save': {
			const isForce = (part: string) => part === '--force' || part === '-f';
			const path = rest
				.filter(part => !isForce(part))
				.join(' ')
				.trim();
			const cmd = path
				? ({kind: 'save', path} as const)
				: ({kind: 'save'} as const);
			return rest.some(isForce) ? {...cmd, force: true} : cmd;
		}
		case '/keep':
			return {kind: 'keep'};
		default:
			return {kind: 'unknown', name: rawCmd};
	}
}

export function lastExchange(
	history: ChatMessage[],
): {userInput: string; assistantOutput: string} | null {
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i].role !== 'assistant') {
			continue;
		}
		for (let j = i - 1; j >= 0; j--) {
			if (history[j].role === 'user') {
				return {
					userInput: history[j].content,
					assistantOutput: history[i].content,
				};
			}
		}
		return null;
	}
	return null;
}

/**
 * Write the session transcript as JSON. Refuses to clobber an existing file
 * unless `force` is set — a transcript is history you can't get back once it
 * is gone.
 */
export function saveTranscript(
	systemMessage: ChatMessage | null,
	history: ChatMessage[],
	filePath?: string,
	force = false,
): string {
	const messages = systemMessage?.content
		? [systemMessage, ...history]
		: history;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const path = filePath ?? join(getChatsDir(), `${stamp}.json`);
	if (!force && existsSync(path)) {
		throw new Error(
			`${path} already exists — use "/save ${path} --force" to overwrite it.`,
		);
	}
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, `${JSON.stringify([{messages}], null, 2)}\n`);
	return path;
}
