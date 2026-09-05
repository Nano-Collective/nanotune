import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import test from "ava";
import type { ChatMessage } from "../types/index.js";
import {
	buildGenerateOptions,
	buildServerOptions,
	lastExchange,
	parseNumericFlag,
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
	t.deepEqual(buildServerOptions({}).options, {
		threads: undefined,
		gpuLayers: undefined,
		ctxSize: 4096,
		batchSize: 2048,
		cpuOnly: undefined,
	});
});

test("buildServerOptions parses numeric flags into numbers", (t) => {
	const {options: result} = buildServerOptions({
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
	t.is(buildServerOptions({ cpuOnly: true }).options.cpuOnly, true);
});

test("buildServerOptions applies the 'low' preset", (t) => {
	const {options: result} = buildServerOptions({ preset: "low" });
	// From BENCHMARK_PRESETS.low — 4 threads, CPU-only.
	t.is(result.threads, 4);
	t.is(result.gpuLayers, 0);
	t.true(result.cpuOnly);
	t.is(result.ctxSize, 2048);
	t.is(result.batchSize, 512);
});

test("buildServerOptions applies the 'high' preset", (t) => {
	const {options: result} = buildServerOptions({ preset: "high" });
	t.is(result.threads, undefined); // auto
	t.is(result.gpuLayers, undefined); // max
	t.falsy(result.cpuOnly);
	t.is(result.ctxSize, 8192);
});

test("buildServerOptions: preset wins over individual flags", (t) => {
	// User passes both — preset is the source of truth (matches benchmark).
	const {options: result} = buildServerOptions({
		preset: "low",
		threads: "16",
		ctxSize: "99999",
	});
	t.is(result.threads, 4); // low preset value
	t.is(result.ctxSize, 2048);
});

test("buildServerOptions: unknown preset falls back to individual flags", (t) => {
	const {options: result} = buildServerOptions({ preset: "nonexistent", threads: "12" });
	t.is(result.threads, 12);
	t.is(result.ctxSize, 4096); // default, since preset lookup missed
});

// ── buildGenerateOptions ──────────────────────────────────────────────

test("buildGenerateOptions defaults maxTokens to 256 for chat REPL", (t) => {
	// Higher than benchmark's 50 because chat replies need to be useful.
	t.is(buildGenerateOptions({}).options.maxTokens, 256);
});

test("buildGenerateOptions defaults temperature to 0.8 and topP to 0.9", (t) => {
	const {options: result} = buildGenerateOptions({});
	t.is(result.temperature, 0.8);
	t.is(result.topP, 0.9);
	t.is(result.seed, undefined);
});

test("buildGenerateOptions parses numeric flags", (t) => {
	const {options: result} = buildGenerateOptions({
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
	const {options: result} = buildGenerateOptions({ preset: "ultra" });
	t.is(result.maxTokens, 1024); // ultra preset
});

test("buildGenerateOptions: explicit --max-tokens overrides preset value", (t) => {
	const {options: result} = buildGenerateOptions({ preset: "low", maxTokens: "999" });
	// Flag wins because the user passed it explicitly.
	t.is(result.maxTokens, 999);
});

test("buildGenerateOptions: unknown preset falls back to the 256 default", (t) => {
	const {options: result} = buildGenerateOptions({ preset: "nonexistent" });
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

test("parseSlashCommand recognises --force on /save", (t) => {
	t.deepEqual(parseSlashCommand("/save runs/session.json --force"), {
		kind: "save",
		path: "runs/session.json",
		force: true,
	});
	t.deepEqual(parseSlashCommand("/save -f session.json"), {
		kind: "save",
		path: "session.json",
		force: true,
	});
});

test("parseSlashCommand /save --force alone takes no path", (t) => {
	t.deepEqual(parseSlashCommand("/save --force"), { kind: "save", force: true });
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

test.serial("saveTranscript refuses to overwrite an existing file", (t) => {
	inProject("no-clobber", () => {
		const path = saveTranscript(SYSTEM, HISTORY, "session.json");
		const err = t.throws(() =>
			saveTranscript(SYSTEM, [{ role: "user", content: "only" }], "session.json"),
		);
		t.regex(err?.message ?? "", /already exists/);
		t.deepEqual(readTranscript(path)[0].messages, [SYSTEM, ...HISTORY]);
	});
});

test.serial("saveTranscript overwrites an existing file when forced", (t) => {
	inProject("overwrite-forced", () => {
		saveTranscript(SYSTEM, HISTORY, "session.json");
		const saved = readTranscript(
			saveTranscript(
				SYSTEM,
				[{ role: "user", content: "only" }],
				"session.json",
				true,
			),
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

// ── parseNumericFlag ──────────────────────────────────────────────────

test("parseNumericFlag leaves an absent flag absent without erroring", (t) => {
	const errors: string[] = [];
	t.is(parseNumericFlag(undefined, "--threads", errors), undefined);
	t.deepEqual(errors, []);
});

test("parseNumericFlag parses a plain number", (t) => {
	const errors: string[] = [];
	t.is(parseNumericFlag("8", "--threads", errors, true), 8);
	t.is(parseNumericFlag(" 0.25 ", "--temperature", errors), 0.25);
	t.is(parseNumericFlag("0", "--seed", errors, true), 0);
	t.deepEqual(errors, []);
});

test("parseNumericFlag rejects trailing garbage rather than truncating it", (t) => {
	// Number.parseInt("4096x") would return 4096 and run the whole benchmark
	// under a value the user never typed.
	const errors: string[] = [];
	t.is(parseNumericFlag("4096x", "--ctx-size", errors, true), undefined);
	t.is(errors.length, 1);
	t.true(errors[0].includes("--ctx-size"));
	t.true(errors[0].includes("4096x"));
});

test("parseNumericFlag rejects a value that parses to NaN", (t) => {
	// Unchecked, this reaches llama-server as the literal argument "NaN".
	const errors: string[] = [];
	t.is(parseNumericFlag("abc", "--gpu-layers", errors, true), undefined);
	t.is(errors.length, 1);
	t.true(errors[0].includes("--gpu-layers"));
});

test("parseNumericFlag rejects a blank value", (t) => {
	// Number("") is 0, so the blank has to be screened out explicitly.
	const errors: string[] = [];
	t.is(parseNumericFlag("   ", "--threads", errors, true), undefined);
	t.is(errors.length, 1);
});

test("parseNumericFlag rejects Infinity and a fractional integer flag", (t) => {
	const errors: string[] = [];
	t.is(parseNumericFlag("Infinity", "--ctx-size", errors, true), undefined);
	t.is(parseNumericFlag("4096.5", "--ctx-size", errors, true), undefined);
	t.is(errors.length, 2);
	// A float flag still accepts a fraction.
	t.is(parseNumericFlag("0.95", "--top-p", errors), 0.95);
	t.is(errors.length, 2);
});

// ── numeric flag validation ───────────────────────────────────────────

test("buildServerOptions reports no errors when every flag parses", (t) => {
	t.deepEqual(
		buildServerOptions({ threads: "8", ctxSize: "8192" }).errors,
		[],
	);
	t.deepEqual(buildServerOptions({}).errors, []);
});

test("buildServerOptions reports one error per unparseable flag", (t) => {
	const { errors } = buildServerOptions({
		threads: "many",
		gpuLayers: "abc",
		ctxSize: "4096x",
		batchSize: "2048!",
	});
	t.is(errors.length, 4);
	t.true(errors[0].includes("--threads"));
	t.true(errors[1].includes("--gpu-layers"));
	t.true(errors[2].includes("--ctx-size"));
	t.true(errors[3].includes("--batch-size"));
});

test("buildServerOptions does not smuggle a rejected value through as NaN", (t) => {
	// The caller bails on `errors`, but the returned options must not carry a
	// NaN either — String(NaN) is what became the literal `-ngl NaN` argument.
	const { options } = buildServerOptions({ gpuLayers: "abc", ctxSize: "4096x" });
	t.is(options.gpuLayers, undefined);
	t.is(options.ctxSize, 4096); // the default, not the truncated "4096x"
});

test("buildServerOptions still reports a bad flag when a preset wins", (t) => {
	// The preset supplies the values, but a typo the user typed is still a typo.
	const result = buildServerOptions({ preset: "low", ctxSize: "4096x" });
	t.is(result.options.ctxSize, 2048);
	t.is(result.errors.length, 1);
});

test("buildGenerateOptions reports one error per unparseable flag", (t) => {
	const { errors } = buildGenerateOptions({
		maxTokens: "lots",
		temperature: "hot",
		topP: "0.9abc",
		seed: "later",
	});
	t.is(errors.length, 4);
	t.true(errors[0].includes("--max-tokens"));
	t.true(errors[1].includes("--temperature"));
	t.true(errors[2].includes("--top-p"));
	t.true(errors[3].includes("--seed"));
});

test("buildGenerateOptions does not smuggle a rejected value through as NaN", (t) => {
	// JSON.stringify(NaN) is null, so llama-server would silently fall back to
	// its own default instead of failing.
	const { options } = buildGenerateOptions({
		maxTokens: "lots",
		temperature: "hot",
		topP: "0.9abc",
		seed: "later",
	});
	t.is(options.maxTokens, 256);
	t.is(options.temperature, 0.8);
	t.is(options.topP, 0.9);
	t.is(options.seed, undefined);
});

test("buildGenerateOptions accepts explicit zeroes", (t) => {
	// The defaults fall back with `??`, not `||`, so a legitimate zero the user
	// typed survives instead of being replaced by the default.
	const { options, errors } = buildGenerateOptions({
		temperature: "0",
		seed: "0",
	});
	t.is(options.temperature, 0);
	t.is(options.seed, 0);
	t.deepEqual(errors, []);
});
