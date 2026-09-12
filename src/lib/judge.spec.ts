import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {createServer, type Server} from 'node:http';
import type {AddressInfo, Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {
	buildJudgePrompt,
	callJudge,
	getJudgeConfigPath,
	JUDGE_CRITERIA,
	parseJudgeResponse,
	resolveCriteria,
	saveJudgeConfig,
} from './judge.js';
import type {JudgeCriteria} from '../types/index.js';

// resolveCriteria

test('resolveCriteria - resolves built-in criteria by name', t => {
	const criteria = resolveCriteria(['helpful', 'accurate']);
	t.is(criteria.length, 2);
	t.is(criteria[0].name, 'helpful');
	t.is(criteria[0].description, JUDGE_CRITERIA.helpful.description);
	t.is(criteria[1].name, 'accurate');
});

test('resolveCriteria - defaults to helpful, accurate, concise when no names given', t => {
	const criteria = resolveCriteria(undefined);
	t.is(criteria.length, 3);
	t.is(criteria[0].name, 'helpful');
	t.is(criteria[1].name, 'accurate');
	t.is(criteria[2].name, 'concise');
});

test('resolveCriteria - defaults when empty array given', t => {
	const criteria = resolveCriteria([]);
	t.is(criteria.length, 3);
});

test('resolveCriteria - handles unknown criteria names', t => {
	const criteria = resolveCriteria(['custom_criterion']);
	t.is(criteria.length, 1);
	t.is(criteria[0].name, 'custom_criterion');
	t.is(criteria[0].description, 'custom_criterion');
});

test('resolveCriteria - mixes known and unknown criteria', t => {
	const criteria = resolveCriteria(['helpful', 'my_custom']);
	t.is(criteria.length, 2);
	t.is(criteria[0].description, JUDGE_CRITERIA.helpful.description);
	t.is(criteria[1].description, 'my_custom');
});

// buildJudgePrompt

test('buildJudgePrompt - includes criteria in prompt', t => {
	const criteria: JudgeCriteria[] = [
		{name: 'helpful', description: 'Is it helpful'},
	];
	const prompt = buildJudgePrompt('What is 2+2?', 'The answer is 4.', criteria, 7);
	t.true(prompt.includes('helpful'));
	t.true(prompt.includes('Is it helpful'));
	t.true(prompt.includes('What is 2+2?'));
	t.true(prompt.includes('The answer is 4.'));
});

test('buildJudgePrompt - includes pass threshold', t => {
	const criteria: JudgeCriteria[] = [
		{name: 'accurate', description: 'Accuracy'},
	];
	const prompt = buildJudgePrompt('test', 'response', criteria, 8);
	t.true(prompt.includes('overall score >= 8'));
});

test('buildJudgePrompt - includes reference answers when provided', t => {
	const criteria: JudgeCriteria[] = [
		{name: 'accurate', description: 'Accuracy'},
	];
	const prompt = buildJudgePrompt('Capital of France?', 'Paris', criteria, 7, ['Paris', 'paris']);
	t.true(prompt.includes('Reference Answers'));
	t.true(prompt.includes('Paris'));
	t.true(prompt.includes('paris'));
});

test('buildJudgePrompt - omits reference section when no answers provided', t => {
	const criteria: JudgeCriteria[] = [
		{name: 'helpful', description: 'Helpfulness'},
	];
	const prompt = buildJudgePrompt('test', 'response', criteria, 7);
	t.false(prompt.includes('Reference Answers'));
});

// parseJudgeResponse

test('parseJudgeResponse - parses valid JSON response', t => {
	const json = JSON.stringify({
		scores: {helpful: 8, accurate: 9},
		overall: 8.5,
		reasoning: 'Good response',
		pass: true,
	});

	const criteria: JudgeCriteria[] = [
		{name: 'helpful', description: 'Helpfulness'},
		{name: 'accurate', description: 'Accuracy'},
	];

	const result = parseJudgeResponse(json, criteria, 7);
	t.true(result.pass);
	t.is(result.score, 8.5);
	t.is(result.reasoning, 'Good response');
	t.is(result.criteriaScores.helpful, 8);
	t.is(result.criteriaScores.accurate, 9);
});

test('parseJudgeResponse - parses JSON wrapped in code blocks', t => {
	const response = '```json\n{"scores": {"helpful": 7}, "overall": 7, "reasoning": "OK", "pass": true}\n```';
	const criteria: JudgeCriteria[] = [{name: 'helpful', description: 'h'}];

	const result = parseJudgeResponse(response, criteria, 7);
	t.true(result.pass);
	t.is(result.score, 7);
});

test('parseJudgeResponse - clamps scores to 0-10 range', t => {
	const json = JSON.stringify({
		scores: {helpful: 15, accurate: -3},
		overall: 12,
		reasoning: 'Out of range',
		pass: true,
	});

	const criteria: JudgeCriteria[] = [
		{name: 'helpful', description: 'h'},
		{name: 'accurate', description: 'a'},
	];

	const result = parseJudgeResponse(json, criteria, 7);
	t.is(result.criteriaScores.helpful, 10);
	t.is(result.criteriaScores.accurate, 0);
	t.is(result.score, 10);
});

test('parseJudgeResponse - determines pass from threshold when pass field missing', t => {
	const json = JSON.stringify({
		scores: {helpful: 8},
		overall: 8,
		reasoning: 'Good',
	});

	const criteria: JudgeCriteria[] = [{name: 'helpful', description: 'h'}];

	const resultPass = parseJudgeResponse(json, criteria, 7);
	t.true(resultPass.pass);

	const jsonLow = JSON.stringify({
		scores: {helpful: 5},
		overall: 5,
		reasoning: 'Below threshold',
	});
	const resultFail = parseJudgeResponse(jsonLow, criteria, 7);
	t.false(resultFail.pass);
});

test('parseJudgeResponse - throws on invalid JSON', t => {
	const criteria: JudgeCriteria[] = [{name: 'helpful', description: 'h'}];
	t.throws(() => parseJudgeResponse('not json at all', criteria, 7));
});

test('parseJudgeResponse - handles missing scores gracefully', t => {
	const json = JSON.stringify({
		scores: {},
		overall: 6,
		reasoning: 'No criteria scores',
		pass: false,
	});

	const criteria: JudgeCriteria[] = [{name: 'helpful', description: 'h'}];
	const result = parseJudgeResponse(json, criteria, 7);
	t.is(Object.keys(result.criteriaScores).length, 0);
	t.is(result.score, 6);
});

test('parseJudgeResponse - handles non-string reasoning', t => {
	const json = JSON.stringify({
		scores: {helpful: 7},
		overall: 7,
		reasoning: 123,
		pass: true,
	});

	const criteria: JudgeCriteria[] = [{name: 'helpful', description: 'h'}];
	const result = parseJudgeResponse(json, criteria, 7);
	t.is(result.reasoning, '');
});

// JUDGE_CRITERIA presets

test('JUDGE_CRITERIA - contains all expected presets', t => {
	const expected = ['helpful', 'accurate', 'concise', 'safe', 'relevant'];
	for (const name of expected) {
		t.truthy(JUDGE_CRITERIA[name], `Criteria '${name}' should exist`);
		t.truthy(JUDGE_CRITERIA[name].name);
		t.truthy(JUDGE_CRITERIA[name].description);
	}
});

// saveJudgeConfig file permissions

test.serial('saveJudgeConfig - writes judge.json with 0600 permissions', t => {
	const originalCwd = process.cwd();
	const dir = mkdtempSync(join(tmpdir(), 'nanotune-judge-'));
	try {
		process.chdir(dir);
		mkdirSync(join(dir, '.nanotune'), {recursive: true});

		saveJudgeConfig({
			name: 'Test',
			baseUrl: 'https://example.invalid/v1',
			apiKey: 'sk-secret',
			model: 'test-model',
		});

		const path = getJudgeConfigPath();
		// The key may be a literal, so the file must not be group/world readable.
		t.is(statSync(path).mode & 0o777, 0o600);
	} finally {
		process.chdir(originalCwd);
		rmSync(dir, {recursive: true, force: true});
	}
});

test.serial('saveJudgeConfig - tightens permissions on a pre-existing file', t => {
	const originalCwd = process.cwd();
	const dir = mkdtempSync(join(tmpdir(), 'nanotune-judge-'));
	try {
		process.chdir(dir);
		mkdirSync(join(dir, '.nanotune'), {recursive: true});

		// Simulate a judge.json written by an earlier version at default mode.
		const path = join(dir, '.nanotune', 'judge.json');
		writeFileSync(path, '{}', {mode: 0o644});
		t.is(statSync(path).mode & 0o777, 0o644);

		saveJudgeConfig({
			name: 'Test',
			baseUrl: 'https://example.invalid/v1',
			model: 'test-model',
		});

		t.is(statSync(path).mode & 0o777, 0o600);
	} finally {
		process.chdir(originalCwd);
		rmSync(dir, {recursive: true, force: true});
	}
});

test.serial('saveJudgeConfig - is 0600 even under a permissive umask', t => {
	const originalCwd = process.cwd();
	// umask 0 is the only setting under which a dropped `mode` becomes visible
	// in the finished file: without it the temp is created 0666 and rename
	// carries that straight onto judge.json.
	const originalUmask = process.umask(0o000);
	const dir = mkdtempSync(join(tmpdir(), 'nanotune-judge-'));
	try {
		process.chdir(dir);
		mkdirSync(join(dir, '.nanotune'), {recursive: true});

		saveJudgeConfig({
			name: 'Test',
			baseUrl: 'https://example.invalid/v1',
			apiKey: 'sk-secret',
			model: 'test-model',
		});

		t.is(statSync(getJudgeConfigPath()).mode & 0o777, 0o600);
	} finally {
		process.chdir(originalCwd);
		process.umask(originalUmask);
		rmSync(dir, {recursive: true, force: true});
	}
});

test.serial('saveJudgeConfig - leaves no temp file behind', t => {
	const originalCwd = process.cwd();
	const dir = mkdtempSync(join(tmpdir(), 'nanotune-judge-'));
	try {
		process.chdir(dir);
		mkdirSync(join(dir, '.nanotune'), {recursive: true});

		saveJudgeConfig({
			name: 'Test',
			baseUrl: 'https://example.invalid/v1',
			model: 'test-model',
		});

		t.false(existsSync(`${getJudgeConfigPath()}.tmp`));
	} finally {
		process.chdir(originalCwd);
		rmSync(dir, {recursive: true, force: true});
	}
});

test.serial('saveJudgeConfig - recovers from a stale temp file', t => {
	const originalCwd = process.cwd();
	const dir = mkdtempSync(join(tmpdir(), 'nanotune-judge-'));
	try {
		process.chdir(dir);
		mkdirSync(join(dir, '.nanotune'), {recursive: true});

		// A process killed between write and rename leaves this behind. The
		// exclusive create would fail with EEXIST forever if it were not
		// cleared first.
		const path = join(dir, '.nanotune', 'judge.json');
		writeFileSync(`${path}.tmp`, '{"stale":true}', {mode: 0o600});

		t.notThrows(() =>
			saveJudgeConfig({
				name: 'Test',
				baseUrl: 'https://example.invalid/v1',
				model: 'test-model',
			}),
		);
		t.is(statSync(path).mode & 0o777, 0o600);
		t.is(JSON.parse(readFileSync(path, 'utf-8')).name, 'Test');
	} finally {
		process.chdir(originalCwd);
		rmSync(dir, {recursive: true, force: true});
	}
});

// callJudge

/**
 * Start a local OpenAI-compatible endpoint and hand back its base URL plus a
 * teardown. `respond` is left undefined to model the failure this guards
 * against: a server that accepts the connection and never answers, which is
 * what a hung model server or a slow rate-limit backoff looks like from here.
 */
async function startJudgeEndpoint(respond?: (content: string) => string) {
	const sockets: Socket[] = [];
	const server: Server = createServer((_req, res) => {
		if (!respond) return;
		res.writeHead(200, {'content-type': 'application/json'});
		res.end(respond(''));
	});
	server.on('connection', socket => sockets.push(socket));
	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const {port} = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		async close() {
			// A never-answered request holds its socket open, so the server would
			// never finish closing and the test worker would never exit.
			for (const socket of sockets) socket.destroy();
			await new Promise<void>(resolve => {
				server.close(() => resolve());
			});
		},
	};
}

test.serial('callJudge - an abort signal cancels a judge that never replies', async t => {
	// Before the fix callJudge took no signal and forwarded none into
	// generateText, so this await never settled and `benchmark --timeout` had
	// nothing to say about it.
	const endpoint = await startJudgeEndpoint();
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 250);
	const startedAt = Date.now();
	try {
		await t.throwsAsync(
			callJudge(
				'What is 2+2?',
				'4',
				resolveCriteria(['helpful']),
				{
					name: 'Stalled',
					baseUrl: endpoint.baseUrl,
					model: 'test-model',
				},
				7,
				undefined,
				controller.signal,
			),
		);
		// Not just "it threw": it threw on the budget. The AI SDK retries a
		// failed call by default, so an unaborted attempt would still be
		// waiting here rather than having given up.
		t.true(
			Date.now() - startedAt < 3000,
			'judge call outlived the abort budget',
		);
	} finally {
		clearTimeout(timeoutId);
		await endpoint.close();
	}
});

test.serial('callJudge - returns the judge verdict when the provider answers', async t => {
	// The signal is optional and must stay out of the way: a judge that
	// replies inside its budget still scores the response normally.
	const verdict =
		'{"scores": {"helpful": 9}, "overall": 9, "reasoning": "Correct.", "pass": true}';
	const endpoint = await startJudgeEndpoint(() =>
		JSON.stringify({
			id: 'chatcmpl-test',
			object: 'chat.completion',
			created: 0,
			model: 'test-model',
			choices: [
				{
					index: 0,
					message: {role: 'assistant', content: verdict},
					finish_reason: 'stop',
				},
			],
			usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
		}),
	);
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 5000);
	try {
		const result = await callJudge(
			'What is 2+2?',
			'4',
			resolveCriteria(['helpful']),
			{name: 'Local', baseUrl: endpoint.baseUrl, model: 'test-model'},
			7,
			undefined,
			controller.signal,
		);
		t.true(result.pass);
		t.is(result.score, 9);
		t.is(result.criteriaScores.helpful, 9);
	} finally {
		clearTimeout(timeoutId);
		await endpoint.close();
	}
});
