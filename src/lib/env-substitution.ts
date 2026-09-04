/**
 * A value that is *entirely* one `${VAR}` or `${VAR:-default}` reference.
 *
 * Anchored on purpose. The previous pattern also expanded a bare `$NAME`
 * anywhere inside a string, so a key pasted verbatim from a provider console —
 * `sk-ant-api03-AB$CD-EF` — was silently truncated to `sk-ant-api03-AB-EF` at
 * load time. judge.json still read correctly on disk, so inspecting the file
 * proved nothing; the corruption happened on every load. These values are
 * credentials, so the rule is now exact: a value either *is* a reference, or it
 * is a literal that round-trips byte for byte.
 */
const ENV_REFERENCE = /^\$\{([A-Z_][A-Z0-9_]*)(?::-(.*))?\}$/s;

/**
 * Expand a `${VAR}` reference, or return the string untouched.
 *
 * An unset variable with no default leaves the reference in place rather than
 * collapsing to ''. A blank credential is indistinguishable from a wrong one by
 * the time it reaches the provider, and the 401 that comes back sends people to
 * debug their provider account; the intact `${VAR}` lets `loadJudgeConfig` name
 * the variable that is actually missing.
 */
function expandEnvVar(str: string): string {
	if (typeof str !== 'string') {
		return str;
	}

	const match = ENV_REFERENCE.exec(str);
	if (!match) {
		return str;
	}

	const [, varName, defaultValue] = match;

	// `??` and not `||`: a variable that is set but empty is still set, and an
	// empty `${VAR:-}` default is a deliberate empty value.
	return process.env[varName] ?? defaultValue ?? str;
}

/**
 * Whether `value` is a reference `substituteEnvVars` could not resolve, i.e.
 * the variable is unset and no default was given.
 */
export function isUnresolvedEnvRef(value: unknown): value is string {
	return typeof value === 'string' && ENV_REFERENCE.test(value);
}

// Recursively substitute environment variables in objects, arrays, and strings
export function substituteEnvVars<T>(value: T): T {
	if (value === null || value === undefined) {
		return value;
	}

	if (typeof value === 'string') {
		return expandEnvVar(value) as T;
	}

	if (Array.isArray(value)) {
		return value.map((item: unknown) => substituteEnvVars(item)) as T;
	}

	if (typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value)) {
			result[key] = substituteEnvVars(val);
		}

		return result as T;
	}

	return value;
}
