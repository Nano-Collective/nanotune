import {StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp, useInput} from 'ink';
import {useState} from 'react';
import {DataTable, Header} from '../../components/index.js';
import {configExists} from '../../lib/config.js';
import {deleteExample, loadTrainingData} from '../../lib/data.js';

const PAGE_SIZE = 10;

export function DataListCommand() {
	const {exit} = useApp();
	const [page, setPage] = useState(0);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [data, setData] = useState(() => loadTrainingData());
	const [message, setMessage] = useState<{
		type: 'success' | 'error';
		text: string;
	} | null>(null);
	const [hasConfig] = useState(() => configExists());

	const totalPages = Math.ceil(data.length / PAGE_SIZE);
	const startIndex = page * PAGE_SIZE;
	const pageData = data.slice(startIndex, startIndex + PAGE_SIZE);

	useInput((input, key) => {
		if (key.escape || input === 'q') {
			exit();
		}

		if (!hasConfig) return;

		if (key.upArrow) {
			setSelectedIndex(i => Math.max(0, i - 1));
		}

		if (key.downArrow) {
			setSelectedIndex(i => Math.min(pageData.length - 1, i + 1));
		}

		if (key.leftArrow || input === '[') {
			if (page > 0) {
				setPage(p => p - 1);
				setSelectedIndex(0);
			}
		}

		if (key.rightArrow || input === ']') {
			if (page < totalPages - 1) {
				setPage(p => p + 1);
				setSelectedIndex(0);
			}
		}

		if (input === 'd') {
			const globalIndex = startIndex + selectedIndex;
			if (globalIndex < data.length) {
				try {
					deleteExample(globalIndex);
					setData(loadTrainingData());
					setMessage({type: 'success', text: 'Example deleted'});
					setTimeout(() => setMessage(null), 2000);

					// Adjust selection if needed
					if (selectedIndex >= pageData.length - 1 && selectedIndex > 0) {
						setSelectedIndex(selectedIndex - 1);
					}
				} catch (err) {
					setMessage({
						type: 'error',
						text: err instanceof Error ? err.message : 'Delete failed',
					});
				}
			}
		}
	});

	if (!hasConfig) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Training Data" />
				<StatusMessage variant="error">
					Not a Nanotune project. Run `nanotune init` first.
				</StatusMessage>
			</Box>
		);
	}

	const tableData = pageData.map((ex, i) => {
		const user = ex.messages.find(m => m.role === 'user');
		const assistant = ex.messages.find(m => m.role === 'assistant');
		return [
			String(startIndex + i + 1),
			user?.content || '',
			assistant?.content || '',
		];
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Header
				title="Training Data"
				subtitle={`${data.length} examples | Page ${page + 1}/${totalPages || 1}`}
			/>

			{message && (
				<Box marginBottom={1}>
					<StatusMessage variant={message.type}>{message.text}</StatusMessage>
				</Box>
			)}

			{data.length === 0 ? (
				<Box flexDirection="column">
					<Text dimColor>No training data yet.</Text>
					<Text>
						Run <Text color="cyan">nanotune data add</Text> to add examples.
					</Text>
				</Box>
			) : (
				<Box flexDirection="column">
					<DataTable
						headers={['#', 'Input', 'Output']}
						rows={tableData}
						columnWidths={[5, 35, 35]}
						selectedIndex={selectedIndex}
					/>

					<Text> </Text>
					<Text dimColor>
						[Up/Down] Navigate [Left/Right] Page [d] Delete [q] Quit
					</Text>
				</Box>
			)}
		</Box>
	);
}
