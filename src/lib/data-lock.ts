import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {getProjectDir} from './config.js';
import {isProcessAlive} from './model-cache.js';

const LOCK_DIR = 'data.lock';
const OWNER_FILE = 'owner.json';

/** How long a caller waits before reporting the holder and giving up. */
const DEFAULT_TIMEOUT_MS = 300_000;
const POLL_MS = 50;

// A busy-wait would burn a core inside the very window this lock exists to
// protect. Node allows Atomics.wait on the main thread, unlike a browser.
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));

export interface LockOwner {
	pid: number;
	host: string;
	/** When the holder took it, for saying how long it has been waiting. */
	since: number;
}

export interface LockOptions {
	timeoutMs?: number;
}

let depth = 0;

export function getDataLockPath(): string {
	return join(getProjectDir(), LOCK_DIR);
}

/**
 * Run `body` holding an exclusive lock on the project's data directory.
 *
 * Re-entrant: a nested call runs the body without waiting, because the process
 * already holds the lock. `collectValidation` calling `fixContextMessages`
 * while holding it is the ordinary case, not an edge.
 *
 * Synchronous by contract. An async body would let two transactions in this
 * process interleave inside the re-entrant chain, which corrupts data without
 * reporting anything - so it is rejected rather than allowed to look fine.
 */
export function withDataLock<T>(body: () => T, options: LockOptions = {}): T {
	if (depth > 0) {
		depth++;
		try {
			return rejectAsyncBody(body);
		} finally {
			depth--;
		}
	}

	depth = 1;
	try {
		acquire(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	} catch (err) {
		depth = 0;
		throw err;
	}

	try {
		return rejectAsyncBody(body);
	} finally {
		depth = 0;
		release();
	}
}

function rejectAsyncBody<T>(body: () => T): T {
	const result = body();
	if (result instanceof Promise) {
		throw new Error(
			'withDataLock was given an async function. Two transactions in one ' +
				'process would interleave inside the re-entrant chain and lose ' +
				'data without reporting anything.',
		);
	}
	return result;
}

/**
 * `mkdir(2)` without `recursive` is the acquisition: it fails with EEXIST
 * atomically on every filesystem this runs on, which `open(..., 'wx')` does not
 * on NFS and which a create-then-write lock file cannot do either.
 */
function acquire(timeoutMs: number): void {
	const path = getDataLockPath();
	mkdirSync(getProjectDir(), {recursive: true});
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		try {
			mkdirSync(path);
			claimAsCurrentProcess(path);
			return;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
		}

		if (abandoned(path)) {
			// SIGKILL and a hard crash skip the `finally` that removes this,
			// so without taking it over every later command would refuse to run
			// against the project for good.
			rmSync(path, {recursive: true, force: true});
			continue;
		}

		if (Date.now() >= deadline) {
			const waited =
				timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
			throw new Error(
				`Gave up after ${waited} waiting for ${describeHolder(path)} to ` +
					`finish writing. Nothing was written. If that process is gone, ` +
					`delete ${path} and try again.`,
			);
		}
		Atomics.wait(SLEEPER, 0, 0, POLL_MS);
	}
}

function claimAsCurrentProcess(path: string): void {
	const owner: LockOwner = {pid: process.pid, host: hostname(), since: Date.now()};
	try {
		writeFileSync(join(path, OWNER_FILE), JSON.stringify(owner));
	} catch (err) {
		// A lock nobody can identify is a lock nobody may reclaim, so give it
		// straight back rather than leave the project unusable.
		rmSync(path, {recursive: true, force: true});
		throw new Error(
			`Could not record ownership of ${path}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

function readOwner(path: string): LockOwner | null {
	try {
		const parsed = JSON.parse(
			readFileSync(join(path, OWNER_FILE), 'utf-8'),
		) as LockOwner;
		return typeof parsed?.pid === 'number' &&
			typeof parsed.host === 'string' &&
			typeof parsed.since === 'number'
			? parsed
			: null;
	} catch {
		return null;
	}
}

/**
 * Only a lock this host took can be judged by its pid. Another host's pid means
 * nothing here - this may be a shared home directory - and an unreadable owner
 * proves nothing at all, so neither is taken over on a guess.
 */
function abandoned(path: string): boolean {
	const owner = readOwner(path);
	return (
		owner !== null && owner.host === hostname() && !isProcessAlive(owner.pid)
	);
}

function describeHolder(path: string): string {
	const owner = readOwner(path);
	if (!owner) return `an unidentified nanotune holding ${path}`;
	const held = Math.max(0, Math.round((Date.now() - owner.since) / 1000));
	const who =
		owner.host === hostname() ? `pid ${owner.pid}` : `${owner.host} pid ${owner.pid}`;
	return `${who}, holding for ${held}s`;
}

function release(): void {
	rmSync(getDataLockPath(), {recursive: true, force: true});
}
