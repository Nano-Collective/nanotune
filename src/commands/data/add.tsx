import {StatusMessage, TextInput} from '@inkjs/ui';
import {Box, Text, useApp, useInput} from 'ink';
import {useState} from 'react';
import {Header} from '../../components/index.js';
import {configExists, loadConfig} from '../../lib/config.js';
import {appendToTrainingData, countExamples} from '../../lib/data.js';

type Field = 'input' | 'output';

export function DataAddCommand() {
	const {exit} = useApp();
	const [field, setField] = useState<Field>('input');
	const [input, setInput] = useState('');
	const [output, setOutput] = useState('');
	const [count, setCount] = useState(() => countExamples());
	const [savedMessage, setSavedMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [hasConfig] = useState(() => configExists());

	useInput((_char, key) => {
		if (key.escape) {
			exit();
		}
		if (hasConfig && key.tab) {
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

		try {
			const config = loadConfig();
			appendToTrainingData({
				systemPrompt: config.systemPrompt,
				userInput: input.trim(),
				assistantOutput: value.trim(),
			});

			setCount(c => c + 1);
			setInput('');
			setOutput('');
			setField('input');
			setSavedMessage('Example saved!');
			setError(null);
			setTimeout(() => setSavedMessage(null), 2000);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save');
		}
	};

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
				{savedMessage && <Text color="green"> {savedMessage}</Text>}
			</Box>

			{error && (
				<Box marginBottom={1}>
					<StatusMessage variant="error">{error}</StatusMessage>
				</Box>
			)}

			<Box flexDirection="column" marginBottom={1}>
				<Text color={field === 'input' ? 'yellow' : 'white'}>User input:</Text>
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

			<Text dimColor>[Enter] Save [Tab] Switch field [Esc] Done</Text>
		</Box>
	);
}
