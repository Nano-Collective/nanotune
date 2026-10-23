import test from 'ava';
import {
	FLAG_RULES,
	parseNumber,
	parseNumericFlag,
	satisfiesRule,
} from './cli-flags.js';

test('a flag that was not passed is left to the caller\'s default', t => {
	t.is(parseNumericFlag('--threads', undefined, FLAG_RULES.positiveInteger), undefined);
	t.is(parseNumber(undefined), undefined);
});

test('trailing garbage fails instead of being truncated', t => {
	// Number.parseInt('4096x') is 4096, which silently ran a different
	// configuration from the one typed.
	t.throws(() => parseNumericFlag('--ctx-size', '4096x', FLAG_RULES.nonNegativeInteger), {
		message: 'Invalid --ctx-size "4096x": expected a non-negative integer.',
	});
	t.throws(() => parseNumericFlag('--gpu-layers', 'abc', FLAG_RULES.integer), {
		message: 'Invalid --gpu-layers "abc": expected an integer.',
	});
});

test('a blank value is rejected rather than read as zero', t => {
	t.throws(() => parseNumericFlag('--max-tokens', '', FLAG_RULES.positiveInteger), {
		message: /Invalid --max-tokens ""/,
	});
	t.throws(() => parseNumericFlag('--max-tokens', '   ', FLAG_RULES.positiveInteger), {
		message: /expected a positive integer/,
	});
});

test('surrounding whitespace is tolerated and the number is returned', t => {
	t.is(parseNumericFlag('--threads', ' 8 ', FLAG_RULES.positiveInteger), 8);
	t.is(parseNumericFlag('--temperature', '0.25', FLAG_RULES.nonNegativeNumber), 0.25);
	t.is(parseNumericFlag('--top-p', '1e-1', FLAG_RULES.unitInterval), 0.1);
});

test('each rule accepts and rejects the values it names', t => {
	const cases: Array<[keyof typeof FLAG_RULES, number, boolean]> = [
		['positiveInteger', 1, true],
		['positiveInteger', 0, false],
		['positiveInteger', -3, false],
		['positiveInteger', 1.5, false],
		['nonNegativeInteger', 0, true],
		['nonNegativeInteger', -1, false],
		['integer', -1, true],
		['integer', 2.5, false],
		['nonNegativeNumber', 0, true],
		['nonNegativeNumber', -0.1, false],
		['unitInterval', 0, true],
		['unitInterval', 1, true],
		['unitInterval', 1.01, false],
		['unitInterval', -0.01, false],
	];
	for (const [name, value, ok] of cases) {
		t.is(satisfiesRule(value, FLAG_RULES[name]), ok, `${name} ${value}`);
	}
});

test('NaN and infinities never satisfy a rule', t => {
	for (const rule of Object.values(FLAG_RULES)) {
		t.false(satisfiesRule(Number.NaN, rule));
		t.false(satisfiesRule(Number.POSITIVE_INFINITY, rule));
	}
	t.throws(() => parseNumericFlag('--seed', 'Infinity', FLAG_RULES.integer), {message: /Invalid --seed/});
});
