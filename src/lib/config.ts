import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
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
