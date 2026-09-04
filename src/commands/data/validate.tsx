import {StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp} from 'ink';
import {
	ExitHint,
	Header,
	StatusBadge,
	useAutoExit,
	useKeyInput,
} from '../../components/index.js';
import {configExists} from '../../lib/config.js';
import {collectValidation} from '../../lib/data.js';

interface Props {
	fix?: boolean;
	rewriteContext?: boolean;
	isEval?: boolean;
}

export function DataValidateCommand({
	fix,
	rewriteContext,
	isEval = false,
}: Props) {
	const {exit} = useApp();
	const hasConfig = configExists();

	useKeyInput((input, key) => {
		if (key.escape || input === 'q' || key.return) {
			exit();
		}
	});

	const setName = isEval ? 'Validation data' : 'Training data';
	const title = isEval ? 'Validate Validation Data' : 'Validate Training Data';

	// Same report `nanotune data validate --json` prints — fixes are applied
	// and the data re-read inside, so this reflects what is left on disk.
	const report = hasConfig
		? collectValidation({fix, rewriteContext, isEval})
		: null;

	// Report is fully rendered on first pass — without a keyboard there is
	// nothing to wait for. Invalid data exits non-zero so CI can gate on it.
	useAutoExit(true, !hasConfig || !report?.valid);

	if (!hasConfig || !report) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title={title} />
				<StatusMessage variant="error">
					Not a Nanotune project. Run `nanotune init` first.
				</StatusMessage>
			</Box>
		);
	}

	const {checks, fixes} = report;

	return (
		<Box flexDirection="column" padding={1}>
			<Header title={title} />

			<Box marginBottom={1}>
				<Text>Examples: </Text>
				<Text color="cyan" bold>
					{report.examples}
				</Text>
			</Box>

			{fixes && (
				<Box flexDirection="column" marginBottom={1}>
					<Text bold>Fixes applied:</Text>
					{fix && (
						<Box>
							<StatusBadge
								status={fixes.duplicatesRemoved > 0 ? 'success' : 'pending'}
							/>
							<Text>
								{' '}
								{fixes.duplicatesRemoved > 0
									? `Removed ${fixes.duplicatesRemoved} exact-duplicate example${fixes.duplicatesRemoved > 1 ? 's' : ''}`
									: 'No exact duplicates found'}
							</Text>
						</Box>
					)}
					{rewriteContext && (
						<Box>
							<StatusBadge
								status={
									fixes.contextMessagesRewritten > 0 ? 'success' : 'pending'
								}
							/>
							<Text>
								{' '}
								{fixes.contextMessagesRewritten > 0
									? `Rewrote context message on ${fixes.contextMessagesRewritten} example${fixes.contextMessagesRewritten > 1 ? 's' : ''}`
									: 'No context-message mismatches to rewrite'}
							</Text>
						</Box>
					)}
				</Box>
			)}

			{report.valid ? (
				<StatusMessage variant="success">{`${setName} is valid!`}</StatusMessage>
			) : (
				<StatusMessage variant="error">{`${setName} has errors`}</StatusMessage>
			)}

			{report.errors.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold color="red">
						Errors:
					</Text>
					{report.errors.map((error, i) => (
						<Box key={i}>
							<StatusBadge status="error" />
							<Text> {error}</Text>
						</Box>
					))}
				</Box>
			)}

			{report.warnings.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold color="yellow">
						Warnings:
					</Text>
					{report.warnings.map((warning, i) => (
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
					<StatusBadge status={checks.dataFileExists ? 'success' : 'error'} />
					<Text> Data file exists</Text>
				</Box>
				<Box>
					<StatusBadge
						status={checks.validJsonStructure ? 'success' : 'error'}
					/>
					<Text> Valid JSON structure</Text>
				</Box>
				<Box>
					<StatusBadge
						status={checks.contextMessageConsistency ? 'success' : 'warning'}
					/>
					<Text> Context message consistency</Text>
				</Box>
				<Box>
					<StatusBadge
						status={checks.noDuplicateInputs ? 'success' : 'warning'}
					/>
					<Text> No duplicate inputs</Text>
				</Box>
				<Box>
					<StatusBadge
						status={checks.minimumExampleCount ? 'success' : 'warning'}
					/>
					<Text> Minimum example count (50+)</Text>
				</Box>
			</Box>

			<Text> </Text>
			<ExitHint>Press any key to exit</ExitHint>
		</Box>
	);
}
