import type {MatchMode} from '../types/index.js';

/**
 * Normalize text for comparison:
 * - trim whitespace
 * - collapse runs of whitespace to a single space
 * - canonicalize different quote characters to `"`
 */
export function normalizeText(text: string): string {
	return text.trim().replace(/\s+/g, ' ').replace(/["'`]/g, '"');
}

/**
 * Check if an actual response matches any of the acceptable answers under the
 * given match mode.
 *
 * Match modes:
 * - "exact": Must match exactly (after optional case normalization).
 * - "contains": Response contains the acceptable answer anywhere.
 * - "startsWith": Response starts with the acceptable answer.
 * - "partial": Bidirectional prefix match — actual is a prefix of expected
 *   OR expected is a prefix of actual. Accepts truncated answers; use with
 *   care since it can inflate pass rates.
 * - "semantic": Normalized comparison; counts as a pass if actual exactly
 *   matches expected, or extends expected with a delimiter ("ls" + " -la").
 *   Does NOT accept truncations of expected. Default; good for code.
 */
export function checkPass(
	acceptable: string[],
	actual: string,
	mode: MatchMode = 'semantic',
	caseSensitive = false,
): {passed: boolean; matchedAnswer: string | null; matchType: string | null} {
	const processText = (text: string) => {
		let processed = text.trim();
		if (!caseSensitive) {
			processed = processed.toLowerCase();
		}
		return processed;
	};

	const actualProcessed = processText(actual);
	const actualNormalized = normalizeText(actualProcessed);

	for (const expected of acceptable) {
		const expectedProcessed = processText(expected);
		const expectedNormalized = normalizeText(expectedProcessed);

		switch (mode) {
			case 'exact': {
				if (actualProcessed === expectedProcessed) {
					return {passed: true, matchedAnswer: expected, matchType: 'exact'};
				}
				break;
			}

			case 'contains': {
				if (actualNormalized.includes(expectedNormalized)) {
					return {
						passed: true,
						matchedAnswer: expected,
						matchType: 'contains',
					};
				}
				break;
			}

			case 'startsWith': {
				if (actualNormalized.startsWith(expectedNormalized)) {
					return {
						passed: true,
						matchedAnswer: expected,
						matchType: 'startsWith',
					};
				}
				break;
			}

			case 'partial': {
				// Bidirectional prefix match. Opt-in because accepting a truncated
				// answer ("ls" for "ls -la") will inflate pass rates.
				if (
					actualNormalized.startsWith(expectedNormalized) ||
					expectedNormalized.startsWith(actualNormalized)
				) {
					return {
						passed: true,
						matchedAnswer: expected,
						matchType: 'partial',
					};
				}
				break;
			}

			case 'semantic':
			default: {
				// 1. Exact match after normalization.
				if (actualNormalized === expectedNormalized) {
					return {passed: true, matchedAnswer: expected, matchType: 'exact'};
				}

				// 2. Actual starts with expected followed by a delimiter — allows
				// trailing content but the expected answer must appear in full.
				if (
					actualNormalized.startsWith(`${expectedNormalized} `) ||
					actualNormalized.startsWith(`${expectedNormalized}:`) ||
					actualNormalized.startsWith(`${expectedNormalized}\n`)
				) {
					return {
						passed: true,
						matchedAnswer: expected,
						matchType: 'startsWith',
					};
				}

				break;
			}
		}
	}

	return {passed: false, matchedAnswer: null, matchType: null};
}
