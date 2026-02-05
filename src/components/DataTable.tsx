import {Box, Text} from 'ink';

interface DataTableProps {
	headers: string[];
	rows: string[][];
	columnWidths?: number[];
	selectedIndex?: number;
}

function truncate(str: string, maxLength: number): string {
	if (str.length <= maxLength) return str;
	return `${str.slice(0, maxLength - 3)}...`;
}

export function DataTable({
	headers,
	rows,
	columnWidths,
	selectedIndex,
}: DataTableProps) {
	const widths = columnWidths || headers.map(() => 20);

	return (
		<Box flexDirection="column">
			{/* Header */}
			<Box borderStyle="single" paddingX={1}>
				{headers.map((header, i) => (
					<Box key={header} width={widths[i]} marginRight={1}>
						<Text bold>{truncate(header, widths[i])}</Text>
					</Box>
				))}
			</Box>

			{/* Rows */}
			{rows.map((row, rowIndex) => (
				<Box
					key={`row-${rowIndex}`}
					paddingX={1}
					borderStyle={selectedIndex === rowIndex ? 'single' : undefined}
				>
					{row.map((cell, cellIndex) => (
						<Box
							key={`cell-${cellIndex}`}
							width={widths[cellIndex]}
							marginRight={1}
						>
							<Text color={selectedIndex === rowIndex ? 'yellow' : undefined}>
								{truncate(cell, widths[cellIndex])}
							</Text>
						</Box>
					))}
				</Box>
			))}

			{rows.length === 0 && (
				<Box paddingX={1}>
					<Text dimColor>No data</Text>
				</Box>
			)}
		</Box>
	);
}
