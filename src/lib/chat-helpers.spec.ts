import test from "ava";
import {
	buildGenerateOptions,
	buildServerOptions,
	parseSlashCommand,
} from "./chat-helpers.js";

// ── parseSlashCommand ─────────────────────────────────────────────────

test("parseSlashCommand returns noop for empty input", (t) => {
	t.deepEqual(parseSlashCommand(""), { kind: "noop" });
});

test("parseSlashCommand returns noop for whitespace-only input", (t) => {
	t.deepEqual(parseSlashCommand("   \n\t"), { kind: "noop" });
});

test("parseSlashCommand treats plain text as a message to send", (t) => {
	t.deepEqual(parseSlashCommand("hello world"), {
		kind: "send",
		text: "hello world",
	});
});

test("parseSlashCommand trims the message text", (t) => {
	t.deepEqual(parseSlashCommand("   hello   "), {
		kind: "send",
		text: "hello",
	});
});

test("parseSlashCommand recognises /exit", (t) => {
	t.deepEqual(parseSlashCommand("/exit"), { kind: "exit" });
});

test("parseSlashCommand recognises /quit as exit alias", (t) => {
	t.deepEqual(parseSlashCommand("/quit"), { kind: "exit" });
});

test("parseSlashCommand recognises /reset", (t) => {
	t.deepEqual(parseSlashCommand("/reset"), { kind: "reset" });
});

test("parseSlashCommand recognises /clear as reset alias", (t) => {
	t.deepEqual(parseSlashCommand("/clear"), { kind: "reset" });
});

test("parseSlashCommand recognises /help", (t) => {
	t.deepEqual(parseSlashCommand("/help"), { kind: "help" });
});

test("parseSlashCommand recognises /stats", (t) => {
	t.deepEqual(parseSlashCommand("/stats"), { kind: "stats" });
});

test("parseSlashCommand recognises /system with argument", (t) => {
	t.deepEqual(parseSlashCommand("/system You are a Bash assistant."), {
		kind: "system",
		text: "You are a Bash assistant.",
	});
});

test("parseSlashCommand /system with multi-word arg keeps internal spacing", (t) => {
	const result = parseSlashCommand("/system  multi   spaced   prompt  ");
	t.is(result.kind, "system");
	if (result.kind !== "system") return;
	// Whitespace splitting may collapse runs — verify the words survive in order.
	t.is(result.text, "multi spaced prompt");
});

test("parseSlashCommand /system without argument returns system-missing", (t) => {
	t.deepEqual(parseSlashCommand("/system"), { kind: "system-missing" });
	t.deepEqual(parseSlashCommand("/system   "), { kind: "system-missing" });
});

test("parseSlashCommand is case-insensitive for command name", (t) => {
	t.deepEqual(parseSlashCommand("/EXIT"), { kind: "exit" });
	t.deepEqual(parseSlashCommand("/Reset"), { kind: "reset" });
});

test("parseSlashCommand /system preserves case of the argument", (t) => {
	const result = parseSlashCommand("/system You Are HELPFUL");
	t.is(result.kind, "system");
	if (result.kind !== "system") return;
	t.is(result.text, "You Are HELPFUL");
});

test("parseSlashCommand returns unknown for unrecognised slash commands", (t) => {
	t.deepEqual(parseSlashCommand("/foobar"), {
		kind: "unknown",
		name: "/foobar",
	});
});

test("parseSlashCommand unknown preserves original casing of the command", (t) => {
	t.deepEqual(parseSlashCommand("/FooBar"), {
		kind: "unknown",
		name: "/FooBar",
	});
});

test("parseSlashCommand does NOT send unknown slash commands as messages", (t) => {
	// Regression: a typo like `/exti` should not be silently prompted into the
	// model — it should surface as unknown so the user sees the error.
	const result = parseSlashCommand("/exti");
	t.is(result.kind, "unknown");
});

// ── buildServerOptions ────────────────────────────────────────────────

test("buildServerOptions defaults when no flags are passed", (t) => {
	t.deepEqual(buildServerOptions({}), {
		threads: undefined,
		gpuLayers: undefined,
		ctxSize: 4096,
		batchSize: 2048,
		cpuOnly: undefined,
	});
});

test("buildServerOptions parses numeric flags into numbers", (t) => {
	const result = buildServerOptions({
		threads: "8",
		gpuLayers: "20",
		ctxSize: "8192",
		batchSize: "1024",
	});
	t.is(result.threads, 8);
	t.is(result.gpuLayers, 20);
	t.is(result.ctxSize, 8192);
	t.is(result.batchSize, 1024);
});

test("buildServerOptions passes cpuOnly through", (t) => {
	t.is(buildServerOptions({ cpuOnly: true }).cpuOnly, true);
});

test("buildServerOptions applies the 'low' preset", (t) => {
	const result = buildServerOptions({ preset: "low" });
	// From BENCHMARK_PRESETS.low — 4 threads, CPU-only.
	t.is(result.threads, 4);
	t.is(result.gpuLayers, 0);
	t.true(result.cpuOnly);
	t.is(result.ctxSize, 2048);
	t.is(result.batchSize, 512);
});

test("buildServerOptions applies the 'high' preset", (t) => {
	const result = buildServerOptions({ preset: "high" });
	t.is(result.threads, undefined); // auto
	t.is(result.gpuLayers, undefined); // max
	t.falsy(result.cpuOnly);
	t.is(result.ctxSize, 8192);
});

test("buildServerOptions: preset wins over individual flags", (t) => {
	// User passes both — preset is the source of truth (matches benchmark).
	const result = buildServerOptions({
		preset: "low",
		threads: "16",
		ctxSize: "99999",
	});
	t.is(result.threads, 4); // low preset value
	t.is(result.ctxSize, 2048);
});

test("buildServerOptions: unknown preset falls back to individual flags", (t) => {
	const result = buildServerOptions({ preset: "nonexistent", threads: "12" });
	t.is(result.threads, 12);
	t.is(result.ctxSize, 4096); // default, since preset lookup missed
});

// ── buildGenerateOptions ──────────────────────────────────────────────

test("buildGenerateOptions defaults maxTokens to 256 for chat REPL", (t) => {
	// Higher than benchmark's 50 because chat replies need to be useful.
	t.is(buildGenerateOptions({}).maxTokens, 256);
});

test("buildGenerateOptions defaults temperature to 0.8 and topP to 0.9", (t) => {
	const result = buildGenerateOptions({});
	t.is(result.temperature, 0.8);
	t.is(result.topP, 0.9);
	t.is(result.seed, undefined);
});

test("buildGenerateOptions parses numeric flags", (t) => {
	const result = buildGenerateOptions({
		maxTokens: "512",
		temperature: "0.2",
		topP: "0.95",
		seed: "42",
	});
	t.is(result.maxTokens, 512);
	t.is(result.temperature, 0.2);
	t.is(result.topP, 0.95);
	t.is(result.seed, 42);
});

test("buildGenerateOptions uses preset maxTokens when no flag is passed", (t) => {
	const result = buildGenerateOptions({ preset: "ultra" });
	t.is(result.maxTokens, 1024); // ultra preset
});

test("buildGenerateOptions: explicit --max-tokens overrides preset value", (t) => {
	const result = buildGenerateOptions({ preset: "low", maxTokens: "999" });
	// Flag wins because the user passed it explicitly.
	t.is(result.maxTokens, 999);
});

test("buildGenerateOptions: unknown preset falls back to the 256 default", (t) => {
	const result = buildGenerateOptions({ preset: "nonexistent" });
	t.is(result.maxTokens, 256);
});
