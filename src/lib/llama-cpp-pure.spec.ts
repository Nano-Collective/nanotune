import test from 'ava';
import {parseChatCompletionResponse, scaleProgress} from './llama-cpp.js';

/**
 * The pure half of the llama.cpp boundary. Spawning a server is a macOS-arm64
 * affair CI cannot do, so response parsing and progress scaling are the parts a
 * test can protect — and a benchmark's latency and throughput numbers all come
 * out of the parser, so a mistake there is reported as a measurement.
 */

// --- parseChatCompletionResponse --------------------------------------------

const timings = {
	prompt_ms: 120.7,
	predicted_ms: 940.2,
	predicted_per_second: 31.5,
	predicted_n: 42,
};

test('the assistant message is extracted and trimmed', t => {
	const result = parseChatCompletionResponse({
		choices: [{message: {content: '  hello world \n'}}],
	} as never);
	t.is(result.text, 'hello world');
});

test('timings are rounded to whole milliseconds', t => {
	const result = parseChatCompletionResponse({
		choices: [{message: {content: 'x'}}],
		timings,
	} as never);
	t.is(result.ttftMs, 121);
	t.is(result.generationTimeMs, 940);
	t.is(result.tokensPerSecond, 31.5);
	t.is(result.tokensGenerated, 42);
});

test('token count falls back to usage when timings are absent', t => {
	// llama-server's `timings` is non-standard; an OpenAI-shaped response has
	// only `usage`. Losing the count here would silently zero a benchmark's
	// throughput rather than failing.
	const result = parseChatCompletionResponse({
		choices: [{message: {content: 'x'}}],
		usage: {completion_tokens: 17},
	} as never);
	t.is(result.tokensGenerated, 17);
	t.is(result.ttftMs, undefined);
	t.is(result.generationTimeMs, undefined);
	t.is(result.tokensPerSecond, undefined);
});

test('timings win over usage when both are present', t => {
	const result = parseChatCompletionResponse({
		choices: [{message: {content: 'x'}}],
		timings,
		usage: {completion_tokens: 999},
	} as never);
	t.is(result.tokensGenerated, 42);
});

test('a response with no choices yields empty text, not a crash', t => {
	// A server that returns an error body still returns *something*, and the
	// caller is mid-benchmark. Throwing here would abandon the whole run.
	t.is(parseChatCompletionResponse({} as never).text, '');
	t.is(parseChatCompletionResponse({choices: []} as never).text, '');
	t.is(
		parseChatCompletionResponse({choices: [{message: {}}]} as never).text,
		'',
	);
});

test('a zero prompt_ms is treated as absent rather than as zero', t => {
	// The implementation guards on truthiness, so 0 becomes undefined. That is
	// the honest reading: llama-server reports 0 when it did not measure.
	const result = parseChatCompletionResponse({
		choices: [{message: {content: 'x'}}],
		timings: {prompt_ms: 0, predicted_ms: 0},
	} as never);
	t.is(result.ttftMs, undefined);
	t.is(result.generationTimeMs, undefined);
});

// --- scaleProgress ----------------------------------------------------------

test('progress is mapped into the given band', t => {
	t.is(scaleProgress(0, 100, 50), 50);
	t.is(scaleProgress(20, 40, 0), 20);
	t.is(scaleProgress(20, 40, 100), 40);
	t.is(scaleProgress(20, 40, 50), 30);
});

test('a missing progress reading is assumed to be halfway', t => {
	// Callers pass through whatever the subprocess reported, which is often
	// nothing. Defaulting to the midpoint keeps the bar moving rather than
	// snapping it back to the start of the band.
	t.is(scaleProgress(20, 40, undefined), 30);
	t.is(scaleProgress(0, 100, undefined), 50);
});

test('a band that does not start at zero never reports below its start', t => {
	for (const progress of [0, 1, 25, 99, 100]) {
		const value = scaleProgress(60, 80, progress);
		t.true(value >= 60 && value <= 80, `${progress} -> ${value}`);
	}
});
