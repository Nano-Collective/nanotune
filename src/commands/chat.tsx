import {existsSync} from 'node:fs';
import {Spinner, StatusMessage, TextInput} from '@inkjs/ui';
import {Box, Static, Text, useApp, useInput} from 'ink';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Header} from '../components/index.js';
import {
	buildGenerateOptions,
	buildServerOptions,
	parseSlashCommand,
} from '../lib/chat-helpers.js';
import {
	configExists,
	findLatestGGUF,
	loadConfig,
	resolveContextMessage,
} from '../lib/config.js';
import {
	chatCompletion,
	type ServerHandle,
	startLlamaServer,
	stopLlamaServer,
} from '../lib/llama-cpp.js';
import type {ChatMessage} from '../types/index.js';

interface Props {
	options: {
		model?: string;
		preset?: string;
		threads?: string;
		gpuLayers?: string;
		ctxSize?: string;
		batchSize?: string;
		cpuOnly?: boolean;
		maxTokens?: string;
		temperature?: string;
		topP?: string;
		seed?: string;
		system?: string;
	};
}

type Status = 'starting' | 'ready' | 'generating' | 'error';

interface AssistantStats {
	tokensPerSecond?: number;
	ttftMs?: number;
	tokensGenerated?: number;
}

interface DisplayTurn {
	id: number;
	role: 'user' | 'assistant' | 'system' | 'info';
	content: string;
	stats?: AssistantStats;
}

const HELP_TEXT = [
	'Slash commands:',
	'  /help          Show this help',
	'  /reset         Clear conversation history',
	'  /system <txt>  Replace the system message and reset history',
	'  /stats         Show session token statistics',
	'  /exit, /quit   Leave the chat',
].join('\n');

export function ChatCommand({options}: Props) {
	const {exit} = useApp();
	const [status, setStatus] = useState<Status>('starting');
	const [error, setError] = useState<string | null>(null);
	const [systemMessage, setSystemMessage] = useState<ChatMessage | null>(null);
	const [history, setHistory] = useState<ChatMessage[]>([]);
	const [displayTurns, setDisplayTurns] = useState<DisplayTurn[]>([]);
	const [modelLabel, setModelLabel] = useState<string>('');
	const [inputKey, setInputKey] = useState(0);
	const [totalTokens, setTotalTokens] = useState(0);

	const serverHandleRef = useRef<ServerHandle | null>(null);
	const turnIdRef = useRef(0);

	// Destructure once so the memo deps below are primitives (stable across
	// renders) — referencing `options.x` directly inside useMemo would make the
	// closure depend on the whole `options` object and trip biome's exhaustive
	// deps rule.
	const {
		model: modelArg,
		system: systemArg,
		preset,
		threads,
		gpuLayers,
		ctxSize,
		batchSize,
		cpuOnly,
		maxTokens,
		temperature,
		topP,
		seed,
	} = options;

	// Memoize so the values are stable across renders — otherwise the startup
	// effect would tear down and restart the llama-server on every state change.
	const serverOptions = useMemo(
		() =>
			buildServerOptions({
				preset,
				threads,
				gpuLayers,
				ctxSize,
				batchSize,
				cpuOnly,
			}),
		[preset, threads, gpuLayers, ctxSize, batchSize, cpuOnly],
	);
	const generateOptions = useMemo(
		() => buildGenerateOptions({preset, maxTokens, temperature, topP, seed}),
		[preset, maxTokens, temperature, topP, seed],
	);

	const appendTurn = useCallback((turn: Omit<DisplayTurn, 'id'>) => {
		setDisplayTurns(prev => [...prev, {id: turnIdRef.current++, ...turn}]);
	}, []);

	// Spin up the server once on mount; tear it down on unmount.
	useEffect(() => {
		let cancelled = false;

		const startup = async () => {
			try {
				if (!configExists()) {
					setError('Not a Nanotune project. Run `nanotune init` first.');
					setStatus('error');
					return;
				}

				// Resolve system message: --system flag wins, then project context.
				try {
					const config = loadConfig();
					const ctx = resolveContextMessage(config);
					if (systemArg) {
						setSystemMessage({role: ctx.role, content: systemArg});
					} else if (ctx.content) {
						setSystemMessage(ctx);
					}
				} catch {
					// Minimal/benchmark-only config — no project context to resolve.
					if (systemArg) {
						setSystemMessage({role: 'system', content: systemArg});
					}
				}

				// Resolve model path.
				const modelPath = modelArg ?? findLatestGGUF();
				if (!modelPath) {
					setError('No exported models found. Run `nanotune export` first.');
					setStatus('error');
					return;
				}
				if (!existsSync(modelPath)) {
					setError(`Model not found: ${modelPath}`);
					setStatus('error');
					return;
				}
				setModelLabel(modelPath.split('/').pop() ?? modelPath);

				const handle = await startLlamaServer(modelPath, serverOptions);
				if (cancelled) {
					await stopLlamaServer(handle);
					return;
				}
				serverHandleRef.current = handle;
				setStatus('ready');
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : 'Failed to start');
					setStatus('error');
				}
			}
		};

		void startup();

		return () => {
			cancelled = true;
			const handle = serverHandleRef.current;
			serverHandleRef.current = null;
			if (handle) {
				void stopLlamaServer(handle);
			}
		};
	}, [modelArg, systemArg, serverOptions]);

	// Backstop: if the process exits unexpectedly (SIGINT etc.), make sure
	// the server child is killed. The useEffect cleanup handles graceful exit.
	useEffect(() => {
		const killOnExit = () => {
			const handle = serverHandleRef.current;
			if (handle) {
				try {
					handle.process.kill('SIGKILL');
				} catch {
					// Best effort
				}
			}
		};
		process.on('exit', killOnExit);
		return () => {
			process.off('exit', killOnExit);
		};
	}, []);

	const sendMessage = useCallback(
		async (text: string) => {
			const handle = serverHandleRef.current;
			if (!handle) return;

			const userMsg: ChatMessage = {role: 'user', content: text};
			const nextHistory = [...history, userMsg];
			setHistory(nextHistory);
			appendTurn({role: 'user', content: text});
			setStatus('generating');

			try {
				const messages: ChatMessage[] = [];
				if (systemMessage?.content) {
					messages.push(systemMessage);
				}
				messages.push(...nextHistory);

				const result = await chatCompletion(handle, messages, generateOptions);

				const assistantMsg: ChatMessage = {
					role: 'assistant',
					content: result.text,
				};
				setHistory(prev => [...prev, assistantMsg]);
				appendTurn({
					role: 'assistant',
					content: result.text,
					stats: {
						tokensPerSecond: result.tokensPerSecond,
						ttftMs: result.ttftMs,
						tokensGenerated: result.tokensGenerated,
					},
				});
				if (result.tokensGenerated) {
					setTotalTokens(prev => prev + (result.tokensGenerated ?? 0));
				}
				setStatus('ready');
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'Generation failed';
				appendTurn({role: 'info', content: `Error: ${msg}`});
				// Roll the user turn back out of the model-visible history so the
				// next attempt starts clean.
				setHistory(history);
				setStatus('ready');
			}
		},
		[appendTurn, generateOptions, history, systemMessage],
	);

	const handleSubmit = useCallback(
		(value: string) => {
			setInputKey(k => k + 1);
			const cmd = parseSlashCommand(value);

			switch (cmd.kind) {
				case 'noop':
					return;
				case 'exit':
					exit();
					return;
				case 'reset':
					setHistory([]);
					appendTurn({
						role: 'info',
						content: 'Conversation history cleared.',
					});
					return;
				case 'system': {
					const role = systemMessage?.role ?? 'system';
					setSystemMessage({role, content: cmd.text});
					setHistory([]);
					appendTurn({
						role: 'info',
						content: `System message updated (${role}). History reset.`,
					});
					return;
				}
				case 'system-missing':
					appendTurn({
						role: 'info',
						content: 'Usage: /system <new system message>',
					});
					return;
				case 'stats':
					appendTurn({
						role: 'info',
						content: `Turns: ${history.length / 2} • Tokens generated: ${totalTokens}`,
					});
					return;
				case 'help':
					appendTurn({role: 'info', content: HELP_TEXT});
					return;
				case 'unknown':
					appendTurn({
						role: 'info',
						content: `Unknown command: ${cmd.name}. Try /help.`,
					});
					return;
				case 'send':
					void sendMessage(cmd.text);
					return;
			}
		},
		[appendTurn, exit, history.length, sendMessage, systemMessage, totalTokens],
	);

	useInput((_input, key) => {
		// Esc exits when not actively generating (so users don't kill a long gen
		// by accident — they can still Ctrl-C if needed).
		if (key.escape && status !== 'generating') {
			exit();
		}
	});

	if (status === 'error') {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Chat" />
				<StatusMessage variant="error">{error}</StatusMessage>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1}>
			<Header
				title="Chat"
				subtitle={
					modelLabel
						? `Model: ${modelLabel}${systemMessage ? ` • System: ${systemMessage.role}` : ''}`
						: undefined
				}
			/>

			{/* Conversation log — Ink's <Static> renders each item exactly once and
			    lets the user scroll back in their terminal scrollback. */}
			<Static items={displayTurns}>
				{turn => <TurnView key={turn.id} turn={turn} />}
			</Static>

			{status === 'starting' && (
				<Box>
					<Spinner label="Starting llama-server (loading model)..." />
				</Box>
			)}

			{status === 'generating' && (
				<Box marginTop={1}>
					<Spinner label="Generating..." />
				</Box>
			)}

			{status === 'ready' && (
				<Box flexDirection="column" marginTop={1}>
					<Box>
						<Text color="yellow" bold>
							You:{' '}
						</Text>
						<TextInput
							key={`input-${inputKey}`}
							onSubmit={handleSubmit}
							placeholder="Type a message or /help"
						/>
					</Box>
					<Box marginTop={1}>
						<Text dimColor>
							[Enter] Send · [/help] Commands · [/exit or Esc] Quit
						</Text>
					</Box>
				</Box>
			)}
		</Box>
	);
}

function TurnView({turn}: {turn: DisplayTurn}) {
	if (turn.role === 'info') {
		return (
			<Box flexDirection="column" marginBottom={1}>
				<Text dimColor>{turn.content}</Text>
			</Box>
		);
	}

	if (turn.role === 'user') {
		return (
			<Box flexDirection="column" marginBottom={1}>
				<Text color="yellow" bold>
					You:
				</Text>
				<Text>{turn.content}</Text>
			</Box>
		);
	}

	// assistant
	const stats = turn.stats;
	const statLine =
		stats &&
		[
			stats.ttftMs !== undefined ? `TTFT ${stats.ttftMs}ms` : null,
			stats.tokensPerSecond !== undefined
				? `${stats.tokensPerSecond.toFixed(1)} tok/s`
				: null,
			stats.tokensGenerated !== undefined
				? `${stats.tokensGenerated} tokens`
				: null,
		]
			.filter(Boolean)
			.join(' · ');

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text color="green" bold>
				Model:
			</Text>
			<Text>{turn.content}</Text>
			{statLine && <Text dimColor>{statLine}</Text>}
		</Box>
	);
}
