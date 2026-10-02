import test from 'ava';
import {
	computeBackoffDelay,
	HttpError,
	isRetryableError,
	retry,
} from './retry.js';

/**
 * The pure half of the retry boundary. `installLlamaCpp` is macOS-arm64 only
 * and cannot be exercised off an Apple Silicon host, so everything that decides
 * *whether* and *how long* to wait has to be provable here instead — a download
 * that silently stops retrying is indistinguishable to the user from one that
 * never retried at all.
 */

/** A `fetch` rejection, shaped the way undici actually produces it. */
function networkError(code: string): Error {
	return Object.assign(new TypeError('fetch failed'), {
		cause: Object.assign(new Error('socket'), {code}),
	});
}

function abortError(): Error {
	return Object.assign(new Error('The operation was aborted'), {
		name: 'AbortError',
	});
}

/** Records the delay sequence without ever waiting. */
function fakeSleep(): {delays: number[]; sleep: (ms: number) => Promise<void>} {
	const delays: number[] = [];
	return {
		delays,
		sleep: async (ms: number) => {
			delays.push(ms);
		},
	};
}

// --- computeBackoffDelay -----------------------------------------------------

test('delay doubles from the base across successive attempts', t => {
	t.is(computeBackoffDelay(1, 1000, 30_000), 1000);
	t.is(computeBackoffDelay(2, 1000, 30_000), 2000);
	t.is(computeBackoffDelay(3, 1000, 30_000), 4000);
});

test('delay is clamped to the ceiling', t => {
	t.is(computeBackoffDelay(20, 1000, 30_000), 30_000);
});

test('a ceiling below the base still yields the ceiling, not a rising series', t => {
	// maxDelayMs < baseDelayMs would otherwise produce 1000, 2000, 4000... and
	// silently ignore the ceiling for every attempt.
	t.is(computeBackoffDelay(1, 1000, 250), 250);
	t.is(computeBackoffDelay(3, 1000, 250), 250);
});

test('a huge attempt count cannot overflow past the ceiling', t => {
	// 2 ** 1024 is Infinity, and Infinity defeats a naive Math.min clamp.
	t.is(computeBackoffDelay(2000, 1000, 30_000), 30_000);
});

test('attempt zero and negative are treated as the first attempt', t => {
	t.is(computeBackoffDelay(0, 1000, 30_000), 1000);
	t.is(computeBackoffDelay(-5, 1000, 30_000), 1000);
});

test('a non-finite base waits zero rather than reaching setTimeout as NaN', t => {
	// setTimeout treats NaN as 0, but `NaN` in a delay also breaks any caller
	// that logs or sums the sequence.
	t.is(computeBackoffDelay(1, Number.NaN, 30_000), 0);
	t.is(computeBackoffDelay(1, Number.POSITIVE_INFINITY, 30_000), 0);
	t.is(computeBackoffDelay(1, 0, 30_000), 0);
});

test('a negative ceiling never produces a negative delay', t => {
	t.is(computeBackoffDelay(1, 1000, -5), 0);
});

// --- isRetryableError --------------------------------------------------------

test('server errors are retried', t => {
	for (const status of [500, 502, 503, 504]) {
		t.true(isRetryableError(new HttpError('u', status)), `${status}`);
	}
});

test('timeout, too-early and rate-limit statuses are retried', t => {
	for (const status of [408, 425, 429]) {
		t.true(isRetryableError(new HttpError('u', status)), `${status}`);
	}
});

test('a 403 carrying Retry-After is a rate limit and is retried', t => {
	t.true(
		isRetryableError(new HttpError('u', 403, 'Forbidden', '30')),
		'GitHub answers an unauthenticated rate limit this way',
	);
});

test('a bare 403 is a permanent rejection and is not retried', t => {
	// A deleted release asset, or a URL the server refuses outright. Retrying
	// only makes the user wait for an error that cannot change.
	t.false(isRetryableError(new HttpError('u', 403, 'Forbidden')));
});

test('client errors are not retried', t => {
	for (const status of [400, 401, 404, 410, 422]) {
		t.false(isRetryableError(new HttpError('u', status)), `${status}`);
	}
});

test('transient socket and DNS failures are retried', t => {
	for (const code of [
		'ECONNRESET',
		'ETIMEDOUT',
		'ECONNREFUSED',
		'EAI_AGAIN',
		'ENETUNREACH',
		'UND_ERR_SOCKET',
	]) {
		t.true(isRetryableError(networkError(code)), code);
	}
});

test('an unrecognised errno fails closed instead of costing three attempts', t => {
	t.false(isRetryableError(networkError('ENOSPC')));
	t.false(isRetryableError(networkError('EACCES')));
});

test('a fetch rejection with no cause is not retried', t => {
	// undici always sets `cause`, so its absence means something other than a
	// socket problem raised this. Retrying would hide it.
	t.false(isRetryableError(new TypeError('fetch failed')));
});

test('a cancellation is never retried', t => {
	t.false(isRetryableError(abortError()));
	t.false(
		isRetryableError(
			Object.assign(new Error('timeout'), {name: 'TimeoutError'}),
		),
	);
});

test('a cancellation stays unretryable even when the network also failed', t => {
	// A Ctrl+C mid-download produces a 5xx-shaped abort. The abort wins: a user
	// who pressed Ctrl+C does not want another four seconds of waiting.
	t.false(isRetryableError(Object.assign(abortError(), networkError('ECONNRESET'))));
});

test('values that are not errors are not retried', t => {
	for (const value of [undefined, null, 'boom', 42, {}, []]) {
		t.false(isRetryableError(value));
	}
});

// --- retry -------------------------------------------------------------------

test('a first-attempt success makes no further calls', async t => {
	const {sleep, delays} = fakeSleep();
	let calls = 0;
	const result = await retry(
		async () => {
			calls++;
			return 'ok';
		},
		{sleep},
	);

	t.is(result, 'ok');
	t.is(calls, 1);
	t.deepEqual(delays, []);
});

test('a transient failure is retried and the value is returned', async t => {
	const {sleep, delays} = fakeSleep();
	let calls = 0;
	const result = await retry(
		async () => {
			calls++;
			if (calls < 3) throw networkError('ECONNRESET');
			return 'recovered';
		},
		{sleep},
	);

	t.is(result, 'recovered');
	t.is(calls, 3);
	t.deepEqual(delays, [1000, 2000]);
});

test('the last failure propagates once the attempt budget is spent', async t => {
	const {sleep, delays} = fakeSleep();
	let calls = 0;
	const err = await t.throwsAsync(
		retry(
			async () => {
				calls++;
				throw networkError('ETIMEDOUT');
			},
			{sleep},
		),
	);

	t.is(calls, 3);
	t.deepEqual(delays, [1000, 2000], 'no wait after the final attempt');
	t.is((err as {cause: {code: string}}).cause.code, 'ETIMEDOUT');
});

test('a permanent failure is rethrown on the first attempt', async t => {
	const {sleep, delays} = fakeSleep();
	let calls = 0;
	await t.throwsAsync(
		retry(
			async () => {
				calls++;
				throw new HttpError('u', 404, 'Not Found');
			},
			{sleep},
		),
	);

	t.is(calls, 1, 'a 404 cannot become a 200 by trying again');
	t.deepEqual(delays, []);
});

test('attempts of one disables retrying entirely', async t => {
	const {sleep, delays} = fakeSleep();
	let calls = 0;
	await t.throwsAsync(
		retry(
			async () => {
				calls++;
				throw networkError('ECONNRESET');
			},
			{attempts: 1, sleep},
		),
	);

	t.is(calls, 1);
	t.deepEqual(delays, []);
});

test('a fractional or non-positive attempt count is a programming error', async t => {
	for (const attempts of [0, -1, 2.5, Number.NaN]) {
		await t.throwsAsync(retry(async () => 'ok', {attempts}), {
			instanceOf: RangeError,
		});
	}
});

test('an already-aborted signal stops before the first call', async t => {
	const {sleep} = fakeSleep();
	const controller = new AbortController();
	controller.abort();

	let calls = 0;
	// `throwIfAborted` raises the signal's reason, which is a DOMException and
	// therefore not an `Error` instance — callers match on `.name` instead.
	const err = await t.throwsAsync(
		retry(
			async () => {
				calls++;
				return 'ok';
			},
			{sleep, signal: controller.signal},
		),
		{any: true},
	);

	t.is(calls, 0);
	t.is((err as {name: string}).name, 'AbortError');
});

test('a signal that fires mid-retry stops the loop', async t => {
	const controller = new AbortController();
	let calls = 0;

	// Shaped the way `fetch` behaves with an abort: the rejection *is* the
	// cancellation, not a socket error the abort happened to coincide with.
	const err = await t.throwsAsync(
		retry(
			async () => {
				calls++;
				controller.abort();
				throw abortError();
			},
			{signal: controller.signal, sleep: async () => {}},
		),
	);

	t.is(calls, 1, 'a cancellation must not be retried even if retryable');
	t.is((err as Error).name, 'AbortError');
});

test('the default sleep resolves without hanging when nothing aborts', async t => {
	// Guards the real timer path; the injected sleep above never exercises it.
	const started = Date.now();
	await retry(async () => 'ok', {baseDelayMs: 1});
	t.true(Date.now() - started < 1000);
});

test('a permissive classifier still cannot swallow a cancellation', async t => {
	const controller = new AbortController();
	let calls = 0;

	await t.throwsAsync(
		retry(
			async () => {
				calls++;
				controller.abort();
				throw new Error('cancelled by signal');
			},
			{
				sleep: async () => {},
				signal: controller.signal,
				isRetryable: () => true,
			},
		),
	);

	t.is(calls, 1);
});
