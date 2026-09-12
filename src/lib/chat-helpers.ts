import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {
	BENCHMARK_PRESETS,
	type BenchmarkPreset,
	type ChatMessage,
} from '../types/index.js';
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
 * Parse a numeric CLI flag, pushing an "Invalid value for --flag" message onto
 * `errors` instead of returning a value when it doesn't parse. Callers report
 * the first error and bail, so a bad flag fails before any subprocess or
 * network work rather than reaching llama-server as the literal argument
 * "NaN" or as a null field in the completion request body.
 *
 * Number() rather than parseInt/parseFloat so trailing garbage ("4096x")
 * is rejected instead of being silently truncated to 4096; a blank value is
 * screened out first because Number('') is 0. `integer` flags reject a
 * fractional value for the same reason — llama-server wants "4096", not
 * "4096.5", and parseInt used to hide the difference.
 */
export function parseNumericFlag(
	raw: string | undefined,
	flag: string,
	errors: string[],
	integer = false,
): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const trimmed = raw.trim();
	const value = trimmed === '' ? Number.NaN : Number(trimmed);
	if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
		errors.push(
			`Invalid value for ${flag}: expected ${
				integer ? 'an integer' : 'a number'
			}, got "${raw}".`,
		);
		return undefined;
	}
	return value;
}

/**
 * Build a `ServerOptions` for `startLlamaServer` from the chat command's CLI
 * flags. A `--preset` wins over individual flags when both are given (matching
 * the benchmark command's behaviour), but every flag the user typed is still
 * parsed so a typo is reported rather than silently discarded.
 */
export function buildServerOptions(options: ChatRawOptions): {
	options: ServerOptions;
	errors: string[];
} {
	const errors: string[] = [];
	const threads = parseNumericFlag(options.threads, '--threads', errors, true);
	const gpuLayers = parseNumericFlag(
		options.gpuLayers,
		'--gpu-layers',
		errors,
		true,
	);
	const ctxSize = parseNumericFlag(options.ctxSize, '--ctx-size', errors, true);
	const batchSize = parseNumericFlag(
		options.batchSize,
		'--batch-size',
		errors,
		true,
	);

	const preset = options.preset
		? BENCHMARK_PRESETS[options.preset as BenchmarkPreset]
		: undefined;
	if (preset) {
		return {
			options: {
				threads: preset.threads,
				gpuLayers: preset.gpuLayers,
				ctxSize: preset.ctxSize,
				batchSize: preset.batchSize,
				cpuOnly: preset.gpuLayers === 0,
			},
			errors,
		};
	}

	return {
		options: {
			threads,
			gpuLayers,
			ctxSize: ctxSize ?? 4096,
			batchSize: batchSize ?? 2048,
			cpuOnly: options.cpuOnly,
		},
		errors,
	};
}

/**
 * Build `GenerateOptions` for `chatCompletion` from CLI flags. Defaults to
 * 256 max tokens for a chat REPL (vs benchmark's 50 — replies need to be
 * long enough to be useful); preset values override the default.
 */
export function buildGenerateOptions(options: ChatRawOptions): {
	options: GenerateOptions;
	errors: string[];
} {
	const presetMax = options.preset
		? BENCHMARK_PRESETS[options.preset as BenchmarkPreset]?.maxTokens
		: undefined;
	const errors: string[] = [];
	return {
		options: {
			maxTokens:
				parseNumericFlag(options.maxTokens, '--max-tokens', errors, true) ??
				presetMax ??
				256,
			temperature:
				parseNumericFlag(options.temperature, '--temperature', errors) ?? 0.8,
			topP: parseNumericFlag(options.topP, '--top-p', errors) ?? 0.9,
			seed: parseNumericFlag(options.seed, '--seed', errors, true),
		},
		errors,
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
