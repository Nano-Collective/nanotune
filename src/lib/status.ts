import {existsSync, readdirSync, statSync} from 'node:fs';
import {basename, join} from 'node:path';
import {
	findLatestBenchmark,
	getAdaptersDir,
	getDataDir,
	getModelsDir,
	loadBenchmark,
	loadConfig,
} from './config.js';
import {countExamples} from './data.js';

/** One exported GGUF in the project's models directory. */
export interface StatusExport {
	name: string;
	sizeBytes: number;
	/** ISO 8601 mtime. */
	modified: string;
}

/** Summary of the most recent saved benchmark run. */
export interface StatusBenchmark {
	/** Filename under `.nanotune/benchmarks/`, for feeding to `benchmark compare`. */
	file: string;
	timestamp: string;
	passed: number;
	total: number;
	passRate: number;
	isBase: boolean;
}

/**
 * Everything `nanotune status` reports, as data.
 *
 * Timestamps are ISO 8601 and sizes are raw bytes: the human forms ("2 hours
 * ago", "1.2 GB") are a rendering concern and stay in the command component,
 * because a consumer handed "2 hours ago" would have to un-format it.
 *
 * Fields that can be absent are `null`, never omitted — `jq` distinguishes a
 * missing key from a null one, and a stable schema should not make callers
 * care which.
 */
export interface StatusReport {
	project: {
		name: string;
		version: string;
		baseModel: string;
	};
	data: {
		trainExamples: number;
		validExamples: number;
		trainLastModified: string | null;
	};
	training: {
		hasTrained: boolean;
		lastRun: string | null;
	};
	/** Newest first, so `.exports[0]` is the latest export. */
	exports: StatusExport[];
	benchmarks: {
		latest: StatusBenchmark | null;
	};
}

/** ISO 8601 mtime of `path`, or null when it does not exist. */
function mtimeIso(path: string): string | null {
	return existsSync(path) ? statSync(path).mtime.toISOString() : null;
}

/**
 * Gather the project's status. Shared by the Ink view and `--json` so the two
 * cannot report different facts; throws the same "Not a Nanotune project"
 * error `loadConfig` does when run outside a project.
 */
export function collectStatus(): StatusReport {
	const config = loadConfig();
	const modelsDir = getModelsDir();
	// `hasTrained` is derived from the same stat rather than a second
	// existsSync, so the two can never disagree about whether a run happened.
	const lastRun = mtimeIso(join(getAdaptersDir(), 'adapters.safetensors'));

	const exports: StatusExport[] = (
		existsSync(modelsDir)
			? readdirSync(modelsDir)
					.filter(f => f.endsWith('.gguf'))
					.map(name => {
						const {size, mtime} = statSync(join(modelsDir, name));
						return {name, sizeBytes: size, mtime};
					})
					.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
			: []
	).map(({name, sizeBytes, mtime}) => ({
		name,
		sizeBytes,
		modified: mtime.toISOString(),
	}));

	// A run that is corrupt or still being written is reported as "no benchmark
	// yet" rather than taking the whole status report down with it.
	let latest: StatusBenchmark | null = null;
	const latestPath = findLatestBenchmark();
	if (latestPath) {
		try {
			const result = loadBenchmark(latestPath);
			latest = {
				file: basename(latestPath),
				timestamp: result.timestamp,
				passed: result.summary.passed,
				total: result.summary.total,
				passRate: result.summary.passRate,
				isBase: Boolean(result.isBase),
			};
		} catch {
			latest = null;
		}
	}

	return {
		project: {
			name: config.name,
			version: config.version,
			baseModel: config.baseModel,
		},
		data: {
			trainExamples: countExamples(),
			validExamples: countExamples(true),
			trainLastModified: mtimeIso(join(getDataDir(), 'train.jsonl')),
		},
		training: {
			hasTrained: lastRun !== null,
			lastRun,
		},
		exports,
		benchmarks: {latest},
	};
}
