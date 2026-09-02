import {StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp} from 'ink';
import {
	ExitHint,
	Header,
	StatusBadge,
	useAutoExit,
	useKeyInput,
} from '../../components/index.js';
import {resolveContextMessage, tryLoadConfig} from '../../lib/config.js';
import {
	type ContextFixResult,
	countExamples,
	type DedupeResult,
	dedupeExamples,
	fixContextMessages,
	parseTrainingData,
	validateTrainingData,
} from '../../lib/data.js';

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
	const {config, error: configError} = tryLoadConfig();

	useKeyInput((input, key) => {
		if (key.escape || input === 'q' || key.return) {
			exit();
		}
	});

	const setName = isEval ? 'Validation data' : 'Training data';
	const title = isEval ? 'Validate Validation Data' : 'Validate Training Data';

	// Both fixes rewrite the whole file, so neither may run on data we could
	// not fully parse: they would drop the malformed lines rather than let the
	// report point at them.
	const parseErrors = config ? parseTrainingData(isEval).errors : [];

	let dedupeResult: DedupeResult | null = null;
	let contextFixResult: ContextFixResult | null = null;
	if (config && parseErrors.length === 0) {
		// Rewrite context first: examples that only become identical after
		// context normalization must still be caught by dedupe in this pass.
		if (rewriteContext) {
			contextFixResult = fixContextMessages(
				resolveContextMessage(config),
				isEval,
			);
		}
		if (fix) {
			dedupeResult = dedupeExamples(isEval);
		}
	}

	// Re-validate after fixes are applied so the report reflects the data
	// actually left on disk.
	const count = config ? countExamples(isEval) : 0;
	const result = config
		? validateTrainingData(resolveContextMessage(config), isEval)
		: null;

	// Report is fully rendered on first pass — without a keyboard there is
	// nothing to wait for. Invalid data exits non-zero so CI can gate on it.
	useAutoExit(true, !config || !result?.valid);

	if (!config || !result) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title={title} />
				<StatusMessage variant="error">{configError}</StatusMessage>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1}>
			<Header title={title} />

			<Box marginBottom={1}>
				<Text>Examples: </Text>
				<Text color="cyan" bold>
					{count}
				</Text>
			</Box>

			{(dedupeResult || contextFixResult) && (
				<Box flexDirection="column" marginBottom={1}>
					<Text bold>Fixes applied:</Text>
					{dedupeResult && (
						<Box>
							<StatusBadge
								status={dedupeResult.removedCount > 0 ? 'success' : 'pending'}
							/>
							<Text>
								{' '}
								{dedupeResult.removedCount > 0
									? `Removed ${dedupeResult.removedCount} exact-duplicate example${dedupeResult.removedCount > 1 ? 's' : ''}`
									: 'No exact duplicates found'}
							</Text>
						</Box>
					)}
					{contextFixResult && (
						<Box>
							<StatusBadge
								status={contextFixResult.fixedCount > 0 ? 'success' : 'pending'}
							/>
							<Text>
								{' '}
								{contextFixResult.fixedCount > 0
									? `Rewrote context message on ${contextFixResult.fixedCount} example${contextFixResult.fixedCount > 1 ? 's' : ''}`
									: 'No context-message mismatches to rewrite'}
							</Text>
						</Box>
					)}
				</Box>
			)}

			{result.valid ? (
				<StatusMessage variant="success">{`${setName} is valid!`}</StatusMessage>
			) : (
				<StatusMessage variant="error">{`${setName} has errors`}</StatusMessage>
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
			<ExitHint>Press any key to exit</ExitHint>
		</Box>
	);
}
