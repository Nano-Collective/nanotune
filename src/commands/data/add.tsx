import {StatusMessage, TextInput} from '@inkjs/ui';
import {Box, Text, useApp, useInput} from 'ink';
import {useState} from 'react';
import {Header} from '../../components/index.js';
import {
	configExists,
	loadConfig,
	resolveContextMessage,
} from '../../lib/config.js';
import {appendTrainingExample, countExamples} from '../../lib/data.js';
import type {ChatMessage} from '../../types/index.js';

type Field = 'input' | 'output' | 'confirm';

export function DataAddCommand() {
	const {exit} = useApp();
	const [field, setField] = useState<Field>('input');
	const [input, setInput] = useState('');
	const [output, setOutput] = useState('');
	const [turns, setTurns] = useState<Array<{user: string; assistant: string}>>(
		[],
	);
	const [count, setCount] = useState(() => countExamples());
	const [savedMessage, setSavedMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [hasConfig] = useState(() => configExists());

	const saveExample = () => {
		try {
			const config = loadConfig();
			const ctx = resolveContextMessage(config);
			const messages: ChatMessage[] = [{role: ctx.role, content: ctx.content}];
			for (const turn of turns) {
				messages.push({role: 'user', content: turn.user});
				messages.push({role: 'assistant', content: turn.assistant});
			}
			appendTrainingExample({messages});

			const turnCount = turns.length;
			setCount(c => c + 1);
			setTurns([]);
			setInput('');
			setOutput('');
			setField('input');
			setSavedMessage(
				`Example saved! (${turnCount} turn${turnCount > 1 ? 's' : ''})`,
			);
			setError(null);
			setTimeout(() => setSavedMessage(null), 2000);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save');
		}
	};

	useInput((_char, key) => {
		if (key.escape) {
			// Auto-save accumulated turns before exit
			if (turns.length > 0) {
				saveExample();
			}
			exit();
		}
		if (hasConfig && key.tab && field !== 'confirm') {
			setField(f => (f === 'input' ? 'output' : 'input'));
		}
	});

	const handleInputSubmit = (value: string) => {
		if (value.trim()) {
			setInput(value.trim());
			setField('output');
		}
	};

	const handleOutputSubmit = (value: string) => {
		if (!input.trim()) {
			setError('Please enter user input first');
			setField('input');
			return;
		}

		if (!value.trim()) {
			setError('Output cannot be empty');
			return;
		}

		setError(null);
		setTurns(prev => [...prev, {user: input.trim(), assistant: value.trim()}]);
		setInput('');
		setOutput('');
		setField('confirm');
	};

	useInput((char, _key) => {
		if (field !== 'confirm') return;

		if (char.toLowerCase() === 'y') {
			setField('input');
		} else if (char.toLowerCase() === 'n') {
			saveExample();
		}
	});

	if (!hasConfig) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Add Training Data" />
				<StatusMessage variant="error">
					Not a Nanotune project. Run `nanotune init` first.
				</StatusMessage>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1}>
			<Header title="Add Training Data" />

			<Box marginBottom={1}>
				<Text>Examples: </Text>
				<Text color="cyan" bold>
					{count}
				</Text>
				{turns.length > 0 && (
					<Text color="magenta">
						{' '}
						| Building: {turns.length} turn
						{turns.length > 1 ? 's' : ''}
					</Text>
				)}
				{savedMessage && <Text color="green"> {savedMessage}</Text>}
			</Box>

			{error && (
				<Box marginBottom={1}>
					<StatusMessage variant="error">{error}</StatusMessage>
				</Box>
			)}

			{turns.length > 0 && field !== 'confirm' && (
				<Box flexDirection="column" marginBottom={1}>
					<Text bold dimColor>
						Accumulated turns:
					</Text>
					{turns.map((turn, i) => (
						<Box key={`turn-${i}`} flexDirection="column">
							<Text dimColor>
								{' '}
								Turn {i + 1} - User: {turn.user.slice(0, 50)}
								{turn.user.length > 50 ? '...' : ''}
							</Text>
							<Text dimColor>
								{' '}
								Turn {i + 1} - Assistant: {turn.assistant.slice(0, 50)}
								{turn.assistant.length > 50 ? '...' : ''}
							</Text>
						</Box>
					))}
				</Box>
			)}

			{field === 'confirm' ? (
				<Box flexDirection="column">
					<Text bold color="green">
						Turn {turns.length} added!
					</Text>
					<Text>
						Add another turn? <Text color="green">(y/n)</Text>
					</Text>
				</Box>
			) : (
				<>
					<Box flexDirection="column" marginBottom={1}>
						<Text color={field === 'input' ? 'yellow' : 'white'}>
							User input:
						</Text>
						<Box borderStyle="round" paddingX={1}>
							{field === 'input' ? (
								<TextInput
									defaultValue={input}
									onSubmit={handleInputSubmit}
									placeholder="Enter user request..."
								/>
							) : (
								<Text>{input || <Text dimColor>Empty</Text>}</Text>
							)}
						</Box>
					</Box>

					<Box flexDirection="column" marginBottom={1}>
						<Text color={field === 'output' ? 'yellow' : 'white'}>
							Expected output:
						</Text>
						<Box borderStyle="round" paddingX={1}>
							{field === 'output' ? (
								<TextInput
									defaultValue={output}
									onSubmit={handleOutputSubmit}
									placeholder="Enter expected response..."
								/>
							) : (
								<Text>{output || <Text dimColor>Empty</Text>}</Text>
							)}
						</Box>
					</Box>
				</>
			)}

			<Text dimColor>
				{field === 'confirm'
					? '[y] Add turn [n] Save example [Esc] Save & exit'
					: '[Enter] Submit [Tab] Switch field [Esc] Save & exit'}
			</Text>
		</Box>
	);
}
