/**
 * Retry with exponential backoff for the large network operations in
 * `installLlamaCpp`.
 *
 * The downloads here are hundreds of megabytes to gigabytes. A single transient
 * `502` from GitHub releases otherwise costs the user the entire transfer, so a
 * 3-attempt backoff is the difference between a hiccup and a re-run.
 *
 * Two properties are load-bearing and easy to break later:
 *
 * 1. **Only transient failures are retried.** A `404` on a deleted asset, or a
 *    `404` from a typo'd model name, will never resolve. Retrying it just makes
 *    the user stare at a progress bar that is going nowhere.
 * 2. **A cancelled request is never retried.** `AbortError` means somebody
 *    pressed Ctrl+C; answering that with a backoff sleep is a bug, not
 *    resilience.
 *
 * Jitter is deliberately absent. The only client is a single-user CLI, so there
 * is no thundering herd to spread out, and leaving it out keeps the delay
 * sequence assertable in tests without a fake clock.
 *
 * There is deliberately no `onRetry` callback. `installLlamaCpp` is an async
 * generator, and a generator cannot `yield` from inside a callback the retry
 * calls while the generator itself is blocked in an `await` — so a "retrying in
 * 2s…" hook could not actually be delivered. Surfacing the wait properly means
 * turning the download path into a generator, which is a larger change than
 * this one. Against a multi-gigabyte transfer a 3 s pause is unremarkable
 * anyway.
 */

/** Statuses that are transient on their own, without a `Retry-After` header. */
const RETRYABLE_STATUS = new Set([408, 425, 429]);

/**
 * `errno` codes worth another attempt. An allowlist rather than a denylist: an
 * unrecognised code should surface the failure immediately instead of costing
 * the user three attempts and two backoff waits before saying the same thing.
 */
const TRANSIENT_NETWORK_CODES = new Set([
	'EAI_AGAIN',
	'ECONNABORTED',
	'ECONNREFUSED',
	'ECONNRESET',
	'EHOSTUNREACH',
	'ENETDOWN',
	'ENETUNREACH',
	'EPIPE',
	'ETIMEDOUT',
	'UND_ERR_BODY_TIMEOUT',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_SOCKET',
]);

/**
 * Raised for a non-2xx response. `fetch` resolves on a 404, so the status has
 * to be lifted into the thrown error before a classifier can see it — an error
 * carrying only a message string cannot tell a missing asset from an overloaded
 * CDN, and the two want opposite treatment.
 */
export class HttpError extends Error {
	readonly status: number;
	readonly url: string;
	/** Parsed `Retry-After`, in ms. Present only when the server sent one. */
	readonly retryAfterMs: number | undefined;

	constructor(
		url: string,
		status: number,
		statusText?: string,
		retryAfterHeader?: string | null,
	) {
		// `statusText` is empty for most responses under undici, so the status
		// code has to lead or the message reads as "download failed: ".
		super(
			statusText
				? `Request to ${url} failed: ${status} ${statusText}`
				: `Request to ${url} failed: ${status}`,
		);
		this.name = 'HttpError';
		this.status = status;
		this.url = url;
		this.retryAfterMs = parseRetryAfter(retryAfterHeader);
	}
}

/**
 * `Retry-After` is either a delay in seconds or an HTTP-date. Only the former
 * shows up in practice, but the spec allows both and an unparseable value must
 * degrade to the computed backoff rather than throw inside error construction.
 */
function parseRetryAfter(header?: string | null): number | undefined {
	if (!header?.trim()) return undefined;
	const value = header.trim();

	if (/^\d+$/.test(value)) {
		const ms = Number(value) * 1000;
		return Number.isFinite(ms) ? ms : undefined;
	}

	// Avoid Date.parse interpreting an invalid numeric delay such as '-1' as
	// a date. HTTP dates contain a month name.
	if (!/[a-z]/i.test(value)) return undefined;
	const asDate = Date.parse(value);
	if (!Number.isNaN(asDate)) {
		return Math.max(0, asDate - Date.now());
	}
	return undefined;
}

export interface RetryOptions {
	/** Total attempts including the first. Must be a positive integer. */
	attempts?: number;
	/** Delay before the second attempt; doubles from there. Default 1000. */
	baseDelayMs?: number;
	/** Ceiling for exponential backoff. Retry-After may exceed it. Default 30_000. */
	maxDelayMs?: number;
	isRetryable?: (err: unknown) => boolean;
	/** Injected so tests can assert the sequence without waiting. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	signal?: AbortSignal;
}

function isAbort(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.name === 'AbortError' || err.name === 'TimeoutError')
	);
}

/**
 * `fetch` rejects with a bare `TypeError: fetch failed` and hides the real
 * reason on `cause`, so that is where `ECONNRESET` and friends actually live.
 */
function networkCode(err: unknown): string | undefined {
	if (typeof err !== 'object' || err === null) return undefined;
	const {cause} = err as {cause?: unknown};
	if (typeof cause !== 'object' || cause === null) return undefined;
	const {code} = cause as {code?: unknown};
	return typeof code === 'string' ? code : undefined;
}

function isRetryableStatus(status: number, hasRetryAfter: boolean): boolean {
	if (status >= 500 && status < 600) return true;
	if (RETRYABLE_STATUS.has(status)) return true;
	// GitHub answers an unauthenticated API rate limit with 403 plus
	// `Retry-After`, while a genuinely forbidden release asset gets a bare 403.
	// The header is the only thing separating the two, so it decides.
	return status === 403 && hasRetryAfter;
}

export function isRetryableError(err: unknown): boolean {
	if (isAbort(err)) return false;
	if (err instanceof HttpError) {
		return isRetryableStatus(err.status, err.retryAfterMs !== undefined);
	}
	const code = networkCode(err);
	return code !== undefined && TRANSIENT_NETWORK_CODES.has(code);
}

/**
 * Delay before the attempt after `attempt`, which is 1-based. Clamped to
 * `maxDelayMs` and to a 2^30 exponent so a large attempt count cannot overflow
 * to `Infinity` and defeat the clamp.
 */
export function computeBackoffDelay(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
): number {
	// NaN fails every `<=` and would otherwise reach setTimeout as a 0 ms wait.
	if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) return 0;

	const ceiling = Number.isFinite(maxDelayMs)
		? Math.max(0, maxDelayMs)
		: baseDelayMs;
	const exponent = Math.min(Math.max(0, attempt - 1), 30);

	return Math.min(baseDelayMs * 2 ** exponent, ceiling);
}

/**
 * Default wait. Abortable, so a Ctrl+C during a 30 s backoff exits immediately
 * instead of sitting out the remaining sleep.
 */
const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		function onAbort(): void {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
		}
		signal?.addEventListener('abort', onAbort, {once: true});
	});

export async function retry<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const {
		attempts = 3,
		baseDelayMs = 1000,
		maxDelayMs = 30_000,
		isRetryable = isRetryableError,
		sleep = defaultSleep,
		signal,
	} = options;

	if (!Number.isInteger(attempts) || attempts < 1) {
		throw new RangeError(
			`retry: attempts must be a positive integer, got ${attempts}`,
		);
	}

	for (let attempt = 1; attempt <= attempts; attempt++) {
		signal?.throwIfAborted();
		try {
			return await fn();
		} catch (err) {
			// Checked ahead of `isRetryable` so a caller that supplies a
			// permissive classifier still cannot swallow a cancellation.
			if (
				attempt === attempts ||
				signal?.aborted ||
				isAbort(err) ||
				!isRetryable(err)
			) {
				throw err;
			}
			const backoff = computeBackoffDelay(attempt, baseDelayMs, maxDelayMs);
			const retryAfter = err instanceof HttpError ? (err.retryAfterMs ?? 0) : 0;
			// Node timers overflow beyond this limit and become a 1 ms wait.
			await sleep(Math.min(Math.max(backoff, retryAfter), 2 ** 31 - 1), signal);
		}
	}

	// Unreachable: the loop either returns or throws on its final attempt.
	// Kept so the function satisfies its return type without a cast.
	throw new Error('retry: exhausted attempts without throwing');
}
