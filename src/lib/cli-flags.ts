/**
 * Parsing for numeric command-line flags.
 *
 * `Number.parseInt('4096x')` is 4096 and `Number.parseInt('abc')` is NaN, and
 * a NaN interpolated into a `llama-server` argument list is the literal string
 * "NaN". Neither is a message about the flag. These helpers use `Number()`, so
 * trailing garbage fails instead of truncating, and name the flag when they
 * reject a value, before any subprocess or network work starts.
 */

export interface FlagRule {
	integer: boolean;
	min?: number;
	max?: number;
	/** Completes "expected …" in the error message. */
	expected: string;
}

export const FLAG_RULES = {
	positiveInteger: {integer: true, min: 1, expected: 'a positive integer'},
	nonNegativeInteger: {
		integer: true,
		min: 0,
		expected: 'a non-negative integer',
	},
	integer: {integer: true, expected: 'an integer'},
	nonNegativeNumber: {
		integer: false,
		min: 0,
		expected: 'a non-negative number',
	},
	unitInterval: {
		integer: false,
		min: 0,
		max: 1,
		expected: 'a number between 0 and 1',
	},
} as const satisfies Record<string, FlagRule>;

/**
 * `Number()` of a raw flag value, or undefined when the flag was not passed.
 * A blank value is screened out first because `Number('')` is 0.
 */
export function parseNumber(raw: string | undefined): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed === '' ? Number.NaN : Number(trimmed);
}

/** Whether `value` satisfies `rule`; NaN and infinities never do. */
export function satisfiesRule(value: number, rule: FlagRule): boolean {
	if (!Number.isFinite(value)) {
		return false;
	}
	if (rule.integer && !Number.isInteger(value)) {
		return false;
	}
	if (rule.min !== undefined && value < rule.min) {
		return false;
	}
	return rule.max === undefined || value <= rule.max;
}

/**
 * Parse one numeric flag. Returns undefined when the flag was not passed, so
 * the caller's default applies, and throws a message naming `flag` when the
 * value is not acceptable.
 */
export function parseNumericFlag(
	flag: string,
	raw: string | undefined,
	rule: FlagRule,
): number | undefined {
	const value = parseNumber(raw);
	if (value === undefined) {
		return undefined;
	}
	if (!satisfiesRule(value, rule)) {
		throw new Error(`Invalid ${flag} "${raw}": expected ${rule.expected}.`);
	}
	return value;
}
