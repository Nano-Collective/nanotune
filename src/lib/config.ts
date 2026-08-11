import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {
	type BenchmarkResult,
	type ChatMessage,
	type Config,
	ConfigSchema,
} from '../types/index.js';

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

export function loadConfig(): Config {
	const path = getConfigPath();
	if (!existsSync(path)) {
		throw new Error('Not a Nanotune project. Run `nanotune init` first.');
	}
	const raw = JSON.parse(readFileSync(path, 'utf-8'));
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

export interface BenchmarkFileInfo {
	path: string;
	filename: string;
	mtime: Date;
}

/**
 * List saved benchmark run files (`benchmark-*.json`) in the project's
 * benchmarks directory, newest first by mtime. Sorting by mtime (rather than
 * filename) keeps this correct even if benchmark filenames stop sharing a
 * single timestamp shape.
 */
export function listBenchmarks(): BenchmarkFileInfo[] {
	const benchmarksDir = getBenchmarksDir();
	if (!existsSync(benchmarksDir)) {
		return [];
	}
	return readdirSync(benchmarksDir)
		.filter(f => f.endsWith('.json') && f.startsWith('benchmark'))
		.map(filename => {
			const path = join(benchmarksDir, filename);
			return {path, filename, mtime: statSync(path).mtime};
		})
		.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/**
 * Find the most recently modified saved benchmark run. Returns `null` if the
 * benchmarks directory is missing or contains no runs.
 */
export function findLatestBenchmark(): string | null {
	const benchmarks = listBenchmarks();
	return benchmarks.length > 0 ? benchmarks[0].path : null;
}

/**
 * Load and parse a saved benchmark run. Accepts a literal path or a value
 * resolved via {@link resolveBenchmarkPath}.
 */
export function loadBenchmark(pathOrName: string): BenchmarkResult {
	const path = resolveBenchmarkPath(pathOrName);
	const content = readFileSync(path, 'utf-8');
	return JSON.parse(content) as BenchmarkResult;
}

/**
 * Resolve a user-supplied benchmark reference to a file path. Tries, in
 * order: the literal path (relative to cwd or absolute), the bare filename
 * under the benchmarks directory, that filename with `.json` appended, and
 * finally `benchmark-<input>.json` (so a copy-pasted timestamp works).
 * Throws with the list of available runs if nothing matches.
 */
export function resolveBenchmarkPath(input: string): string {
	const benchmarksDir = getBenchmarksDir();
	const candidates = [
		input,
		join(benchmarksDir, input),
		join(benchmarksDir, `${input}.json`),
	];
	if (!input.startsWith('benchmark')) {
		candidates.push(join(benchmarksDir, `benchmark-${input}.json`));
	}

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	const available = listBenchmarks()
		.map(b => b.filename)
		.join(', ');
	throw new Error(
		`Could not find a benchmark run matching "${input}".${
			available ? ` Available runs: ${available}` : ' No benchmark runs found.'
		}`,
	);
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
