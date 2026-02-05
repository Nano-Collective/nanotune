import {Box, Text} from 'ink';

interface LossChartProps {
	data: number[];
	width?: number;
	height?: number;
	label?: string;
}

export function LossChart({
	data,
	width = 40,
	height = 8,
	label = 'Loss',
}: LossChartProps) {
	if (data.length === 0) {
		return (
			<Box flexDirection="column">
				<Text dimColor>{label}: No data yet</Text>
			</Box>
		);
	}

	const min = Math.min(...data);
	const max = Math.max(...data);
	const range = max - min || 1;

	// Normalize data to height
	const normalizedData = data.map(v =>
		Math.round(((max - v) / range) * (height - 1)),
	);

	// Sample data to fit width
	const step = Math.max(1, Math.floor(data.length / width));
	const sampledData = [];
	for (let i = 0; i < data.length; i += step) {
		sampledData.push(normalizedData[i]);
	}

	// Build chart rows
	const rows: string[] = [];
	for (let y = 0; y < height; y++) {
		let row = '';
		for (let x = 0; x < sampledData.length; x++) {
			if (sampledData[x] === y) {
				row += '\u25CF';
			} else if (sampledData[x] < y && (sampledData[x + 1] ?? height) >= y) {
				row += '\u2502';
			} else {
				row += ' ';
			}
		}
		rows.push(row);
	}

	const formatNum = (n: number) => n.toFixed(2);

	return (
		<Box flexDirection="column">
			<Text bold>{label}</Text>
			<Box>
				<Box flexDirection="column" marginRight={1}>
					<Text dimColor>{formatNum(max)}</Text>
					{Array(height - 2)
						.fill(0)
						.map((_, i) => (
							<Text key={i}> </Text>
						))}
					<Text dimColor>{formatNum(min)}</Text>
				</Box>
				<Box flexDirection="column" borderStyle="single">
					{rows.map((row, i) => (
						<Text key={i} color="green">
							{row}
						</Text>
					))}
				</Box>
			</Box>
		</Box>
	);
}
