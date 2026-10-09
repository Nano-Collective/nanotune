import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execa, type ResultPromise} from 'execa';
import type {
	DependencyStatus,
	DownloadProgress,
	FineTuneType,
	TrainingProgress,
} from '../types/index.js';
import {
	EARLY_STOPPING_SCRIPT,
	parseSelectionEvent,
	type SelectionEvent,
} from './early-stopping.js';

export interface MLXTrainingOptions {
	model: string;
	dataPath: string;
	adapterPath: string;
	iterations: number;
	learningRate: number;
	batchSize: number;
	numLayers: number;
	stepsPerEval: number;
	saveEvery: number;
	resume?: boolean;
	fineTuneType: FineTuneType;
	loraRank: number;
	loraAlpha: number;
	loraDropout: number;
	maxSeqLength: number;
	gradCheckpoint: boolean;
	valBatches: number;
	seed: number;
	earlyStoppingPatience: number;
	loadBestModelAtEnd: boolean;
	/**
	 * Optional AbortSignal for stopping a run early. Aborting sends SIGINT so
	 * MLX writes its checkpoint before exiting; the generator then returns
	 * normally, since a user-requested stop is not a training failure.
	 */
	signal?: AbortSignal;
	/** All loss reports, including standalone validation evaluations. */
	onLoss?: (point: TrainingLossPoint) => void;
	/** Called once MLX reports a checkpoint write has completed. */
	onCheckpoint?: () => void;
	onSelection?: (progress: TrainingProgress) => void;
}

export interface TrainingLossPoint {
	iteration: number;
	trainLoss?: number;
	valLoss?: number;
}

/** MLX reports train and validation losses on separate lines. */
export function parseTrainingLoss(line: string): TrainingLossPoint | null {
	const prefix = line.match(
		/Iter\s+(\d+)(?:\s*\([^)]+\))?:\s*(?:Train|Val) loss/i,
	);
	if (!prefix) return null;
	const number = '([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?)';
	const train = line.match(new RegExp(`Train loss\\s+${number}`, 'i'));
	const val = line.match(new RegExp(`Val loss\\s+${number}`, 'i'));
	const point: TrainingLossPoint = {iteration: Number(prefix[1])};
	if (train && Number.isFinite(Number(train[1])))
		point.trainLoss = Number(train[1]);
	if (val && Number.isFinite(Number(val[1]))) point.valLoss = Number(val[1]);
	return point.trainLoss === undefined && point.valLoss === undefined
		? null
		: point;
}

// mlx_lm has no flat CLI flags for LoRA rank/scale/dropout. They are only
// settable via a YAML config's `lora_parameters` block, passed with -c/--config.
// (mlx_lm calls the field `scale`; Nanotune's schema/CLI call it `alpha` to
// match common LoRA terminology and issue #72's wording.)
//
// Values reach here already validated as finite numbers by TrainingConfigSchema,
// but `String(1e-7)` yields exponent notation that PyYAML's 1.1 resolver reads
// as a string rather than a float, so anything below 1e-6 is written in fixed
// notation instead.
function yamlNumber(value: number): string {
	return Math.abs(value) < 1e-6 && value !== 0
		? value.toFixed(20)
		: String(value);
}

export function buildLoraConfigYaml(
	rank: number,
	alpha: number,
	dropout: number,
): string {
	return `lora_parameters:\n  rank: ${yamlNumber(rank)}\n  scale: ${yamlNumber(alpha)}\n  dropout: ${yamlNumber(dropout)}\n`;
}

export async function checkPython(): Promise<{
	installed: boolean;
	version?: string;
}> {
	try {
		const result = await execa('python3', ['--version']);
		const versionMatch = result.stdout.match(/Python (\d+\.\d+\.\d+)/);
		return {
			installed: true,
			version: versionMatch?.[1],
		};
	} catch {
		return {installed: false};
	}
}

export async function checkMLXInstalled(): Promise<boolean> {
	try {
		await execa('python3', ['-c', 'import mlx_lm']);
		return true;
	} catch {
		return false;
	}
}

export async function installMLX(): Promise<void> {
	try {
		// Try the friendly user-site install first; on stock macOS Python 3.12+
		// this avoids the externally-managed-environment lockout.
		await execa('pip3', ['install', '--user', 'mlx-lm'], {
			stdout: 'inherit',
			stderr: 'pipe',
		});
	} catch (err) {
		const stderr =
			err && typeof err === 'object' && 'stderr' in err
				? String((err as {stderr: unknown}).stderr ?? '')
				: '';

		if (stderr.includes('externally-managed-environment')) {
			throw new Error(
				'pip refuses to install mlx-lm into the system Python (externally-managed-environment).\n' +
					'Pick one of:\n' +
					'  • Create a venv: python3 -m venv ~/.nanotune/venv && source ~/.nanotune/venv/bin/activate && pip install mlx-lm\n' +
					'  • Install via pipx: pipx install mlx-lm\n' +
					'  • Override (not recommended): pip3 install --user --break-system-packages mlx-lm\n' +
					'Then re-run `nanotune train`.',
			);
		}

		const tail = stderr.trim().split('\n').slice(-10).join('\n');
		throw new Error(
			`Failed to install mlx-lm via pip3.${tail ? `\n\nDetails:\n${tail}` : ''}`,
		);
	}
}

/**
 * @public Deliberately uncalled. Kept for `nanotune doctor` (#65), which is
 * what will surface a toolchain check to the user. Note `llamaCpp` is
 * hardcoded false — llama.cpp is checked separately in llama-cpp.ts.
 */
export async function checkDependencies(): Promise<DependencyStatus> {
	const python = await checkPython();
	const mlx = python.installed ? await checkMLXInstalled() : false;

	return {
		python: python.installed,
		pythonVersion: python.version,
		mlx,
		llamaCpp: false, // Will be checked separately
	};
}

// Python script that downloads a model via huggingface_hub and reports
// progress as JSON lines on stdout by polling the cache blobs directory.
// This avoids all tqdm/pipe/TTY issues by monitoring actual disk usage.
const DOWNLOAD_SCRIPT = `
import sys, json, os, time, threading
os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '1'
from huggingface_hub import snapshot_download, HfApi, constants

model_id = sys.argv[1]
api = HfApi()
total_size = 0

# Get model info for total size
try:
    info = api.model_info(model_id, files_metadata=True)
    siblings = info.siblings or []
    total_size = sum(s.size for s in siblings if s.size)
    file_count = len(siblings)
    print(json.dumps({"status":"start","totalSize":total_size,"fileCount":file_count}), flush=True)
except Exception:
    print(json.dumps({"status":"start","totalSize":0,"fileCount":0}), flush=True)

# Build cache dir path (mirrors huggingface_hub convention)
cache_dir = constants.HF_HUB_CACHE
repo_folder = os.path.join(cache_dir, "models--" + model_id.replace("/", "--"))
blobs_dir = os.path.join(repo_folder, "blobs")

def get_downloaded_bytes():
    """Sum sizes of all blobs + incomplete files in the cache."""
    total = 0
    if not os.path.isdir(blobs_dir):
        return 0
    for name in os.listdir(blobs_dir):
        try:
            total += os.path.getsize(os.path.join(blobs_dir, name))
        except OSError:
            pass
    return total

# Run download in a thread so we can poll progress on the main thread
result = {"error": None, "path": None}
def download():
    try:
        result["path"] = snapshot_download(model_id)
    except Exception as e:
        result["error"] = str(e)

t = threading.Thread(target=download)
t.start()

# Poll progress while download thread runs
while t.is_alive():
    downloaded = get_downloaded_bytes()
    if total_size > 0:
        pct = min(99, round(downloaded / total_size * 100))
        print(json.dumps({"status":"progress","downloaded":downloaded,"totalSize":total_size,"percent":pct}), flush=True)
    t.join(timeout=0.25)

# Final status
if result["error"]:
    print(json.dumps({"status":"error","error":result["error"]}), flush=True)
    sys.exit(1)
else:
    print(json.dumps({"status":"done","percent":100,"path":result["path"]}), flush=True)
`.trim();

export interface DownloadStatus {
	status: 'start' | 'progress' | 'done' | 'error';
	totalSize?: number;
	fileCount?: number;
	downloaded?: number;
	percent?: number;
	error?: string;
	/** Resolved local snapshot directory, present on the final 'done' event. */
	path?: string;
}

export async function* ensureModelDownloaded(
	model: string,
): AsyncGenerator<DownloadProgress> {
	const subprocess = execa('python3', ['-c', DOWNLOAD_SCRIPT, model], {
		stdout: 'pipe',
		stderr: 'pipe',
		buffer: false,
		env: {
			...process.env,
			PYTHONUNBUFFERED: '1',
		},
	});

	const stdout = subprocess.stdout;
	if (!stdout) {
		throw new Error('Failed to get stdout from download process');
	}

	let stderrOutput = '';
	if (subprocess.stderr) {
		subprocess.stderr.on('data', (chunk: Buffer) => {
			stderrOutput += chunk.toString();
		});
	}

	let buffer = '';
	let downloadError: string | null = null;

	// The for-await can throw ABORT_ERR if the process exits mid-stream.
	// Catch that and let the subprocess result handler below surface the real error.
	try {
		for await (const chunk of stdout) {
			buffer += chunk.toString();
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const msg: DownloadStatus = JSON.parse(line);
					if (msg.status === 'start') {
						const sizeInfo =
							msg.totalSize && msg.totalSize > 0
								? `${msg.fileCount} files, ${formatBytes(msg.totalSize)} total`
								: undefined;
						yield {type: 'download', sizeInfo};
					} else if (msg.status === 'progress') {
						yield {
							type: 'download',
							percent: msg.percent,
							sizeInfo:
								msg.downloaded && msg.totalSize
									? `${formatBytes(msg.downloaded)} / ${formatBytes(msg.totalSize)}`
									: undefined,
						};
					} else if (msg.status === 'done') {
						yield {type: 'download', percent: 100, path: msg.path};
					} else if (msg.status === 'error') {
						downloadError = msg.error || 'Model download failed';
					}
				} catch (err) {
					if (err instanceof SyntaxError) continue;
					throw err;
				}
			}
		}
	} catch {
		// Stream aborted — process exited, handled below
	}

	// Check for errors from the Python script or subprocess
	if (downloadError) {
		throw new Error(`Model download failed: ${downloadError}`);
	}

	try {
		await subprocess;
	} catch (err) {
		const stderrTrimmed = stderrOutput.trim();
		if (stderrTrimmed) {
			const stderrLines = stderrTrimmed.split('\n');
			const relevantLines = stderrLines.slice(-10).join('\n');
			throw new Error(`Model download failed\n\nDetails:\n${relevantLines}`);
		}
		throw new Error(
			err instanceof Error ? err.message : 'Model download failed',
		);
	}
}

function formatBytes(bytes: number, decimals = 2): string {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(decimals)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(decimals)} MB`;
	return `${(bytes / 1e3).toFixed(decimals)} KB`;
}

/**
 * `full` fine-tuning trains the weights directly, so mlx_lm never reads
 * `lora_parameters` and writing the temp YAML would be dead work.
 */
export function needsLoraConfig(fineTuneType: FineTuneType): boolean {
	return fineTuneType !== 'full';
}

/**
 * Builds the mlx_lm argv. Split out from `runTraining` so the flag wiring is
 * testable without spawning a trainer. `loraConfigPath` is the temp YAML from
 * `buildLoraConfigYaml`, omitted for `full` fine-tuning.
 */
export function buildTrainingArgs(
	options: MLXTrainingOptions,
	loraConfigPath?: string,
): string[] {
	const args = [
		'-m',
		'mlx_lm',
		'lora',
		'--model',
		options.model,
		'--train',
		'--data',
		options.dataPath,
		'--adapter-path',
		options.adapterPath,
		'--iters',
		String(options.iterations),
		'--learning-rate',
		String(options.learningRate),
		'--batch-size',
		String(options.batchSize),
		'--num-layers',
		String(options.numLayers),
		'--steps-per-eval',
		String(options.stepsPerEval),
		'--save-every',
		String(options.saveEvery),
		'--fine-tune-type',
		options.fineTuneType,
		'--max-seq-length',
		String(options.maxSeqLength),
		'--val-batches',
		String(options.valBatches),
		'--seed',
		String(options.seed),
	];

	if (options.gradCheckpoint) {
		args.push('--grad-checkpoint');
	}

	// mlx_lm merges the -c config with the explicit flags above, with the
	// explicit flags winning on overlap, so this only supplies rank/scale/dropout.
	if (loraConfigPath) {
		args.push('-c', loraConfigPath);
	}

	if (options.resume) {
		args.push(
			'--resume-adapter-file',
			`${options.adapterPath}/adapters.safetensors`,
		);
	}

	return args;
}

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

const RICH_VAL = /^\s*(\d+)\s+val\s+([0-9]*\.?[0-9]+)/i;
const RICH_TRAIN = /^\s*(\d+)\s+([0-9]*\.?[0-9]+)\s+[▼▲]/;

interface ParsedTrainingLine {
	iteration: number;
	trainLoss?: number;
	valLoss?: number;
}

export function parseTrainingLogLine(raw: string): ParsedTrainingLine | null {
	const line = raw.replace(ANSI, '');
	const plain = parseTrainingLoss(line);
	if (plain) return plain;
	const val = line.match(RICH_VAL);
	if (val) {
		return {
			iteration: Number.parseInt(val[1], 10),
			valLoss: Number.parseFloat(val[2]),
		};
	}
	const richTrain = line.match(RICH_TRAIN);
	if (richTrain) {
		return {
			iteration: Number.parseInt(richTrain[1], 10),
			trainLoss: Number.parseFloat(richTrain[2]),
		};
	}
	return null;
}

/** Publish a fully copied checkpoint atomically; a failed copy keeps the target. */
export function restoreAdapterFile(src: string, dest: string): void {
	const temp = `${dest}.restore-${process.pid}.tmp`;
	try {
		copyFileSync(src, temp);
		renameSync(temp, dest);
	} finally {
		rmSync(temp, {force: true});
	}
}

export async function* runTraining(
	options: MLXTrainingOptions,
): AsyncGenerator<TrainingProgress> {
	// LoRA rank/alpha/dropout have no flat CLI flags, so they go in a temp YAML
	// config. Directory creation happens inside the try so a failed write still
	// gets cleaned up in the finally below rather than leaking a temp dir.
	let loraConfigDir: string | null = null;
	let detachAbort: (() => void) | null = null;
	let subprocess: ResultPromise | undefined;
	let subprocessSettled = false;
	let selectionDir: string | null = null;
	try {
		let loraConfigPath: string | undefined;
		if (needsLoraConfig(options.fineTuneType)) {
			loraConfigDir = mkdtempSync(join(tmpdir(), 'nanotune-lora-'));
			loraConfigPath = join(loraConfigDir, 'lora.yaml');
			writeFileSync(
				loraConfigPath,
				buildLoraConfigYaml(
					options.loraRank,
					options.loraAlpha,
					options.loraDropout,
				),
			);
		}

		const selectBest =
			options.earlyStoppingPatience > 0 || options.loadBestModelAtEnd;
		if (selectBest)
			selectionDir = mkdtempSync(join(tmpdir(), 'nanotune-selection-'));
		const bestPath = selectionDir
			? join(selectionDir, 'best.safetensors')
			: null;
		const args = buildTrainingArgs(options, loraConfigPath);
		// The wrapper runs the same CLI, injecting a callback at the evaluation
		// boundary. A unique path excludes every previous run's checkpoints.
		const argv =
			selectBest && bestPath
				? [
						'-c',
						EARLY_STOPPING_SCRIPT,
						String(options.earlyStoppingPatience),
						String(options.loadBestModelAtEnd),
						bestPath,
						...args.slice(3),
					]
				: args;
		subprocess = execa('python3', argv, {
			stdout: 'pipe',
			stderr: 'pipe',
			buffer: false,
		});

		detachAbort = stopOnAbort(subprocess, options.signal);

		const stdout = subprocess.stdout;
		const stderr = subprocess.stderr;
		if (!stdout) {
			throw new Error('Failed to get stdout from training process');
		}

		// Collect stderr for error reporting
		let stderrOutput = '';
		if (stderr) {
			stderr.on('data', (chunk: Buffer) => {
				stderrOutput += chunk.toString();
			});
		}

		let buffer = '';
		let selection: SelectionEvent | null = null;
		let last: TrainingProgress | null = null;
		let latestValLoss: number | undefined;
		function parseUpdate(line: string): TrainingProgress | null {
			const event = parseSelectionEvent(line);
			if (event?.type === 'selection') {
				selection = event;
				return null;
			}
			if (event?.type === 'validation') {
				if (event.valLoss !== null) {
					options.onLoss?.({
						iteration: event.iteration,
						valLoss: event.valLoss,
					});
					latestValLoss = event.valLoss;
				}
				return null;
			}
			if (/Saved (?:adapter|final) weights/i.test(line))
				options.onCheckpoint?.();
			const point = parseTrainingLogLine(line);
			if (!point) return null;
			// Structured evaluations already carry the correct optimizer step.
			if (!selectBest) {
				options.onLoss?.(point);
				if (point.valLoss !== undefined) latestValLoss = point.valLoss;
			} else if (point.trainLoss !== undefined) {
				options.onLoss?.({
					iteration: point.iteration,
					trainLoss: point.trainLoss,
				});
			}
			if (point.trainLoss === undefined) return null;
			const update = {
				iteration: point.iteration,
				totalIterations: options.iterations,
				trainLoss: point.trainLoss,
				valLoss: latestValLoss,
				isTrainReport: true,
			};
			last = update;
			return update;
		}

		// The for-await can throw ABORT_ERR if the process exits mid-stream, which
		// is exactly what a SIGINT stop looks like. Let the subprocess result below
		// decide whether that was a stop or a real failure.
		try {
			for await (const chunk of stdout) {
				buffer += chunk.toString();
				const lines = buffer.split(/\r\n|\n|\r/);
				buffer = lines.pop() || '';

				for (const line of lines) {
					const update = parseUpdate(line);
					if (update) yield update;
				}
			}
		} catch (err) {
			if (!(err instanceof Error && err.name === 'AbortError')) {
				throw err;
			}
		}

		const finalUpdate = parseUpdate(buffer);
		if (finalUpdate) yield finalUpdate;
		try {
			await subprocess;
			subprocessSettled = true;
		} catch (err) {
			subprocessSettled = true;
			if (!options.signal?.aborted) {
				const errorMessage =
					err instanceof Error ? err.message : 'Training failed';
				const stderrTrimmed = stderrOutput.trim();
				if (stderrTrimmed) {
					const stderrLines = stderrTrimmed.split('\n');
					const relevantLines = stderrLines.slice(-10).join('\n');
					throw new Error(`${errorMessage}\n\nDetails:\n${relevantLines}`);
				}
				throw err;
			}
		}

		if (options.signal?.aborted) return;
		if (selectBest) {
			// Successful exit must include the callback's result. Never infer a
			// best checkpoint from console output or a stale numbered file.
			const result = selection as SelectionEvent | null;
			if (!result)
				throw new Error('MLX did not report best-checkpoint selection.');
			let restoredBest = false;
			if (result.restoreBest && bestPath) {
				if (!existsSync(bestPath))
					throw new Error('The evaluated best checkpoint is missing.');
				restoreAdapterFile(
					bestPath,
					join(options.adapterPath, 'adapters.safetensors'),
				);
				restoredBest = true;
				options.onCheckpoint?.();
			}
			const summary: TrainingProgress = {
				iteration: (last as TrainingProgress | null)?.iteration ?? 0,
				totalIterations: options.iterations,
				trainLoss: (last as TrainingProgress | null)?.trainLoss,
				valLoss: latestValLoss,
				isTrainReport: false,
				earlyStopped: result.earlyStopped,
				restoredBest,
				bestIteration: result.bestIteration ?? undefined,
				bestValLoss: result.bestValLoss ?? undefined,
			};
			options.onSelection?.(summary);
			yield summary;
		}
	} finally {
		detachAbort?.();
		// A failed history write or a consumer ending the generator must not
		// leave a trainer updating weights after its run has been finalized.
		if (subprocess && !subprocessSettled) {
			subprocess.kill('SIGINT');
			await subprocess.catch(() => {});
		}
		if (loraConfigDir) {
			rmSync(loraConfigDir, {recursive: true, force: true});
		}
		if (selectionDir) rmSync(selectionDir, {recursive: true, force: true});
	}
}

export async function fuseAdapters(
	model: string,
	adapterPath: string,
	outputPath: string,
): Promise<void> {
	await execa('python3', [
		'-m',
		'mlx_lm.fuse',
		'--model',
		model,
		'--adapter-path',
		adapterPath,
		'--save-path',
		outputPath,
	]);
}

/**
 * Stop `subprocess` as soon as `signal` aborts. Split out from `runTraining`
 * so the wiring — including a signal that is already aborted, which never
 * fires an `abort` event — is testable without spawning a trainer.
 *
 * Returns a detach function. Callers must invoke it once the run is over:
 * a caller-owned signal outlives the subprocess, and a listener left attached
 * would signal a dead (or PID-recycled) process on a later abort.
 */
export function stopOnAbort(
	subprocess: ResultPromise,
	signal?: AbortSignal,
): () => void {
	if (!signal) {
		return () => {};
	}
	if (signal.aborted) {
		abortTraining(subprocess);
		return () => {};
	}
	const onAbort = () => abortTraining(subprocess);
	signal.addEventListener('abort', onAbort, {once: true});
	return () => signal.removeEventListener('abort', onAbort);
}

export function abortTraining(subprocess: ResultPromise): void {
	subprocess.kill('SIGINT');
}

/**
 * True when a thrown error should be reported as a user-requested stop rather
 * than a training failure. The error itself is deliberately not inspected: once
 * we have sent SIGINT, whatever surfaces (an ExecaError, an aborted stream) is
 * a consequence of the stop we asked for.
 */
export function shouldTreatAsStop(signal?: AbortSignal): boolean {
	return signal?.aborted === true;
}
