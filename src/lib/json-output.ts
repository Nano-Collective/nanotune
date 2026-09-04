/**
 * The `--json` output contract, in one place.
 *
 * Commands run with `--json` never mount Ink: `render()` writes to stdout the
 * moment it mounts, and a box-drawn frame in the middle of a JSON document is
 * not something a consumer can recover from. The CLI calls a plain collector
 * function instead and hands the result here.
 *
 * The contract itself: stdout carries the payload or nothing at all — never a
 * diagnostic, never a partial document — and the exit code carries the status,
 * so `nanotune <cmd> --json | jq .` works and `$?` still gates a script.
 */

export interface JsonOutcome {
	/** JSON document destined for stdout, or null when no report was produced. */
	stdout: string | null;
	/** Diagnostic destined for stderr, or null on success. */
	stderr: string | null;
	exitCode: number;
}

/**
 * Decide what a `--json` run should write and exit with, without writing
 * anything. Split from {@link emitJson} so the contract is testable without
 * capturing the real stdout — the same split as `buildTrainingArgs` against
 * `runTraining`.
 *
 * `failed` marks a run that produced a perfectly good report describing a bad
 * state — training data with errors, say. That still prints, because the
 * report is the useful part, but it must exit non-zero so CI can gate on it.
 */
export async function buildJsonOutcome<T>(
	collect: () => T | Promise<T>,
	failed?: (result: T) => boolean,
): Promise<JsonOutcome> {
	let result: T;
	try {
		result = await collect();
	} catch (err) {
		return {
			stdout: null,
			stderr: err instanceof Error ? err.message : String(err),
			exitCode: 1,
		};
	}

	// Serialise in full before anything is written. JSON.stringify builds the
	// whole document in memory, so a value it cannot handle fails here rather
	// than after half an object has already reached the consumer.
	let json: string;
	try {
		json = JSON.stringify(result, null, 2);
	} catch (err) {
		return {
			stdout: null,
			stderr: err instanceof Error ? err.message : String(err),
			exitCode: 1,
		};
	}

	return {
		stdout: `${json}\n`,
		stderr: null,
		exitCode: failed?.(result) ? 1 : 0,
	};
}

/**
 * Run a collector and perform the writes {@link buildJsonOutcome} decided on.
 *
 * Sets `process.exitCode` rather than calling `process.exit`, so buffered
 * stdout is flushed before the process leaves — `process.exit` can truncate a
 * large report mid-document when stdout is a pipe.
 */
export async function emitJson<T>(
	collect: () => T | Promise<T>,
	failed?: (result: T) => boolean,
): Promise<void> {
	const outcome = await buildJsonOutcome(collect, failed);
	if (outcome.stdout !== null) {
		process.stdout.write(outcome.stdout);
	}
	if (outcome.stderr !== null) {
		console.error(outcome.stderr);
	}
	if (outcome.exitCode !== 0) {
		process.exitCode = outcome.exitCode;
	}
}
