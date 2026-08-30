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
import {TrainingConfigSchema, type TrainingProgress} from '../types/index.js';

// Maps TrainingConfigSchema field names to the CLI flag that overrides them,
// so schema validation errors can point at the flag the user actually typed.
// `seed` is the mlx_lm training seed, overridden by --train-seed; the bare
// --seed flag is Nanotune's train/validation split seed and is handled
// separately below.
const TRAINING_FLAG_NAMES: Record<string, string> = {
	iterations: '-i, --iterations',
	learningRate: '--lr',
	batchSize: '--batch-size',
	numLayers: '--num-layers',
	stepsPerEval: '--steps-per-eval',
	saveEvery: '--save-every',
	fineTuneType: '--fine-tune-type',
	loraRank: '--lora-rank',
	loraAlpha: '--lora-alpha',
	loraDropout: '--lora-dropout',
	maxSeqLength: '--max-seq-length',
	valBatches: '--val-batches',
	seed: '--train-seed',
};

// Absent flag stays absent so the config value wins. Anything unparseable
// becomes NaN, which TrainingConfigSchema rejects with the field name attached.
// Number() rather than parseInt/parseFloat so "8abc" fails instead of becoming
// 8; a blank value is screened out first because Number('') is 0.
function numericOverride(raw?: string): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed === '' ? Number.NaN : Number(trimmed);
}

interface Props {
	options: {
		iterations?: string;
		lr?: string;
		batchSize?: string;
		numLayers?: string;
		stepsPerEval?: string;
		saveEvery?: string;
		fineTuneType?: string;
		loraRank?: string;
		loraAlpha?: string;
		loraDropout?: string;
		maxSeqLength?: string;
		gradCheckpoint?: boolean;
		valBatches?: string;
		trainSeed?: string;
		resume?: boolean;
		dryRun?: boolean;
		seed?: string;
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
	const [split, setSplit] = useState<{
		trainCount: number;
		validCount: number;
		didSplit: boolean;
	} | null>(null);
	const [seedIgnored, setSeedIgnored] = useState(false);
	// The checkpoint interval the run actually used. `--save-every` overrides
	// config.json, so the stop/stopped views must report against this rather
	// than re-reading config.training.saveEvery and naming the wrong iteration.
	const [saveEvery, setSaveEvery] = useState<number | null>(null);
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
			// Parse the seed before any work happens. Number.parseInt would turn
			// a typo into NaN and mulberry32 would coerce that to 0, producing a
			// confidently deterministic split under a seed the user never asked
			// for; `--seed 3.7` would silently truncate the same way. Number()
			// rejects both, but reads blank input as 0, so that is screened out
			// first. Testing against undefined rather than truthiness keeps
			// `--seed 0` a real seed.
			let seed: number | undefined;
			if (options.seed !== undefined) {
				const raw = options.seed.trim();
				const parsed = raw === '' ? Number.NaN : Number(raw);
				if (!Number.isInteger(parsed)) {
					setError(`Invalid --seed "${options.seed}": expected an integer.`);
					setStatus('error');
					return;
				}
				seed = parsed;
			}

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

			// Load config
			const config = loadConfig();

			// Override with CLI options. Number() rather than parseInt/parseFloat
			// so trailing garbage ("8abc") becomes NaN and gets caught below
			// instead of being silently truncated to a plausible-looking value.
			const overrides = {
				iterations: numericOverride(options.iterations),
				learningRate: numericOverride(options.lr),
				batchSize: numericOverride(options.batchSize),
				numLayers: numericOverride(options.numLayers),
				stepsPerEval: numericOverride(options.stepsPerEval),
				saveEvery: numericOverride(options.saveEvery),
				fineTuneType: options.fineTuneType,
				loraRank: numericOverride(options.loraRank),
				loraAlpha: numericOverride(options.loraAlpha),
				loraDropout: numericOverride(options.loraDropout),
				maxSeqLength: numericOverride(options.maxSeqLength),
				gradCheckpoint: options.gradCheckpoint,
				valBatches: numericOverride(options.valBatches),
				seed: numericOverride(options.trainSeed),
			};

			// Fail fast, before the slow MLX install and data-validation steps,
			// rather than letting a bad value reach mlx_lm as NaN or an
			// out-of-range number. TrainingConfigSchema is the single source of
			// truth for valid ranges and enum values (also enforced on
			// config.json itself via loadConfig() above).
			const validation = TrainingConfigSchema.safeParse({
				...config.training,
				...Object.fromEntries(
					Object.entries(overrides).filter(([, value]) => value !== undefined),
				),
			});
			if (!validation.success) {
				const issue = validation.error.issues[0];
				const field = String(issue.path[0]);
				// Only blame a flag when the user actually passed one; otherwise
				// the bad value came from config.json and saying so is the fix.
				const source =
					overrides[field as keyof typeof overrides] === undefined
						? `config.training.${field}`
						: (TRAINING_FLAG_NAMES[field] ?? field);
				setError(`Invalid value for ${source}: ${issue.message}`);
				setStatus('error');
				return;
			}
			const training = validation.data;
			setSaveEvery(training.saveEvery);

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

			// Dry run check. This returns before the split so that a command
			// documented as "validate config without training" leaves train.jsonl
			// and valid.jsonl exactly as it found them.
			if (options.dryRun) {
				setStatus('done');
				return;
			}

			// Ensure we have a validation set (MLX requires it).
			const split = ensureValidationSet(seed);
			setSplit(split);
			// The split only happens when there is no validation set yet, so a
			// seed handed to an already-split project changes nothing. Saying so
			// beats letting the user believe they re-rolled the split.
			if (seed !== undefined && !split.didSplit) {
				setSeedIgnored(true);
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

			// Spread the parsed schema output rather than the raw locals: these
			// are the values validation actually approved, and they arrive
			// correctly typed, so mlx_lm cannot receive something the checks
			// above never saw.
			const trainingOptions: MLXTrainingOptions = {
				...training,
				model: config.baseModel,
				dataPath: getDataDir(),
				adapterPath: getAdaptersDir(),
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
			if (shouldTreatAsStop(abortRef.current?.signal)) {
				setStatus('stopped');
				return;
			}
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
		options.fineTuneType,
		options.loraRank,
		options.loraAlpha,
		options.loraDropout,
		options.maxSeqLength,
		options.gradCheckpoint,
		options.valBatches,
		options.trainSeed,
		options.resume,
		options.dryRun,
		options.seed,
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
	// This component re-renders on every training update, so prefer the counts
	// the split already returned over re-reading both files each time.
	const exampleCount = split ? split.trainCount : countExamples();
	const validCount = split ? split.validCount : countExamples(true);

	return (
		<Box flexDirection="column" padding={1}>
			<Header title="Training" />

			<Box flexDirection="column" marginBottom={1}>
				<Text>
					Model: <Text color="cyan">{config.baseModel}</Text>
				</Text>
				<Text>
					Examples: <Text color="cyan">{exampleCount}</Text> train
					{' | '}
					<Text color="cyan">{validCount}</Text> validation
				</Text>
				{split?.didSplit && (
					<Text color="yellow">
						Split {split.trainCount + split.validCount} examples into{' '}
						{split.trainCount} train / {split.validCount} validation.
					</Text>
				)}
				{seedIgnored && (
					<Text color="yellow">
						Existing validation set found - --seed ignored. Delete valid.jsonl
						to re-split.
					</Text>
				)}
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
						const interval = saveEvery ?? config.training.saveEvery;
						const lastSaved =
							Math.floor(progress.iteration / interval) * interval;
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
							const interval = saveEvery ?? config.training.saveEvery;
							const lastSaved =
								Math.floor(progress.iteration / interval) * interval;
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
									No checkpoint saved (stopped before iteration {interval})
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
