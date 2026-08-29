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
 * Combined server + generation options, for callers that bundle both sets into
 * one object. Prefer the split `ServerOptions` (for `startLlamaServer`) and
 * `GenerateOptions` (for `chatCompletion`) directly — every caller in the repo
 * does, so this is currently referenced only by its type tests.
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
		/** Streaming delta object — present in SSE chunks instead of `message`. */
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
 * - `{done: true, result}` — generation finished; `result` holds the full
 *   assembled text and per-turn timing stats (TTFT, tok/s, token count).
 *   `cancelled` is true when the caller's AbortSignal ended the turn early,
 *   in which case `result.text` is whatever had been generated so far.
 *
 * Exactly one `done` chunk is yielded per stream, cancelled or not.
 */
export type StreamChunk =
	| {done: false; token: string}
	| {done: true; result: InferenceResult; cancelled?: boolean};

/**
 * Assemble an InferenceResult from generated text plus llama-server's timing
 * and usage fields. Shared by the buffered and streaming paths so the two
 * cannot drift in how they report TTFT, tok/s and token counts.
 */
function toInferenceResult(
	text: string,
	timings: LlamaServerTimings | undefined,
	usage: ChatCompletionResponse['usage'],
): InferenceResult {
	return {
		text: text.trim(),
		ttftMs: timings?.prompt_ms ? Math.round(timings.prompt_ms) : undefined,
		generationTimeMs: timings?.predicted_ms
			? Math.round(timings.predicted_ms)
			: undefined,
		tokensPerSecond: timings?.predicted_per_second,
		tokensGenerated: timings?.predicted_n ?? usage?.completion_tokens,
	};
}

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
	return toInferenceResult(content, data.timings, data.usage);
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
	/**
	 * Settles when the child exits — with the `ExecaError` if it was killed or
	 * exited non-zero, never by rejecting. Callers can watch it to notice a
	 * server that died under them.
	 */
	exited: Promise<unknown>;
}

/**
 * Wrap a freshly spawned llama-server child in a `ServerHandle`.
 *
 * `exited` is attached here, at spawn time, and never later: execa's promise
 * rejects whenever the child is killed or exits non-zero, and on Node 22 an
 * unhandled rejection is fatal. Deferring the handler to `stopLlamaServer` —
 * minutes or hours away — means a server that dies mid-run takes the whole
 * CLI down with a raw stack dump.
 */
export function createServerHandle(
	port: number,
	serverProcess: ResultPromise,
): ServerHandle {
	return {
		port,
		process: serverProcess,
		exited: serverProcess.catch((err: unknown) => err),
	};
}

/**
 * Wait for the server to answer /health, giving up early if the child exits
 * first. Without the race a bad GGUF — which llama-server rejects in
 * milliseconds — reports a generic timeout a full minute later instead of the
 * exit that actually happened.
 */
export async function waitForServerOrExit(
	port: number,
	exited: Promise<unknown>,
	timeoutMs: number,
): Promise<void> {
	await Promise.race([
		waitForServer(port, timeoutMs),
		exited.then(value => {
			throw new Error(
				`llama-server exited during startup${
					value instanceof Error ? `: ${value.message}` : ''
				}`,
			);
		}),
	]);
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
	const handle = createServerHandle(port, serverProcess);

	try {
		await waitForServerOrExit(port, handle.exited, startupTimeoutMs);
	} catch (err) {
		serverProcess.kill();
		throw err;
	}

	return handle;
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
	const exited = handle.exited;
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

/** True for the DOMException fetch raises when an AbortSignal fires. */
function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === 'AbortError';
}

/**
 * Streaming variant of `chatCompletion`. Sends `"stream": true` to the
 * llama-server `/v1/chat/completions` SSE endpoint and yields tokens as they
 * arrive, finishing with a `{done: true, result}` chunk carrying the same
 * timing stats the non-streaming response would have returned.
 *
 * The caller must iterate the generator with `for await … of`. Aborting via
 * `options.signal` is not an error: the generator swallows the AbortError and
 * still yields a final `{done: true, cancelled: true, result}` chunk holding
 * the partial text, so callers see exactly one terminal chunk either way and
 * never have to distinguish "cancelled" from "failed" in a catch block.
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

	// Accumulated text and the timings from whichever chunk carried them.
	let fullText = '';
	let timings: LlamaServerTimings | undefined;
	let usage: ChatCompletionResponse['usage'];
	let cancelled = false;

	/**
	 * Parse a batch of complete SSE lines, updating the accumulators above and
	 * yielding a token chunk per non-empty `delta.content`. Declared inline so
	 * the trailing-buffer flush below can run the exact same parsing as the
	 * main loop: a final line that arrives without a trailing newline still
	 * has to contribute its token and the timings attached to it.
	 */
	function* consumeLines(lines: string[]): Generator<StreamChunk> {
		for (const line of lines) {
			const trimmed = line.trim();

			// Blank line (event separator) or SSE comment — skip.
			if (!trimmed || trimmed.startsWith(':')) continue;

			// Every SSE event line we care about starts with "data: ".
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

			// llama-server attaches timings to the final chunk, but take them
			// from any chunk that carries them.
			if (chunk.timings) timings = chunk.timings;
			if (chunk.usage) usage = chunk.usage;

			const token = chunk.choices?.[0]?.delta?.content;
			if (token) {
				fullText += token;
				yield {done: false, token};
			}
		}
	}

	try {
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

		// Holds the trailing partial line between reads — SSE events routinely
		// straddle chunk boundaries.
		let lineBuffer = '';
		const decoder = new TextDecoder();

		for await (const bytes of response.body) {
			// Signal fired between reads — stop before decoding more.
			if (signal?.aborted) {
				cancelled = true;
				break;
			}

			lineBuffer += decoder.decode(bytes, {stream: true});

			const lines = lineBuffer.split('\n');
			// The last segment may be incomplete; hold it for the next read.
			lineBuffer = lines.pop() ?? '';

			yield* consumeLines(lines);
		}

		// Flush the decoder and parse whatever is left, so a final line that
		// arrived without a trailing newline still contributes its token and
		// timings.
		lineBuffer += decoder.decode();
		if (lineBuffer.trim()) {
			yield* consumeLines([lineBuffer]);
		}
	} catch (err) {
		// An abort is a normal outcome, not a failure — fall through to the
		// terminal chunk below. Anything else is a real error.
		if (!isAbortError(err) && !signal?.aborted) throw err;
		cancelled = true;
	}

	yield {
		done: true,
		result: toInferenceResult(fullText, timings, usage),
		cancelled,
	};
}
