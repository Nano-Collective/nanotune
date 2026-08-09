import {Text} from 'ink';
import {supportsRawMode} from '../lib/tty.js';

interface Props {
	/** Key hint to show, e.g. "Press any key to exit". */
	children: string;
}

/**
 * Renders a keyboard hint only when there is a keyboard to act on it. Piped
 * and CI runs exit on their own, so telling those users to "press any key"
 * is just noise in the captured output.
 */
export function ExitHint({children}: Props) {
	if (!supportsRawMode()) {
		return null;
	}
	return <Text dimColor>{children}</Text>;
}
