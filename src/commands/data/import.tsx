import {resolve} from 'node:path';
import {Spinner, StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp, useInput} from 'ink';
import {useEffect, useState} from 'react';
import {Header} from '../../components/index.js';
import {configExists, loadConfig} from '../../lib/config.js';
import {
	type ImportResult,
	importData,
	loadTrainingData,
} from '../../lib/data.js';

interface Props {
	file: string;
}

export function DataImportCommand({file}: Props) {
	const {exit} = useApp();
	const [status, setStatus] = useState<
		'preview' | 'importing' | 'done' | 'error'
	>('preview');
	const [result, setResult] = useState<ImportResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [preview, setPreview] = useState<string[]>([]);

	useEffect(() => {
		// Load preview
		try {
			const existingData = loadTrainingData();
			const previewItems = existingData.slice(0, 3).map(ex => {
				const user = ex.messages.find(m => m.role === 'user');
				const assistant = ex.messages.find(m => m.role === 'assistant');
				return `${user?.content?.slice(0, 30) || '?'} -> ${assistant?.content?.slice(0, 30) || '?'}`;
			});
			setPreview(previewItems);
		} catch {
			// Ignore preview errors
		}
	}, []);

	useInput(input => {
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

	const doImport = async () => {
		try {
			if (!configExists()) {
				setError('Not a Nanotune project. Run `nanotune init` first.');
				setStatus('error');
				return;
			}

			const config = loadConfig();
			const filePath = resolve(process.cwd(), file);
			const importResult = importData(filePath, config.systemPrompt);

			setResult(importResult);
			setStatus('done');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Import failed');
			setStatus('error');
		}
	};

	if (!configExists()) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Import Training Data" />
				<StatusMessage variant="error">
					Not a Nanotune project. Run `nanotune init` first.
				</StatusMessage>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1}>
			<Header title="Import Training Data" />

			{status === 'preview' && (
				<Box flexDirection="column">
					<Text>
						File: <Text color="cyan">{file}</Text>
					</Text>
					<Text> </Text>

					{preview.length > 0 && (
						<Box flexDirection="column" marginBottom={1}>
							<Text bold>Preview of existing data:</Text>
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
					{result.errors.length > 0 && (
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
