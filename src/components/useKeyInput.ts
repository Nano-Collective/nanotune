import {type Key, useApp, useInput} from 'ink';
import {useEffect} from 'react';
import {supportsRawMode} from '../lib/tty.js';

export type KeyHandler = (input: string, key: Key) => void;

/**
 * Drop-in replacement for Ink's `useInput` that no-ops when stdin is not a
 * TTY. Ink enables raw mode unconditionally, which throws on a non-TTY stdin;
 * passing `isActive: false` skips that entirely, so piped and CI runs render
 * their output instead of a stack trace.
 */
export function useKeyInput(handler: KeyHandler, isActive = true): void {
	useInput(handler, {isActive: isActive && supportsRawMode()});
}

/**
 * Exit once `done` is true and there is no keyboard to wait on. Commands
 * normally park on a "Press any key to exit" frame; without a TTY that would
 * hang forever, so we unmount as soon as the final frame has been committed.
 *
 * Pass `failed` to mark the run as unsuccessful — it sets a non-zero exit code
 * so `nanotune train && nanotune export` chains behave in scripts.
 */
export function useAutoExit(done: boolean, failed = false): void {
	const {exit} = useApp();

	useEffect(() => {
		if (!done) {
			return;
		}
		if (failed) {
			process.exitCode = 1;
		}
		if (!supportsRawMode()) {
			exit();
		}
	}, [done, failed, exit]);
}
