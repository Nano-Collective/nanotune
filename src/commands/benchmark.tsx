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
import {
	type BenchmarkRunOptions,
	type CategoryResult,
	runBenchmark,
} from '../lib/benchmark-run.js';
import {configExists} from '../lib/config.js';
import type {BenchmarkResult} from '../types/index.js';

interface Props {
	options: BenchmarkRunOptions;
}

type Status = 'loading' | 'running' | 'done' | 'error';

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

	// The run itself lives in lib/benchmark-run.ts and is shared with
	// `--json`; this only translates its events into view state. Every failure
	// arrives as a throw, which is what the catch below turns into the error
	// frame.
	const run = useCallback(async () => {
		try {
			for await (const event of runBenchmark(options)) {
				switch (event.type) {
					case 'prep':
						setPrepStep(event.message);
						break;
					case 'test-start':
						setStatus('running');
						setCurrentTest(event.prompt);
						setProgress(((event.index + 1) / event.total) * 100);
						break;
					case 'test-end':
						setCategories(event.categories);
						break;
					case 'warning':
						setWarning(event.message);
						break;
					case 'done':
						setResults(event.result);
						setStatus('done');
						break;
				}
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Benchmark failed');
			setStatus('error');
		}
	}, [options]);
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
