import test from "ava";
import type { InferenceOptions, InferenceResult } from "./llama-cpp.js";

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

test("llama.cpp stderr parsing regex for tokens per second", (t) => {
	// Test the regex pattern used to parse timing info from llama.cpp stderr
	const tpsPattern = /(\d+\.?\d*)\s*tok\/s/;

	const line1 = "llama_perf_context_print:        45.23 tok/s";
	const match1 = line1.match(tpsPattern);
	t.truthy(match1);
	t.is(match1?.[1], "45.23");

	const line2 = "generation speed: 120 tok/s";
	const match2 = line2.match(tpsPattern);
	t.truthy(match2);
	t.is(match2?.[1], "120");
});

test("llama.cpp stderr parsing regex for tokens generated", (t) => {
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
