import test from 'ava';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	explainConvertFailure,
	isLlamaCppInstalledAt,
	parseChatCompletionResponse,
	pickMacArm64Release,
	scaleProgress,
	selectConvertMembers,
} from './llama-cpp.js';

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

// --- choosing a release to install --------------------------------------

const asset = (name: string) => ({name, browser_download_url: `https://example.test/${name}`});

test('the install skips a placeholder release with no binaries, as llama.cpp\'s "latest" is today', t => {
	// GitHub's `releases/latest` for llama.cpp answers with v0.7.0, whose only
	// asset is `nightly-tag.txt`; every real build is a prerelease.
	const picked = pickMacArm64Release([
		{tag_name: 'v0.7.0', assets: [asset('nightly-tag.txt')]},
		{
			tag_name: 'b11836',
			assets: [
				asset('llama-b11836-bin-ubuntu-x64.tar.gz'),
				asset('llama-b11836-bin-macos-x64.tar.gz'),
				asset('llama-b11836-bin-macos-arm64.tar.gz'),
			],
		},
		{tag_name: 'b11835', assets: [asset('llama-b11835-bin-macos-arm64.tar.gz')]},
	]);
	t.is(picked.tag, 'b11836');
	t.is(picked.downloadUrl, 'https://example.test/llama-b11836-bin-macos-arm64.tar.gz');
});

test('the install never picks a draft release', t => {
	const picked = pickMacArm64Release([
		{tag_name: 'b2', draft: true, assets: [asset('llama-b2-bin-macos-arm64.tar.gz')]},
		{tag_name: 'b1', assets: [asset('llama-b1-bin-macos-arm64.tar.gz')]},
	]);
	t.is(picked.tag, 'b1');
});

test('the install ignores non-tarball macOS arm64 assets', t => {
	t.throws(
		() => pickMacArm64Release([{tag_name: 'b1', assets: [asset('llama-b1-bin-macos-arm64.zip')]}]),
		{message: /macOS arm64/},
	);
});

test('the install fails clearly when no recent release has a macOS arm64 binary', t => {
	t.throws(() => pickMacArm64Release([]), {message: /macOS arm64/});
	t.throws(() => pickMacArm64Release([{tag_name: 'v0.7.0', assets: [asset('nightly-tag.txt')]}]), {message: /macOS arm64/});
});

// --- which parts of the source archive the convert script needs ------------

test('the archive prefix is read from the listing, not rebuilt from the tag', t => {
	// GitHub drops a leading "v" from the top directory of a tag archive.
	t.deepEqual(
		selectConvertMembers(['llama.cpp-0.7.0/', 'llama.cpp-0.7.0/gguf-py/gguf/__init__.py']),
		['llama.cpp-0.7.0/gguf-py'],
	);
});

test('conversion/ is extracted when the release has it and left alone when it does not', t => {
	const withPackage = selectConvertMembers([
		'llama.cpp-b11836/',
		'llama.cpp-b11836/convert_hf_to_gguf.py',
		'llama.cpp-b11836/conversion/__init__.py',
		'llama.cpp-b11836/gguf-py/gguf/__init__.py',
	]);
	t.deepEqual(withPackage, ['llama.cpp-b11836/gguf-py', 'llama.cpp-b11836/conversion']);

	const without = selectConvertMembers([
		'llama.cpp-b3000/',
		'llama.cpp-b3000/convert_hf_to_gguf.py',
		'llama.cpp-b3000/gguf-py/gguf/__init__.py',
	]);
	t.deepEqual(without, ['llama.cpp-b3000/gguf-py']);
});

test('an unreadable source archive is reported rather than extracted blindly', t => {
	t.throws(() => selectConvertMembers([]), {message: /empty or unreadable/});
});

// --- is an existing install usable ----------------------------------------

function fakeInstall(script: string, extras: string[] = []): string {
	const dir = mkdtempSync(join(tmpdir(), 'nanotune-llama-install-'));
	mkdirSync(join(dir, 'bin'), {recursive: true});
	writeFileSync(join(dir, 'bin', 'llama-quantize'), '');
	writeFileSync(join(dir, 'convert_hf_to_gguf.py'), script);
	mkdirSync(join(dir, 'gguf-py'));
	for (const extra of extras) mkdirSync(join(dir, extra));
	return dir;
}

test('an install of a script that imports `conversion` is incomplete without that package', t => {
	const script = 'import torch\n\nfrom conversion import (\n    ModelBase,\n)\n';
	const broken = fakeInstall(script);
	const whole = fakeInstall(script, ['conversion']);
	try {
		t.false(isLlamaCppInstalledAt(broken));
		t.true(isLlamaCppInstalledAt(whole));
	} finally {
		rmSync(broken, {recursive: true, force: true});
		rmSync(whole, {recursive: true, force: true});
	}
});

test('an older script with no `conversion` import needs no such package', t => {
	const dir = fakeInstall('import gguf\nprint("old convert script")\n');
	try {
		t.true(isLlamaCppInstalledAt(dir));
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

test('an install missing its quantizer, script or gguf-py is not usable', t => {
	const dir = fakeInstall('import gguf\n');
	try {
		rmSync(join(dir, 'gguf-py'), {recursive: true});
		t.false(isLlamaCppInstalledAt(dir));
		t.false(isLlamaCppInstalledAt(join(dir, 'does-not-exist')));
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

// --- explaining a failed conversion ---------------------------------------

test('a missing torch is explained as exactly that', t => {
	const message = explainConvertFailure(
		"Traceback (most recent call last):\n  File \"convert_hf_to_gguf.py\", line 12, in <module>\n    import torch\nModuleNotFoundError: No module named 'torch'\n",
	);
	t.regex(message ?? '', /needs the Python package "torch"/);
	t.regex(message ?? '', /pip3 install torch/);
	t.notRegex(message ?? '', /pip3 install gguf/);
});

test('a missing submodule names its top-level package and the pip name', t => {
	t.regex(explainConvertFailure("ModuleNotFoundError: No module named 'google.protobuf'") ?? '', /pip3 install protobuf/);
	t.regex(explainConvertFailure("ModuleNotFoundError: No module named 'yaml'") ?? '', /pip3 install pyyaml/);
});

test('a missing conversion package points at reinstalling llama.cpp', t => {
	const message = explainConvertFailure("ModuleNotFoundError: No module named 'conversion'");
	t.regex(message ?? '', /install is incomplete/);
	t.regex(message ?? '', /~\/\.nanotune\/llama\.cpp/);
});

test('a failure that is not a missing module is left to the caller', t => {
	t.is(explainConvertFailure('RuntimeError: unsupported architecture'), null);
	t.is(explainConvertFailure(''), null);
});
