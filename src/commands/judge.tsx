import {Select, Spinner, StatusMessage, TextInput} from '@inkjs/ui';
import {Box, Text, useApp, useInput} from 'ink';
import {useCallback, useEffect, useState} from 'react';
import {Header} from '../components/index.js';
import {configExists} from '../lib/config.js';
import {
	callJudge,
	isJudgeConfigured,
	loadJudgeConfig,
	resolveCriteria,
	saveJudgeConfig,
} from '../lib/judge.js';
import {PROVIDER_TEMPLATES} from '../lib/judge-templates.js';
import type {JudgeProviderConfig} from '../types/index.js';

type ConfigureStep =
	| 'select-provider'
	| 'fill-fields'
	| 'confirm'
	| 'testing'
	| 'done'
	| 'error';

export function JudgeConfigureCommand() {
	const {exit} = useApp();
	const [step, setStep] = useState<ConfigureStep>('select-provider');
	const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
		null,
	);
	const [fieldIndex, setFieldIndex] = useState(0);
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [builtConfig, setBuiltConfig] = useState<JudgeProviderConfig | null>(
		null,
	);
	const [errorMessage, setErrorMessage] = useState('');

	useInput((_input, key) => {
		if (key.escape) {
			exit();
		}
	});

	const template = selectedTemplateId
		? PROVIDER_TEMPLATES.find(t => t.id === selectedTemplateId)
		: null;

	const handleProviderSelect = useCallback((value: string) => {
		setSelectedTemplateId(value);
		setStep('fill-fields');
		setFieldIndex(0);
		setAnswers({});
	}, []);

	const handleFieldSubmit = useCallback(
		(value: string) => {
			if (!template) return;

			const field = template.fields[fieldIndex];
			const actual = value.trim() || field.default || '';

			// Validate required
			if (field.required && !actual) {
				return; // Don't advance
			}

			// Validate with custom validator
			if (field.validator && actual) {
				const error = field.validator(actual);
				if (error) {
					setErrorMessage(error);
					setStep('error');
					return;
				}
			}

			const newAnswers = {...answers, [field.name]: actual};
			setAnswers(newAnswers);

			if (fieldIndex < template.fields.length - 1) {
				setFieldIndex(fieldIndex + 1);
			} else {
				// All fields done — build config
				const config = template.buildConfig(newAnswers);
				setBuiltConfig(config);
				setStep('confirm');
			}
		},
		[template, fieldIndex, answers],
	);

	useInput(input => {
		if (step === 'confirm' && builtConfig) {
			if (input.toLowerCase() === 'y') {
				setStep('testing');
			} else if (input.toLowerCase() === 'n') {
				exit();
			}
		}
	});

	// Test connection when entering testing step
	useEffect(() => {
		if (step !== 'testing' || !builtConfig) return;

		let cancelled = false;

		const testConnection = async () => {
			try {
				await callJudge(
					'Say hello in one word.',
					'Hello!',
					resolveCriteria(['helpful']),
					builtConfig,
					5,
				);

				if (!cancelled) {
					saveJudgeConfig(builtConfig);
					setStep('done');
					setTimeout(() => exit(), 100);
				}
			} catch (err) {
				if (!cancelled) {
					setErrorMessage(
						`Connection test failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
					);
					setStep('error');
				}
			}
		};

		testConnection();

		return () => {
			cancelled = true;
		};
	}, [step, builtConfig, exit]);

	if (step === 'error') {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Judge Configure" />
				<StatusMessage variant="error">{errorMessage}</StatusMessage>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1}>
			<Header title="Judge Configure" />

			{step === 'select-provider' && (
				<Box flexDirection="column">
					<Text>Select a provider for the LLM judge:</Text>
					<Select
						options={PROVIDER_TEMPLATES.map(t => ({
							label: t.name,
							value: t.id,
						}))}
						visibleOptionCount={PROVIDER_TEMPLATES.length}
						onChange={handleProviderSelect}
					/>
				</Box>
			)}

			{step === 'fill-fields' && template && (
				<Box flexDirection="column">
					<Text dimColor>Provider: {template.name}</Text>
					<Text> </Text>
					{template.fields.slice(0, fieldIndex).map(f => (
						<Text key={f.name}>
							{f.name}:{' '}
							<Text color="cyan">{f.sensitive ? '***' : answers[f.name]}</Text>
						</Text>
					))}
					<Text>{template.fields[fieldIndex].prompt}:</Text>
					<TextInput
						key={`field-${fieldIndex}`}
						defaultValue={template.fields[fieldIndex].default}
						onSubmit={handleFieldSubmit}
						placeholder={
							template.fields[fieldIndex].required
								? 'Required'
								: 'Optional (press Enter to skip)'
						}
					/>
				</Box>
			)}

			{step === 'confirm' && builtConfig && (
				<Box flexDirection="column">
					<Text bold>Configuration Summary:</Text>
					<Text> </Text>
					<Text>
						Provider: <Text color="cyan">{builtConfig.name}</Text>
					</Text>
					<Text>
						Base URL: <Text color="cyan">{builtConfig.baseUrl}</Text>
					</Text>
					<Text>
						Model: <Text color="cyan">{builtConfig.model}</Text>
					</Text>
					<Text>
						API Key:{' '}
						<Text color="cyan">{builtConfig.apiKey ? '***' : '(none)'}</Text>
					</Text>
					{builtConfig.sdkProvider && (
						<Text>
							SDK Provider: <Text color="cyan">{builtConfig.sdkProvider}</Text>
						</Text>
					)}
					<Text> </Text>
					<Text>
						Save and test connection? <Text color="green">(y/n)</Text>
					</Text>
				</Box>
			)}

			{step === 'testing' && (
				<Box>
					<Spinner label="Testing connection to judge model..." />
				</Box>
			)}

			{step === 'done' && (
				<Box flexDirection="column">
					<StatusMessage variant="success">
						Judge configured successfully!
					</StatusMessage>
					<Text> </Text>
					<Text bold>Next steps:</Text>
					<Text>
						{'  '}Test it: <Text color="cyan">nanotune judge test</Text>
					</Text>
					<Text>
						{'  '}Use in benchmarks: set{' '}
						<Text color="cyan">{'"match": "llm-judge"'}</Text> in your
						tests.json
					</Text>
				</Box>
			)}

			<Text> </Text>
			<Text dimColor>[Esc] Cancel</Text>
		</Box>
	);
}

export function JudgeTestCommand() {
	const {exit} = useApp();
	const [status, setStatus] = useState<
		'checking' | 'running' | 'done' | 'error'
	>('checking');
	const [result, setResult] = useState<{
		score: number;
		reasoning: string;
		criteriaScores: Record<string, number>;
	} | null>(null);
	const [errorMessage, setErrorMessage] = useState('');

	useInput((_input, key) => {
		if (key.escape || key.return) {
			exit();
		}
	});

	useEffect(() => {
		let cancelled = false;

		const run = async () => {
			if (!configExists()) {
				setErrorMessage('Not a Nanotune project. Run `nanotune init` first.');
				setStatus('error');
				return;
			}

			if (!isJudgeConfigured()) {
				setErrorMessage(
					'LLM judge is not configured. Run `nanotune judge configure` first.',
				);
				setStatus('error');
				return;
			}

			setStatus('running');

			try {
				const config = loadJudgeConfig();
				const criteria = resolveCriteria(['helpful', 'accurate', 'concise']);

				const judgeResult = await callJudge(
					'What is the capital of France?',
					'The capital of France is Paris. It is known as the City of Light and is famous for landmarks like the Eiffel Tower.',
					criteria,
					config,
					7,
				);

				if (!cancelled) {
					setResult({
						score: judgeResult.score,
						reasoning: judgeResult.reasoning,
						criteriaScores: judgeResult.criteriaScores,
					});
					setStatus('done');
				}
			} catch (err) {
				if (!cancelled) {
					setErrorMessage(err instanceof Error ? err.message : 'Unknown error');
					setStatus('error');
				}
			}
		};

		run();

		return () => {
			cancelled = true;
		};
	}, []);

	if (status === 'error') {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Judge Test" />
				<StatusMessage variant="error">{errorMessage}</StatusMessage>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1}>
			<Header title="Judge Test" />

			{(status === 'checking' || status === 'running') && (
				<Spinner label="Running test evaluation..." />
			)}

			{status === 'done' && result && (
				<Box flexDirection="column">
					<StatusMessage variant="success">Judge test completed!</StatusMessage>
					<Text> </Text>
					<Text bold>Test Prompt:</Text>
					<Text dimColor> "What is the capital of France?"</Text>
					<Text> </Text>
					<Text bold>Test Response:</Text>
					<Text dimColor>
						{' '}
						"The capital of France is Paris. It is known as the City of
						Light..."
					</Text>
					<Text> </Text>
					<Text bold>Judge Scores:</Text>
					{Object.entries(result.criteriaScores).map(([name, score]) => (
						<Text key={name}>
							{'  '}
							{name}:{' '}
							<Text
								color={score >= 7 ? 'green' : score >= 4 ? 'yellow' : 'red'}
							>
								{score}/10
							</Text>
						</Text>
					))}
					<Text> </Text>
					<Text>
						Overall:{' '}
						<Text color={result.score >= 7 ? 'green' : 'yellow'} bold>
							{result.score}/10
						</Text>
					</Text>
					<Text> </Text>
					<Text bold>Reasoning:</Text>
					<Text dimColor> {result.reasoning}</Text>
				</Box>
			)}

			<Text> </Text>
			<Text dimColor>Press any key to exit</Text>
		</Box>
	);
}
