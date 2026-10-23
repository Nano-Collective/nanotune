import {
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {getProjectDir} from './config.js';
import {isProcessAlive} from './model-cache.js';

const LOCK_DIR = 'data.lock';
const OWNER_FILE = 'owner.json';

/**
 * How long a caller waits before reporting the holder and giving up. Every
 * write under the lock is a read, a transform and a rewrite of one file, which
 * takes well under a second for a large dataset, so a minute means something
 * is wrong rather than busy.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_MS = 50;

/**
 * The owner file is written straight after the lock directory is created, so a
 * lock that still has no readable owner after this long was abandoned by a
 * process killed between the two steps. A fresh one may simply be mid-write.
 */
const UNOWNED_GRACE_MS = 60_000;

/**
 * Errors from creating a directory that mean "try again", not "you cannot".
 * Windows reports a directory another process has just removed, or one a
 * real-time scanner holds open, as EPERM or EACCES. On POSIX those codes mean
 * the directory is not writable, which no amount of waiting changes, so they
 * fail at once rather than after the whole timeout.
 */
const TRANSIENT_MKDIR: ReadonlySet<string> =
	process.platform === 'win32'
		? new Set(['EPERM', 'EACCES', 'EBUSY'])
		: new Set();

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
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== 'EEXIST') {
				// Windows refuses to create a directory another process removed a
				// moment ago, or one a real-time scanner has open, and says EPERM
				// or EACCES where POSIX would simply have created it. This lock is
				// created and removed constantly under contention, so that is an
				// expected part of acquiring it rather than a failure to report.
				// Bounded by the same deadline as the wait, so a genuinely
				// unwritable directory still surfaces instead of spinning.
				if (!TRANSIENT_MKDIR.has(code ?? '') || Date.now() >= deadline) {
					throw err;
				}
				Atomics.wait(SLEEPER, 0, 0, POLL_MS);
				continue;
			}
		}

		if (unownedStale(path)) {
			// A crash between creating the directory and writing the owner leaves a
			// lock that nothing will ever fill in. Only the grace period makes it safe
			// to remove by path.
			rmSync(path, {recursive: true, force: true});
			continue;
		}
		if (reclaim(path)) {
			// SIGKILL and a hard crash skip the `finally` that removes this,
			// so without taking it over every later command would refuse to run
			// against the project for good.
			continue;
		}

		if (Date.now() >= deadline) {
			const waited =
				timeoutMs >= 1000
					? `${Math.round(timeoutMs / 1000)}s`
					: `${timeoutMs}ms`;
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
	const owner: LockOwner = {
		pid: process.pid,
		host: hostname(),
		since: Date.now(),
	};
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

function parseOwner(file: string): LockOwner | null {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf-8')) as LockOwner;
		return typeof parsed?.pid === 'number' &&
			typeof parsed.host === 'string' &&
			typeof parsed.since === 'number'
			? parsed
			: null;
	} catch {
		return null;
	}
}

function readOwnership(path: string): {owner: LockOwner; file: string} | null {
	const file = join(path, OWNER_FILE);
	const owner = parseOwner(file);
	if (owner) return {owner, file};
	try {
		for (const name of readdirSync(path)) {
			const match = name.match(/^reclaim-(\d+)-([a-f0-9]+)\.json$/);
			if (!match) continue;
			return {
				owner: {
					pid: Number(match[1]),
					host: Buffer.from(match[2], 'hex').toString(),
					since: Date.now(),
				},
				file: join(path, name),
			};
		}
	} catch {
		// The holder can release the directory between the failed mkdir and read.
	}
	return null;
}

function readOwner(path: string): LockOwner | null {
	return readOwnership(path)?.owner ?? null;
}

/**
 * A lock with no readable owner is taken over only once it has stayed that way
 * for longer than the acquisition window could take. The owner file is written
 * straight after the directory is created, so a fresh lock may just be mid-write.
 */
function unownedStale(path: string): boolean {
	return readOwnership(path) === null && ageMs(path) > UNOWNED_GRACE_MS;
}

function ageMs(path: string): number {
	try {
		return Date.now() - statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Only a lock this host took can be judged by its pid. Another host's pid means
 * nothing here - this may be a shared home directory - so it is never reclaimed.
 */
function reclaim(path: string): boolean {
	const state = readOwnership(path);
	if (
		!state ||
		state.owner.host !== hostname() ||
		state.owner.pid === process.pid ||
		isProcessAlive(state.owner.pid)
	) {
		return false;
	}
	const claim = join(
		path,
		`reclaim-${process.pid}-${Buffer.from(hostname()).toString('hex')}.json`,
	);
	try {
		// Renaming the owner record elects one reclaimer. Another contender's
		// stale observation must not authorize deleting a newly acquired lock.
		renameSync(state.file, claim);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
	const captured = parseOwner(claim);
	if (
		captured &&
		captured.host === hostname() &&
		!isProcessAlive(captured.pid)
	) {
		rmSync(path, {recursive: true, force: true});
		return true;
	}
	// A live/new owner was captured after our stale observation. Restore its
	// record without replacing another owner that may have appeared meanwhile.
	try {
		linkSync(claim, join(path, OWNER_FILE));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== 'EEXIST' && code !== 'ENOENT') throw error;
	} finally {
		rmSync(claim, {force: true});
	}
	return false;
}

function describeHolder(path: string): string {
	const owner = readOwner(path);
	if (!owner) return `an unidentified nanotune holding ${path}`;
	const held = Math.max(0, Math.round((Date.now() - owner.since) / 1000));
	const who =
		owner.host === hostname()
			? `pid ${owner.pid}`
			: `${owner.host} pid ${owner.pid}`;
	return `${who}, holding for ${held}s`;
}

function release(): void {
	rmSync(getDataLockPath(), {recursive: true, force: true});
}
