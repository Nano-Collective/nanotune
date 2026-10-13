/**
 * The seeded shuffle the split is built on, kept out of `stratified-split.ts`
 * because nothing about it is specific to stratifying: it is a PRNG and a
 * Fisher-Yates, and both the unstratified split and the stratified one need
 * them. On `main` these were private to `data.ts`; this is the same code with
 * a name for it, not a widened surface on the split module.
 */

/** Mulberry32: small, fast, 32-bit seedable PRNG. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** In-place Fisher-Yates. Returns the same array for chaining. */
export function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}
