import {StatusMessage} from '@inkjs/ui';
import {Box, Text} from 'ink';
import {useRef} from 'react';
import {Header, useAutoExit} from '../../components/index.js';
import {loadConfig} from '../../lib/config.js';
import {repairTrainingData} from '../../lib/data.js';
import type {DataRepairReport} from '../../lib/data-recovery.js';

export function DataRepairCommand({isEval = false}: {isEval?: boolean}) {
	const outcome = useRef<{
		report: DataRepairReport | null;
		error: string | null;
	} | null>(null);
	if (outcome.current === null) {
		try {
			loadConfig();
			outcome.current = {report: repairTrainingData(isEval), error: null};
		} catch (error) {
			outcome.current = {
				report: null,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
	const {report, error} = outcome.current;
	useAutoExit(true, error !== null);
	return (
		<Box flexDirection="column" padding={1}>
			<Header
				title={isEval ? 'Repair Validation Data' : 'Repair Training Data'}
			/>
			{error && <StatusMessage variant="error">{error}</StatusMessage>}
			{report && (
				<Box flexDirection="column">
					<StatusMessage variant="success">
						{report.quarantined > 0
							? `Quarantined ${report.quarantined} malformed ${report.quarantined === 1 ? 'row' : 'rows'}.`
							: 'No malformed rows found.'}
					</StatusMessage>
					<Text>Valid examples: {report.examples}</Text>
					{report.journalRecovered && (
						<Text>Recovered an interrupted append.</Text>
					)}
					{report.backupPath && (
						<Text>Original backup: {report.backupPath}</Text>
					)}
					{report.quarantinePath && (
						<Text>Quarantine: {report.quarantinePath}</Text>
					)}
				</Box>
			)}
		</Box>
	);
}
