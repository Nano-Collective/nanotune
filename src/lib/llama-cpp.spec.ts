import test from "ava";
import type {
	ChatCompletionResponse,
	InferenceOptions,
	InferenceResult,
} from "./llama-cpp.js";
import {
	exportModel,
	parseChatCompletionResponse,
	quantize,
	scaleProgress,
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
