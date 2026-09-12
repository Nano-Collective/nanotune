import test from 'ava';
import {isUnresolvedEnvRef, substituteEnvVars} from './env-substitution.js';

// Suppress console.error noise from missing env var warnings
const originalConsoleError = console.error;
test.before(() => {
	console.error = () => {};
});
test.after(() => {
	console.error = originalConsoleError;
});

// String substitution

test('substituteEnvVars - returns string with existing env var', t => {
	process.env.TEST_VAR = 'test_value';
	const result = substituteEnvVars('${TEST_VAR}');
	t.is(result, 'test_value');
	delete process.env.TEST_VAR;
});

test('substituteEnvVars - leaves an unbraced $NAME alone', t => {
	// The `$NAME` form is gone: it matched any `$` before an uppercase letter,
	// which is a shape real API keys have.
	process.env.MY_VAR = 'my_value';
	t.is(substituteEnvVars('$MY_VAR'), '$MY_VAR');
	delete process.env.MY_VAR;
});

test('substituteEnvVars - uses default value when env var not set', t => {
	const result = substituteEnvVars('${NONEXISTENT:-default_value}');
	t.is(result, 'default_value');
});

test('substituteEnvVars - leaves the reference intact when the var is unset', t => {
	// Not '': a blank credential reaches the provider as a 401 that blames the
	// user's account. The intact reference lets loadJudgeConfig name the variable.
	t.is(substituteEnvVars('${NONEXISTENT_VAR_XYZ}'), '${NONEXISTENT_VAR_XYZ}');
});

test('substituteEnvVars - resolves a variable that is set but empty', t => {
	// Set-but-empty is still set, so it wins over both the default and the
	// leave-it-alone fallback.
	process.env.EMPTY_VAR = '';
	t.is(substituteEnvVars('${EMPTY_VAR}'), '');
	delete process.env.EMPTY_VAR;
});

test('substituteEnvVars - honours an empty default', t => {
	t.is(substituteEnvVars('${NONEXISTENT_VAR_XYZ:-}'), '');
});

test('substituteEnvVars - leaves a string holding several references alone', t => {
	// Only a whole-value reference substitutes, so this is a literal now.
	process.env.FIRST = 'hello';
	process.env.SECOND = 'world';
	t.is(substituteEnvVars('${FIRST} ${SECOND}'), '${FIRST} ${SECOND}');
	delete process.env.FIRST;
	delete process.env.SECOND;
});

test('substituteEnvVars - leaves an embedded reference alone', t => {
	process.env.HOST_VAR = 'example.com';
	t.is(
		substituteEnvVars('https://${HOST_VAR}/v1'),
		'https://${HOST_VAR}/v1',
	);
	delete process.env.HOST_VAR;
});

// Non-string input

test('substituteEnvVars - returns number unchanged', t => {
	const result = substituteEnvVars(42);
	t.is(result, 42);
});

test('substituteEnvVars - returns boolean unchanged', t => {
	const result = substituteEnvVars(true);
	t.is(result, true);
});

test('substituteEnvVars - returns null unchanged', t => {
	const result = substituteEnvVars(null);
	t.is(result, null);
});

test('substituteEnvVars - returns undefined unchanged', t => {
	const result = substituteEnvVars(undefined);
	t.is(result, undefined);
});

// Array recursion

test('substituteEnvVars - substitutes vars in array of strings', t => {
	process.env.ARRAY_VAR = 'array_value';
	const result = substituteEnvVars(['${ARRAY_VAR}', 'prefix-${ARRAY_VAR}']);
	t.deepEqual(result, ['array_value', 'prefix-${ARRAY_VAR}']);
	delete process.env.ARRAY_VAR;
});

test('substituteEnvVars - handles nested arrays', t => {
	process.env.NESTED = 'nested';
	const result = substituteEnvVars([['${NESTED}']]);
	t.deepEqual(result, [['nested']]);
	delete process.env.NESTED;
});

// Object recursion

test('substituteEnvVars - substitutes vars in object values', t => {
	process.env.OBJ_VAR = 'obj_value';
	const result = substituteEnvVars({key: '${OBJ_VAR}'});
	t.deepEqual(result, {key: 'obj_value'});
	delete process.env.OBJ_VAR;
});

test('substituteEnvVars - handles nested objects', t => {
	process.env.NESTED_VAR = 'nested_value';
	const result = substituteEnvVars({
		outer: {inner: '${NESTED_VAR}'},
	});
	t.deepEqual(result, {outer: {inner: 'nested_value'}});
	delete process.env.NESTED_VAR;
});

// Edge cases

test('substituteEnvVars - handles empty string', t => {
	const result = substituteEnvVars('');
	t.is(result, '');
});

test('substituteEnvVars - handles string without env vars', t => {
	const result = substituteEnvVars('just a literal string');
	t.is(result, 'just a literal string');
});

test('substituteEnvVars - complex config object', t => {
	process.env.HOST = 'localhost';
	process.env.PORT = '8080';
	const result = substituteEnvVars({
		server: {host: '${HOST}', port: '${PORT}', ssl: true},
		fallback: '${MISSING:-fallback_url}',
		endpoints: ['${HOST}/api', '${HOST}/health'],
	});
	t.deepEqual(result, {
		server: {host: 'localhost', port: '8080', ssl: true},
		fallback: 'fallback_url',
		// Embedded, so literal.
		endpoints: ['${HOST}/api', '${HOST}/health'],
	});
	delete process.env.HOST;
	delete process.env.PORT;
});

// Literal API keys

// Every shape below reached expandEnvVar's old unbraced `$NAME` branch and came
// back truncated, on every load, while judge.json still read correctly on disk.
for (const key of [
	'sk-live$SECRET_PART-abc123',
	'sk-ant-api03-AB$CD-EF',
	'sk-live$secret-abc123',
	'sk-$A$B$C',
	'$LEADING-dollar',
	'trailing-dollar$',
]) {
	test(`substituteEnvVars - literal key round-trips: ${key}`, t => {
		// Set, so a surviving expansion swaps in a value rather than '' and the
		// assertion cannot pass by the variable happening to be unset.
		process.env.SECRET_PART = 'LEAKED';
		process.env.CD = 'LEAKED';
		process.env.A = 'LEAKED';
		process.env.LEADING = 'LEAKED';
		t.is(substituteEnvVars(key), key);
		t.false(substituteEnvVars(key).includes('LEAKED'));
		for (const name of ['SECRET_PART', 'CD', 'A', 'LEADING']) {
			delete process.env[name];
		}
	});
}

test('substituteEnvVars - a literal key survives inside a judge config', t => {
	// The path that actually broke: loadJudgeConfig hands the whole parsed
	// judge.json through, so the key is corrupted in transit rather than on disk.
	process.env.CD = 'LEAKED';
	t.deepEqual(
		substituteEnvVars({
			name: 'Anthropic',
			baseUrl: 'https://api.anthropic.com/v1',
			apiKey: 'sk-ant-api03-AB$CD-EF',
			model: 'claude-haiku',
		}),
		{
			name: 'Anthropic',
			baseUrl: 'https://api.anthropic.com/v1',
			apiKey: 'sk-ant-api03-AB$CD-EF',
			model: 'claude-haiku',
		},
	);
	delete process.env.CD;
});

// isUnresolvedEnvRef

test('isUnresolvedEnvRef - true for a bare reference', t => {
	t.true(isUnresolvedEnvRef('${SOME_VAR}'));
});

test('isUnresolvedEnvRef - false for a literal key that contains a dollar', t => {
	// The guard must never reject a key the user pasted verbatim.
	t.false(isUnresolvedEnvRef('sk-ant-api03-AB$CD-EF'));
	t.false(isUnresolvedEnvRef('https://${HOST}/v1'));
	t.false(isUnresolvedEnvRef(''));
	t.false(isUnresolvedEnvRef(undefined));
});

test('isUnresolvedEnvRef - false once the reference has resolved', t => {
	process.env.RESOLVED_VAR = 'a-real-value';
	t.false(isUnresolvedEnvRef(substituteEnvVars('${RESOLVED_VAR}')));
	delete process.env.RESOLVED_VAR;
});
