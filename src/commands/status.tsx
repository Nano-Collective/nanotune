import {StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp} from 'ink';
import {
	ExitHint,
	Header,
	StatusBadge,
	useAutoExit,
	useKeyInput,
} from '../components/index.js';
import {configExists} from '../lib/config.js';
import {collectStatus} from '../lib/status.js';

function formatRelativeTime(iso: string): string {
	const now = new Date();
	const diffMs = now.getTime() - new Date(iso).getTime();
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
	const hasConfig = configExists();

	useKeyInput((input, key) => {
		if (key.escape || key.return || input === 'q') {
			exit();
		}
	});

	// Nothing to wait for without a keyboard — render the report and leave.
	useAutoExit(true, !hasConfig);

	if (!hasConfig) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Project Status" />
				<StatusMessage variant="error">
					Not a Nanotune project. Run `nanotune init` first.
				</StatusMessage>
			</Box>
		);
	}

	// Same report `nanotune status --json` prints, so the two views cannot
	// drift; only the formatting below is this component's own.
	const report = collectStatus();
	const latestBenchmark = report.benchmarks.latest;

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
						{report.project.name}
					</Text>
				</Text>
				<Text>
					Base Model: <Text color="cyan">{report.project.baseModel}</Text>
				</Text>

				<Text> </Text>
				<Text bold>Training Data:</Text>
				<Text>
					{'  '}Training Examples:{' '}
					<Text color="cyan">{report.data.trainExamples}</Text>
				</Text>
				<Text>
					{'  '}Validation Examples:{' '}
					<Text color="cyan">{report.data.validExamples}</Text>
				</Text>
				{report.data.trainLastModified && (
					<Text dimColor>
						{'  '}Last Modified:{' '}
						{formatRelativeTime(report.data.trainLastModified)}
					</Text>
				)}

				<Text> </Text>
				<Text bold>Training:</Text>
				<Box>
					<Text>{'  '}Status: </Text>
					{report.training.hasTrained ? (
						<StatusBadge status="success" label="Completed" />
					) : (
						<StatusBadge status="pending" label="Not started" />
					)}
				</Box>
				{report.training.lastRun && (
					<Text dimColor>
						{'  '}Last Run: {formatRelativeTime(report.training.lastRun)}
					</Text>
				)}

				<Text> </Text>
				<Text bold>Exports:</Text>
				{report.exports.length > 0 ? (
					report.exports.map((model, i) => (
						<Text key={model.name}>
							{'  '}
							<Text color={i === 0 ? 'cyan' : undefined}>{model.name}</Text>
							<Text dimColor> ({formatFileSize(model.sizeBytes)})</Text>
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
						<Text color={latestBenchmark.passRate >= 0.9 ? 'green' : 'yellow'}>
							{latestBenchmark.passed}/{latestBenchmark.total} (
							{Math.round(latestBenchmark.passRate * 100)}%)
						</Text>
						{latestBenchmark.isBase && (
							<Text dimColor> (base model, control)</Text>
						)}
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
			<ExitHint>Press any key to exit</ExitHint>
		</Box>
	);
}
