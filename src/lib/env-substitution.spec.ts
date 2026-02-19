import test from 'ava';
import {substituteEnvVars} from './env-substitution.js';

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

test('substituteEnvVars - returns string with unbraced env var', t => {
	process.env.MY_VAR = 'my_value';
	const result = substituteEnvVars('$MY_VAR');
	t.is(result, 'my_value');
	delete process.env.MY_VAR;
});

test('substituteEnvVars - uses default value when env var not set', t => {
	const result = substituteEnvVars('${NONEXISTENT:-default_value}');
	t.is(result, 'default_value');
});

test('substituteEnvVars - returns empty string when env var not found and no default', t => {
	const result = substituteEnvVars('${NONEXISTENT_VAR_XYZ}');
	t.is(result, '');
});

test('substituteEnvVars - substitutes multiple vars in one string', t => {
	process.env.FIRST = 'hello';
	process.env.SECOND = 'world';
	const result = substituteEnvVars('${FIRST} ${SECOND}');
	t.is(result, 'hello world');
	delete process.env.FIRST;
	delete process.env.SECOND;
});

test('substituteEnvVars - handles mixed braced and unbraced vars', t => {
	process.env.VAR1 = 'a';
	process.env.VAR2 = 'b';
	const result = substituteEnvVars('${VAR1} and $VAR2');
	t.is(result, 'a and b');
	delete process.env.VAR1;
	delete process.env.VAR2;
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
	const result = substituteEnvVars(['prefix-${ARRAY_VAR}-suffix']);
	t.deepEqual(result, ['prefix-array_value-suffix']);
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
		endpoints: ['localhost/api', 'localhost/health'],
	});
	delete process.env.HOST;
	delete process.env.PORT;
});
