import test from 'ava';
import {
	buildJudgePrompt,
	JUDGE_CRITERIA,
	parseJudgeResponse,
	resolveCriteria,
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
