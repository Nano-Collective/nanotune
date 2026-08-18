import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {Spinner, StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp} from 'ink';
import {useCallback, useEffect, useState} from 'react';
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
} from '../lib/mlx.js';
import {assertSupportedPlatform} from '../lib/platform.js';
import type {TrainingProgress} from '../types/index.js';

interface Props {
	options: {
		iterations?: string;
		lr?: string;
		batchSize?: string;
		numLayers?: string;
		stepsPerEval?: string;
		saveEvery?: string;
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

	useKeyInput((input, key) => {
		if (key.escape && status !== 'training' && status !== 'downloading') {
			exit();
		}
		if ((status === 'done' || status === 'error') && (key.return || input)) {
			exit();
		}
	});

	useAutoExit(status === 'done' || status === 'error', status === 'error');

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
			const batchSize = options.batchSize
				? Number.parseInt(options.batchSize, 10)
				: config.training.batchSize;
			const numLayers = options.numLayers
				? Number.parseInt(options.numLayers, 10)
				: config.training.numLayers;
			const stepsPerEval = options.stepsPerEval
				? Number.parseInt(options.stepsPerEval, 10)
				: config.training.stepsPerEval;
			const saveEvery = options.saveEvery
				? Number.parseInt(options.saveEvery, 10)
				: config.training.saveEvery;

			// Fail fast on unparseable numeric flags rather than letting NaN
			// reach mlx_lm as a literal "NaN" argument with an opaque error.
			const numericOverrides: Array<[flag: string, value: number]> = [
				['-i, --iterations', iterations],
				['--lr', learningRate],
				['--batch-size', batchSize],
				['--num-layers', numLayers],
				['--steps-per-eval', stepsPerEval],
				['--save-every', saveEvery],
			];
			for (const [flag, value] of numericOverrides) {
				if (!Number.isFinite(value)) {
					setError(`Invalid value for ${flag}: must be a number.`);
					setStatus('error');
					return;
				}
			}

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

			// Start training
			setStatus('training');
			const startTime = Date.now();

			const trainingOptions: MLXTrainingOptions = {
				model: config.baseModel,
				dataPath: getDataDir(),
				adapterPath: getAdaptersDir(),
				iterations,
				learningRate,
				batchSize,
				numLayers,
				stepsPerEval,
				saveEvery,
				resume: options.resume,
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

			setStatus('done');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Training failed');
			setStatus('error');
		}
	}, [
		options.iterations,
		options.lr,
		options.batchSize,
		options.numLayers,
		options.stepsPerEval,
		options.saveEvery,
		options.resume,
		options.dryRun,
	]);

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
					<Text dimColor>[Ctrl+C] Stop training (checkpoint saved)</Text>
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
