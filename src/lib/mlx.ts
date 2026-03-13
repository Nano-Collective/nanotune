import {execa, type ResultPromise} from 'execa';
import type {
	DependencyStatus,
	DownloadProgress,
	TrainingProgress,
} from '../types/index.js';

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
	await execa('pip3', ['install', 'mlx-lm'], {stdio: 'inherit'});
}

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
    print(json.dumps({"status":"done","percent":100}), flush=True)
`.trim();

export interface DownloadStatus {
	status: 'start' | 'progress' | 'done' | 'error';
	totalSize?: number;
	fileCount?: number;
	downloaded?: number;
	percent?: number;
	error?: string;
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
						yield {type: 'download', percent: 100};
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

export function parseDownloadProgress(line: string): DownloadProgress | null {
	// File download: "model.safetensors: 45%|██▍   |1.2G/2.7G [00:30<00:37, 40.5MB/s]"
	const fileMatch = line.match(
		/^(.+?):\s+(\d+)%\|.*?\|\s*([\d.]+\w+\/[\d.]+\w+)/,
	);
	if (fileMatch) {
		return {
			type: 'download',
			fileName: fileMatch[1].trim(),
			percent: Number.parseInt(fileMatch[2], 10),
			sizeInfo: fileMatch[3],
		};
	}

	// Multi-file fetch: "Fetching 12 files: 75%|██▍   |9/12"
	const fetchMatch = line.match(/^Fetching\s+\d+\s+files?:\s+(\d+)%\|/);
	if (fetchMatch) {
		return {
			type: 'download',
			percent: Number.parseInt(fetchMatch[1], 10),
		};
	}

	// Generic tqdm fallback: anything with N%|
	const genericMatch = line.match(/(\d+)%\|/);
	if (genericMatch) {
		return {
			type: 'download',
			percent: Number.parseInt(genericMatch[1], 10),
		};
	}

	return null;
}

export async function* runTraining(
	options: MLXTrainingOptions,
): AsyncGenerator<TrainingProgress> {
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
	];

	if (options.resume) {
		args.push(
			'--resume-adapter-file',
			`${options.adapterPath}/adapters.safetensors`,
		);
	}

	const subprocess = execa('python3', args, {
		stdout: 'pipe',
		stderr: 'pipe',
		buffer: false,
	});

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

	for await (const chunk of stdout) {
		buffer += chunk.toString();
		const lines = buffer.split('\n');
		buffer = lines.pop() || '';

		for (const line of lines) {
			// Parse: "Iter 10: Train loss 1.234, Val loss 1.456"
			// or: "Iter 10 (15.2 it/s): Train loss 1.234"
			const match = line.match(
				/Iter\s+(\d+)(?:\s*\([^)]+\))?:\s*Train loss\s+([\d.]+)(?:,\s*Val loss\s+([\d.]+))?/i,
			);
			if (match) {
				yield {
					iteration: Number.parseInt(match[1], 10),
					totalIterations: options.iterations,
					trainLoss: Number.parseFloat(match[2]),
					valLoss: match[3] ? Number.parseFloat(match[3]) : undefined,
				};
			}
		}
	}

	try {
		await subprocess;
	} catch (err) {
		// Include stderr in the error message for better debugging
		const errorMessage = err instanceof Error ? err.message : 'Training failed';
		const stderrTrimmed = stderrOutput.trim();
		if (stderrTrimmed) {
			// Extract the most relevant part of the error (last few lines usually have the actual error)
			const stderrLines = stderrTrimmed.split('\n');
			const relevantLines = stderrLines.slice(-10).join('\n');
			throw new Error(`${errorMessage}\n\nDetails:\n${relevantLines}`);
		}
		throw err;
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

export async function runInference(
	model: string,
	prompt: string,
	maxTokens = 100,
): Promise<string> {
	const result = await execa('python3', [
		'-m',
		'mlx_lm.generate',
		'--model',
		model,
		'--prompt',
		prompt,
		'--max-tokens',
		String(maxTokens),
	]);

	return result.stdout;
}

export function abortTraining(subprocess: ResultPromise): void {
	subprocess.kill('SIGINT');
}
