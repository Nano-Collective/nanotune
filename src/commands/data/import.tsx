import {resolve} from 'node:path';
import {Spinner, StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp} from 'ink';
import {useCallback, useEffect, useState} from 'react';
import {
	ExitHint,
	Header,
	useAutoExit,
	useKeyInput,
} from '../../components/index.js';
import {
	configExists,
	loadConfig,
	resolveContextMessage,
} from '../../lib/config.js';
import {
	countTurns,
	describeEmptyImport,
	type ImportResult,
	importData,
	loadTrainingData,
} from '../../lib/data.js';

interface Props {
	file: string;
	/** Skip the y/n confirmation — needed to run under CI or in a pipeline. */
	yes?: boolean;
	isEval?: boolean;
	/**
	 * Treat a CSV file's first row as data, never as a header — needed when
	 * that row is genuinely "input","output" rather than a header.
	 */
	headerless?: boolean;
}

export function DataImportCommand({
	file,
	yes,
	isEval = false,
	headerless = false,
}: Props) {
	const {exit} = useApp();
	const [status, setStatus] = useState<
		'preview' | 'importing' | 'done' | 'error'
	>(yes ? 'importing' : 'preview');
	const [result, setResult] = useState<ImportResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [preview, setPreview] = useState<string[]>([]);

	useEffect(() => {
		// Load preview
		try {
			const existingData = loadTrainingData(isEval);
			const previewItems = existingData.slice(0, 3).map(ex => {
				const user = ex.messages.find(m => m.role === 'user');
				const assistant = ex.messages.find(m => m.role === 'assistant');
				const turns = countTurns(ex);
				const turnsLabel = turns > 1 ? ` (${turns} turns)` : '';
				return `${user?.content?.slice(0, 30) || '?'} -> ${assistant?.content?.slice(0, 30) || '?'}${turnsLabel}`;
			});
			setPreview(previewItems);
		} catch {
			// Ignore preview errors
		}
	}, [isEval]);

	const doImport = useCallback(() => {
		try {
			if (!configExists()) {
				setError('Not a Nanotune project. Run `nanotune init` first.');
				setStatus('error');
				return;
			}

			const config = loadConfig();
			const filePath = resolve(process.cwd(), file);
			const importResult = importData(
				filePath,
				resolveContextMessage(config),
				isEval,
				{headerless},
			);

			setResult(importResult);
			// An import that brought nothing in is a failure, not a success with
			// a footnote: nothing changed, and the exit code has to say so.
			const failure = describeEmptyImport(importResult, file);
			if (failure) {
				setError(failure);
				setStatus('error');
				return;
			}
			setStatus('done');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Import failed');
			setStatus('error');
		}
	}, [file, isEval, headerless]);

	// `--yes` skips straight past the confirmation prompt.
	useEffect(() => {
		if (yes) {
			doImport();
		}
	}, [yes, doImport]);

	useKeyInput(input => {
		if (status === 'preview') {
			if (input.toLowerCase() === 'y') {
				setStatus('importing');
				doImport();
			} else if (input.toLowerCase() === 'n' || input === '\x1b') {
				exit();
			}
		} else if (status === 'done' || status === 'error') {
			exit();
		}
	});

	useAutoExit(status === 'done' || status === 'error', status === 'error');

	// Per-row problems, shown after a partial import and under the failure
	// message when every row was rejected.
	const warnings =
		result && result.errors.length > 0 ? (
			<Box flexDirection="column" marginTop={1}>
				<Text color="yellow">Warnings:</Text>
				{result.errors.slice(0, 5).map((e, i) => (
					<Text key={i} dimColor>
						- {e}
					</Text>
				))}
				{result.errors.length > 5 && (
					<Text dimColor>... and {result.errors.length - 5} more</Text>
				)}
			</Box>
		) : null;

	if (!configExists()) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header
					title={isEval ? 'Import Validation Data' : 'Import Training Data'}
				/>
				<StatusMessage variant="error">
					Not a Nanotune project. Run `nanotune init` first.
				</StatusMessage>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1}>
			<Header
				title={isEval ? 'Import Validation Data' : 'Import Training Data'}
			/>

			{status === 'preview' && (
				<Box flexDirection="column">
					<Text>
						File: <Text color="cyan">{file}</Text>
					</Text>
					<Text> </Text>

					{preview.length > 0 && (
						<Box flexDirection="column" marginBottom={1}>
							<Text bold>
								Preview of existing {isEval ? 'validation' : 'training'} data:
							</Text>
							{preview.map((p, i) => (
								<Text key={i} dimColor>
									{p}
								</Text>
							))}
						</Box>
					)}

					<Text>
						Import data from this file? <Text color="green">(y/n)</Text>
					</Text>
				</Box>
			)}

			{status === 'importing' && <Spinner label="Importing data..." />}

			{status === 'done' && result && (
				<Box flexDirection="column">
					<StatusMessage variant="success">Import complete!</StatusMessage>
					<Text> </Text>
					<Text>
						Imported: <Text color="green">{result.imported}</Text>
					</Text>
					{result.skipped > 0 && (
						<Text>
							Skipped: <Text color="yellow">{result.skipped}</Text>
						</Text>
					)}
					{warnings}
					<Text> </Text>
					<ExitHint>Press any key to exit</ExitHint>
				</Box>
			)}

			{status === 'error' && (
				<Box flexDirection="column">
					<StatusMessage variant="error">{error}</StatusMessage>
					{result && result.skipped > 0 && warnings}
					<Text> </Text>
					<ExitHint>Press any key to exit</ExitHint>
				</Box>
			)}
		</Box>
	);
}
