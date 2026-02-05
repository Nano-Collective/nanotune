import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Spinner, StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp, useInput} from 'ink';
import {useCallback, useEffect, useState} from 'react';
import {Header, Progress, StatusBadge} from '../components/index.js';
import {
	configExists,
	getBenchmarksDir,
	getModelsDir,
	loadConfig,
} from '../lib/config.js';
import {runGGUFInference} from '../lib/llama-cpp.js';
import type {
	BenchmarkResult,
	BenchmarkTest,
	BenchmarkTestResult,
	MatchMode,
} from '../types/index.js';

interface Props {
	options: {
		model?: string;
		dataset?: string;
		timeout?: string;
	};
}

type Status = 'loading' | 'running' | 'done' | 'error';

interface CategoryResult {
	passed: number;
	total: number;
}

/**
 * Normalize text for comparison
 * - Trim whitespace
 * - Normalize multiple spaces/newlines to single space
 * - Normalize quotes
 */
function normalizeText(text: string): string {
	return text.trim().replace(/\s+/g, ' ').replace(/["'`]/g, '"');
}

/**
 * Check if actual response matches any acceptable answer
 *
 * Match modes:
 * - "exact": Must match exactly (after optional normalization)
 * - "contains": Response contains the acceptable answer anywhere
 * - "startsWith": Response starts with the acceptable answer
 * - "semantic": Normalized comparison with prefix matching (default, good for code)
 */
function checkPass(
	acceptable: string[],
	actual: string,
	mode: MatchMode = 'semantic',
	caseSensitive = false,
): {passed: boolean; matchedAnswer: string | null; matchType: string | null} {
	const processText = (text: string) => {
		let processed = text.trim();
		if (!caseSensitive) {
			processed = processed.toLowerCase();
		}
		return processed;
	};

	const actualProcessed = processText(actual);
	const actualNormalized = normalizeText(actualProcessed);

	for (const expected of acceptable) {
		const expectedProcessed = processText(expected);
		const expectedNormalized = normalizeText(expectedProcessed);

		switch (mode) {
			case 'exact': {
				// Strict exact match (only case normalization if enabled)
				if (actualProcessed === expectedProcessed) {
					return {passed: true, matchedAnswer: expected, matchType: 'exact'};
				}
				break;
			}

			case 'contains': {
				// Response contains the acceptable answer anywhere
				if (actualNormalized.includes(expectedNormalized)) {
					return {passed: true, matchedAnswer: expected, matchType: 'contains'};
				}
				break;
			}

			case 'startsWith': {
				// Response starts with the acceptable answer
				if (actualNormalized.startsWith(expectedNormalized)) {
					return {
						passed: true,
						matchedAnswer: expected,
						matchType: 'startsWith',
					};
				}
				break;
			}

			case 'semantic':
			default: {
				// Normalized comparison with multiple match strategies

				// 1. Exact match after normalization
				if (actualNormalized === expectedNormalized) {
					return {passed: true, matchedAnswer: expected, matchType: 'exact'};
				}

				// 2. Starts with (for responses with extra content)
				if (
					actualNormalized.startsWith(expectedNormalized + ' ') ||
					actualNormalized.startsWith(expectedNormalized + ':') ||
					actualNormalized.startsWith(expectedNormalized + '\n')
				) {
					return {
						passed: true,
						matchedAnswer: expected,
						matchType: 'startsWith',
					};
				}

				// 3. Expected starts with actual (actual is subset of expected)
				if (
					expectedNormalized.startsWith(actualNormalized + ' ') ||
					expectedNormalized.startsWith(actualNormalized)
				) {
					return {passed: true, matchedAnswer: expected, matchType: 'partial'};
				}

				break;
			}
		}
	}

	return {passed: false, matchedAnswer: null, matchType: null};
}

function generateMarkdownReport(
	result: BenchmarkResult,
	systemPrompt: string,
): string {
	const lines: string[] = [];

	lines.push('# Benchmark Report');
	lines.push('');
	lines.push(`**Date:** ${new Date(result.timestamp).toLocaleString()}`);
	lines.push(`**Model:** ${result.model.split('/').pop()}`);
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

	// System prompt used
	lines.push('## System Prompt');
	lines.push('');
	lines.push('```');
	lines.push(systemPrompt);
	lines.push('```');
	lines.push('');

	// Detailed results
	lines.push('## Detailed Results');
	lines.push('');

	for (const testResult of result.results) {
		const status = testResult.passed ? '✅' : '❌';
		lines.push(`### ${status} Test #${testResult.id}: ${testResult.prompt}`);
		lines.push('');
		lines.push(`**Category:** ${testResult.category}`);
		if (testResult.latencyMs) {
			lines.push(`**Latency:** ${testResult.latencyMs}ms`);
		}
		lines.push('');
		lines.push('**Expected (any of):**');
		for (const expected of testResult.expected) {
			lines.push(`- \`${expected}\``);
		}
		lines.push('');
		lines.push('**Model Response:**');
		lines.push('```');
		lines.push(testResult.actual);
		lines.push('```');
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
			lines.push(`| ${f.id} | ${f.prompt} | ${expected} | ${actual} |`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

export function BenchmarkCommand({options}: Props) {
	const {exit} = useApp();
	const [status, setStatus] = useState<Status>('loading');
	const [error, setError] = useState<string | null>(null);
	const [currentTest, setCurrentTest] = useState<string | null>(null);
	const [progress, setProgress] = useState(0);
	const [results, setResults] = useState<BenchmarkResult | null>(null);
	const [categories, setCategories] = useState<Record<string, CategoryResult>>(
		{},
	);

	useInput((_input, key) => {
		if (key.escape || key.return) {
			exit();
		}
	});

	const run = useCallback(async () => {
		try {
			// Check project exists
			if (!configExists()) {
				setError('Not a Nanotune project. Run `nanotune init` first.');
				setStatus('error');
				return;
			}

			const config = loadConfig();
			const modelsDir = getModelsDir();
			const benchmarksDir = getBenchmarksDir();

			// Find model
			let modelPath = options.model;
			if (!modelPath) {
				// Find latest GGUF file
				const ggufFiles = readdirSync(modelsDir).filter(f =>
					f.endsWith('.gguf'),
				);
				if (ggufFiles.length === 0) {
					setError('No exported models found. Run `nanotune export` first.');
					setStatus('error');
					return;
				}
				// Sort by modification time, newest first
				const sorted = ggufFiles
					.map(f => ({
						name: f,
						path: join(modelsDir, f),
					}))
					.sort((a, b) => {
						const {statSync} = require('node:fs');
						return statSync(b.path).mtimeMs - statSync(a.path).mtimeMs;
					});
				modelPath = sorted[0].path;
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
				writeFileSync(datasetPath, JSON.stringify(tests, null, 2));
				setError(
					`No benchmark dataset found. Created sample at ${datasetPath}`,
				);
				setStatus('error');
				return;
			}

			// Run benchmarks
			setStatus('running');
			const timeout = options.timeout
				? Number.parseInt(options.timeout, 10)
				: 30000;

			const failures: BenchmarkResult['failures'] = [];
			const allResults: BenchmarkTestResult[] = [];
			const categoryResults: Record<string, CategoryResult> = {};

			for (let i = 0; i < tests.length; i++) {
				const test = tests[i];
				setCurrentTest(test.prompt);
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

				try {
					// Build prompt with system message
					const fullPrompt = `${config.systemPrompt}\n\nUser: ${test.prompt}\n\nAssistant:`;

					response = await Promise.race([
						runGGUFInference(modelPath, fullPrompt, 50),
						new Promise<string>((_, reject) =>
							setTimeout(() => reject(new Error('Timeout')), timeout),
						),
					]);

					latencyMs = Date.now() - startTime;

					// Check if response matches any acceptable answer
					const matchResult = checkPass(
						test.acceptable,
						response.trim(),
						test.match || 'semantic',
						test.caseSensitive ?? false,
					);
					passed = matchResult.passed;

					if (passed) {
						categoryResults[test.category].passed++;
					} else {
						failures.push({
							id: test.id,
							prompt: test.prompt,
							expected: test.acceptable,
							actual: response.trim(),
						});
					}
				} catch (err) {
					latencyMs = Date.now() - startTime;
					response =
						err instanceof Error ? `Error: ${err.message}` : 'Unknown error';
					failures.push({
						id: test.id,
						prompt: test.prompt,
						expected: test.acceptable,
						actual: response,
					});
				}

				// Store full result for detailed report
				allResults.push({
					id: test.id,
					prompt: test.prompt,
					expected: test.acceptable,
					actual: response.trim(),
					passed,
					category: test.category,
					latencyMs,
				});

				setCategories({...categoryResults});
			}

			// Calculate final results
			const totalPassed = Object.values(categoryResults).reduce(
				(sum, c) => sum + c.passed,
				0,
			);
			const totalTests = tests.length;

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

			const finalResult: BenchmarkResult = {
				model: modelPath,
				timestamp: new Date().toISOString(),
				summary: {
					total: totalTests,
					passed: totalPassed,
					failed: totalTests - totalPassed,
					passRate: totalPassed / totalTests,
					avgLatencyMs,
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
			writeFileSync(resultPath, JSON.stringify(finalResult, null, 2));

			// Save human-readable markdown report
			const reportFilename = resultFilename.replace('.json', '.md');
			const reportPath = join(benchmarksDir, reportFilename);
			const report = generateMarkdownReport(finalResult, config.systemPrompt);
			writeFileSync(reportPath, report);

			setResults(finalResult);
			setStatus('done');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Benchmark failed');
			setStatus('error');
		}
	}, [options.model, options.dataset, options.timeout]);

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

			{status === 'loading' && <Spinner label="Loading benchmark data..." />}

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
					<Text>
						Model: <Text color="cyan">{results.model.split('/').pop()}</Text>
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
					<Text dimColor>Press any key to exit</Text>
				</Box>
			)}

			{status === 'error' && (
				<Box flexDirection="column">
					<StatusMessage variant="error">{error}</StatusMessage>
					<Text> </Text>
					<Text dimColor>Press any key to exit</Text>
				</Box>
			)}
		</Box>
	);
}
