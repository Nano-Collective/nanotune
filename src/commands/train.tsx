import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {Spinner, StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp} from 'ink';
import {useCallback, useEffect, useRef, useState} from 'react';
import {
	ExitHint,
	Header,
	LossChart,
	Progress,
	useAutoExit,
	useKeyInput,
} from '../components/index.js';
import {
	configExists,
	getAdaptersDir,
	getDataDir,
	loadConfig,
} from '../lib/config.js';
import {countExamples, ensureValidationSet} from '../lib/data.js';
import {
	checkMLXInstalled,
	ensureModelDownloaded,
	installMLX,
	type MLXTrainingOptions,
	runTraining,
	shouldTreatAsStop,
} from '../lib/mlx.js';
import {assertSupportedPlatform} from '../lib/platform.js';
import type {TrainingProgress} from '../types/index.js';

interface Props {
	options: {
		iterations?: string;
		lr?: string;
		resume?: boolean;
		dryRun?: boolean;
	};
}

type Status =
	| 'checking'
	| 'installing'
	| 'validating'
	| 'downloading'
	| 'training'
	| 'stopping'
	| 'stopped'
	| 'done'
	| 'error';

export function TrainCommand({options}: Props) {
	const {exit} = useApp();
	const [status, setStatus] = useState<Status>('checking');
	const [progress, setProgress] = useState<TrainingProgress | null>(null);
	const [lossHistory, setLossHistory] = useState<number[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [eta, setEta] = useState<string | null>(null);
	const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
	const [downloadDetail, setDownloadDetail] = useState<string | null>(null);
	const [elapsed, setElapsed] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	// Ctrl+C is ours to handle here (the command renders with
	// `exitOnCtrlC: false`), so mid-training it stops the trainer gracefully
	// instead of letting Ink tear the app down while MLX is still writing.
	// A second Ctrl+C gives up on the checkpoint rather than trapping the user
	// behind a trainer that will not exit.
	useKeyInput((input, key) => {
		if (key.ctrl && input === 'c') {
			if (status === 'training') {
				abortRef.current?.abort();
				setStatus('stopping');
			} else if (status === 'stopping') {
				process.exit(130);
			} else {
				exit();
			}
			return;
		}
		if (key.escape && status !== 'training' && status !== 'downloading') {
			exit();
		}
		if (
			(status === 'done' || status === 'stopped' || status === 'error') &&
			(key.return || input)
		) {
			exit();
		}
	});

	useAutoExit(
		status === 'done' || status === 'stopped' || status === 'error',
		status === 'error',
	);

	useEffect(() => {
		if (status === 'stopped') {
			process.exitCode = 130;
		}
	}, [status]);

	const run = useCallback(async () => {
		try {
			// Fail fast on unsupported hardware. Without this the run dies much
			// later inside `pip install mlx-lm` with an opaque resolver error.
			assertSupportedPlatform();

			// Check project exists
			if (!configExists()) {
				setError('Not a Nanotune project. Run `nanotune init` first.');
				setStatus('error');
				return;
			}

			// Resume requires an existing checkpoint — fail fast with a clear
			// message rather than letting MLX throw an opaque file-not-found.
			if (options.resume) {
				const adapterFile = join(getAdaptersDir(), 'adapters.safetensors');
				if (!existsSync(adapterFile)) {
					setError(
						'Cannot --resume: no checkpoint found. Run `nanotune train` without --resume first.',
					);
					setStatus('error');
					return;
				}
			}

			// Check MLX
			setStatus('checking');
			const hasMLX = await checkMLXInstalled();
			if (!hasMLX) {
				setStatus('installing');
				await installMLX();
			}

			// Validate data
			setStatus('validating');
			const exampleCount = countExamples();
			if (exampleCount === 0) {
				setError(
					'No training data found. Run `nanotune data add` to add examples.',
				);
				setStatus('error');
				return;
			}

			// Ensure we have a validation set (MLX requires it)
			ensureValidationSet();

			// Load config
			const config = loadConfig();

			// Override with CLI options
			const iterations = options.iterations
				? Number.parseInt(options.iterations, 10)
				: config.training.iterations;
			const learningRate = options.lr
				? Number.parseFloat(options.lr)
				: config.training.learningRate;

			// Dry run check
			if (options.dryRun) {
				setStatus('done');
				return;
			}

			// Download model if not cached
			setStatus('downloading');
			const downloadStart = Date.now();
			const elapsedTimer = setInterval(() => {
				const sec = Math.floor((Date.now() - downloadStart) / 1000);
				const m = Math.floor(sec / 60);
				const s = sec % 60;
				setElapsed(m > 0 ? `${m}m ${s}s` : `${s}s`);
			}, 1000);

			try {
				for await (const event of ensureModelDownloaded(config.baseModel)) {
					if (event.percent != null) {
						setDownloadPercent(event.percent);
					}
					if (event.sizeInfo) {
						setDownloadDetail(event.sizeInfo);
					}
				}
			} finally {
				clearInterval(elapsedTimer);
				setElapsed(null);
			}

			// Start training. The controller is in place before the status flips
			// so a Ctrl+C on the very first frame still has something to abort.
			const controller = new AbortController();
			abortRef.current = controller;
			setStatus('training');
			const startTime = Date.now();

			const trainingOptions: MLXTrainingOptions = {
				model: config.baseModel,
				dataPath: getDataDir(),
				adapterPath: getAdaptersDir(),
				iterations,
				learningRate,
				batchSize: config.training.batchSize,
				numLayers: config.training.numLayers,
				stepsPerEval: config.training.stepsPerEval,
				saveEvery: config.training.saveEvery,
				resume: options.resume,
				signal: controller.signal,
			};

			for await (const update of runTraining(trainingOptions)) {
				setProgress(update);
				setLossHistory(prev => [...prev, update.trainLoss]);

				// Calculate ETA
				const elapsedMs = Date.now() - startTime;
				const iterationsComplete = update.iteration;
				const iterationsRemaining = update.totalIterations - iterationsComplete;
				if (iterationsComplete > 0) {
					const msPerIteration = elapsedMs / iterationsComplete;
					const msRemaining = msPerIteration * iterationsRemaining;
					const secondsRemaining = Math.round(msRemaining / 1000);
					const minutes = Math.floor(secondsRemaining / 60);
					const seconds = secondsRemaining % 60;
					setEta(`${minutes}m ${seconds}s`);
				}
			}

			setStatus(controller.signal.aborted ? 'stopped' : 'done');
		} catch (err) {
			if (shouldTreatAsStop(abortRef.current?.signal, err)) {
				setStatus('stopped');
				return;
			}
			setError(err instanceof Error ? err.message : 'Training failed');
			setStatus('error');
		}
	}, [options.iterations, options.lr, options.resume, options.dryRun]);

	useEffect(() => {
		run();
	}, [run]);

	if (!configExists()) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Training" />
				<StatusMessage variant="error">
					Not a Nanotune project. Run `nanotune init` first.
				</StatusMessage>
			</Box>
		);
	}

	const config = loadConfig();
	const exampleCount = countExamples();

	return (
		<Box flexDirection="column" padding={1}>
			<Header title="Training" />

			<Box flexDirection="column" marginBottom={1}>
				<Text>
					Model: <Text color="cyan">{config.baseModel}</Text>
				</Text>
				<Text>
					Examples: <Text color="cyan">{exampleCount}</Text>
				</Text>
				<Text>
					Iterations:{' '}
					<Text color="cyan">
						{options.iterations || config.training.iterations}
					</Text>
				</Text>
			</Box>

			{status === 'checking' && <Spinner label="Checking dependencies..." />}

			{status === 'installing' && (
				<Spinner label="Installing MLX (this may take a moment)..." />
			)}

			{status === 'validating' && (
				<Spinner label="Validating training data..." />
			)}

			{status === 'downloading' && (
				<Box flexDirection="column">
					<Spinner label="Downloading model..." />
					{downloadPercent != null && downloadPercent > 0 && (
						<Box marginTop={1}>
							<Progress percent={downloadPercent} label="Download" />
						</Box>
					)}
					{downloadDetail && <Text dimColor>{downloadDetail}</Text>}
					{elapsed && <Text dimColor>Elapsed: {elapsed}</Text>}
				</Box>
			)}

			{status === 'training' && progress && (
				<Box flexDirection="column">
					<Progress
						percent={(progress.iteration / progress.totalIterations) * 100}
						label="Progress"
					/>

					<Text>
						Iteration: {progress.iteration}/{progress.totalIterations}
					</Text>

					<Box marginY={1}>
						<LossChart
							data={lossHistory}
							width={40}
							height={6}
							label="Training Loss"
						/>
					</Box>

					<Box>
						<Text>
							Train Loss:{' '}
							<Text color="green">{progress.trainLoss.toFixed(4)}</Text>
						</Text>
						{progress.valLoss && (
							<Text>
								{' | '}Val Loss:{' '}
								<Text color="green">{progress.valLoss.toFixed(4)}</Text>
							</Text>
						)}
						{eta && (
							<Text>
								{' | '}ETA: <Text color="yellow">{eta}</Text>
							</Text>
						)}
					</Box>

					<Text> </Text>
					<Text dimColor>[Ctrl+C] Stop training</Text>
				</Box>
			)}

			{status === 'stopping' && progress && (
				<Box flexDirection="column">
					{(() => {
						const saveEvery = config.training.saveEvery;
						const lastSaved =
							Math.floor(progress.iteration / saveEvery) * saveEvery;
						return (
							<Spinner
								label={
									lastSaved > 0
										? `Stopping training (last checkpoint: iteration ${lastSaved})...`
										: 'Stopping training (no checkpoint saved yet)...'
								}
							/>
						);
					})()}
					<Text dimColor>[Ctrl+C] Quit without waiting</Text>
				</Box>
			)}

			{status === 'stopped' && (
				<Box flexDirection="column">
					<StatusMessage variant="warning">Training stopped</StatusMessage>
					<Text> </Text>
					{progress &&
						(() => {
							const saveEvery = config.training.saveEvery;
							const lastSaved =
								Math.floor(progress.iteration / saveEvery) * saveEvery;
							return lastSaved > 0 ? (
								<>
									<Text>
										Checkpoint saved at iteration{' '}
										<Text color="cyan">{lastSaved}</Text>
									</Text>
									<Text> </Text>
									<Text>
										Resume with:{' '}
										<Text color="cyan">nanotune train --resume</Text>
									</Text>
								</>
							) : (
								<Text>
									No checkpoint saved (stopped before iteration {saveEvery})
								</Text>
							);
						})()}
					<Text> </Text>
					<ExitHint>Press any key to exit</ExitHint>
				</Box>
			)}

			{status === 'done' && (
				<Box flexDirection="column">
					<StatusMessage variant="success">Training complete!</StatusMessage>
					<Text> </Text>
					{progress && (
						<Text>
							Final loss:{' '}
							<Text color="green">{progress.trainLoss.toFixed(4)}</Text>
						</Text>
					)}
					<Text> </Text>
					<Text>
						Next: <Text color="cyan">nanotune export</Text>
					</Text>
					<Text> </Text>
					<ExitHint>Press any key to exit</ExitHint>
				</Box>
			)}

			{status === 'error' && (
				<Box flexDirection="column">
					<StatusMessage variant="error">{error}</StatusMessage>
					<Text> </Text>
					<ExitHint>Press Esc to exit</ExitHint>
				</Box>
			)}
		</Box>
	);
}
