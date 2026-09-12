import {existsSync, mkdirSync, readFileSync, renameSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {Spinner, StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp} from 'ink';
import {useCallback, useEffect, useState} from 'react';
import {
	ExitHint,
	Header,
	Progress,
	StatusBadge,
	useAutoExit,
	useKeyInput,
} from '../components/index.js';
import {checkPass} from '../lib/benchmark-match.js';
import {
	buildMessages,
	formatConversationForJudge,
	getTestDisplayPrompt,
	resolveSamplingOptions,
	summarizeSamples,
} from '../lib/benchmark-utils.js';
import {
	configExists,
	ensureBenchmarksDir,
	findLatestGGUF,
	loadConfig,
	resolveContextMessage,
	writeFileAtomic,
} from '../lib/config.js';
import {
	callJudge,
	isJudgeConfigured,
	loadJudgeConfig,
	resolveCriteria,
} from '../lib/judge.js';
import {
	chatCompletion,
	checkLlamaCppInstalled,
	exportModel,
	type GenerateOptions,
	installLlamaCpp,
	type ServerOptions,
	startLlamaServer,
	stopLlamaServer,
} from '../lib/llama-cpp.js';
import {ensureModelDownloaded} from '../lib/mlx.js';
import {
	getBaseModelCachePath,
	sweepStaleCacheArtifacts,
} from '../lib/model-cache.js';
import {assertSupportedPlatform} from '../lib/platform.js';
import {
	BENCHMARK_PRESETS,
	type BenchmarkPreset,
	type BenchmarkResult,
	type BenchmarkTest,
	type BenchmarkTestResult,
	type JudgeProviderConfig,
} from '../types/index.js';

interface Props {
	options: {
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
	};
}

type Status = 'loading' | 'running' | 'done' | 'error';

interface CategoryResult {
	passed: number;
	total: number;
}

function generateMarkdownReport(
	result: BenchmarkResult,
	contextMessage: {role: string; content: string},
): string {
	const lines: string[] = [];

	lines.push('# Benchmark Report');
	lines.push('');
	lines.push(`**Date:** ${new Date(result.timestamp).toLocaleString()}`);
	lines.push(`**Model:** ${result.model.split('/').pop()}`);
	lines.push(
		`**Run Type:** ${result.isBase ? 'Base model (control)' : 'Fine-tuned'}`,
	);
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

export function BenchmarkCommand({options}: Props) {
	const {exit} = useApp();
	const [status, setStatus] = useState<Status>('loading');
	const [error, setError] = useState<string | null>(null);
	const [prepStep, setPrepStep] = useState<string | null>(null);
	const [currentTest, setCurrentTest] = useState<string | null>(null);
	const [progress, setProgress] = useState(0);
	const [results, setResults] = useState<BenchmarkResult | null>(null);
	const [warning, setWarning] = useState<string | null>(null);
	const [categories, setCategories] = useState<Record<string, CategoryResult>>(
		{},
	);

	useKeyInput((_input, key) => {
		if (key.escape || key.return) {
			exit();
		}
	});

	useAutoExit(status === 'done' || status === 'error', status === 'error');

	const run = useCallback(async () => {
		try {
			// Check project exists
			if (!configExists()) {
				setError('Not a Nanotune project. Run `nanotune init` first.');
				setStatus('error');
				return;
			}

			// Try full config; fall back to raw config for benchmark-only setups
			let contextMsg: {role: string; content: string} = {
				role: 'system',
				content: '',
			};
			let config: ReturnType<typeof loadConfig> | null = null;
			try {
				config = loadConfig();
				contextMsg = resolveContextMessage(config);
			} catch {
				// Minimal config (e.g., external benchmark runner) — no context message needed
			}
			const benchmarksDir = ensureBenchmarksDir();

			if (options.model && options.base) {
				setError(
					'`--model` and `--base` are mutually exclusive — `--base` resolves the model itself.',
				);
				setStatus('error');
				return;
			}

			// Resolve the sampling flags before anything expensive. `--base` can
			// spend minutes downloading and quantizing a base model, and failing
			// a typo'd `--samples` only after that has finished wastes the whole
			// run on something we could see immediately.
			const sampling = resolveSamplingOptions({
				temperature: options.temperature,
				seed: options.seed,
				samples: options.samples,
			});

			// Reject a mistyped flag rather than running a suite under settings
			// the user didn't ask for.
			if (sampling.errors.length > 0) {
				setError(sampling.errors[0]);
				setStatus('error');
				return;
			}

			if (sampling.samples > 1 && sampling.temperature === 0) {
				setError(
					'Cannot use --samples with temperature 0 (greedy decoding produces identical outputs). Use --temperature 0.1 or higher for sampling.',
				);
				setStatus('error');
				return;
			}

			// Find model
			let modelPath: string | null;
			if (options.base) {
				if (!config) {
					setError(
						'`--base` requires a full nanotune config with `baseModel` set. Run `nanotune init` first, or omit `--base` and pass `--model` directly.',
					);
					setStatus('error');
					return;
				}

				// Fail fast on unsupported hardware before a multi-minute
				// download/convert/quantize run.
				assertSupportedPlatform();

				const quantization = config.export.quantization;
				const cachePath = getBaseModelCachePath(config.baseModel, quantization);

				if (!existsSync(cachePath)) {
					// Installing llama.cpp and downloading the base model are
					// independent — run them concurrently instead of waiting on
					// one before starting the other.
					const [, snapshotPath] = await Promise.all([
						(async () => {
							const hasLlamaCpp = await checkLlamaCppInstalled();
							if (!hasLlamaCpp) {
								setPrepStep('Installing llama.cpp...');
								for await (const msg of installLlamaCpp()) {
									setPrepStep(msg);
								}
							}
						})(),
						(async (): Promise<string | undefined> => {
							setPrepStep(`Downloading base model ${config.baseModel}...`);
							let resolvedPath: string | undefined;
							for await (const progress of ensureModelDownloaded(
								config.baseModel,
							)) {
								setPrepStep(
									progress.sizeInfo
										? `Downloading base model... ${progress.sizeInfo}`
										: 'Downloading base model...',
								);
								if (progress.path) {
									resolvedPath = progress.path;
								}
							}
							return resolvedPath;
						})(),
					]);
					if (!snapshotPath) {
						throw new Error(
							'Could not resolve the downloaded base model path.',
						);
					}

					// Export to a temp path and rename into place atomically.
					// existsSync(cachePath) above is the only thing gating reuse of
					// this cache — if a run gets killed mid-quantize and the partial
					// file landed directly at cachePath, every future run would
					// silently treat that corrupt file as a valid cache hit.
					mkdirSync(dirname(cachePath), {recursive: true});
					// Clean up .tmp-<pid>.gguf / -f16.gguf leftovers from a previous
					// run that was interrupted before its own cleanup could run.
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
							setPrepStep(progress.step);
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
				modelPath = options.model ?? findLatestGGUF();
				if (!modelPath) {
					setError('No exported models found. Run `nanotune export` first.');
					setStatus('error');
					return;
				}
			}

			if (!existsSync(modelPath)) {
				setError(`Model not found: ${modelPath}`);
				setStatus('error');
				return;
			}

			// Load benchmark dataset
			let tests: BenchmarkTest[] = [];
			const datasetPath = options.dataset || join(benchmarksDir, 'tests.json');

			if (existsSync(datasetPath)) {
				const content = readFileSync(datasetPath, 'utf-8');
				tests = JSON.parse(content);
			} else {
				// Create sample benchmark file with examples of different match modes
				tests = [
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
				writeFileAtomic(datasetPath, JSON.stringify(tests, null, 2));
				setError(
					`No benchmark dataset found. Created sample at ${datasetPath}`,
				);
				setStatus('error');
				return;
			}

			// Validate tests: each must have either prompt or messages
			for (const test of tests) {
				if (!test.prompt && (!test.messages || test.messages.length === 0)) {
					setError(`Test #${test.id} must have either "prompt" or "messages".`);
					setStatus('error');
					return;
				}
			}

			let serverOptions: ServerOptions;
			let generateOptions: GenerateOptions;

			if (options.preset) {
				// Validate preset
				const validPresets: BenchmarkPreset[] = [
					'low',
					'medium',
					'high',
					'ultra',
				];
				if (!validPresets.includes(options.preset as BenchmarkPreset)) {
					setError(
						`Invalid preset: ${options.preset}. Valid presets: ${validPresets.join(', ')}`,
					);
					setStatus('error');
					return;
				}

				// Apply preset configuration
				const preset = BENCHMARK_PRESETS[options.preset as BenchmarkPreset];
				serverOptions = {
					threads: preset.threads,
					gpuLayers: preset.gpuLayers,
					ctxSize: preset.ctxSize,
					batchSize: preset.batchSize,
					cpuOnly: preset.gpuLayers === 0,
				};
				generateOptions = {
					maxTokens: preset.maxTokens,
					temperature: sampling.temperature,
					seed: sampling.seed,
				};
			} else {
				serverOptions = {
					threads: options.threads
						? Number.parseInt(options.threads, 10)
						: undefined,
					gpuLayers: options.gpuLayers
						? Number.parseInt(options.gpuLayers, 10)
						: undefined,
					ctxSize: options.ctxSize
						? Number.parseInt(options.ctxSize, 10)
						: 4096,
					batchSize: options.batchSize
						? Number.parseInt(options.batchSize, 10)
						: 2048,
					cpuOnly: options.cpuOnly,
				};
				generateOptions = {
					maxTokens: options.maxTokens
						? Number.parseInt(options.maxTokens, 10)
						: 50,
					temperature: sampling.temperature,
					seed: sampling.seed,
				};
			}

			// Check if any tests use llm-judge and load judge config if needed
			const hasJudgeTests = tests.some(t => t.match === 'llm-judge');
			let judgeConfig: JudgeProviderConfig | null = null;

			if (hasJudgeTests) {
				if (!isJudgeConfigured()) {
					setError(
						'Some tests use "llm-judge" match mode but no judge is configured. Run `nanotune judge configure` first.',
					);
					setStatus('error');
					return;
				}
				judgeConfig = loadJudgeConfig();
			}

			// Run benchmarks
			setStatus('running');
			const timeout = options.timeout
				? Number.parseInt(options.timeout, 10)
				: 30000;

			const failures: BenchmarkResult['failures'] = [];
			const allResults: BenchmarkTestResult[] = [];
			const categoryResults: Record<string, CategoryResult> = {};

			// Start llama-server once for the whole run — cold-starting per test
			// would multiply latency by N and cache the model from disk N times.
			const serverHandle = await startLlamaServer(modelPath, serverOptions);

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
					setCurrentTest(getTestDisplayPrompt(test));
					setProgress(((i + 1) / tests.length) * 100);

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
								const inferenceResult = await chatCompletion(
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
								// Timeout or other errors: treat this sample as failed and continue.
								// This ensures partial results aren't thrown away when one sample
								// times out in a multi-sample run.
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
								// For multi-turn tests, include conversation context in the judge prompt
								const judgePrompt = test.messages
									? formatConversationForJudge(test.messages, contextMsg)
									: (test.prompt as string);
								// The judge decides pass/fail, so a provider that stalls hangs
								// the run exactly as a stalled generation would — and the
								// inference timer above has already been cleared by the time we
								// reach here. Give judging its own budget rather than extending
								// that one: this is a second call, and a slow-but-fine generation
								// must not eat the time the judge needs and flip a pass to a fail.
								const judgeController = new AbortController();
								const judgeTimeoutId = setTimeout(() => {
									judgeController.abort();
								}, timeout);
								try {
									const judgeResult = await callJudge(
										judgePrompt,
										sampleResponse.trim(),
										criteria,
										judgeConfig,
										threshold,
										test.acceptable,
										judgeController.signal,
									);
									samplePassed = judgeResult.pass;
									if (sample === 0) {
										judgeScore = judgeResult.score;
										judgeReasoning = judgeResult.reasoning;
										judgeCriteriaScores = judgeResult.criteriaScores;
									}
								} catch (err) {
									// A judge that never answered is not a verdict. Fail the
									// sample and move on — the same way an inference timeout is
									// handled above — and leave judgeScore unset so the report
									// says why rather than reading as the model scoring 0.
									samplePassed = false;
									if (sample === 0) {
										judgeReasoning = judgeController.signal.aborted
											? `Judge timed out after ${timeout}ms`
											: `Judge call failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
									}
								} finally {
									clearTimeout(judgeTimeoutId);
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

					setCategories({...categoryResults});
				}
			} finally {
				await stopLlamaServer(serverHandle);
			}

			if (abortReason && allResults.length === 0) {
				// Nothing ran, so there is no partial report worth writing.
				setError(abortReason);
				setStatus('error');
				return;
			}
			setWarning(abortReason);

			// Calculate final results
			const totalPassed = Object.values(categoryResults).reduce(
				(sum, c) => sum + c.passed,
				0,
			);
			// Not `tests.length` — an aborted run must score against what it
			// actually ran, or the pass rate reads as a catastrophic regression.
			const totalTests = allResults.length;

			// Calculate average latency (excluding errors/timeouts)
			const validLatencies = allResults
				.filter(r => r.latencyMs && !r.actual.startsWith('Error:'))
				.map(r => r.latencyMs as number);
			const avgLatencyMs =
				validLatencies.length > 0
					? Math.round(
							validLatencies.reduce((a, b) => a + b, 0) / validLatencies.length,
						)
					: undefined;

			// Calculate average tokens per second
			const validTps = allResults
				.filter(r => r.tokensPerSecond && !r.actual.startsWith('Error:'))
				.map(r => r.tokensPerSecond as number);
			const avgTokensPerSecond =
				validTps.length > 0
					? Math.round(
							(validTps.reduce((a, b) => a + b, 0) / validTps.length) * 100,
						) / 100
					: undefined;

			// Calculate average TTFT
			const validTtft = allResults
				.filter(r => r.ttftMs && !r.actual.startsWith('Error:'))
				.map(r => r.ttftMs as number);
			const avgTtftMs =
				validTtft.length > 0
					? Math.round(validTtft.reduce((a, b) => a + b, 0) / validTtft.length)
					: undefined;

			// Calculate average judge score (for llm-judge tests only)
			const judgeResults = allResults.filter(r => r.judgeScore !== undefined);
			const avgJudgeScore =
				judgeResults.length > 0
					? Math.round(
							(judgeResults.reduce((sum, r) => sum + (r.judgeScore ?? 0), 0) /
								judgeResults.length) *
								10,
						) / 10
					: undefined;

			const finalResult: BenchmarkResult = {
				model: modelPath,
				timestamp: new Date().toISOString(),
				config: {
					temperature: sampling.temperature,
					seed: sampling.seed,
					samples: sampling.samples,
				},
				isBase: Boolean(options.base),
				summary: {
					total: totalTests,
					passed: totalPassed,
					failed: totalTests - totalPassed,
					passRate: totalPassed / totalTests,
					avgLatencyMs,
					avgTokensPerSecond,
					avgTtftMs,
					avgJudgeScore,
					judgeModel: judgeConfig?.model,
				},
				categories: categoryResults,
				results: allResults,
				failures,
			};

			// Save detailed JSON results
			const resultFilename = `benchmark-${new Date()
				.toISOString()
				.replace(/[:.]/g, '-')}.json`;
			const resultPath = join(benchmarksDir, resultFilename);
			writeFileAtomic(resultPath, JSON.stringify(finalResult, null, 2));

			// Save human-readable markdown report
			const reportFilename = resultFilename.replace('.json', '.md');
			const reportPath = join(benchmarksDir, reportFilename);
			const report = generateMarkdownReport(finalResult, contextMsg);
			writeFileAtomic(reportPath, report);

			setResults(finalResult);
			setStatus('done');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Benchmark failed');
			setStatus('error');
		}
	}, [
		options.model,
		options.base,
		options.dataset,
		options.timeout,
		options.preset,
		options.threads,
		options.gpuLayers,
		options.ctxSize,
		options.batchSize,
		options.cpuOnly,
		options.maxTokens,
		options.temperature,
		options.seed,
		options.samples,
	]);

	useEffect(() => {
		run();
	}, [run]);

	if (!configExists()) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Benchmark" />
				<StatusMessage variant="error">
					Not a Nanotune project. Run `nanotune init` first.
				</StatusMessage>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1}>
			<Header title="Benchmark" />

			{status === 'loading' && (
				<Spinner label={prepStep ?? 'Loading benchmark data...'} />
			)}

			{status === 'running' && (
				<Box flexDirection="column">
					<Progress percent={progress} label="Progress" />
					<Text> </Text>
					<Text>
						Running: <Text color="yellow">{currentTest}</Text>
					</Text>
					<Text> </Text>

					<Text bold>Results:</Text>
					{Object.entries(categories).map(([name, result]) => (
						<Box key={name}>
							<StatusBadge
								status={result.passed === result.total ? 'success' : 'warning'}
							/>
							<Text>
								{' '}
								{name}: {result.passed}/{result.total} (
								{Math.round((result.passed / result.total) * 100)}%)
							</Text>
						</Box>
					))}
				</Box>
			)}

			{status === 'done' && results && (
				<Box flexDirection="column">
					<Box
						flexDirection="column"
						borderStyle="double"
						paddingX={2}
						paddingY={1}
					>
						<Text bold>BENCHMARK COMPLETE</Text>
					</Box>

					<Text> </Text>
					{warning && (
						<StatusMessage variant="warning">{warning}</StatusMessage>
					)}
					<Text>
						Model: <Text color="cyan">{results.model.split('/').pop()}</Text>
						{results.isBase && <Text dimColor> (base model, control)</Text>}
					</Text>
					<Text>
						Score:{' '}
						<Text
							color={results.summary.passRate >= 0.9 ? 'green' : 'yellow'}
							bold
						>
							{results.summary.passed}/{results.summary.total} (
							{Math.round(results.summary.passRate * 100)}%)
						</Text>
					</Text>
					{results.summary.avgLatencyMs !== undefined && (
						<Text>
							Avg Latency: <Text bold>{results.summary.avgLatencyMs}ms</Text>
						</Text>
					)}
					{results.summary.avgTokensPerSecond !== undefined && (
						<Text>
							Avg Tokens/sec:{' '}
							<Text bold>{results.summary.avgTokensPerSecond.toFixed(2)}</Text>
						</Text>
					)}
					{results.summary.avgTtftMs !== undefined && (
						<Text>
							Avg TTFT: <Text bold>{results.summary.avgTtftMs}ms</Text>
						</Text>
					)}
					{results.summary.avgJudgeScore !== undefined && (
						<Text>
							Judge Score:{' '}
							<Text
								color={results.summary.avgJudgeScore >= 7 ? 'green' : 'yellow'}
								bold
							>
								{results.summary.avgJudgeScore}/10
							</Text>
							{results.summary.judgeModel && (
								<Text dimColor> ({results.summary.judgeModel})</Text>
							)}
						</Text>
					)}

					<Text> </Text>
					<Text bold>By Category:</Text>
					{Object.entries(results.categories).map(([name, result]) => {
						const percent = Math.round((result.passed / result.total) * 100);
						const barWidth = 20;
						const filled = Math.round((percent / 100) * barWidth);
						const bar =
							'\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);

						return (
							<Box key={name}>
								<Box width={12}>
									<Text>{name}:</Text>
								</Box>
								<Box width={8}>
									<Text>
										{result.passed}/{result.total}
									</Text>
								</Box>
								<Text color={percent >= 90 ? 'green' : 'yellow'}>{bar}</Text>
								<Text> {percent}%</Text>
							</Box>
						);
					})}

					{results.failures.length > 0 && (
						<Box flexDirection="column" marginTop={1}>
							<Text bold color="red">
								Failed Tests:
							</Text>
							{results.failures.slice(0, 5).map(f => (
								<Box key={f.id} flexDirection="column" marginLeft={1}>
									<Text>
										[{f.id}] {f.prompt}
									</Text>
									<Text dimColor>Expected: {f.expected.join(' | ')}</Text>
									<Text dimColor>Actual: {f.actual}</Text>
								</Box>
							))}
							{results.failures.length > 5 && (
								<Text dimColor>
									... and {results.failures.length - 5} more failures
								</Text>
							)}
						</Box>
					)}

					<Text> </Text>
					<ExitHint>Press any key to exit</ExitHint>
				</Box>
			)}

			{status === 'error' && (
				<Box flexDirection="column">
					<StatusMessage variant="error">{error}</StatusMessage>
					<Text> </Text>
					<ExitHint>Press any key to exit</ExitHint>
				</Box>
			)}
		</Box>
	);
}
