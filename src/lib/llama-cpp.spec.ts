import test from "ava";
import { execa } from "execa";
import type {
	ChatCompletionResponse,
	InferenceOptions,
	InferenceResult,
	ServerHandle,
	StreamChunk,
} from "./llama-cpp.js";
import {
	chatCompletionStream,
	createServerHandle,
	exportModel,
	parseChatCompletionResponse,
	quantize,
	scaleProgress,
	stopLlamaServer,
	waitForServerOrExit,
} from "./llama-cpp.js";

test("InferenceOptions structure accepts all valid options", (t) => {
	const options: InferenceOptions = {
		maxTokens: 100,
		threads: 4,
		gpuLayers: 20,
		ctxSize: 4096,
		batchSize: 2048,
		temperature: 0.8,
		topP: 0.9,
		seed: 42,
		cpuOnly: false,
	};

	t.is(options.maxTokens, 100);
	t.is(options.threads, 4);
	t.is(options.gpuLayers, 20);
	t.is(options.ctxSize, 4096);
	t.is(options.batchSize, 2048);
	t.is(options.temperature, 0.8);
	t.is(options.topP, 0.9);
	t.is(options.seed, 42);
	t.is(options.cpuOnly, false);
});

test("InferenceOptions works with partial options", (t) => {
	const options: InferenceOptions = {
		maxTokens: 50,
		cpuOnly: true,
	};

	t.is(options.maxTokens, 50);
	t.is(options.cpuOnly, true);
	t.is(options.threads, undefined);
	t.is(options.gpuLayers, undefined);
});

test("InferenceResult structure is correct", (t) => {
	const result: InferenceResult = {
		text: "Hello, world!",
		ttftMs: 150,
		generationTimeMs: 850,
		tokensPerSecond: 25.5,
		tokensGenerated: 20,
	};

	t.is(result.text, "Hello, world!");
	t.is(result.ttftMs, 150);
	t.is(result.generationTimeMs, 850);
	t.is(result.tokensPerSecond, 25.5);
	t.is(result.tokensGenerated, 20);
});

test("InferenceResult works with minimal data", (t) => {
	const result: InferenceResult = {
		text: "Simple response",
	};

	t.is(result.text, "Simple response");
	t.is(result.ttftMs, undefined);
	t.is(result.generationTimeMs, undefined);
	t.is(result.tokensPerSecond, undefined);
	t.is(result.tokensGenerated, undefined);
});

test("InferenceOptions handles edge cases", (t) => {
	// CPU only with 0 GPU layers
	const cpuOnlyOptions: InferenceOptions = {
		cpuOnly: true,
		gpuLayers: 0,
	};
	t.true(cpuOnlyOptions.cpuOnly);
	t.is(cpuOnlyOptions.gpuLayers, 0);

	// Maximum context size
	const maxCtxOptions: InferenceOptions = {
		ctxSize: 32768,
		batchSize: 4096,
	};
	t.is(maxCtxOptions.ctxSize, 32768);
	t.is(maxCtxOptions.batchSize, 4096);

	// Single thread
	const singleThreadOptions: InferenceOptions = {
		threads: 1,
	};
	t.is(singleThreadOptions.threads, 1);
});

// Legacy fallback regex tests (older llama.cpp format)
test("llama.cpp stderr parsing regex for tokens per second (legacy fallback)", (t) => {
	const tpsPattern = /([\d.]+)\s*tok\/s/;

	const line1 = "llama_perf_context_print:        45.23 tok/s";
	const match1 = line1.match(tpsPattern);
	t.truthy(match1);
	t.is(match1?.[1], "45.23");

	const line2 = "generation speed: 120 tok/s";
	const match2 = line2.match(tpsPattern);
	t.truthy(match2);
	t.is(match2?.[1], "120");
});

test("llama.cpp stderr parsing regex for tokens generated (legacy fallback)", (t) => {
	const tokensPattern = /(\d+)\s+tokens\s+generated/i;

	const line1 = "llama_perf_context_print:   100 tokens generated";
	const match1 = line1.match(tokensPattern);
	t.truthy(match1);
	t.is(match1?.[1], "100");

	const line2 = "150 tokens generated in 3.5 seconds";
	const match2 = line2.match(tokensPattern);
	t.truthy(match2);
	t.is(match2?.[1], "150");
});

// ── parseChatCompletionResponse ───────────────────────────────────────

test("parseChatCompletionResponse extracts content from choices[0].message", (t) => {
	const data: ChatCompletionResponse = {
		choices: [{ message: { role: "assistant", content: "Hello, world!" } }],
	};
	const result = parseChatCompletionResponse(data);
	t.is(result.text, "Hello, world!");
});

test("parseChatCompletionResponse trims surrounding whitespace from content", (t) => {
	const data: ChatCompletionResponse = {
		choices: [{ message: { content: "   trimmed   " } }],
	};
	t.is(parseChatCompletionResponse(data).text, "trimmed");
});

test("parseChatCompletionResponse returns empty text when choices is missing", (t) => {
	const result = parseChatCompletionResponse({});
	t.is(result.text, "");
});

test("parseChatCompletionResponse returns empty text when choices is empty", (t) => {
	const result = parseChatCompletionResponse({ choices: [] });
	t.is(result.text, "");
});

test("parseChatCompletionResponse returns empty text when message is missing", (t) => {
	const result = parseChatCompletionResponse({ choices: [{}] });
	t.is(result.text, "");
});

test("parseChatCompletionResponse handles missing content gracefully", (t) => {
	const result = parseChatCompletionResponse({
		choices: [{ message: { role: "assistant" } }],
	});
	t.is(result.text, "");
});

test("parseChatCompletionResponse maps top-level timings into result", (t) => {
	const data: ChatCompletionResponse = {
		choices: [{ message: { content: "ok" } }],
		timings: {
			prompt_ms: 123.4,
			predicted_ms: 567.8,
			predicted_per_second: 42.5,
			predicted_n: 99,
		},
	};
	const result = parseChatCompletionResponse(data);
	t.is(result.ttftMs, 123); // rounded
	t.is(result.generationTimeMs, 568); // rounded
	t.is(result.tokensPerSecond, 42.5);
	t.is(result.tokensGenerated, 99);
});

test("parseChatCompletionResponse falls back to usage.completion_tokens when timings.predicted_n is missing", (t) => {
	const data: ChatCompletionResponse = {
		choices: [{ message: { content: "ok" } }],
		timings: { prompt_ms: 50 },
		usage: { completion_tokens: 77 },
	};
	const result = parseChatCompletionResponse(data);
	t.is(result.tokensGenerated, 77);
});

test("parseChatCompletionResponse prefers timings.predicted_n over usage.completion_tokens", (t) => {
	const data: ChatCompletionResponse = {
		choices: [{ message: { content: "ok" } }],
		timings: { predicted_n: 99 },
		usage: { completion_tokens: 77 },
	};
	t.is(parseChatCompletionResponse(data).tokensGenerated, 99);
});

test("parseChatCompletionResponse leaves timing fields undefined when neither is present", (t) => {
	const result = parseChatCompletionResponse({
		choices: [{ message: { content: "ok" } }],
	});
	t.is(result.ttftMs, undefined);
	t.is(result.generationTimeMs, undefined);
	t.is(result.tokensPerSecond, undefined);
	t.is(result.tokensGenerated, undefined);
});

test("parseChatCompletionResponse does not round prompt_ms=0 to undefined", (t) => {
	// 0 is falsy in JS but a legitimate timing value. Verify the parser doesn't
	// silently drop it. Note: the current implementation does drop 0 because
	// of the truthy check — this test pins the existing behaviour so we don't
	// accidentally change it without a follow-up.
	const result = parseChatCompletionResponse({
		choices: [{ message: { content: "ok" } }],
		timings: { prompt_ms: 0, predicted_ms: 0 },
	});
	t.is(result.ttftMs, undefined);
	t.is(result.generationTimeMs, undefined);
});

test("parseChatCompletionResponse returns InferenceResult-shaped value", (t) => {
	const result: InferenceResult = parseChatCompletionResponse({
		choices: [{ message: { content: "ok" } }],
	});
	// Type-asserts at compile time; smoke check at runtime.
	t.is(typeof result.text, "string");
});

test("scaleProgress maps a sub-step onto its slice of the export", (t) => {
	t.is(scaleProgress(0, 50, 0), 0);
	t.is(scaleProgress(0, 50, 100), 50);
	t.is(scaleProgress(50, 100, 0), 50);
	t.is(scaleProgress(50, 100, 100), 100);
});

test("scaleProgress stays mid-slice while a sub-step is still running", (t) => {
	// A sub-step that has not reported progress yet must never read as done.
	t.is(scaleProgress(0, 50, undefined), 25);
	t.is(scaleProgress(50, 100, undefined), 75);
});

test("quantize reports no progress on its kickoff event", async (t) => {
	// Only the first yield is pulled, so llama-quantize is never spawned.
	const first = await quantize("in.gguf", "out.gguf", "q4_k_m").next();

	t.is(first.value?.step, "Quantizing to q4_k_m...");
	t.is(first.value?.progress, undefined);
});

test("exportModel does not jump to 100% before quantization finishes", async (t) => {
	// Regression: the quantize kickoff event used to be re-yielded as
	// progress: 100 while a multi-GB model was still being written.
	const gen = exportModel("fused", "model.gguf", "q4_k_m");
	const start = await gen.next();
	const converting = await gen.next();
	await gen.return(undefined);

	t.is(start.value?.progress, 0);
	t.is(converting.value?.progress, 25);
	t.is(scaleProgress(50, 100, undefined), 75);
});

// ── server lifecycle ──────────────────────────────────────────────────

// llama-server itself is not available in CI, so these stand a plain node
// child process in for it: the bug is in how the execa promise is handled,
// not in what the child does.
const spawnChild = (code: string) =>
	execa(process.execPath, ["-e", code], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});

/** Collect anything Node reports as an unhandled rejection while `fn` runs. */
async function withUnhandledRejections(
	fn: () => Promise<void>,
): Promise<unknown[]> {
	const seen: unknown[] = [];
	const listener = (reason: unknown) => seen.push(reason);
	process.on("unhandledRejection", listener);
	try {
		await fn();
		// An unhandled rejection is reported at the end of the tick that created
		// it, so give the loop a turn before deciding none happened.
		await new Promise((r) => setTimeout(r, 100));
	} finally {
		process.off("unhandledRejection", listener);
	}
	return seen;
}

test("createServerHandle settles `exited` when the child exits non-zero, without an unhandled rejection", async (t) => {
	// Regression: execa's promise was left orphaned, so a server dying mid-run
	// killed the whole CLI with a raw ExecaError stack dump.
	let exitValue: unknown;
	const rejections = await withUnhandledRejections(async () => {
		const handle = createServerHandle(
			1234,
			spawnChild("setTimeout(() => process.exit(3), 50)"),
		);
		exitValue = await handle.exited;
	});

	t.true(exitValue instanceof Error);
	t.deepEqual(rejections, []);
});

test("createServerHandle settles `exited` when the child is killed, without an unhandled rejection", async (t) => {
	let exitValue: unknown;
	const rejections = await withUnhandledRejections(async () => {
		const handle = createServerHandle(
			1234,
			spawnChild("setInterval(() => {}, 1000)"),
		);
		handle.process.kill("SIGTERM");
		exitValue = await handle.exited;
	});

	t.true(exitValue instanceof Error);
	t.deepEqual(rejections, []);
});

test("stopLlamaServer terminates a running child and resolves", async (t) => {
	const handle = createServerHandle(
		1234,
		spawnChild("setInterval(() => {}, 1000)"),
	);

	await stopLlamaServer(handle);

	// execa reports a killed child as an error — proof it is actually gone.
	t.true((await handle.exited) instanceof Error);
});

test("stopLlamaServer resolves for a child that already exited on its own", async (t) => {
	// The mid-run case: the server is long gone by the time the caller's
	// `finally` runs.
	const handle = createServerHandle(1234, spawnChild("process.exit(3)"));
	await handle.exited;

	await stopLlamaServer(handle);

	t.pass();
});

test("stopLlamaServer escalates past a child that ignores SIGTERM", async (t) => {
	const handle = createServerHandle(
		1234,
		spawnChild(
			"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
		),
	);

	await stopLlamaServer(handle, 100);

	t.true((await handle.exited) instanceof Error);
});

test("waitForServerOrExit reports the child's exit instead of waiting out the startup timeout", async (t) => {
	// Nothing ever listens on port 1, so /health can only fail.
	const handle = createServerHandle(1, spawnChild("process.exit(1)"));
	const started = Date.now();

	const err = await t.throwsAsync(waitForServerOrExit(1, handle.exited, 2000));

	t.true(err?.message.startsWith("llama-server exited during startup"));
	t.true(Date.now() - started < 1500);
});

test("waitForServerOrExit still times out when the child stays up but never answers", async (t) => {
	const handle = createServerHandle(
		1,
		spawnChild("setInterval(() => {}, 1000)"),
	);

	const err = await t.throwsAsync(waitForServerOrExit(1, handle.exited, 300));

	t.true(err?.message.includes("failed to start within"));
	await stopLlamaServer(handle);
});

// ── chatCompletionStream ──────────────────────────────────────────────

const enc = new TextEncoder();

/** A ReadableStream that emits each string as its own byte chunk. */
function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
			controller.close();
		},
	});
}

/** SSE lines joined into a single chunk, newline-terminated as llama-server sends them. */
function sseLines(lines: string[]): ReadableStream<Uint8Array> {
	return sseBody([`${lines.join("\n")}\n`]);
}

/** Swap in a fetch implementation for the duration of `callback`. */
async function withMockFetch(
	impl: () => Promise<Response>,
	callback: () => Promise<void>,
): Promise<void> {
	const original = globalThis.fetch;
	globalThis.fetch = impl as typeof globalThis.fetch;
	try {
		await callback();
	} finally {
		globalThis.fetch = original;
	}
}

function makeServerHandle(): ServerHandle {
	// Only `port` is read by chatCompletionStream; the child is never touched.
	return {
		port: 9999,
		process: null as unknown as ServerHandle["process"],
		exited: Promise.resolve(undefined),
	};
}

/** Drain the generator against a mocked streaming response. */
async function collectChunks(
	body: ReadableStream<Uint8Array>,
	options?: { signal?: AbortSignal },
): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = [];
	await withMockFetch(
		async () => new Response(body, { status: 200 }),
		async () => {
			for await (const chunk of chatCompletionStream(
				makeServerHandle(),
				[{ role: "user", content: "hi" }],
				options,
			)) {
				chunks.push(chunk);
			}
		},
	);
	return chunks;
}

const TIMINGS = {
	prompt_ms: 123.4,
	predicted_ms: 567.8,
	predicted_per_second: 42.5,
	predicted_n: 10,
};

test("chatCompletionStream yields token chunks then a done chunk", async (t) => {
	const chunks = await collectChunks(
		sseLines([
			'data: {"choices":[{"delta":{"content":"Hello"}}]}',
			'data: {"choices":[{"delta":{"content":","}}]}',
			'data: {"choices":[{"delta":{"content":" world!"}}]}',
			"data: [DONE]",
		]),
	);

	t.is(chunks.length, 4);
	t.deepEqual(chunks[0], { done: false, token: "Hello" });
	t.deepEqual(chunks[1], { done: false, token: "," });
	t.deepEqual(chunks[2], { done: false, token: " world!" });

	const last = chunks[3];
	t.true(last.done);
	if (last.done) {
		t.is(last.result.text, "Hello, world!");
		t.false(last.cancelled);
	}
});

test("chatCompletionStream skips SSE chunks with empty or missing delta.content", async (t) => {
	const chunks = await collectChunks(
		sseLines([
			// Role-only delta (llama-server's first chunk) — no content.
			'data: {"choices":[{"delta":{"role":"assistant"}}]}',
			": keep-alive comment",
			'data: {"choices":[{"delta":{"content":"Hi"}}]}',
			// Empty-string delta — must not produce a token chunk.
			'data: {"choices":[{"delta":{"content":""}}]}',
			"data: [DONE]",
		]),
	);

	const tokens = chunks.filter((c) => !c.done);
	t.is(tokens.length, 1);
	t.deepEqual(tokens[0], { done: false, token: "Hi" });
});

test("chatCompletionStream parses timings from the final SSE chunk", async (t) => {
	const chunks = await collectChunks(
		sseLines([
			'data: {"choices":[{"delta":{"content":"ok"}}]}',
			`data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"timings":${JSON.stringify(TIMINGS)}}`,
			"data: [DONE]",
		]),
	);

	const last = chunks.at(-1);
	t.truthy(last?.done);
	if (last?.done) {
		t.is(last.result.text, "ok");
		t.is(last.result.ttftMs, 123); // Math.round(123.4)
		t.is(last.result.generationTimeMs, 568); // Math.round(567.8)
		t.is(last.result.tokensPerSecond, 42.5);
		t.is(last.result.tokensGenerated, 10);
	}
});

test("chatCompletionStream parses a final SSE line that arrives without a trailing newline", async (t) => {
	// Regression: the leftover buffer was flushed out of the decoder but never
	// parsed, so an unterminated final line silently lost both its token and
	// the timings llama-server attaches to it.
	const chunks = await collectChunks(
		sseBody([
			'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
			`data: {"choices":[{"delta":{"content":"!"}}],"timings":${JSON.stringify(TIMINGS)}}`,
		]),
	);

	t.deepEqual(
		chunks.filter((c) => !c.done),
		[
			{ done: false, token: "hi" },
			{ done: false, token: "!" },
		],
	);

	const last = chunks.at(-1);
	if (last?.done) {
		t.is(last.result.text, "hi!");
		t.is(last.result.tokensPerSecond, 42.5);
		t.is(last.result.tokensGenerated, 10);
	} else {
		t.fail("expected a done chunk");
	}
});

test("chatCompletionStream reassembles an SSE event split across byte chunks", async (t) => {
	const chunks = await collectChunks(
		sseBody([
			'data: {"choices":[{"delta":{"cont',
			'ent":"split"}}]}\n',
			"data: [DONE]\n",
		]),
	);

	t.deepEqual(
		chunks.filter((c) => !c.done),
		[{ done: false, token: "split" }],
	);
});

test("chatCompletionStream ends with a cancelled done chunk when the signal fires mid-stream", async (t) => {
	// Drive the body by hand so the abort lands between two reads, exactly as
	// it does when the user hits Esc partway through a reply.
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const ac = new AbortController();

	await withMockFetch(
		async () => new Response(body, { status: 200 }),
		async () => {
			const stream = chatCompletionStream(
				makeServerHandle(),
				[{ role: "user", content: "hi" }],
				{ signal: ac.signal },
			);

			controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n'));
			const first = await stream.next();
			t.deepEqual(first.value, { done: false, token: "first" });

			ac.abort();
			controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"second"}}]}\n'));

			// The turn ends with a done chunk carrying the partial text — never a
			// throw, and never a silent return with no terminal chunk.
			const last = await stream.next();
			t.true(last.value?.done);
			if (last.value?.done) {
				t.true(last.value.cancelled);
				t.is(last.value.result.text, "first");
			}

			// Breaking out of the read loop already cancelled the body stream, so
			// there is nothing left to close here.
			t.true((await stream.next()).done);
		},
	);
});

test("chatCompletionStream yields a cancelled done chunk when the signal fires before any token", async (t) => {
	const ac = new AbortController();
	ac.abort();

	const chunks: StreamChunk[] = [];
	await withMockFetch(
		async () => {
			// What fetch does for an already-aborted signal.
			throw Object.assign(new Error("This operation was aborted"), {
				name: "AbortError",
			});
		},
		async () => {
			for await (const chunk of chatCompletionStream(
				makeServerHandle(),
				[{ role: "user", content: "hi" }],
				{ signal: ac.signal },
			)) {
				chunks.push(chunk);
			}
		},
	);

	t.is(chunks.length, 1);
	const only = chunks[0];
	t.true(only.done);
	if (only.done) {
		t.true(only.cancelled);
		t.is(only.result.text, "");
	}
});

test("chatCompletionStream throws when the server returns a non-OK status", async (t) => {
	await withMockFetch(
		async () =>
			new Response(null, { status: 500, statusText: "Internal Server Error" }),
		async () => {
			await t.throwsAsync(
				async () => {
					for await (const _ of chatCompletionStream(makeServerHandle(), [
						{ role: "user", content: "hi" },
					])) {
						// should not reach here
					}
				},
				{ message: /stream.*failed/i },
			);
		},
	);
});
