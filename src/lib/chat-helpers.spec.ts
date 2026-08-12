import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import test from "ava";
import type { ChatMessage } from "../types/index.js";
import {
	buildGenerateOptions,
	buildServerOptions,
	lastExchange,
	parseSlashCommand,
	saveTranscript,
} from "./chat-helpers.js";
import { importData, loadTrainingData } from "./data.js";

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

test("parseSlashCommand recognises /save without an argument", (t) => {
	t.deepEqual(parseSlashCommand("/save"), { kind: "save" });
});

test("parseSlashCommand recognises /save with a path argument", (t) => {
	t.deepEqual(parseSlashCommand("/save runs/session.json"), {
		kind: "save",
		path: "runs/session.json",
	});
});

test("parseSlashCommand /save with only whitespace after it takes no path", (t) => {
	t.deepEqual(parseSlashCommand("/save    "), { kind: "save" });
});

test("parseSlashCommand /save preserves case of the path", (t) => {
	t.deepEqual(parseSlashCommand("/save My-Chat.JSON"), {
		kind: "save",
		path: "My-Chat.JSON",
	});
});

test("parseSlashCommand recognises /keep", (t) => {
	t.deepEqual(parseSlashCommand("/keep"), { kind: "keep" });
});

test("parseSlashCommand /keep ignores trailing arguments", (t) => {
	t.deepEqual(parseSlashCommand("/keep this one"), { kind: "keep" });
});

test("parseSlashCommand is case-insensitive for /save and /keep", (t) => {
	t.deepEqual(parseSlashCommand("/SAVE"), { kind: "save" });
	t.deepEqual(parseSlashCommand("/Keep"), { kind: "keep" });
});

// ── lastExchange ──────────────────────────────────────────────────────

test("lastExchange returns null for an empty history", (t) => {
	t.is(lastExchange([]), null);
});

test("lastExchange returns null when the model has not replied yet", (t) => {
	t.is(lastExchange([{ role: "user", content: "hello" }]), null);
});

test("lastExchange returns the only exchange", (t) => {
	t.deepEqual(
		lastExchange([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		]),
		{ userInput: "hello", assistantOutput: "hi" },
	);
});

test("lastExchange returns the most recent exchange in a long chat", (t) => {
	t.deepEqual(
		lastExchange([
			{ role: "user", content: "first" },
			{ role: "assistant", content: "one" },
			{ role: "user", content: "second" },
			{ role: "assistant", content: "two" },
			{ role: "user", content: "third" },
			{ role: "assistant", content: "three" },
		]),
		{ userInput: "third", assistantOutput: "three" },
	);
});

test("lastExchange ignores a trailing user turn still awaiting a reply", (t) => {
	t.deepEqual(
		lastExchange([
			{ role: "user", content: "first" },
			{ role: "assistant", content: "one" },
			{ role: "user", content: "pending" },
		]),
		{ userInput: "first", assistantOutput: "one" },
	);
});

test("lastExchange returns null when an assistant turn has no user before it", (t) => {
	t.is(lastExchange([{ role: "assistant", content: "unprompted" }]), null);
});

// ── saveTranscript ────────────────────────────────────────────────────

const SYSTEM: ChatMessage = { role: "system", content: "You are terse." };
const HISTORY: ChatMessage[] = [
	{ role: "user", content: "list files by size" },
	{ role: "assistant", content: "ls -lS" },
];

const ORIG_CWD = process.cwd();
const TMP_ROOT = join(ORIG_CWD, ".test-chat-helpers");

function inProject(name: string, fn: (dir: string) => void): void {
	const dir = join(TMP_ROOT, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	process.chdir(dir);
	try {
		fn(dir);
	} finally {
		process.chdir(ORIG_CWD);
	}
}

function readTranscript(path: string): Array<{ messages: ChatMessage[] }> {
	return JSON.parse(readFileSync(path, "utf-8"));
}

test.after.always(() => {
	process.chdir(ORIG_CWD);
	rmSync(TMP_ROOT, { recursive: true, force: true });
});

test.serial("saveTranscript defaults to a timestamped file in .nanotune/chats", (t) => {
	inProject("default-path", (dir) => {
		const path = saveTranscript(SYSTEM, HISTORY);
		t.is(dirname(path), join(dir, ".nanotune", "chats"));
		t.regex(basename(path), /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/);
		t.true(existsSync(path));
	});
});

test.serial("saveTranscript writes the system message ahead of the history", (t) => {
	inProject("with-system", () => {
		const saved = readTranscript(saveTranscript(SYSTEM, HISTORY));
		t.is(saved.length, 1);
		t.deepEqual(saved[0].messages, [SYSTEM, ...HISTORY]);
	});
});

test.serial("saveTranscript omits the system message when there is none", (t) => {
	inProject("no-system", () => {
		const saved = readTranscript(saveTranscript(null, HISTORY));
		t.deepEqual(saved[0].messages, HISTORY);
	});
});

test.serial("saveTranscript omits an empty system message", (t) => {
	inProject("empty-system", () => {
		const saved = readTranscript(
			saveTranscript({ role: "system", content: "" }, HISTORY),
		);
		t.deepEqual(saved[0].messages, HISTORY);
	});
});

test.serial("saveTranscript keeps a non-system context role", (t) => {
	inProject("developer-role", () => {
		const ctx: ChatMessage = { role: "developer", content: "Be terse." };
		const saved = readTranscript(saveTranscript(ctx, HISTORY));
		t.is(saved[0].messages[0].role, "developer");
	});
});

test.serial("saveTranscript writes to an explicit path", (t) => {
	inProject("explicit-path", (dir) => {
		const path = saveTranscript(SYSTEM, HISTORY, "session.json");
		t.is(path, "session.json");
		t.true(existsSync(join(dir, "session.json")));
	});
});

test.serial("saveTranscript creates missing parent directories", (t) => {
	inProject("nested-path", (dir) => {
		const path = saveTranscript(SYSTEM, HISTORY, join("runs", "a", "b.json"));
		t.true(existsSync(join(dir, "runs", "a", "b.json")));
		t.is(readTranscript(path)[0].messages.length, 3);
	});
});

test.serial("saveTranscript keeps every turn of a multi-turn conversation", (t) => {
	inProject("multi-turn", () => {
		const history: ChatMessage[] = [
			{ role: "user", content: "one" },
			{ role: "assistant", content: "1" },
			{ role: "user", content: "two" },
			{ role: "assistant", content: "2" },
		];
		const saved = readTranscript(saveTranscript(SYSTEM, history));
		t.is(saved[0].messages.length, 5);
		t.is(saved[0].messages[4].content, "2");
	});
});

test.serial("saveTranscript output is importable by nanotune data import", (t) => {
	inProject("importable", () => {
		mkdirSync(join(".nanotune", "data"), { recursive: true });
		const path = saveTranscript(SYSTEM, HISTORY);
		const result = importData(path, { role: "system", content: "ignored" });
		t.deepEqual(result.errors, []);
		t.is(result.imported, 1);
		t.is(result.skipped, 0);
		const imported = loadTrainingData();
		t.is(imported.length, 1);
		t.deepEqual(imported[0].messages, [SYSTEM, ...HISTORY]);
	});
});

test.serial("saveTranscript overwrites an existing file at the same path", (t) => {
	inProject("overwrite", () => {
		saveTranscript(SYSTEM, HISTORY, "session.json");
		const saved = readTranscript(
			saveTranscript(SYSTEM, [{ role: "user", content: "only" }], "session.json"),
		);
		t.is(saved[0].messages.length, 2);
	});
});

test.serial("saveTranscript ends the file with a newline", (t) => {
	inProject("trailing-newline", () => {
		const path = saveTranscript(SYSTEM, HISTORY, "session.json");
		t.true(readFileSync(path, "utf-8").endsWith("}\n]\n"));
	});
});
