import {existsSync, readdirSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {QuantizationType} from '../types/index.js';

/**
 * Mirror HuggingFace's own cache-directory convention (`models--org--name`)
 * so cached base-model GGUFs are recognizable next to the HF snapshot cache
 * they were built from.
 */
export function sanitizeModelId(modelId: string): string {
	return modelId.replace(/\//g, '--');
}

/**
 * Path to the cached quantized GGUF for a base model, keyed by model id and
 * quantization. Lives under the home directory (like `~/.nanotune/llama.cpp`)
 * rather than the project's `.nanotune/models/`, since the expensive
 * download+convert+quantize work is reusable across every project that
 * fine-tunes from the same base model.
 */
export function getBaseModelCachePath(
	baseModel: string,
	quantization: QuantizationType,
): string {
	return join(
		homedir(),
		'.nanotune',
		'models',
		'base-cache',
		`${sanitizeModelId(baseModel)}-${quantization}.gguf`,
	);
}

/**
 * Remove leftover `.tmp-<pid>.gguf` cache files (and their `-f16.gguf`
 * conversion intermediates, which share the same `.tmp-<pid>` stem) from a
 * previous export that was interrupted before its `finally` cleanup could
 * run — e.g. a killed process on SIGINT. Safe to call unconditionally before
 * starting a new export; a no-op if the directory doesn't exist yet.
 */
export function sweepStaleCacheArtifacts(cacheDir: string): void {
	if (!existsSync(cacheDir)) {
		return;
	}
	for (const name of readdirSync(cacheDir)) {
		if (name.includes('.tmp-') && name.endsWith('.gguf')) {
			rmSync(join(cacheDir, name), {force: true});
		}
	}
}
