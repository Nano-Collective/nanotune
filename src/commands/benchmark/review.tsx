import {StatusMessage, TextInput} from '@inkjs/ui';
import {Box, Text, useApp} from 'ink';
import {useEffect, useState} from 'react';
import {
	ExitHint,
	Header,
	useAutoExit,
	useKeyInput,
} from '../../components/index.js';
import {
	configExists,
	findLatestBenchmark,
	loadBenchmark,
	loadConfig,
	resolveBenchmarkPath,
	resolveContextMessage,
} from '../../lib/config.js';
import {
	appendToTrainingData,
	appendTrainingExample,
	countExamples,
} from '../../lib/data.js';
import type {BenchmarkResult, ChatMessage} from '../../types/index.js';

interface Props {
	report?: string;
}

type Status = 'loading' | 'reviewing' | 'done' | 'error';
type Failure = BenchmarkResult['failures'][number];

export function BenchmarkReviewCommand({report}: Props) {
	const {exit} = useApp();
	const [status, setStatus] = useState<Status>('loading');
	const [error, setError] = useState<string | null>(null);
	const [reportName, setReportName] = useState('');
	const [contextMessage, setContextMessage] = useState<ChatMessage | null>(
		null,
	);
	const [failures, setFailures] = useState<Failure[]>([]);
	const [index, setIndex] = useState(0);
	const [savedCount, setSavedCount] = useState(0);
	const [skippedCount, setSkippedCount] = useState(0);
	const [lastMessage, setLastMessage] = useState<string | null>(null);

	useAutoExit(status === 'done' || status === 'error', status === 'error');

	useEffect(() => {
		if (!configExists()) {
			setError('Not a Nanotune project. Run `nanotune init` first.');
			setStatus('error');
			return;
		}

		try {
			const path = report
				? resolveBenchmarkPath(report)
				: findLatestBenchmark();
			if (!path) {
				setError(
					'No saved benchmark runs found. Run `nanotune benchmark` first.',
				);
				setStatus('error');
				return;
			}

			const result = loadBenchmark(path);

			try {
				const config = loadConfig();
				setContextMessage(resolveContextMessage(config));
			} catch {
				// Minimal config (e.g., external benchmark runner) — examples are
				// saved without a context message, same as benchmark.tsx's run path.
			}

			setReportName(path.split(/[/\\]/).pop() ?? path);
			setFailures(result.failures);
			setStatus(result.failures.length === 0 ? 'done' : 'reviewing');
		} catch (err) {
			setError(
				err instanceof Error ? err.message : 'Could not load benchmark report',
			);
			setStatus('error');
		}
	}, [report]);

	useKeyInput((_input, key) => {
		if (status === 'reviewing') {
			if (key.escape) {
				setStatus('done');
			}
			return;
		}
		if (key.escape || key.return) {
			exit();
		}
	});

	const advance = () => {
		const next = index + 1;
		// Set both in the same event-handler pass (rather than nesting setStatus
		// inside setIndex's updater) so the two updates land in one render — an
		// out-of-range index must never be visible while status still says
		// 'reviewing'.
		if (next >= failures.length) {
			setStatus('done');
		}
		setIndex(next);
	};

	const handleSubmit = (value: string) => {
		const current = failures[index];
		const corrected = value.trim();

		if (!corrected) {
			setSkippedCount(c => c + 1);
			setLastMessage(null);
			advance();
			return;
		}

		try {
			if (current.messages && current.messages.length > 0) {
				const messages: ChatMessage[] = [
					...(contextMessage?.content ? [contextMessage] : []),
					...current.messages,
					{role: 'assistant', content: corrected},
				];
				appendTrainingExample({messages}, false);
			} else {
				appendToTrainingData(
					{
						contextMessage,
						userInput: current.prompt,
						assistantOutput: corrected,
					},
					false,
				);
			}
			setSavedCount(c => c + 1);
			setLastMessage(`Saved (${countExamples()} examples total).`);
		} catch (err) {
			setLastMessage(
				`Could not save: ${err instanceof Error ? err.message : 'write failed'}`,
			);
		}
		advance();
	};

	if (status === 'error') {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Benchmark Review" />
				<StatusMessage variant="error">{error}</StatusMessage>
				<Text> </Text>
				<ExitHint>Press any key to exit</ExitHint>
			</Box>
		);
	}

	if (status === 'loading') {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Benchmark Review" />
			</Box>
		);
	}

	if (status === 'done') {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Benchmark Review" subtitle={reportName} />
				{failures.length === 0 ? (
					<StatusMessage variant="success">
						No failed tests in this report — nothing to review.
					</StatusMessage>
				) : (
					<Text>
						Reviewed {savedCount + skippedCount}/{failures.length} failures —{' '}
						<Text color="green" bold>
							{savedCount} saved
						</Text>
						, <Text dimColor>{skippedCount} skipped</Text>.
					</Text>
				)}
				<Text> </Text>
				<ExitHint>Press any key to exit</ExitHint>
			</Box>
		);
	}

	// reviewing
	const current = failures[index];

	return (
		<Box flexDirection="column" padding={1}>
			<Header
				title="Benchmark Review"
				subtitle={`${reportName} • Failure ${index + 1}/${failures.length} (test #${current.id})`}
			/>

			{current.messages && current.messages.length > 0 ? (
				<Box flexDirection="column" marginBottom={1}>
					<Text bold>Conversation:</Text>
					{current.messages.map((msg, i) => (
						<Box key={`msg-${i}`}>
							<Text dimColor>{msg.role}: </Text>
							<Text>{msg.content}</Text>
						</Box>
					))}
				</Box>
			) : (
				<Box marginBottom={1}>
					<Text bold>Prompt: </Text>
					<Text>{current.prompt}</Text>
				</Box>
			)}

			{current.expected.length > 0 && (
				<Box flexDirection="column" marginBottom={1}>
					<Text bold>Expected (any of):</Text>
					{current.expected.map((exp, i) => (
						<Text key={`expected-${i}`} dimColor>
							- {exp}
						</Text>
					))}
				</Box>
			)}

			<Box flexDirection="column" marginBottom={1}>
				<Text bold color="red">
					Actual:
				</Text>
				<Text>{current.actual}</Text>
			</Box>

			{lastMessage && (
				<Box marginBottom={1}>
					<Text dimColor>{lastMessage}</Text>
				</Box>
			)}

			<Box>
				<Text color="yellow" bold>
					Corrected response:{' '}
				</Text>
				<TextInput
					key={index}
					onSubmit={handleSubmit}
					placeholder="Type the correct answer, or press Enter to skip"
				/>
			</Box>
			<Box marginTop={1}>
				<Text dimColor>
					[Enter] Save & next (blank = skip) [Esc] Stop reviewing
				</Text>
			</Box>
		</Box>
	);
}
