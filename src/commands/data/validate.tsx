import {StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp, useInput} from 'ink';
import {Header, StatusBadge} from '../../components/index.js';
import {
	configExists,
	loadConfig,
	resolveContextMessage,
} from '../../lib/config.js';
import {countExamples, validateTrainingData} from '../../lib/data.js';

export function DataValidateCommand() {
	const {exit} = useApp();

	useInput((input, key) => {
		if (key.escape || input === 'q' || key.return) {
			exit();
		}
	});

	if (!configExists()) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Validate Training Data" />
				<StatusMessage variant="error">
					Not a Nanotune project. Run `nanotune init` first.
				</StatusMessage>
			</Box>
		);
	}

	const config = loadConfig();
	const count = countExamples();
	const result = validateTrainingData(resolveContextMessage(config));

	return (
		<Box flexDirection="column" padding={1}>
			<Header title="Validate Training Data" />

			<Box marginBottom={1}>
				<Text>Examples: </Text>
				<Text color="cyan" bold>
					{count}
				</Text>
			</Box>

			{result.valid ? (
				<StatusMessage variant="success">Training data is valid!</StatusMessage>
			) : (
				<StatusMessage variant="error">Training data has errors</StatusMessage>
			)}

			{result.errors.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold color="red">
						Errors:
					</Text>
					{result.errors.map((error, i) => (
						<Box key={i}>
							<StatusBadge status="error" />
							<Text> {error}</Text>
						</Box>
					))}
				</Box>
			)}

			{result.warnings.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold color="yellow">
						Warnings:
					</Text>
					{result.warnings.map((warning, i) => (
						<Box key={i}>
							<StatusBadge status="warning" />
							<Text> {warning}</Text>
						</Box>
					))}
				</Box>
			)}

			<Box flexDirection="column" marginTop={1}>
				<Text bold>Checks performed:</Text>
				<Box>
					<StatusBadge status={count > 0 ? 'success' : 'error'} />
					<Text> Data file exists</Text>
				</Box>
				<Box>
					<StatusBadge
						status={result.errors.length === 0 ? 'success' : 'error'}
					/>
					<Text> Valid JSON structure</Text>
				</Box>
				<Box>
					<StatusBadge
						status={
							!result.warnings.some(w => w.includes('context messages'))
								? 'success'
								: 'warning'
						}
					/>
					<Text> Context message consistency</Text>
				</Box>
				<Box>
					<StatusBadge
						status={
							!result.warnings.some(w => w.includes('duplicate'))
								? 'success'
								: 'warning'
						}
					/>
					<Text> No duplicate inputs</Text>
				</Box>
				<Box>
					<StatusBadge status={count >= 50 ? 'success' : 'warning'} />
					<Text> Minimum example count (50+)</Text>
				</Box>
			</Box>

			<Text> </Text>
			<Text dimColor>Press any key to exit</Text>
		</Box>
	);
}
