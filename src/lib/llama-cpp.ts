import {createWriteStream, existsSync, mkdirSync} from 'node:fs';
import {chmod, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {execa, type ResultPromise} from 'execa';
import type {ChatMessage, QuantizationType} from '../types/index.js';
import {assertSupportedPlatform} from './platform.js';

const LLAMA_CPP_DIR = join(homedir(), '.nanotune', 'llama.cpp');
const LLAMA_CPP_BIN_DIR = join(LLAMA_CPP_DIR, 'bin');

// We'll fetch the latest release dynamically
const GITHUB_API_LATEST =
	'https://api.github.com/repos/ggerganov/llama.cpp/releases/latest';

export function getLlamaCppPath(): string {
	return LLAMA_CPP_DIR;
}

export function getLlamaCppBinDir(): string {
	return LLAMA_CPP_BIN_DIR;
}

export async function checkLlamaCppInstalled(): Promise<boolean> {
	const quantizePath = join(LLAMA_CPP_BIN_DIR, 'llama-quantize');
	const convertScript = join(LLAMA_CPP_DIR, 'convert_hf_to_gguf.py');
	const ggufPyDir = join(LLAMA_CPP_DIR, 'gguf-py');
	// Need all three: binary, convert script, and gguf-py
	return (
		existsSync(quantizePath) &&
		existsSync(convertScript) &&
		existsSync(ggufPyDir)
	);
}

interface GitHubAsset {
	name: string;
	browser_download_url: string;
}

interface GitHubRelease {
	tag_name: string;
	assets: GitHubAsset[];
}

async function getLatestRelease(): Promise<{
	tag: string;
	downloadUrl: string;
}> {
	const response = await fetch(GITHUB_API_LATEST, {
		headers: {Accept: 'application/vnd.github.v3+json'},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch release info: ${response.statusText}`);
	}

	const release = (await response.json()) as GitHubRelease;

	// Find the macOS arm64 binary (Apple Silicon)
	const asset = release.assets.find(
		a => a.name.includes('macos-arm64') && a.name.endsWith('.tar.gz'),
	);

	if (!asset) {
		throw new Error('Could not find macOS arm64 binary in latest release');
	}

	return {
		tag: release.tag_name,
		downloadUrl: asset.browser_download_url,
	};
}

async function downloadAndExtract(url: string, destDir: string): Promise<void> {
	const tarPath = join(destDir, 'llama.tar.gz');

	// Download
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download: ${response.statusText}`);
	}

	// Save to file
	const fileStream = createWriteStream(tarPath);
	await pipeline(response.body as unknown as NodeJS.ReadableStream, fileStream);

	// Extract
	await execa('tar', ['-xzf', tarPath, '-C', destDir, '--strip-components=1']);

	// Clean up tarball
	await rm(tarPath);

	// Make binaries executable
	const binaries = [
		'llama-quantize',
		'llama-cli',
		'llama-server',
		'llama-gguf-split',
	];
	for (const bin of binaries) {
		const binPath = join(destDir, bin);
		if (existsSync(binPath)) {
			await chmod(binPath, 0o755);
		}
	}
}

async function downloadConvertScript(tag: string): Promise<void> {
	const scriptPath = join(LLAMA_CPP_DIR, 'convert_hf_to_gguf.py');
	const ggufPyDir = join(LLAMA_CPP_DIR, 'gguf-py');

	// Clean up old versions first
	if (existsSync(scriptPath)) {
		await rm(scriptPath);
	}
	if (existsSync(ggufPyDir)) {
		await rm(ggufPyDir, {recursive: true});
	}

	// Download the convert script matching the release version
	const scriptUrl = `https://raw.githubusercontent.com/ggerganov/llama.cpp/${tag}/convert_hf_to_gguf.py`;

	const response = await fetch(scriptUrl);
	if (!response.ok || !response.body) {
		throw new Error(
			`Failed to download convert script: ${response.statusText}`,
		);
	}

	const fileStream = createWriteStream(scriptPath);
	await pipeline(response.body as unknown as NodeJS.ReadableStream, fileStream);
	await chmod(scriptPath, 0o755);

	// Download the bundled gguf-py package (the script uses this instead of pip gguf)
	mkdirSync(ggufPyDir, {recursive: true});

	// Download gguf-py as a tarball from the release
	const ggufTarUrl = `https://github.com/ggerganov/llama.cpp/archive/${tag}.tar.gz`;
	const ggufTarPath = join(LLAMA_CPP_DIR, 'repo.tar.gz');

	const ggufResponse = await fetch(ggufTarUrl);
	if (!ggufResponse.ok || !ggufResponse.body) {
		throw new Error(`Failed to download gguf-py: ${ggufResponse.statusText}`);
	}

	const ggufFileStream = createWriteStream(ggufTarPath);
	await pipeline(
		ggufResponse.body as unknown as NodeJS.ReadableStream,
		ggufFileStream,
	);

	// Extract just the gguf-py directory
	await execa('tar', [
		'-xzf',
		ggufTarPath,
		'-C',
		LLAMA_CPP_DIR,
		'--strip-components=1',
		`llama.cpp-${tag}/gguf-py`,
	]);

	// Clean up tarball
	await rm(ggufTarPath);
}

export async function* installLlamaCpp(): AsyncGenerator<string> {
	assertSupportedPlatform();

	// Create directories
	if (!existsSync(LLAMA_CPP_DIR)) {
		mkdirSync(LLAMA_CPP_DIR, {recursive: true});
	}
	if (!existsSync(LLAMA_CPP_BIN_DIR)) {
		mkdirSync(LLAMA_CPP_BIN_DIR, {recursive: true});
	}

	yield 'Fetching latest llama.cpp release...';

	const {tag, downloadUrl} = await getLatestRelease();

	yield `Downloading llama.cpp ${tag} (pre-built binary)...`;

	await downloadAndExtract(downloadUrl, LLAMA_CPP_BIN_DIR);

	yield 'Downloading convert script...';

	await downloadConvertScript(tag);

	yield 'llama.cpp installation complete!';
}

export interface ConvertProgress {
	step: string;
	progress?: number;
}

export async function* convertToGGUF(
	inputPath: string,
	outputPath: string,
): AsyncGenerator<ConvertProgress> {
	const convertScript = join(LLAMA_CPP_DIR, 'convert_hf_to_gguf.py');

	yield {step: 'Converting to GGUF format...'};

	try {
		await execa('python3', [
			convertScript,
			inputPath,
			'--outfile',
			outputPath,
			'--outtype',
			'f16',
		]);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		// Check for common issues
		if (message.includes('gguf')) {
			throw new Error(
				`Conversion failed. You may need to install gguf: pip3 install gguf\n\n${message}`,
			);
		}
		throw err;
	}

	yield {step: 'Conversion complete!', progress: 100};
}

export async function* quantize(
	inputPath: string,
	outputPath: string,
	quantType: QuantizationType,
): AsyncGenerator<ConvertProgress> {
	const quantizeBin = join(LLAMA_CPP_BIN_DIR, 'llama-quantize');

	yield {step: `Quantizing to ${quantType}...`};

	await execa(quantizeBin, [inputPath, outputPath, quantType]);

	yield {step: 'Quantization complete!', progress: 100};
}

/**
 * Maps a sub-step's own 0-100 progress onto its slice of the overall export.
 * Sub-steps that report no progress yet are treated as mid-slice, so the bar
 * shows work in flight instead of a premature 100%.
 */
export function scaleProgress(
	start: number,
	end: number,
	progress?: number,
): number {
	return start + ((progress ?? 50) / 100) * (end - start);
}

export async function* exportModel(
	fusedModelPath: string,
	outputPath: string,
	quantization: QuantizationType,
): AsyncGenerator<ConvertProgress> {
	// Step 1: Convert to GGUF (f16)
	const f16Path = outputPath.replace(/\.gguf$/, '-f16.gguf');

	yield {step: 'Step 1/2: Converting to GGUF...', progress: 0};

	try {
		for await (const update of convertToGGUF(fusedModelPath, f16Path)) {
			yield {
				step: update.step,
				progress: scaleProgress(0, 50, update.progress),
			};
		}

		// Step 2: Quantize if needed
		if (quantization === 'f16') {
			// Already done, just rename
			const {rename} = await import('node:fs/promises');
			await rename(f16Path, outputPath);
			yield {step: 'Export complete!', progress: 100};
			return;
		}

		yield {step: `Step 2/2: Quantizing to ${quantization}...`, progress: 50};

		for await (const update of quantize(f16Path, outputPath, quantization)) {
			yield {
				step: update.step,
				progress: scaleProgress(50, 100, update.progress),
			};
		}

		yield {step: 'Export complete!', progress: 100};
	} finally {
		// Clean up f16 intermediate whether or not quantize succeeded. If
		// quantization was 'f16' we already renamed it away, so unlink is a no-op.
		if (existsSync(f16Path)) {
			const {unlink} = await import('node:fs/promises');
			try {
				await unlink(f16Path);
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}

/**
 * Combined server + generation options accepted by the one-shot
 * `runGGUFInference` helper. New code should prefer the split `ServerOptions`
 * (for `startLlamaServer`) and `GenerateOptions` (for `chatCompletion`)
 * directly; this exists so callers that bundle everything into one object
 * still have a single type to import.
 */
export type InferenceOptions = ServerOptions & GenerateOptions;

export interface InferenceResult {
	/** Generated text output */
	text: string;
	/** Time to first token in milliseconds */
	ttftMs?: number;
	/** Total generation time in milliseconds */
	generationTimeMs?: number;
	/** Tokens per second */
	tokensPerSecond?: number;
	/** Total tokens generated */
	tokensGenerated?: number;
}

export interface ParsedStderr {
	ttftMs?: number;
	generationTimeMs?: number;
	tokensPerSecond?: number;
	tokensGenerated?: number;
}

/**
 * Parse llama.cpp stderr output for timing metrics.
 *
 * llama.cpp outputs lines like:
 *   llama_perf_context_print: prompt eval time =   567.89 ms /  50 tokens (  11.36 ms per token,   88.05 tokens per second)
 *   llama_perf_context_print:        eval time =  1234.56 ms /  99 runs   (  12.47 ms per token,   80.19 tokens per second)
 *   llama_perf_context_print:       total time =  1802.45 ms / 149 tokens
 */
export function parseLlamaCppStderr(stderr: string): ParsedStderr {
	const result: ParsedStderr = {};

	// TTFT: extract from "prompt eval time = <X> ms"
	const promptEvalMatch = stderr.match(/prompt eval time\s*=\s*([\d.]+)\s*ms/);
	if (promptEvalMatch) {
		result.ttftMs = Math.round(Number.parseFloat(promptEvalMatch[1]));
	}

	// Generation tokens/sec: extract from eval time line (not prompt eval)
	// Match "eval time = ... (<X> tokens per second)" but NOT "prompt eval time"
	const evalTpsMatch = stderr.match(
		/(?<!prompt\s)eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*(?:runs|tokens)\s*\([^)]*?([\d.]+)\s*tokens per second\)/,
	);
	if (evalTpsMatch) {
		result.generationTimeMs = Math.round(Number.parseFloat(evalTpsMatch[1]));
		result.tokensGenerated = Number.parseInt(evalTpsMatch[2], 10);
		result.tokensPerSecond = Number.parseFloat(evalTpsMatch[3]);
	}

	// Fallback: older llama.cpp versions that output "tok/s"
	if (result.tokensPerSecond === undefined) {
		const tpsMatch = stderr.match(/([\d.]+)\s*tok\/s/);
		if (tpsMatch) {
			result.tokensPerSecond = Number.parseFloat(tpsMatch[1]);
		}
	}

	// Fallback: older format "N tokens generated"
	if (result.tokensGenerated === undefined) {
		const tokensMatch = stderr.match(/(\d+)\s+tokens\s+generated/i);
		if (tokensMatch) {
			result.tokensGenerated = Number.parseInt(tokensMatch[1], 10);
		}
	}

	return result;
}

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			if (addr && typeof addr === 'object') {
				const port = addr.port;
				server.close(() => resolve(port));
			} else {
				server.close(() => reject(new Error('Failed to get port')));
			}
		});
		server.on('error', reject);
	});
}

async function waitForServer(port: number, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/health`);
			if (res.ok) return;
		} catch {
			// Server not ready yet
		}
		await new Promise(r => setTimeout(r, 250));
	}
	throw new Error(`llama-server failed to start within ${timeoutMs / 1000}s`);
}

interface LlamaServerTimings {
	prompt_n?: number;
	prompt_ms?: number;
	predicted_n?: number;
	predicted_ms?: number;
	predicted_per_token_ms?: number;
	predicted_per_second?: number;
}

export interface ChatCompletionResponse {
	choices?: Array<{
		message?: {role?: string; content?: string};
		/** Streaming delta object present in SSE chunks. */
		delta?: {role?: string; content?: string};
		finish_reason?: string | null;
	}>;
	timings?: LlamaServerTimings;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}

/**
 * A single item yielded by `chatCompletionStream`.
 *
 * - `{done: false, token}` — a new piece of generated text just arrived.
 * - `{done: true, result}` — generation finished; `result` contains the full
 *   assembled text and per-turn timing stats (TTFT, tok/s, token count).
 */
export type StreamChunk =
	| {done: false; token: string}
	| {done: true; result: InferenceResult};

/**
 * Parse a llama-server `/v1/chat/completions` response into our InferenceResult.
 * Pulled out of `chatCompletion` so it can be unit-tested without spawning a
 * server. Tolerates llama-server's non-standard top-level `timings` field and
 * falls back to OpenAI-shaped `usage.completion_tokens` when timings are absent.
 */
export function parseChatCompletionResponse(
	data: ChatCompletionResponse,
): InferenceResult {
	const content = data.choices?.[0]?.message?.content ?? '';
	const timings = data.timings;

	return {
		text: content.trim(),
		ttftMs: timings?.prompt_ms ? Math.round(timings.prompt_ms) : undefined,
		generationTimeMs: timings?.predicted_ms
			? Math.round(timings.predicted_ms)
			: undefined,
		tokensPerSecond: timings?.predicted_per_second,
		tokensGenerated: timings?.predicted_n ?? data.usage?.completion_tokens,
	};
}

/** Server-lifetime options (used at llama-server startup time). */
export interface ServerOptions {
	threads?: number;
	gpuLayers?: number;
	ctxSize?: number;
	batchSize?: number;
	cpuOnly?: boolean;
}

/** Per-request generation options (passed in the chat completions body). */
export interface GenerateOptions {
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	seed?: number;
	/**
	 * Optional AbortSignal forwarded to the underlying fetch. Callers racing
	 * a timeout against `chatCompletion` should pass a signal here so the
	 * in-flight request is actually cancelled, freeing up the server for the
	 * next test instead of letting it generate into the void.
	 */
	signal?: AbortSignal;
}

/** Handle to a running llama-server. Pass it back to `chatCompletion`. */
export interface ServerHandle {
	port: number;
	process: ResultPromise;
}

/**
 * Start a llama-server child process bound to a free local port. Caller must
 * stop it with `stopLlamaServer` (the kill is non-graceful but llama-server
 * is happy to be killed).
 */
export async function startLlamaServer(
	modelPath: string,
	options: ServerOptions = {},
	startupTimeoutMs = 60_000,
): Promise<ServerHandle> {
	const {
		threads,
		gpuLayers,
		ctxSize = 4096,
		batchSize = 2048,
		cpuOnly,
	} = options;

	const serverBin = join(LLAMA_CPP_BIN_DIR, 'llama-server');

	// Ensure llama-server is available (may be missing from older installations)
	if (!existsSync(serverBin)) {
		for await (const _ of installLlamaCpp()) {
			// consume install progress
		}
		if (!existsSync(serverBin)) {
			throw new Error(
				'llama-server binary not found after installation. Please re-run `nanotune export` to update llama.cpp.',
			);
		}
	}

	const port = await findFreePort();

	const args: string[] = [
		'-m',
		modelPath,
		'--port',
		String(port),
		'--host',
		'127.0.0.1',
		'-c',
		String(ctxSize),
		'-b',
		String(batchSize),
	];

	if (threads !== undefined) {
		args.push('-t', String(threads));
	}
	if (gpuLayers !== undefined) {
		args.push('-ngl', String(gpuLayers));
	}
	if (cpuOnly) {
		args.push('-ngl', '0');
	}

	const serverProcess = execa(serverBin, args, {
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
	});

	try {
		await waitForServer(port, startupTimeoutMs);
	} catch (err) {
		serverProcess.kill();
		throw err;
	}

	return {port, process: serverProcess};
}

/**
 * Stop a running llama-server started with `startLlamaServer`. Sends SIGTERM
 * first and escalates to SIGKILL after a short grace period if the process
 * hasn't exited — so a hung server can't block the caller's `finally` forever.
 */
export async function stopLlamaServer(
	handle: ServerHandle,
	graceMs = 2000,
): Promise<void> {
	const exited = handle.process.catch(() => {});
	handle.process.kill('SIGTERM');

	const escalation = new Promise<void>(resolve => {
		const timer = setTimeout(() => {
			// Process hasn't exited within grace window — force-kill.
			handle.process.kill('SIGKILL');
			resolve();
		}, graceMs);
		exited.then(() => {
			clearTimeout(timer);
			resolve();
		});
	});

	await Promise.race([exited, escalation]);
	// Wait for the actual exit so callers aren't holding a zombie handle.
	await exited;
}

/**
 * Send a chat-completion request to a running llama-server. Uses the OpenAI-
 * compatible `/v1/chat/completions` endpoint so llama-server applies the
 * model's chat template baked into the GGUF — matching the format the model
 * was trained on. This is the inference-time counterpart to MLX training's
 * `messages: [...]` input.
 */
export async function chatCompletion(
	handle: ServerHandle,
	messages: ChatMessage[],
	options: GenerateOptions = {},
): Promise<InferenceResult> {
	const {
		maxTokens = 100,
		temperature = 0.8,
		topP = 0.9,
		seed,
		signal,
	} = options;

	const body: Record<string, unknown> = {
		messages,
		max_tokens: maxTokens,
		temperature,
		top_p: topP,
	};
	if (seed !== undefined) {
		body.seed = seed;
	}

	const response = await fetch(
		`http://127.0.0.1:${handle.port}/v1/chat/completions`,
		{
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(body),
			signal,
		},
	);

	if (!response.ok) {
		throw new Error(
			`llama-server /v1/chat/completions failed: ${response.statusText}`,
		);
	}

	const data = (await response.json()) as ChatCompletionResponse;
	return parseChatCompletionResponse(data);
}

/**
 * Streaming variant of `chatCompletion`. Sends `"stream": true` to the
 * llama-server `/v1/chat/completions` SSE endpoint and yields tokens as they
 * arrive, finishing with a `{done: true, result}` chunk that carries the same
 * timing stats that the non-streaming response would have returned.
 *
 * The caller must iterate the generator with `for await … of`. Passing an
 * `AbortSignal` via `options.signal` cancels the in-flight request cleanly;
 * the generator will return (not throw) after the signal fires.
 *
 * NOTE: `chatCompletion` is deliberately left unchanged — the benchmark
 * command relies on it and does not need streaming.
 */
export async function* chatCompletionStream(
	handle: ServerHandle,
	messages: ChatMessage[],
	options: GenerateOptions = {},
): AsyncGenerator<StreamChunk> {
	const {
		maxTokens = 100,
		temperature = 0.8,
		topP = 0.9,
		seed,
		signal,
	} = options;

	const body: Record<string, unknown> = {
		messages,
		max_tokens: maxTokens,
		temperature,
		top_p: topP,
		stream: true,
	};
	if (seed !== undefined) {
		body.seed = seed;
	}

	const response = await fetch(
		`http://127.0.0.1:${handle.port}/v1/chat/completions`,
		{
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(body),
			signal,
		},
	);

	if (!response.ok) {
		throw new Error(
			`llama-server /v1/chat/completions (stream) failed: ${response.statusText}`,
		);
	}

	if (!response.body) {
		throw new Error(
			'llama-server returned no response body for streaming request',
		);
	}

	// Accumulate the full text and carry the final timings here.
	let fullText = '';
	let lastTimings: LlamaServerTimings | undefined;
	let lastUsage: ChatCompletionResponse['usage'];

	// Buffer for incomplete SSE lines that span chunk boundaries.
	let lineBuffer = '';

	const decoder = new TextDecoder();

	for await (const rawBytes of response.body as unknown as AsyncIterable<Uint8Array>) {
		// Abort signal fired between chunks — exit cleanly.
		if (signal?.aborted) {
			return;
		}

		lineBuffer += decoder.decode(rawBytes, {stream: true});

		// Process all complete lines in the buffer.
		const lines = lineBuffer.split('\n');
		// Keep the last (potentially incomplete) segment in the buffer.
		lineBuffer = lines.pop() ?? '';

		for (const line of lines) {
			const trimmed = line.trim();

			// SSE comment or blank line — skip.
			if (!trimmed || trimmed.startsWith(':')) continue;

			// Every SSE event line starts with "data: ".
			if (!trimmed.startsWith('data: ')) continue;

			const payload = trimmed.slice('data: '.length).trim();

			// End-of-stream sentinel.
			if (payload === '[DONE]') continue;

			let chunk: ChatCompletionResponse;
			try {
				chunk = JSON.parse(payload) as ChatCompletionResponse;
			} catch {
				// Malformed JSON in an SSE line — skip rather than crash.
				continue;
			}

			// Capture timings from any chunk that carries them (llama-server
			// attaches them to the final chunk).
			if (chunk.timings) lastTimings = chunk.timings;
			if (chunk.usage) lastUsage = chunk.usage;

			const delta = chunk.choices?.[0]?.delta?.content;
			if (delta) {
				fullText += delta;
				yield {done: false, token: delta};
			}
		}
	}

	// Flush any remaining bytes from the decoder.
	lineBuffer += decoder.decode();

	// Build the final InferenceResult — same shape as parseChatCompletionResponse.
	const result: InferenceResult = {
		text: fullText.trim(),
		ttftMs: lastTimings?.prompt_ms
			? Math.round(lastTimings.prompt_ms)
			: undefined,
		generationTimeMs: lastTimings?.predicted_ms
			? Math.round(lastTimings.predicted_ms)
			: undefined,
		tokensPerSecond: lastTimings?.predicted_per_second,
		tokensGenerated: lastTimings?.predicted_n ?? lastUsage?.completion_tokens,
	};

	yield {done: true, result};
}

/**
 * One-shot convenience: start a server, run one chat completion, stop the
 * server. Prefer `startLlamaServer` + `chatCompletion` when you have more
 * than one request to make.
 */
export async function runGGUFInference(
	modelPath: string,
	messages: ChatMessage[],
	options: ServerOptions & GenerateOptions = {},
): Promise<InferenceResult> {
	const handle = await startLlamaServer(modelPath, options);
	try {
		return await chatCompletion(handle, messages, options);
	} finally {
		await stopLlamaServer(handle);
	}
}
