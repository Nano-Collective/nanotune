import {Box, Text} from 'ink';

interface ProgressProps {
	percent: number;
	width?: number;
	label?: string;
}

export function Progress({percent, width = 30, label}: ProgressProps) {
	const clampedPercent = Math.min(100, Math.max(0, percent));
	const filled = Math.floor((clampedPercent / 100) * width);
	const empty = width - filled;

	const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

	return (
		<Box>
			{label && <Text>{label}: </Text>}
			<Text color="green">{bar}</Text>
			<Text> {clampedPercent.toFixed(0)}%</Text>
		</Box>
	);
}
