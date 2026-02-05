import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp, useInput} from 'ink';
import {Header, StatusBadge} from '../components/index.js';
import {
	configExists,
	getAdaptersDir,
	getBenchmarksDir,
	getDataDir,
	getModelsDir,
	loadConfig,
} from '../lib/config.js';
import {countExamples} from '../lib/data.js';
import type {BenchmarkResult} from '../types/index.js';

function formatRelativeTime(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffSeconds = Math.floor(diffMs / 1000);
	const diffMinutes = Math.floor(diffSeconds / 60);
	const diffHours = Math.floor(diffMinutes / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
	if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
	if (diffMinutes > 0)
		return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
	return 'just now';
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function StatusCommand() {
	const {exit} = useApp();

	useInput((input, key) => {
		if (key.escape || key.return || input === 'q') {
			exit();
		}
	});

	if (!configExists()) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Project Status" />
				<StatusMessage variant="error">
					Not a Nanotune project. Run `nanotune init` first.
				</StatusMessage>
			</Box>
		);
	}

	const config = loadConfig();
	const dataDir = getDataDir();
	const adaptersDir = getAdaptersDir();
	const modelsDir = getModelsDir();
	const benchmarksDir = getBenchmarksDir();

	// Training data info
	const exampleCount = countExamples();
	const trainFile = join(dataDir, 'train.jsonl');
	const trainModified = existsSync(trainFile)
		? formatRelativeTime(statSync(trainFile).mtime)
		: null;

	// Training status
	const adapterFile = join(adaptersDir, 'adapters.safetensors');
	const hasTrained = existsSync(adapterFile);
	const trainedTime = hasTrained
		? formatRelativeTime(statSync(adapterFile).mtime)
		: null;

	// Exported models
	const models = existsSync(modelsDir)
		? readdirSync(modelsDir)
				.filter(f => f.endsWith('.gguf'))
				.map(f => {
					const path = join(modelsDir, f);
					const stats = statSync(path);
					return {
						name: f,
						size: formatFileSize(stats.size),
						modified: stats.mtime,
					};
				})
				.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		: [];

	// Latest benchmark
	let latestBenchmark: BenchmarkResult | null = null;
	if (existsSync(benchmarksDir)) {
		const benchmarkFiles = readdirSync(benchmarksDir)
			.filter(f => f.endsWith('.json') && f.startsWith('benchmark'))
			.sort()
			.reverse();

		if (benchmarkFiles.length > 0) {
			try {
				const content = readFileSync(
					join(benchmarksDir, benchmarkFiles[0]),
					'utf-8',
				);
				latestBenchmark = JSON.parse(content);
			} catch {
				// Ignore parse errors
			}
		}
	}

	return (
		<Box flexDirection="column" padding={1}>
			<Header title="Project Status" />

			<Box
				flexDirection="column"
				borderStyle="single"
				paddingX={2}
				paddingY={1}
			>
				<Text>
					Project:{' '}
					<Text color="cyan" bold>
						{config.name}
					</Text>
				</Text>
				<Text>
					Base Model: <Text color="cyan">{config.baseModel}</Text>
				</Text>

				<Text> </Text>
				<Text bold>Training Data:</Text>
				<Text>
					{'  '}Examples: <Text color="cyan">{exampleCount}</Text>
				</Text>
				{trainModified && (
					<Text dimColor>
						{'  '}Last Modified: {trainModified}
					</Text>
				)}

				<Text> </Text>
				<Text bold>Training:</Text>
				<Box>
					<Text>{'  '}Status: </Text>
					{hasTrained ? (
						<StatusBadge status="success" label="Completed" />
					) : (
						<StatusBadge status="pending" label="Not started" />
					)}
				</Box>
				{trainedTime && (
					<Text dimColor>
						{'  '}Last Run: {trainedTime}
					</Text>
				)}

				<Text> </Text>
				<Text bold>Exports:</Text>
				{models.length > 0 ? (
					models.map((model, i) => (
						<Text key={model.name}>
							{'  '}
							<Text color={i === 0 ? 'cyan' : undefined}>{model.name}</Text>
							<Text dimColor> ({model.size})</Text>
							{i === 0 && <Text color="yellow"> {'<-'} latest</Text>}
						</Text>
					))
				) : (
					<Text dimColor>{'  '}No exported models yet</Text>
				)}

				<Text> </Text>
				<Text bold>Benchmarks:</Text>
				{latestBenchmark ? (
					<Box>
						<Text>{'  '}Latest: </Text>
						<Text
							color={
								latestBenchmark.summary.passRate >= 0.9 ? 'green' : 'yellow'
							}
						>
							{latestBenchmark.summary.passed}/{latestBenchmark.summary.total} (
							{Math.round(latestBenchmark.summary.passRate * 100)}%)
						</Text>
						<Text dimColor>
							{' '}
							- {new Date(latestBenchmark.timestamp).toLocaleDateString()}
						</Text>
					</Box>
				) : (
					<Text dimColor>{'  '}No benchmarks run yet</Text>
				)}
			</Box>

			<Text> </Text>
			<Text dimColor>Press any key to exit</Text>
		</Box>
	);
}
