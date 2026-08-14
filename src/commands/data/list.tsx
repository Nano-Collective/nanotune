import {StatusMessage, TextInput} from '@inkjs/ui';
import {Box, Text, useApp} from 'ink';
import {useState} from 'react';
import {DataTable, Header, useKeyInput} from '../../components/index.js';
import {configExists} from '../../lib/config.js';
import {
	clampPagination,
	countTurns,
	deleteExample,
	loadTrainingData,
	mergeEditedTurn,
	updateTrainingExample,
} from '../../lib/data.js';
import type {ChatMessage} from '../../types/index.js';

type EditField = 'input' | 'output';

const PAGE_SIZE = 10;

export function DataListCommand() {
	const {exit} = useApp();
	const [page, setPage] = useState(0);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
	const [data, setData] = useState(() => loadTrainingData());
	const [message, setMessage] = useState<{
		type: 'success' | 'error';
		text: string;
	} | null>(null);
	const [hasConfig] = useState(() => configExists());

	const [editIndex, setEditIndex] = useState<number | null>(null);
	const [editField, setEditField] = useState<EditField>('input');
	const [editInput, setEditInput] = useState('');
	const [editOutput, setEditOutput] = useState('');
	const [editError, setEditError] = useState<string | null>(null);

	const totalPages = Math.ceil(data.length / PAGE_SIZE);
	const startIndex = page * PAGE_SIZE;
	const pageData = data.slice(startIndex, startIndex + PAGE_SIZE);

	const saveEdit = (userInput: string, assistantOutput: string) => {
		if (editIndex === null) return;
		try {
			const original = data[editIndex];
			const updated: {messages: ChatMessage[]} = {
				messages: mergeEditedTurn(
					original.messages,
					userInput,
					assistantOutput,
				),
			};
			updateTrainingExample(editIndex, updated);
			setData(loadTrainingData());
			setExpandedIndex(null);
			setEditIndex(null);
			setEditError(null);
			setMessage({type: 'success', text: 'Example updated'});
			setTimeout(() => setMessage(null), 2000);
		} catch (err) {
			setEditError(err instanceof Error ? err.message : 'Update failed');
		}
	};

	const handleEditInputSubmit = (value: string) => {
		if (value.trim()) {
			setEditInput(value.trim());
			setEditField('output');
		}
	};

	const handleEditOutputSubmit = (value: string) => {
		if (!value.trim()) {
			setEditError('Output cannot be empty');
			return;
		}
		setEditOutput(value.trim());
		saveEdit(editInput, value.trim());
	};

	useKeyInput((_input, key) => {
		if (editIndex === null) return;

		if (key.escape) {
			setEditIndex(null);
			setEditError(null);
			return;
		}

		if (key.tab) {
			setEditField(f => (f === 'input' ? 'output' : 'input'));
		}
	});

	useKeyInput((input, key) => {
		if (editIndex !== null) return;

		if (key.escape || input === 'q') {
			exit();
		}

		if (!hasConfig) return;

		if (key.upArrow) {
			setSelectedIndex(i => Math.max(0, i - 1));
			setExpandedIndex(null);
		}

		if (key.downArrow) {
			setSelectedIndex(i => Math.min(pageData.length - 1, i + 1));
			setExpandedIndex(null);
		}

		if (key.leftArrow || input === '[') {
			if (page > 0) {
				setPage(p => p - 1);
				setSelectedIndex(0);
				setExpandedIndex(null);
			}
		}

		if (key.rightArrow || input === ']') {
			if (page < totalPages - 1) {
				setPage(p => p + 1);
				setSelectedIndex(0);
				setExpandedIndex(null);
			}
		}

		if (key.return) {
			const globalIndex = startIndex + selectedIndex;
			if (globalIndex < data.length) {
				setExpandedIndex(prev =>
					prev === selectedIndex ? null : selectedIndex,
				);
			}
		}

		if (input === 'd') {
			const globalIndex = startIndex + selectedIndex;
			if (globalIndex < data.length) {
				try {
					deleteExample(globalIndex);
					const remaining = loadTrainingData();
					setData(remaining);
					setExpandedIndex(null);
					setMessage({type: 'success', text: 'Example deleted'});
					setTimeout(() => setMessage(null), 2000);

					const next = clampPagination(
						remaining.length,
						page,
						selectedIndex,
						PAGE_SIZE,
					);
					setPage(next.page);
					setSelectedIndex(next.selectedIndex);
				} catch (err) {
					setMessage({
						type: 'error',
						text: err instanceof Error ? err.message : 'Delete failed',
					});
				}
			}
		}

		if (input === 'e') {
			const globalIndex = startIndex + selectedIndex;
			if (globalIndex < data.length) {
				const ex = data[globalIndex];
				const userMsg = ex.messages.find(m => m.role === 'user');
				const assistantMsg = ex.messages.find(m => m.role === 'assistant');
				setEditIndex(globalIndex);
				setEditInput(userMsg?.content ?? '');
				setEditOutput(assistantMsg?.content ?? '');
				setEditField('input');
				setEditError(null);
				setExpandedIndex(null);
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
		const turns = countTurns(ex);
		return [
			String(startIndex + i + 1),
			user?.content || '',
			assistant?.content || '',
			String(turns),
		];
	});

	const expandedExample =
		expandedIndex !== null ? pageData[expandedIndex] : null;

	const editingExample = editIndex !== null ? data[editIndex] : null;
	const editExtraTurns = editingExample ? countTurns(editingExample) - 1 : 0;

	if (editingExample && editIndex !== null) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title={`Editing Example #${editIndex + 1}`} />

				{editError && (
					<Box marginBottom={1}>
						<StatusMessage variant="error">{editError}</StatusMessage>
					</Box>
				)}

				{editExtraTurns > 0 && (
					<Box marginBottom={1}>
						<Text dimColor>
							{editExtraTurns} additional turn{editExtraTurns > 1 ? 's' : ''}{' '}
							preserved, not edited here.
						</Text>
					</Box>
				)}

				<Box flexDirection="column" marginBottom={1}>
					<Text color={editField === 'input' ? 'yellow' : 'white'}>
						User input:
					</Text>
					<Box borderStyle="round" paddingX={1}>
						{editField === 'input' ? (
							<TextInput
								defaultValue={editInput}
								onSubmit={handleEditInputSubmit}
							/>
						) : (
							<Text>{editInput || <Text dimColor>Empty</Text>}</Text>
						)}
					</Box>
				</Box>

				<Box flexDirection="column" marginBottom={1}>
					<Text color={editField === 'output' ? 'yellow' : 'white'}>
						Expected output:
					</Text>
					<Box borderStyle="round" paddingX={1}>
						{editField === 'output' ? (
							<TextInput
								defaultValue={editOutput}
								onSubmit={handleEditOutputSubmit}
							/>
						) : (
							<Text>{editOutput || <Text dimColor>Empty</Text>}</Text>
						)}
					</Box>
				</Box>

				<Text dimColor>[Enter] Submit [Tab] Switch field [Esc] Cancel</Text>
			</Box>
		);
	}

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
						headers={['#', 'Input', 'Output', 'Turns']}
						rows={tableData}
						columnWidths={[5, 30, 30, 6]}
						selectedIndex={selectedIndex}
					/>

					{expandedExample && (
						<Box
							flexDirection="column"
							marginTop={1}
							borderStyle="round"
							paddingX={1}
						>
							<Text bold>
								Conversation ({expandedExample.messages.length} messages)
							</Text>
							{expandedExample.messages.map((msg, i) => (
								<Box key={`msg-${i}`}>
									<Text
										color={
											msg.role === 'user'
												? 'yellow'
												: msg.role === 'assistant'
													? 'green'
													: 'blue'
										}
										bold
									>
										{msg.role}:{' '}
									</Text>
									<Text>
										{msg.content.slice(0, 80)}
										{msg.content.length > 80 ? '...' : ''}
									</Text>
								</Box>
							))}
						</Box>
					)}

					<Text> </Text>
					<Text dimColor>
						[Up/Down] Navigate [Left/Right] Page [Enter] Expand/collapse [e]
						Edit [d] Delete [q] Quit
					</Text>
				</Box>
			)}
		</Box>
	);
}
