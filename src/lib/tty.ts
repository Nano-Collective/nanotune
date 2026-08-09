/**
 * Terminal capability checks.
 *
 * Ink puts stdin into raw mode as soon as a component calls `useInput`. When
 * stdin is not a TTY — CI, `nanotune status | tee log`, `< /dev/null`, Docker
 * without `-t` — that throws "Raw mode is not supported on the current
 * process.stdin" and dumps a React reconciler stack trace over the user's
 * output. Commands consult these helpers so they can degrade to a clean
 * render-and-exit instead.
 */

/** The subset of `process.stdin` we actually care about. */
export interface StdinLike {
	isTTY?: boolean;
}

/**
 * Whether stdin can be switched into raw mode, i.e. whether we can read
 * individual keystrokes. Mirrors Ink's own `isRawModeSupported` check.
 */
export function supportsRawMode(stdin: StdinLike = process.stdin): boolean {
	return stdin.isTTY === true;
}

/**
 * Message shown when a command that genuinely needs a keyboard (prompts,
 * menus, a REPL) is run without a TTY. Kept here so the wording stays
 * consistent across commands and is testable without spawning a process.
 */
export function interactiveRequiredMessage(command: string): string {
	return (
		`\`nanotune ${command}\` needs an interactive terminal.\n` +
		'stdin is not a TTY, so it cannot read keypresses. Run it directly in a ' +
		'terminal rather than through a pipe, a CI job, or with stdin redirected.'
	);
}
