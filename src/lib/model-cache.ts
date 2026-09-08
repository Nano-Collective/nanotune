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
 * Whether `pid` currently belongs to a live process. Signal 0 performs the
 * permission and existence checks without delivering anything: `ESRCH` means
 * no such process, while `EPERM` means it exists but is owned by someone
 * else — still alive, so still not ours to clean up.
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Remove leftover `.tmp-<pid>.gguf` cache files (and their `-f16.gguf`
 * conversion intermediates, which share the same `.tmp-<pid>` stem) from a
 * previous export that was interrupted before its `finally` cleanup could
 * run — e.g. a killed process on SIGINT. A no-op if the directory doesn't
 * exist yet.
 *
 * Only files whose owning pid is gone are swept: two `benchmark --base` runs
 * against the same base model share this directory, and deleting every
 * `.tmp-*` unconditionally would pull the half-written GGUF out from under a
 * concurrent export mid-quantize. The residual risk is pid reuse, which would
 * make us skip a genuinely stale file — harmless, since the next run whose pid
 * doesn't collide sweeps it.
 */
export function sweepStaleCacheArtifacts(cacheDir: string): void {
	if (!existsSync(cacheDir)) {
		return;
	}
	for (const name of readdirSync(cacheDir)) {
		if (!name.endsWith('.gguf')) {
			continue;
		}
		const owner = name.match(/\.tmp-(\d+)/);
		if (!owner || isProcessAlive(Number.parseInt(owner[1], 10))) {
			continue;
		}
		rmSync(join(cacheDir, name), {force: true});
	}
}
