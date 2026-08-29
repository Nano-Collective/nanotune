import {existsSync} from 'node:fs';
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
import {configExists} from '../../lib/config.js';
import {countExamples, type ExportResult, exportData} from '../../lib/data.js';

interface Props {
	file: string;
	/** Skip the overwrite confirmation — needed to run under CI or in a pipeline. */
	yes?: boolean;
	isEval?: boolean;
}

export function DataExportCommand({file, yes, isEval = false}: Props) {
	const {exit} = useApp();
	const filePath = resolve(process.cwd(), file);
	const fileExists = existsSync(filePath);
	const [status, setStatus] = useState<
		'confirm' | 'exporting' | 'done' | 'error'
	>(!fileExists || yes ? 'exporting' : 'confirm');
	const [result, setResult] = useState<ExportResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const count = configExists() ? countExamples(isEval) : 0;
	const title = isEval ? 'Export Validation Data' : 'Export Training Data';

	const doExport = useCallback(() => {
		try {
			if (!configExists()) {
				setError('Not a Nanotune project. Run `nanotune init` first.');
				setStatus('error');
				return;
			}

			const exportResult = exportData(filePath, isEval);
			if (
				exportResult.exported === 0 &&
				exportResult.errors[0]?.startsWith('Unsupported')
			) {
				setError(exportResult.errors[0]);
				setStatus('error');
				return;
			}

			setResult(exportResult);
			setStatus('done');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Export failed');
			setStatus('error');
		}
	}, [filePath, isEval]);

	useEffect(() => {
		if (status === 'exporting') {
			doExport();
		}
	}, [status, doExport]);

	useKeyInput(input => {
		if (status === 'confirm') {
			if (input.toLowerCase() === 'y') {
				setStatus('exporting');
			} else if (input.toLowerCase() === 'n' || input === '\x1b') {
				exit();
			}
		} else if (status === 'done' || status === 'error') {
			exit();
		}
	});

	useAutoExit(status === 'done' || status === 'error', status === 'error');

	if (!configExists()) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title={title} />
				<StatusMessage variant="error">
					Not a Nanotune project. Run `nanotune init` first.
				</StatusMessage>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1}>
			<Header title={title} />

			{status === 'confirm' && (
				<Box flexDirection="column">
					<Text>
						File: <Text color="cyan">{file}</Text>
					</Text>
					<Text>
						Examples: <Text color="cyan">{count}</Text>
					</Text>
					<Text> </Text>
					<Text color="yellow">File already exists.</Text>
					<Text>
						Overwrite it? <Text color="green">(y/n)</Text>
					</Text>
				</Box>
			)}

			{status === 'exporting' && <Spinner label="Exporting data..." />}

			{status === 'done' && result && (
				<Box flexDirection="column">
					<StatusMessage variant="success">Export complete!</StatusMessage>
					<Text> </Text>
					<Text>
						Exported: <Text color="green">{result.exported}</Text>
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
