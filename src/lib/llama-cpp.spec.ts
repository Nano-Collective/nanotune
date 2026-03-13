import test from "ava";
import type { InferenceOptions, InferenceResult } from "./llama-cpp.js";
import { parseLlamaCppStderr } from "./llama-cpp.js";

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

// parseLlamaCppStderr tests with actual llama.cpp output
test("parseLlamaCppStderr extracts all metrics from full llama.cpp output", (t) => {
	const stderr = [
		"llama_perf_sampler_print:    sampling time =       0.50 ms /   100 runs   (    0.01 ms per token,200000.00 tokens per second)",
		"llama_perf_context_print:        load time =     250.00 ms",
		"llama_perf_context_print: prompt eval time =     567.89 ms /    50 tokens (   11.36 ms per token,    88.05 tokens per second)",
		"llama_perf_context_print:        eval time =    1234.56 ms /    99 runs   (   12.47 ms per token,    80.19 tokens per second)",
		"llama_perf_context_print:       total time =    1802.45 ms /   149 tokens",
	].join("\n");

	const result = parseLlamaCppStderr(stderr);

	t.is(result.ttftMs, 568); // 567.89 rounded
	t.is(result.generationTimeMs, 1235); // 1234.56 rounded
	t.is(result.tokensGenerated, 99);
	t.is(result.tokensPerSecond, 80.19);
});

test("parseLlamaCppStderr extracts TTFT from prompt eval time", (t) => {
	const stderr =
		"llama_perf_context_print: prompt eval time =     123.45 ms /    10 tokens (   12.35 ms per token,    80.97 tokens per second)";

	const result = parseLlamaCppStderr(stderr);

	t.is(result.ttftMs, 123);
});

test("parseLlamaCppStderr extracts generation tokens/sec from eval time", (t) => {
	const stderr =
		"llama_perf_context_print:        eval time =    2000.00 ms /    50 runs   (   40.00 ms per token,    25.00 tokens per second)";

	const result = parseLlamaCppStderr(stderr);

	t.is(result.tokensPerSecond, 25.0);
	t.is(result.tokensGenerated, 50);
	t.is(result.generationTimeMs, 2000);
});

test("parseLlamaCppStderr falls back to tok/s pattern for older versions", (t) => {
	const stderr = "llama_print_timings: generation speed: 45.23 tok/s";

	const result = parseLlamaCppStderr(stderr);

	t.is(result.tokensPerSecond, 45.23);
	t.is(result.ttftMs, undefined);
});

test("parseLlamaCppStderr falls back to tokens generated pattern", (t) => {
	const stderr = "100 tokens generated in 4.0 seconds";

	const result = parseLlamaCppStderr(stderr);

	t.is(result.tokensGenerated, 100);
});

test("parseLlamaCppStderr returns empty for unrecognised stderr", (t) => {
	const result = parseLlamaCppStderr("some random log output");

	t.is(result.ttftMs, undefined);
	t.is(result.generationTimeMs, undefined);
	t.is(result.tokensPerSecond, undefined);
	t.is(result.tokensGenerated, undefined);
});

test("parseLlamaCppStderr returns empty for empty string", (t) => {
	const result = parseLlamaCppStderr("");

	t.is(result.ttftMs, undefined);
	t.is(result.generationTimeMs, undefined);
	t.is(result.tokensPerSecond, undefined);
	t.is(result.tokensGenerated, undefined);
});

test("parseLlamaCppStderr does not confuse prompt eval with eval", (t) => {
	// Both lines present — should pick prompt eval for TTFT and eval for generation
	const stderr = [
		"llama_perf_context_print: prompt eval time =     100.00 ms /    10 tokens (   10.00 ms per token,   100.00 tokens per second)",
		"llama_perf_context_print:        eval time =     500.00 ms /    50 runs   (   10.00 ms per token,   100.00 tokens per second)",
	].join("\n");

	const result = parseLlamaCppStderr(stderr);

	t.is(result.ttftMs, 100);
	t.is(result.generationTimeMs, 500);
	t.is(result.tokensGenerated, 50);
	t.is(result.tokensPerSecond, 100.0);
});
