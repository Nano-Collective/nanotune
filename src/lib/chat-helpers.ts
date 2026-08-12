import {mkdirSync, writeFileSync} from 'node:fs';
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
 * Build a `ServerOptions` for `startLlamaServer` from the chat command's CLI
 * flags. A `--preset` wins over individual flags when both are given (matching
 * the benchmark command's behaviour).
 */
export function buildServerOptions(options: ChatRawOptions): ServerOptions {
	if (options.preset) {
		const preset = BENCHMARK_PRESETS[options.preset as BenchmarkPreset];
		if (preset) {
			return {
				threads: preset.threads,
				gpuLayers: preset.gpuLayers,
				ctxSize: preset.ctxSize,
				batchSize: preset.batchSize,
				cpuOnly: preset.gpuLayers === 0,
			};
		}
	}
	return {
		threads: options.threads ? Number.parseInt(options.threads, 10) : undefined,
		gpuLayers: options.gpuLayers
			? Number.parseInt(options.gpuLayers, 10)
			: undefined,
		ctxSize: options.ctxSize ? Number.parseInt(options.ctxSize, 10) : 4096,
		batchSize: options.batchSize
			? Number.parseInt(options.batchSize, 10)
			: 2048,
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
	return {
		maxTokens: options.maxTokens
			? Number.parseInt(options.maxTokens, 10)
			: (presetMax ?? 256),
		temperature: options.temperature
			? Number.parseFloat(options.temperature)
			: 0.8,
		topP: options.topP ? Number.parseFloat(options.topP) : 0.9,
		seed: options.seed ? Number.parseInt(options.seed, 10) : undefined,
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
	| {kind: 'save'; path?: string}
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
		case '/save':
			return arg ? {kind: 'save', path: arg} : {kind: 'save'};
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

export function saveTranscript(
	systemMessage: ChatMessage | null,
	history: ChatMessage[],
	filePath?: string,
): string {
	const messages = systemMessage?.content
		? [systemMessage, ...history]
		: history;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const path = filePath ?? join(getChatsDir(), `${stamp}.json`);
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, `${JSON.stringify([{messages}], null, 2)}\n`);
	return path;
}
