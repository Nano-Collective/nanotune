import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {type ChatMessage, type Config, ConfigSchema} from '../types/index.js';

const CONFIG_DIR = '.nanotune';
const CONFIG_FILE = 'config.json';

export function getProjectDir(): string {
	return join(process.cwd(), CONFIG_DIR);
}

export function getConfigPath(): string {
	return join(getProjectDir(), CONFIG_FILE);
}

export function getDataDir(): string {
	return join(getProjectDir(), 'data');
}

export function getAdaptersDir(): string {
	return join(getProjectDir(), 'adapters');
}

export function getModelsDir(): string {
	return join(getProjectDir(), 'models');
}

export function getBenchmarksDir(): string {
	return join(getProjectDir(), 'benchmarks');
}

export function configExists(): boolean {
	return existsSync(getConfigPath());
}

function splitWords(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.split(/[\s_-]+/)
		.filter(Boolean);
}

function editDistance(a: string, b: string): number {
	let previous = Array.from({length: b.length + 1}, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(
				previous[j] + 1,
				current[j - 1] + 1,
				previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[b.length];
}

function suggestKey(unknownKey: string, validKeys: string[]): string | null {
	const lower = unknownKey.toLowerCase();
	const words = splitWords(unknownKey);
	let best: string | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;

	for (const key of validKeys) {
		const distance = editDistance(lower, key.toLowerCase());
		const limit = splitWords(key).some(word => words.includes(word))
			? Math.max(lower.length, key.length)
			: Math.floor(Math.max(lower.length, key.length) / 3);
		if (distance <= limit && distance < bestDistance) {
			best = key;
			bestDistance = distance;
		}
	}

	return best;
}

function shapeOf(schema: z.ZodType): Record<string, z.ZodType> | null {
	if (schema instanceof z.ZodObject) {
		return schema.shape as Record<string, z.ZodType>;
	}
	if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
		return shapeOf(schema.unwrap() as z.ZodType);
	}
	return null;
}

function collectUnknownKeys(
	value: unknown,
	schema: z.ZodType,
	path: string,
	warnings: string[],
): void {
	const shape = shapeOf(schema);
	if (
		!shape ||
		value === null ||
		typeof value !== 'object' ||
		Array.isArray(value)
	) {
		return;
	}

	const validKeys = Object.keys(shape);
	for (const [key, child] of Object.entries(value)) {
		const fullPath = path ? `${path}.${key}` : key;
		const known = shape[key];
		if (!known) {
			const suggestion = suggestKey(key, validKeys);
			warnings.push(
				`unknown key "${fullPath}" in ${CONFIG_FILE} — ignored.` +
					(suggestion ? ` Did you mean "${suggestion}"?` : ''),
			);
			continue;
		}
		collectUnknownKeys(child, known, fullPath, warnings);
	}
}

export function findUnknownConfigKeys(raw: unknown): string[] {
	const warnings: string[] = [];
	collectUnknownKeys(raw, ConfigSchema, '', warnings);
	return warnings;
}

const warnedKeys = new Set<string>();

export function loadConfig(): Config {
	const path = getConfigPath();
	if (!existsSync(path)) {
		throw new Error('Not a Nanotune project. Run `nanotune init` first.');
	}
	const raw = JSON.parse(readFileSync(path, 'utf-8'));
	for (const warning of findUnknownConfigKeys(raw)) {
		if (!warnedKeys.has(warning)) {
			warnedKeys.add(warning);
			console.warn(`Warning: ${warning}`);
		}
	}
	return ConfigSchema.parse(raw);
}

export function saveConfig(config: Config): void {
	const projectDir = getProjectDir();
	if (!existsSync(projectDir)) {
		mkdirSync(projectDir, {recursive: true});
	}
	const path = getConfigPath();
	writeFileSync(path, JSON.stringify(config, null, 2));
}

const GITIGNORE_CONTENTS = `# Nanotune project artifacts
adapters/
models/
benchmarks/
judge.json
`;

export function initializeProjectDirs(): void {
	const dirs = [
		getProjectDir(),
		getDataDir(),
		getAdaptersDir(),
		getModelsDir(),
		getBenchmarksDir(),
	];

	for (const dir of dirs) {
		if (!existsSync(dir)) {
			mkdirSync(dir, {recursive: true});
		}
	}

	// Write .gitignore inside .nanotune/ to protect API keys and keep
	// multi-GB adapters/models out of the user's git history.
	const gitignorePath = join(getProjectDir(), '.gitignore');
	if (!existsSync(gitignorePath)) {
		writeFileSync(gitignorePath, GITIGNORE_CONTENTS);
	}
}

/**
 * Find the most recently modified GGUF in the project's models directory.
 * Returns `null` if the directory is missing or contains no GGUFs — callers
 * should surface a clear "run `nanotune export` first" message in that case.
 */
export function findLatestGGUF(): string | null {
	const modelsDir = getModelsDir();
	if (!existsSync(modelsDir)) {
		return null;
	}
	const ggufs = readdirSync(modelsDir).filter(f => f.endsWith('.gguf'));
	if (ggufs.length === 0) {
		return null;
	}
	const sorted = ggufs
		.map(f => ({name: f, path: join(modelsDir, f)}))
		.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
	return sorted[0].path;
}

export function resolveContextMessage(config: Config): ChatMessage {
	if (config.contextMessage) {
		return config.contextMessage;
	}
	return {role: 'system', content: config.systemPrompt ?? ''};
}

export function createDefaultConfig(
	name: string,
	baseModel: string,
	contextMessage: ChatMessage,
): Config {
	return {
		name,
		version: '1.0.0',
		baseModel,
		contextMessage,
		training: {
			iterations: 150,
			learningRate: 5e-5,
			batchSize: 4,
			numLayers: 16,
			stepsPerEval: 50,
			saveEvery: 50,
		},
		export: {
			quantization: 'q4_k_m',
			outputName: name,
		},
	};
}
