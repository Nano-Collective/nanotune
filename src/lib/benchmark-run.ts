import {existsSync, mkdirSync, readFileSync, renameSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {
	BENCHMARK_PRESETS,
	type BenchmarkPreset,
	type BenchmarkResult,
	type BenchmarkTest,
	type BenchmarkTestResult,
	type ChatMessage,
	type JudgeProviderConfig,
} from '../types/index.js';
import {checkPass} from './benchmark-match.js';
import {
	buildMessages,
	formatConversationForJudge,
	getTestDisplayPrompt,
	resolveSamplingOptions,
	type SamplingOptions,
	summarizeSamples,
} from './benchmark-utils.js';
import {
	configExists,
	ensureBenchmarksDir,
	findLatestGGUF,
	loadConfig,
	resolveContextMessage,
	writeFileAtomic,
} from './config.js';
import {
	callJudge,
	isJudgeConfigured,
	loadJudgeConfig,
	resolveCriteria,
} from './judge.js';
import {
	chatCompletion,
	checkLlamaCppInstalled,
	exportModel,
	type GenerateOptions,
	installLlamaCpp,
	type ServerOptions,
	startLlamaServer,
	stopLlamaServer,
} from './llama-cpp.js';
import {ensureModelDownloaded} from './mlx.js';
import {
	getBaseModelCachePath,
	sweepStaleCacheArtifacts,
} from './model-cache.js';
import {assertSupportedPlatform} from './platform.js';

export interface CategoryResult {
	passed: number;
	total: number;
}

/** Raw CLI flags for `nanotune benchmark`, as commander hands them over. */
export interface BenchmarkRunOptions {
	model?: string;
	base?: boolean;
	dataset?: string;
	timeout?: string;
	preset?: string;
	threads?: string;
	gpuLayers?: string;
	ctxSize?: string;
	batchSize?: string;
	cpuOnly?: boolean;
	maxTokens?: string;
	temperature?: string;
	seed?: string;
	samples?: string;
}

/**
 * Progress from a benchmark run.
 *
 * The finished `BenchmarkResult` rides on the final `done` event rather than
 * being the generator's return value: `for await … of` discards a generator's
 * return, and every other long-running generator here (`ensureModelDownloaded`
 * putting its resolved `path` on the last event) reports the same way.
 *
 * Exactly one `done` event is yielded per successful run. A run that cannot
 * produce a result throws instead.
 */
export type BenchmarkEvent =
	| {type: 'prep'; message: string}
	| {type: 'test-start'; index: number; total: number; prompt: string}
	| {type: 'test-end'; categories: Record<string, CategoryResult>}
	| {type: 'warning'; message: string}
	| {type: 'done'; result: BenchmarkResult};

/**
 * The llama-server and judge calls a run makes.
 *
 * Injectable so the scoring loop — sampling, timeouts, judge-vs-match
 * dispatch, category tallying, failure recording — can be exercised against a
 * fake instead of a live server and a real model. Production always takes the
 * default; only tests pass this.
 */
export interface BenchmarkDeps {
	startLlamaServer: typeof startLlamaServer;
	chatCompletion: typeof chatCompletion;
	stopLlamaServer: typeof stopLlamaServer;
	callJudge: typeof callJudge;
}

const DEFAULT_DEPS: BenchmarkDeps = {
	startLlamaServer,
	chatCompletion,
	stopLlamaServer,
	callJudge,
};

const VALID_PRESETS: BenchmarkPreset[] = ['low', 'medium', 'high', 'ultra'];

/**
 * Turn the raw flags into llama-server and generation options. A `--preset`
 * replaces the individual flags wholesale rather than merging with them, which
 * is why the two branches share nothing but the resolved sampling values.
 *
 * Split out of `runBenchmark` so the flag wiring is testable without a server,
 * the same split as `buildTrainingArgs` against `runTraining`.
 */
export function resolveRunOptions(
	options: BenchmarkRunOptions,
	sampling: Pick<SamplingOptions, 'temperature' | 'seed'>,
): {serverOptions: ServerOptions; generateOptions: GenerateOptions} {
	if (options.preset) {
		if (!VALID_PRESETS.includes(options.preset as BenchmarkPreset)) {
			throw new Error(
				`Invalid preset: ${options.preset}. Valid presets: ${VALID_PRESETS.join(', ')}`,
			);
		}

		const preset = BENCHMARK_PRESETS[options.preset as BenchmarkPreset];
		return {
			serverOptions: {
				threads: preset.threads,
				gpuLayers: preset.gpuLayers,
				ctxSize: preset.ctxSize,
				batchSize: preset.batchSize,
				cpuOnly: preset.gpuLayers === 0,
			},
			generateOptions: {
				maxTokens: preset.maxTokens,
				temperature: sampling.temperature,
				seed: sampling.seed,
			},
		};
	}

	return {
		serverOptions: {
			threads: options.threads
				? Number.parseInt(options.threads, 10)
				: undefined,
			gpuLayers: options.gpuLayers
				? Number.parseInt(options.gpuLayers, 10)
				: undefined,
			ctxSize: options.ctxSize ? Number.parseInt(options.ctxSize, 10) : 4096,
			batchSize: options.batchSize
				? Number.parseInt(options.batchSize, 10)
				: 2048,
			cpuOnly: options.cpuOnly,
		},
		generateOptions: {
			maxTokens: options.maxTokens
				? Number.parseInt(options.maxTokens, 10)
				: 50,
			temperature: sampling.temperature,
			seed: sampling.seed,
		},
	};
}

/**
 * Reject a dataset whose tests cannot be run. Throws on the first bad test so
 * the message names it, rather than failing deep inside the run loop.
 */
export function validateTests(tests: BenchmarkTest[]): void {
	for (const test of tests) {
		if (!test.prompt && (!test.messages || test.messages.length === 0)) {
			throw new Error(
				`Test #${test.id} must have either "prompt" or "messages".`,
			);
		}
	}
}

/**
 * Mean of `select` across results that produced a real response.
 *
 * Tests whose `actual` begins with "Error:" are timeouts and transport
 * failures — including their timings would report the latency of giving up as
 * though it were the model's speed.
 */
function averageOver(
	results: BenchmarkTestResult[],
	select: (result: BenchmarkTestResult) => number | undefined,
	round: (value: number) => number,
): number | undefined {
	const values = results
		.filter(r => select(r) && !r.actual.startsWith('Error:'))
		.map(r => select(r) as number);
	return values.length > 0
		? round(values.reduce((a, b) => a + b, 0) / values.length)
		: undefined;
}

/**
 * Aggregate per-test results into the run summary. Pure, so the averaging and
 * the partial-run arithmetic are testable without running a benchmark.
 */
export function summarizeResults(
	allResults: BenchmarkTestResult[],
	categoryResults: Record<string, CategoryResult>,
	judgeModel?: string,
): BenchmarkResult['summary'] {
	const totalPassed = Object.values(categoryResults).reduce(
		(sum, c) => sum + c.passed,
		0,
	);
	// Not the dataset length — an aborted run must score against what it
	// actually ran, or the pass rate reads as a catastrophic regression.
	const totalTests = allResults.length;

	// Judge scores are averaged over every judged test, errors included: a
	// judge that scored a failed response still produced a real score.
	const judged = allResults.filter(r => r.judgeScore !== undefined);
	const avgJudgeScore =
		judged.length > 0
			? Math.round(
					(judged.reduce((sum, r) => sum + (r.judgeScore ?? 0), 0) /
						judged.length) *
						10,
				) / 10
			: undefined;

	return {
		total: totalTests,
		passed: totalPassed,
		failed: totalTests - totalPassed,
		// Guarded: an empty dataset makes this 0/0, and `JSON.stringify` writes
		// NaN as `null` — a documented `number` field arriving as null is worse
		// for a consumer than an honest zero.
		passRate: totalTests > 0 ? totalPassed / totalTests : 0,
		avgLatencyMs: averageOver(allResults, r => r.latencyMs, Math.round),
		avgTokensPerSecond: averageOver(
			allResults,
			r => r.tokensPerSecond,
			v => Math.round(v * 100) / 100,
		),
		avgTtftMs: averageOver(allResults, r => r.ttftMs, Math.round),
		avgJudgeScore,
		judgeModel,
	};
}

const SAMPLE_TESTS: BenchmarkTest[] = [
	{
		id: 1,
		prompt: 'list all files',
		acceptable: ['ls', 'ls -la', 'ls -a', 'ls -l'],
		category: 'basic',
		match: 'semantic',
	},
	{
		id: 2,
		prompt: 'show current directory',
		acceptable: ['pwd'],
		category: 'basic',
		match: 'startsWith',
	},
];

/**
 * Render a run as the Markdown report saved next to the JSON results.
 *
 * Exported for tests: it produces a user-facing artefact from a large branchy
 * template, and lived unexercised inside the command component until the run
 * moved here.
 */
export function generateMarkdownReport(
	result: BenchmarkResult,
	contextMessage: ChatMessage,
): string {
	const lines: string[] = [];

	lines.push('# Benchmark Report');
	lines.push('');
	lines.push(`**Date:** ${new Date(result.timestamp).toLocaleString()}`);
	lines.push(`**Model:** ${result.model.split('/').pop()}`);
	lines.push(
		`**Run Type:** ${result.isBase ? 'Base model (control)' : 'Fine-tuned'}`,
	);
	if (result.warning) {
		lines.push('');
		lines.push(`> **Incomplete run:** ${result.warning}`);
	}
	if (result.config) {
		lines.push('');
		lines.push('## Configuration');
		lines.push('');
		lines.push(`- **Temperature:** ${result.config.temperature}`);
		lines.push(`- **Seed:** ${result.config.seed}`);
		lines.push(`- **Samples per test:** ${result.config.samples}`);
	}
	lines.push('');

	// Summary
	lines.push('## Summary');
	lines.push('');
	lines.push(`- **Total Tests:** ${result.summary.total}`);
	lines.push(`- **Passed:** ${result.summary.passed}`);
	lines.push(`- **Failed:** ${result.summary.failed}`);
	lines.push(`- **Pass Rate:** ${Math.round(result.summary.passRate * 100)}%`);
	if (result.summary.avgLatencyMs) {
		lines.push(`- **Avg Latency:** ${result.summary.avgLatencyMs}ms`);
	}
	if (result.summary.avgTokensPerSecond !== undefined) {
		lines.push(
			`- **Avg Tokens/sec:** ${result.summary.avgTokensPerSecond.toFixed(2)}`,
		);
	}
	if (result.summary.avgTtftMs !== undefined) {
		lines.push(`- **Avg TTFT:** ${result.summary.avgTtftMs}ms`);
	}
	if (result.summary.avgJudgeScore !== undefined) {
		lines.push(`- **Avg Judge Score:** ${result.summary.avgJudgeScore}/10`);
	}
	if (result.summary.judgeModel) {
		lines.push(`- **Judge Model:** ${result.summary.judgeModel}`);
	}
	lines.push('');

	// Category breakdown
	lines.push('## Results by Category');
	lines.push('');
	for (const [category, stats] of Object.entries(result.categories)) {
		const percent = Math.round((stats.passed / stats.total) * 100);
		lines.push(
			`- **${category}:** ${stats.passed}/${stats.total} (${percent}%)`,
		);
	}
	lines.push('');

	// Context message used
	lines.push(`## Context Message (${contextMessage.role})`);
	lines.push('');
	lines.push('```');
	lines.push(contextMessage.content);
	lines.push('```');
	lines.push('');

	// Detailed results
	lines.push('## Detailed Results');
	lines.push('');

	for (const testResult of result.results) {
		const status = testResult.passed ? '✅' : '❌';
		const label = testResult.messages
			? `[${testResult.messages.length}-msg conversation]`
			: testResult.prompt;
		lines.push(`### ${status} Test #${testResult.id}: ${label}`);
		lines.push('');
		if (testResult.messages) {
			lines.push('**Conversation:**');
			lines.push('');
			for (const msg of testResult.messages) {
				const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
				lines.push(`> **${role}:** ${msg.content}`);
			}
			lines.push('');
		}
		lines.push(`**Category:** ${testResult.category}`);
		if (testResult.samples !== undefined) {
			lines.push(`**Samples:** ${testResult.samples}`);
			lines.push(
				`**Sample Pass Rate:** ${Math.round((testResult.samplePassRate ?? 0) * 100)}%`,
			);
			lines.push(
				`**Sample Variance:** ${(testResult.sampleVariance ?? 0).toFixed(4)}`,
			);
		}
		if (testResult.latencyMs) {
			lines.push(`**Total Latency:** ${testResult.latencyMs}ms`);
		}
		if (testResult.ttftMs) {
			lines.push(`**Time to First Token:** ${testResult.ttftMs}ms`);
		}
		if (testResult.generationTimeMs) {
			lines.push(`**Generation Time:** ${testResult.generationTimeMs}ms`);
		}
		if (testResult.tokensGenerated) {
			lines.push(`**Tokens Generated:** ${testResult.tokensGenerated}`);
		}
		if (testResult.tokensPerSecond) {
			lines.push(`**Tokens/Second:** ${testResult.tokensPerSecond.toFixed(2)}`);
		}
		lines.push('');
		if (testResult.expected.length > 0) {
			lines.push('**Expected (any of):**');
			for (const expected of testResult.expected) {
				lines.push(`- \`${expected}\``);
			}
			lines.push('');
		}
		lines.push('**Model Response:**');
		lines.push('```');
		lines.push(testResult.actual);
		lines.push('```');
		if (testResult.judgeScore !== undefined) {
			lines.push('');
			lines.push(`**Judge Score:** ${testResult.judgeScore}/10`);
			if (testResult.judgeCriteriaScores) {
				lines.push('');
				lines.push('**Criteria Scores:**');
				for (const [criterion, score] of Object.entries(
					testResult.judgeCriteriaScores,
				)) {
					lines.push(`- ${criterion}: ${score}/10`);
				}
			}
			if (testResult.judgeReasoning) {
				lines.push('');
				lines.push(`**Judge Reasoning:** ${testResult.judgeReasoning}`);
			}
		}
		lines.push('');
		lines.push('---');
		lines.push('');
	}

	// Failed tests summary for quick reference
	if (result.failures.length > 0) {
		lines.push('## Failed Tests Summary');
		lines.push('');
		lines.push('| ID | Prompt | Expected | Actual |');
		lines.push('|---|---|---|---|');
		for (const f of result.failures) {
			const expected = f.expected.join(' \\| ');
			const actual = f.actual.replace(/\n/g, ' ').slice(0, 50);
			const prompt = f.messages
				? `[${f.messages.length}-msg conversation]`
				: f.prompt;
			lines.push(`| ${f.id} | ${prompt} | ${expected} | ${actual} |`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

/**
 * Run a benchmark suite end to end, yielding progress as it goes.
 *
 * Every failure throws rather than returning a status: the Ink command turns a
 * throw into its error frame and `--json` turns it into a stderr line and a
 * non-zero exit, so neither consumer needs its own notion of "failed".
 *
 * Writes the detailed JSON and the Markdown report to the project's benchmarks
 * directory before yielding `done`, exactly as the command did inline.
 */
export async function* runBenchmark(
	options: BenchmarkRunOptions,
	deps: BenchmarkDeps = DEFAULT_DEPS,
): AsyncGenerator<BenchmarkEvent> {
	if (!configExists()) {
		throw new Error('Not a Nanotune project. Run `nanotune init` first.');
	}

	// Try full config; fall back to raw config for benchmark-only setups.
	let contextMsg: ChatMessage = {role: 'system', content: ''};
	let config: ReturnType<typeof loadConfig> | null = null;
	try {
		config = loadConfig();
		contextMsg = resolveContextMessage(config);
	} catch {
		// Minimal config (e.g. external benchmark runner) — no context message.
	}
	const benchmarksDir = ensureBenchmarksDir();

	if (options.model && options.base) {
		throw new Error(
			'`--model` and `--base` are mutually exclusive — `--base` resolves the model itself.',
		);
	}

	// Resolve the sampling flags before anything expensive. `--base` can spend
	// minutes downloading and quantizing a base model, and failing a typo'd
	// `--samples` only after that has finished wastes the whole run on
	// something we could see immediately.
	const sampling = resolveSamplingOptions({
		temperature: options.temperature,
		seed: options.seed,
		samples: options.samples,
	});

	// Reject a mistyped flag rather than running a suite under settings the
	// user didn't ask for.
	if (sampling.errors.length > 0) {
		throw new Error(sampling.errors[0]);
	}

	if (sampling.samples > 1 && sampling.temperature === 0) {
		throw new Error(
			'Cannot use --samples with temperature 0 (greedy decoding produces identical outputs). Use --temperature 0.1 or higher for sampling.',
		);
	}

	// Resolving the options this early also rejects a bad `--preset` before the
	// base-model download rather than after it.
	const {serverOptions, generateOptions} = resolveRunOptions(options, sampling);

	let modelPath: string;
	if (options.base) {
		if (!config) {
			throw new Error(
				'`--base` requires a full nanotune config with `baseModel` set. Run `nanotune init` first, or omit `--base` and pass `--model` directly.',
			);
		}

		// Fail fast on unsupported hardware before a multi-minute
		// download/convert/quantize run.
		assertSupportedPlatform();

		const {baseModel} = config;
		const quantization = config.export.quantization;
		const cachePath = getBaseModelCachePath(baseModel, quantization);

		if (!existsSync(cachePath)) {
			// Installing llama.cpp and downloading the base model are
			// independent — run them concurrently instead of waiting on one
			// before starting the other. Neither job can `yield` (a nested async
			// function is not this generator), so both report into `latest` and
			// the drain loop below turns that into events. They already shared a
			// single progress line before this was a generator, so nothing is
			// lost by collapsing them into one.
			let latest = 'Preparing base model...';
			const work = Promise.all([
				(async () => {
					const hasLlamaCpp = await checkLlamaCppInstalled();
					if (!hasLlamaCpp) {
						latest = 'Installing llama.cpp...';
						for await (const msg of installLlamaCpp()) {
							latest = msg;
						}
					}
				})(),
				(async (): Promise<string | undefined> => {
					latest = `Downloading base model ${baseModel}...`;
					let resolvedPath: string | undefined;
					for await (const progress of ensureModelDownloaded(baseModel)) {
						latest = progress.sizeInfo
							? `Downloading base model... ${progress.sizeInfo}`
							: 'Downloading base model...';
						if (progress.path) {
							resolvedPath = progress.path;
						}
					}
					return resolvedPath;
				})(),
			]);

			// Attach the settle handler at creation, never later: `work` can
			// reject while the drain loop is sleeping, and on Node 22 an
			// unhandled rejection is fatal. Awaiting `work` below still surfaces
			// the error to the caller.
			let settled = false;
			const markSettled = () => {
				settled = true;
			};
			void work.then(markSettled, markSettled);

			let reported = '';
			while (!settled) {
				if (latest !== reported) {
					reported = latest;
					yield {type: 'prep', message: latest};
				}
				await new Promise(resolve => setTimeout(resolve, 100));
			}

			const [, snapshotPath] = await work;
			if (!snapshotPath) {
				throw new Error('Could not resolve the downloaded base model path.');
			}

			// Export to a temp path and rename into place atomically.
			// existsSync(cachePath) above is the only thing gating reuse of this
			// cache — if a run gets killed mid-quantize and the partial file
			// landed directly at cachePath, every future run would silently treat
			// that corrupt file as a valid cache hit.
			mkdirSync(dirname(cachePath), {recursive: true});
			// Clean up .tmp-<pid>.gguf / -f16.gguf leftovers from a previous run
			// that was interrupted before its own cleanup could run.
			sweepStaleCacheArtifacts(dirname(cachePath));
			const tempCachePath = cachePath.replace(
				/\.gguf$/,
				`.tmp-${process.pid}.gguf`,
			);
			try {
				for await (const progress of exportModel(
					snapshotPath,
					tempCachePath,
					quantization,
				)) {
					yield {type: 'prep', message: progress.step};
				}
				renameSync(tempCachePath, cachePath);
			} finally {
				if (existsSync(tempCachePath)) {
					rmSync(tempCachePath, {force: true});
				}
			}
		}

		modelPath = cachePath;
	} else {
		const resolved = options.model ?? findLatestGGUF();
		if (!resolved) {
			throw new Error('No exported models found. Run `nanotune export` first.');
		}
		modelPath = resolved;
	}

	if (!existsSync(modelPath)) {
		throw new Error(`Model not found: ${modelPath}`);
	}

	// Load benchmark dataset
	const datasetPath = options.dataset || join(benchmarksDir, 'tests.json');
	if (!existsSync(datasetPath)) {
		// Leave a runnable starting point behind rather than just complaining.
		writeFileAtomic(datasetPath, JSON.stringify(SAMPLE_TESTS, null, 2));
		throw new Error(
			`No benchmark dataset found. Created sample at ${datasetPath}`,
		);
	}
	const tests: BenchmarkTest[] = JSON.parse(readFileSync(datasetPath, 'utf-8'));
	validateTests(tests);

	// Check if any tests use llm-judge and load judge config if needed
	const hasJudgeTests = tests.some(t => t.match === 'llm-judge');
	let judgeConfig: JudgeProviderConfig | null = null;

	if (hasJudgeTests) {
		if (!isJudgeConfigured()) {
			throw new Error(
				'Some tests use "llm-judge" match mode but no judge is configured. Run `nanotune judge configure` first.',
			);
		}
		judgeConfig = loadJudgeConfig();
	}

	const timeout = options.timeout
		? Number.parseInt(options.timeout, 10)
		: 30000;

	const failures: BenchmarkResult['failures'] = [];
	const allResults: BenchmarkTestResult[] = [];
	const categoryResults: Record<string, CategoryResult> = {};

	// Start llama-server once for the whole run — cold-starting per test would
	// multiply latency by N and cache the model from disk N times.
	const serverHandle = await deps.startLlamaServer(modelPath, serverOptions);

	// The server can die under us mid-run (OOM, an incompatible GGUF, an
	// external kill). `exited` settles the moment it does — stop there and
	// report what we have, rather than letting every remaining test fail to
	// connect and burying the reason.
	let serverDied = false;
	let abortReason: string | null = null;
	void serverHandle.exited.then(() => {
		serverDied = true;
	});

	try {
		for (let i = 0; i < tests.length; i++) {
			if (serverDied) {
				abortReason = `llama-server exited unexpectedly after ${i} of ${tests.length} tests — saving partial results.`;
				break;
			}
			const test = tests[i];
			yield {
				type: 'test-start',
				index: i,
				total: tests.length,
				prompt: getTestDisplayPrompt(test),
			};

			// Initialize category
			if (!categoryResults[test.category]) {
				categoryResults[test.category] = {passed: 0, total: 0};
			}
			categoryResults[test.category].total++;

			const startTime = Date.now();
			let response = '';
			let passed = false;
			let latencyMs: number | undefined;
			let ttftMs: number | undefined;
			let generationTimeMs: number | undefined;
			let tokensGenerated: number | undefined;
			let tokensPerSecond: number | undefined;

			let judgeScore: number | undefined;
			let judgeReasoning: string | undefined;
			let judgeCriteriaScores: Record<string, number> | undefined;

			const samplePasses: boolean[] = [];

			try {
				// Build messages array (chat-template aware) for this test.
				const requestMessages = buildMessages(test, contextMsg);

				for (let sample = 0; sample < sampling.samples; sample++) {
					// Cancel the in-flight fetch when the timeout wins — otherwise
					// llama-server keeps generating into the void and the next test
					// is delayed waiting for the server to free up.
					const controller = new AbortController();
					const timeoutId = setTimeout(() => {
						controller.abort();
					}, timeout);

					let sampleResponse = '';
					let sampleFailed = false;
					try {
						const inferenceResult = await deps.chatCompletion(
							serverHandle,
							requestMessages,
							{
								...generateOptions,
								seed: sampling.seed + sample,
								signal: controller.signal,
							},
						);
						sampleResponse = inferenceResult.text;
						if (sample === 0) {
							latencyMs = Date.now() - startTime;
							response = inferenceResult.text;
							ttftMs = inferenceResult.ttftMs;
							generationTimeMs = inferenceResult.generationTimeMs;
							tokensGenerated = inferenceResult.tokensGenerated;
							tokensPerSecond = inferenceResult.tokensPerSecond;
						}
					} catch (err) {
						// Timeout or other errors: treat this sample as failed and
						// continue. This ensures partial results aren't thrown away
						// when one sample times out in a multi-sample run.
						sampleFailed = true;
						if (sample === 0) {
							latencyMs = Date.now() - startTime;
							response =
								err instanceof Error
									? `Error: ${err.message}`
									: 'Unknown error';
						}
					} finally {
						clearTimeout(timeoutId);
					}

					let samplePassed: boolean;
					if (sampleFailed) {
						// Sample failed due to timeout or error, mark as failed
						samplePassed = false;
					} else if (test.match === 'llm-judge' && judgeConfig) {
						// Use LLM judge for evaluation
						const criteria = resolveCriteria(test.criteria);
						const threshold = test.passThreshold ?? 7;
						// For multi-turn tests, include conversation context in the
						// judge prompt
						const judgePrompt = test.messages
							? formatConversationForJudge(test.messages, contextMsg)
							: (test.prompt as string);
						const judgeResult = await deps.callJudge(
							judgePrompt,
							sampleResponse.trim(),
							criteria,
							judgeConfig,
							threshold,
							test.acceptable,
						);
						samplePassed = judgeResult.pass;
						if (sample === 0) {
							judgeScore = judgeResult.score;
							judgeReasoning = judgeResult.reasoning;
							judgeCriteriaScores = judgeResult.criteriaScores;
						}
					} else {
						// Use string matching
						const matchResult = checkPass(
							test.acceptable || [],
							sampleResponse.trim(),
							test.match || 'semantic',
							test.caseSensitive ?? false,
						);
						samplePassed = matchResult.passed;
					}
					samplePasses.push(samplePassed);
				}

				passed = summarizeSamples(samplePasses).passed;

				if (passed) {
					categoryResults[test.category].passed++;
				} else {
					failures.push({
						id: test.id,
						prompt: getTestDisplayPrompt(test),
						messages: test.messages,
						expected: test.acceptable || [],
						actual: response.trim(),
					});
				}
			} catch (err) {
				latencyMs = Date.now() - startTime;
				response =
					err instanceof Error ? `Error: ${err.message}` : 'Unknown error';
				failures.push({
					id: test.id,
					prompt: getTestDisplayPrompt(test),
					messages: test.messages,
					expected: test.acceptable || [],
					actual: response,
				});
			}

			// Store full result for detailed report
			const sampleSummary = summarizeSamples(samplePasses);
			allResults.push({
				id: test.id,
				prompt: getTestDisplayPrompt(test),
				messages: test.messages,
				expected: test.acceptable || [],
				actual: response.trim(),
				passed,
				category: test.category,
				latencyMs,
				ttftMs,
				generationTimeMs,
				tokensGenerated,
				tokensPerSecond,
				judgeScore,
				judgeReasoning,
				judgeCriteriaScores,
				samples: sampling.samples > 1 ? sampling.samples : undefined,
				samplePassRate:
					sampling.samples > 1 ? sampleSummary.passRate : undefined,
				sampleVariance:
					sampling.samples > 1 ? sampleSummary.variance : undefined,
			});

			yield {type: 'test-end', categories: {...categoryResults}};
		}
	} finally {
		await deps.stopLlamaServer(serverHandle);
	}

	if (abortReason && allResults.length === 0) {
		// Nothing ran, so there is no partial report worth writing.
		throw new Error(abortReason);
	}
	if (abortReason) {
		yield {type: 'warning', message: abortReason};
	}

	const finalResult: BenchmarkResult = {
		model: modelPath,
		timestamp: new Date().toISOString(),
		config: {
			temperature: sampling.temperature,
			seed: sampling.seed,
			samples: sampling.samples,
		},
		isBase: Boolean(options.base),
		// Recorded on the result itself, not just shown in the terminal: without
		// it a saved partial run is indistinguishable from a complete one, and a
		// consumer would read its pass rate as a real score.
		warning: abortReason ?? undefined,
		summary: summarizeResults(allResults, categoryResults, judgeConfig?.model),
		categories: categoryResults,
		results: allResults,
		failures,
	};

	// Save detailed JSON results
	const resultFilename = `benchmark-${new Date()
		.toISOString()
		.replace(/[:.]/g, '-')}.json`;
	writeFileAtomic(
		join(benchmarksDir, resultFilename),
		JSON.stringify(finalResult, null, 2),
	);

	// Save human-readable markdown report
	writeFileAtomic(
		join(benchmarksDir, resultFilename.replace('.json', '.md')),
		generateMarkdownReport(finalResult, contextMsg),
	);

	yield {type: 'done', result: finalResult};
}

/**
 * One line of human-readable progress for a benchmark event, or null when the
 * event carries none.
 *
 * Used by `--json` to report progress on stderr during a run that can take
 * minutes, without putting anything on stdout ahead of the JSON document.
 */
export function formatEventForStderr(event: BenchmarkEvent): string | null {
	switch (event.type) {
		case 'prep':
			return event.message;
		case 'test-start':
			return `[${event.index + 1}/${event.total}] ${event.prompt}`;
		case 'warning':
			return event.message;
		default:
			return null;
	}
}
