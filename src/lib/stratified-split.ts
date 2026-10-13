import type {TrainingExample} from '../types/index.js';

/**
 * Stratified train/validation splitting (#211).
 *
 * Everything in this module is pure: no filesystem, no config, no clock. It
 * takes bucket sizes and returns an allocation. `splitTrainValidation` in
 * `data.ts` is the only thing that turns an allocation into files, which keeps
 * the arithmetic — where an off-by-one silently deletes a user's training data
 * — testable without a single fixture on disk.
 */

/**
 * Bucket key for an example with no usable tag.
 *
 * A NUL prefix makes this unforgeable. `normalizeBucketKey` strips control
 * characters, so no tag can ever start with one, and an example genuinely
 * tagged "untagged" stays in its own bucket instead of merging with every
 * unlabelled example and swamping them. `displayBucketKey` is what callers
 * show a person.
 */
const UNTAGGED_SENTINEL = '\u0000untagged';

/** Bucket key for an example with no usable tag. See `displayBucketKey`. */
export const UNTAGGED_BUCKET = UNTAGGED_SENTINEL;

/** Turn an internal bucket key into something worth printing. */
export function displayBucketKey(key: string): string {
	return key === UNTAGGED_SENTINEL ? 'untagged' : key;
}

/** Beyond this many tags per example the rest are ignored. */
export const MAX_TAGS_PER_EXAMPLE = 16;

/** Tags longer than this are truncated; a 10MB "category" is a mistake, not a category. */
export const MAX_TAG_LENGTH = 64;

/**
 * Above this many buckets the labels carry no signal — every dataset with one
 * example per category has as many buckets as it has examples — so stratifying
 * them is indistinguishable from shuffling. Past the cap we fall back to a
 * random split and say so, rather than reporting a stratification a reviewer
 * would reasonably read as meaningful.
 */
export const MAX_BUCKETS_FOR_STRATIFICATION = 50;

/**
 * Mulberry32: small, fast, 32-bit seedable PRNG. Used so train/valid splits
 * are reproducible across runs when a seed is provided.
 */
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

/** In-place Fisher-Yates shuffle. Returns the same array for chaining. */
export function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

/**
 * Throw unless `ratio` is a usable validation ratio.
 *
 * Without this, `Math.max(1, NaN)` is NaN, `slice(0, NaN)` is `[]`, and
 * train.jsonl is written empty — the dataset silently moves to valid.jsonl and
 * is gone from training. A ratio of 1 or more reaches the same place one step
 * later: validCount exceeds the dataset, trainCount goes negative, and
 * `slice(0, -1)` drops one example more than intended. Both are unrecoverable
 * once the write lands, so they are rejected before any work happens.
 */
export function assertValidRatio(ratio: number): number {
	if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
		throw new Error(
			`Validation ratio must be a finite number, got ${
				typeof ratio === 'number' ? ratio : typeof ratio
			}.`,
		);
	}
	if (ratio < 0) {
		throw new Error(`Validation ratio must be 0 or greater, got ${ratio}.`);
	}
	if (ratio >= 1) {
		throw new Error(
			`Validation ratio must be less than 1 so at least one training example remains, got ${ratio}.`,
		);
	}
	return ratio;
}

/**
 * How many examples the validation set should hold for `total` examples.
 *
 * Always at least one when there are two or more, always at most
 * `total - 1`. A ratio of 0 therefore means "the smallest validation set that
 * is still a validation set", which is what `Math.max(1, ...)` has always
 * meant here; the cap at `total - 1` is new and is what stops a ratio above 1
 * from eating training data.
 */
export function validTarget(total: number, ratio: number): number {
	if (total <= 1) return 0;
	return Math.min(total - 1, Math.max(1, Math.floor(total * ratio)));
}

/**
 * Reduce one raw tag to a bucket key, or `null` if it cannot be one.
 *
 * `Math` and `math` and `  math  ` are one category, not three — a dataset
 * tagged inconsistently across files otherwise stratifies against itself. The
 * match is case-insensitive and NFC-normalized so a tag typed on macOS and the
 * same tag typed with a combining accent still land together.
 */
export function normalizeBucketKey(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	// Control characters go first: they are what would let a tag impersonate the
	// untagged sentinel, and they have no place in a category name.
	const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
	if (!stripped) return null;
	const key = stripped
		.normalize('NFC')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.slice(0, MAX_TAG_LENGTH)
		.trim();
	return key === '' ? null : key;
}

export interface NormalizedTags {
	/**
	 * The author's tags as written, minus the entries that could not be used.
	 * Kept verbatim rather than normalized so an export round-trips back to the
	 * file the user handed us.
	 */
	display: string[];
	/**
	 * The bucket this example is stratified under: its first usable tag's
	 * normalized key, or UNTAGGED_BUCKET when it has none.
	 *
	 * Only the first tag counts. Counting one example in several buckets would
	 * make the bucket sizes sum to more than the dataset, and every
	 * "did we keep every example?" invariant below depends on that sum.
	 */
	bucket: string;
	/** True when a tag was dropped or truncated by the limits above. */
	adjusted: boolean;
}

/**
 * Read an example's `tags` as if nothing about it can be trusted.
 *
 * `parseTrainingData` casts each line straight to `TrainingExample`, so `tags`
 * arrives from a hand-written or third-party file as whatever JSON happened to
 * hold — a bare string, a number, null, an array of objects. Anything that
 * called `.map()` or `.filter()` on it directly would throw mid-split, with the
 * dataset half-written. This is total: it returns a usable answer for every
 * input including `undefined` and hostile shapes, and never throws.
 */
export function normalizeTags(tags: unknown): NormalizedTags {
	const raw: unknown[] = Array.isArray(tags) ? tags : [];
	const display: string[] = [];
	const keys: string[] = [];
	// `tags` present but not an array is itself a correction worth reporting.
	let adjusted = tags !== undefined && !Array.isArray(tags);

	for (const entry of raw) {
		if (display.length >= MAX_TAGS_PER_EXAMPLE) {
			adjusted = true;
			break;
		}
		if (typeof entry !== 'string') {
			adjusted = true;
			continue;
		}
		if (entry.length > MAX_TAG_LENGTH) {
			adjusted = true;
		}
		const key = normalizeBucketKey(entry);
		if (key === null) {
			adjusted = true;
			continue;
		}
		// An entry that normalizes to a key we already have adds nothing but
		// noise ("Math" beside "math"), and would let one example look like it
		// belongs to two of its own buckets.
		if (keys.includes(key)) {
			adjusted = true;
			continue;
		}
		keys.push(key);
		display.push(
			entry.trim().slice(0, MAX_TAG_LENGTH) || entry.slice(0, MAX_TAG_LENGTH),
		);
	}

	return {
		display,
		bucket: keys[0] ?? UNTAGGED_BUCKET,
		adjusted,
	};
}

const NON_FINGERPRINTABLE = /[^\p{L}\p{N}]+/gu;

/**
 * Collapse text to the part a person would consider the same words.
 *
 * Case, accents, punctuation and how much whitespace go; what is left is
 * letters and numbers separated by single spaces, so "What's 2 + 2?" and
 * "whats  22" fingerprint alike.
 */
function normalizeForFingerprint(text: string): string {
	return text
		.normalize('NFC')
		.toLowerCase()
		.replace(NON_FINGERPRINTABLE, ' ')
		.trim();
}

/**
 * A key that ignores every difference a person would not think twice about.
 *
 * Two examples with the same fingerprint are the same example as far as
 * evaluation is concerned. If one lands in train and its twin in valid, the
 * validation loss is measuring memorization of a string the model has already
 * been shown — the number goes down, and nothing about the model got better.
 * That is the failure this whole module exists to prevent.
 *
 * Over-merging is the safe direction: a false collision groups two examples
 * onto one side of the split, costing a little stratification precision, and
 * never puts one example on both sides.
 */
export function contentFingerprint(example: TrainingExample): string {
	const messages = Array.isArray(example?.messages) ? example.messages : [];
	return messages
		.map(m => {
			const role = typeof m?.role === 'string' ? m.role : '';
			const content = typeof m?.content === 'string' ? m.content : '';
			// The role goes through the same filter: an unnormalized role can hold
			// the separator and let one message's content run into the next
			// message's role, so two different conversations could fingerprint alike.
			return `${normalizeForFingerprint(role)} ${normalizeForFingerprint(content)}`;
		})
		.join('\n');
}

/**
 * Collect examples that must not be separated, given their fingerprints.
 *
 * Known limitation, stated rather than papered over: grouping is per-example,
 * so a conversation imported as several separate examples can still be split
 * across train and valid. Catching that needs a conversation identifier, which
 * the on-disk format does not carry. Multi-turn examples — the shape nanotune
 * writes them in — are one example, so they cannot be split this way.
 *
 * Returns one array of example indexes per group, in order of first
 * appearance. Two entries with the same fingerprint land in the same array, so
 * a near-duplicate pair cannot end up on opposite sides of the split.
 */
export function buildLeakGroups(fingerprints: string[]): number[][] {
	const groups = new Map<string, number[]>();
	fingerprints.forEach((fingerprint, index) => {
		const existing = groups.get(fingerprint);
		if (existing) existing.push(index);
		else groups.set(fingerprint, [index]);
	});
	return [...groups.values()];
}

/**
 * The category a group of examples belongs under.
 *
 * A group is held out or kept whole, so it has to land in exactly one bucket.
 * Its members can disagree — a near-duplicate pair where one was tagged `math`
 * and the other left untagged — so the most common category wins, with ties
 * broken lexicographically. Lexicographic rather than insertion order because
 * insertion order would depend on which example happened to be read first,
 * and a split that moves when the file is resorted is not reproducible.
 */
export function majorityBucket(values: string[]): string {
	if (values.length === 0) return UNTAGGED_BUCKET;

	const tally = new Map<string, number>();
	for (const value of values) {
		tally.set(value, (tally.get(value) ?? 0) + 1);
	}

	let best: string | undefined;
	let bestCount = 0;
	for (const value of [...tally.keys()].sort()) {
		const count = tally.get(value) ?? 0;
		if (count > bestCount) {
			best = value;
			bestCount = count;
		}
	}
	return best ?? UNTAGGED_BUCKET;
}

export interface BucketAllocation {
	/** Normalized category key, or UNTAGGED_BUCKET. */
	key: string;
	/** Examples in this bucket. */
	size: number;
	/**
	 * How many of them the validation set actually takes.
	 *
	 * This is the realized count, not the requested one. Keeping near-duplicate
	 * groups whole means a bucket whose groups are larger than its remaining
	 * budget cannot hit the number exactly — `shortfall` below is the gap, and
	 * reporting the realized count is what keeps `nanotune train` honest about
	 * what the validation set holds.
	 */
	valid: number;
}

/** Why stratification was not applied, when it was not. */
export type StratifyFallback =
	| 'no-categories'
	| 'too-many-categories'
	| 'too-few-examples';

export interface StratifyResult {
	/** Indices into the input assigned to the validation set. */
	validIndexes: number[];
	/** Indices assigned to the training set — exactly the complement above. */
	trainIndexes: number[];
	/** Per-bucket outcome, sorted by key so two runs are diffable. */
	buckets: BucketAllocation[];
	/**
	 * Buckets the validation set could not cover at this ratio. Surfaced rather
	 * than swallowed: a rare category missing from validation is the exact
	 * problem #211 was filed about, and it is still the right outcome when the
	 * dataset is too small to cover it.
	 */
	unrepresentedBuckets: string[];
	/**
	 * Validation examples the ratio asked for that group indivisibility made
	 * impossible to fill. Zero for every dataset without duplicate examples.
	 */
	shortfall: number;
	/** Present when no stratification was applied. */
	fallback?: StratifyFallback;
}

/**
 * How many examples to move into validation, per bucket.
 *
 * Returns one number per entry of `sizes`, and guarantees:
 *
 *   - the sum is exactly `validTarget(sum(sizes), ratio)`, always. Summing a
 *     per-bucket `floor` instead loses up to one example per bucket and quietly
 *     hands back a smaller validation set than the user asked for; refusing to
 *     fill the budget at all hands back none, and a training run with no
 *     validation set is not a thing that trains.
 *   - `0 <= result[i] <= sizes[i]`.
 *   - every bucket that can hold one has one, whenever the budget allows.
 *
 * A bucket is only ever emptied when the ratio leaves nothing else to take
 * from: a category with one example either earns its validation slot or
 * disappears from training entirely. Both outcomes are bad, and this picks the
 * one the user asked for — a validation set of the size they requested — rather
 * than silently returning none.
 *
 * `sizes` must be in a stable order (the caller sorts by bucket key) because
 * the tie-breaks below fall back on index. Sorting the input is what makes a
 * seeded split reproducible across runs.
 */
export function apportionValid(sizes: number[], ratio: number): number[] {
	assertValidRatio(ratio);
	if (sizes.length === 0) return [];

	const total = sizes.reduce((sum, size) => sum + size, 0);
	if (total === 0) return sizes.map(() => 0);

	// A bucket can technically give up everything; the passes below make that
	// the last resort rather than the rule.
	const capacity = [...sizes];
	const target = validTarget(total, ratio);

	// Pass 1 — every category earns a validation example before any category
	// earns a second one. This is the fix for #211: floor(1 * 0.1) is 0, so a
	// per-bucket proportional split drops a one-example category out of
	// validation entirely, which is the whole complaint in the issue.
	const allocation = capacity.map(cap => Math.min(1, cap));
	let assigned = allocation.reduce((sum, n) => sum + n, 0);

	// Pass 2 — more categories want a slot than the ratio can pay for. Take
	// them back from the largest buckets first: dropping one validation example
	// from a bucket of 200 barely moves its rate, while the same drop from a
	// bucket of 2 halves it. Draining the largest bucket entirely before
	// touching the next one is deliberate — it leaves the rare categories,
	// which have nothing to spare, holding their slots.
	if (assigned > target) {
		const largestFirst = [...capacity.keys()].sort(
			(a, b) => sizes[b] - sizes[a] || a - b,
		);
		for (const index of largestFirst) {
			if (assigned <= target) break;
			if (allocation[index] > 0) {
				allocation[index]--;
				assigned--;
			}
		}
	}

	// Pass 3 — hand out whatever is left, largest remainder first. Ties break on
	// index, which is bucket-key order, so the result never depends on object
	// key ordering or on which bucket happened to be seen first.
	if (assigned < target) {
		distributeLargestRemainder(allocation, capacity, target);
	}

	return allocation;
}

function distributeLargestRemainder(
	allocation: number[],
	capacity: number[],
	target: number,
): void {
	let remaining = target - allocation.reduce((sum, n) => sum + n, 0);
	let pool = capacity
		.map((_, index) => index)
		.filter(index => allocation[index] < capacity[index]);

	// Each round either fills the pool, exhausts the budget, or hands out a
	// whole pool's worth of floor shares plus the remainders — so this settles
	// in a couple of passes over the pool rather than one iteration per example.
	while (remaining > 0 && pool.length > 0) {
		const poolRoom = pool.reduce(
			(sum, index) => sum + (capacity[index] - allocation[index]),
			0,
		);

		if (poolRoom <= remaining) {
			for (const index of pool) allocation[index] = capacity[index];
			remaining = 0;
			break;
		}

		let handedOut = 0;
		const remainders: Array<{index: number; fraction: number}> = [];
		for (const index of pool) {
			const room = capacity[index] - allocation[index];
			const exact = (room * remaining) / poolRoom;
			const take = Math.min(Math.floor(exact), room);
			allocation[index] += take;
			handedOut += take;
			remainders.push({index, fraction: exact - Math.floor(exact)});
		}
		remaining -= handedOut;

		if (remaining > 0) {
			remainders.sort((a, b) => b.fraction - a.fraction || a.index - b.index);
			for (const {index} of remainders) {
				if (remaining === 0) break;
				if (allocation[index] < capacity[index]) {
					allocation[index]++;
					remaining--;
				}
			}
		}

		pool = pool.filter(index => allocation[index] < capacity[index]);
	}
}

/**
 * Split examples into train and validation, keeping every near-duplicate group
 * whole and keeping every category represented.
 *
 * `groups[g]` lists the example indexes that belong together, and
 * `bucketOfGroup[g]` is the category that group belongs to. Groups — not
 * examples — are the unit of allocation: a group of three paraphrases either is
 * held out or is not, because holding out one of them tells you nothing about a
 * model that trained on the other two.
 *
 * `rng` decides *which* groups inside a category are held out. It has no say in
 * *how many* — those come from `apportionValid`, so the ratio is exact either
 * way. Without it the choice is by first appearance, which is deterministic
 * and fine for a test but would make every seeded split hold out the same
 * examples: a shuffle applied afterwards to a set the plan has already chosen
 * has nothing left to decide.
 *
 * The caller passes the indexes explicitly rather than letting this module
 * infer them from group sizes. `buildLeakGroups` hands out ids in order of
 * first appearance, which means a group's members are scattered through the
 * file, not adjacent — inferring "group g owns a contiguous run" from sizes
 * alone silently points at the wrong examples and drops near-duplicates on both
 * sides, which is the exact failure this is here to prevent.
 */
export function stratifyGroups(
	groups: number[][],
	bucketOfGroup: string[],
	ratio: number,
	rng?: () => number,
): StratifyResult {
	assertValidRatio(ratio);

	const groupCount = groups.length;
	if (bucketOfGroup.length !== groupCount) {
		throw new Error(
			'stratifyGroups: bucketOfGroup must have one entry per group.',
		);
	}

	const totalExamples = groups.reduce(
		(sum, indexes) => sum + indexes.length,
		0,
	);
	const empty: StratifyResult = {
		validIndexes: [],
		trainIndexes: [],
		buckets: [],
		unrepresentedBuckets: [],
		shortfall: 0,
	};

	if (groupCount === 0 || totalExamples === 0) return empty;
	if (totalExamples <= 1) return {...empty, fallback: 'too-few-examples'};

	// A Map, never a plain object: these keys come out of a user-supplied file,
	// and an object keyed by "__proto__" or "constructor" reaches Object's
	// prototype instead of storing a category.
	const bucketSizes = new Map<string, number>();
	for (let group = 0; group < groupCount; group++) {
		const key = bucketOfGroup[group];
		bucketSizes.set(key, (bucketSizes.get(key) ?? 0) + groups[group].length);
	}

	if (bucketSizes.size <= 1) {
		return {...empty, fallback: 'no-categories'};
	}
	if (
		bucketSizes.size >
		Math.max(MAX_BUCKETS_FOR_STRATIFICATION, totalExamples * 0.2)
	) {
		return {...empty, fallback: 'too-many-categories'};
	}

	const keys = [...bucketSizes.keys()].sort();
	const allocation = apportionValid(
		keys.map(key => bucketSizes.get(key) ?? 0),
		ratio,
	);

	// Largest groups first, so the big ones claim their budget before the small
	// ones fragment it. Groups of one — any dataset without duplicates — pack
	// exactly, so this only costs precision where there is something to lose.
	//
	// No index tie-break: `Array.sort` is stable, so groups of equal size keep
	// the order they arrived in, which is the shuffled order. Adding `|| a - b`
	// here would silently sort the shuffle back out.
	const orderWithinBucket = (a: number, b: number) =>
		groups[b].length - groups[a].length;

	const heldOut: boolean[] = new Array(groupCount).fill(false);
	const budgetByBucket = new Map<string, number>();
	for (const [index, key] of keys.entries()) {
		budgetByBucket.set(key, allocation[index]);
	}

	const byBucket = new Map<string, number[]>();
	for (let group = 0; group < groupCount; group++) {
		const key = bucketOfGroup[group];
		const bucket = byBucket.get(key);
		if (bucket) bucket.push(group);
		else byBucket.set(key, [group]);
	}

	for (const key of keys) {
		let budget = budgetByBucket.get(key) ?? 0;
		if (budget <= 0) continue;

		// Shuffle first, then sort stably by size descending. The sort is what
		// packs well — a big group claims its slot before small ones fragment
		// the budget — while the shuffle is what makes equally-sized groups,
		// which are interchangeable as far as packing goes, a random choice
		// rather than always the first few in the file.
		const bucketGroups = byBucket.get(key) ?? [];
		const positions = rng
			? shuffleInPlace(
					bucketGroups.map((_, position) => position),
					rng,
				).map(position => bucketGroups[position])
			: bucketGroups;

		let left = budget;
		for (const group of [...positions].sort(orderWithinBucket)) {
			if (left <= 0) break;
			if (groups[group].length <= left) {
				heldOut[group] = true;
				left -= groups[group].length;
			}
		}
		budgetByBucket.set(key, left);
	}

	const realized = new Map<string, number>();
	for (let group = 0; group < groupCount; group++) {
		if (heldOut[group]) {
			const key = bucketOfGroup[group];
			realized.set(key, (realized.get(key) ?? 0) + groups[group].length);
		}
	}

	const buckets: BucketAllocation[] = keys.map(key => ({
		key,
		size: bucketSizes.get(key) ?? 0,
		valid: realized.get(key) ?? 0,
	}));

	const validIndexes: number[] = [];
	const trainIndexes: number[] = [];
	for (let group = 0; group < groupCount; group++) {
		const destination = heldOut[group] ? validIndexes : trainIndexes;
		destination.push(...groups[group]);
	}

	const requested = allocation.reduce((sum, n) => sum + n, 0);

	return {
		validIndexes,
		trainIndexes,
		buckets,
		unrepresentedBuckets: buckets
			.filter(bucket => bucket.valid === 0)
			.map(bucket => bucket.key),
		shortfall: requested - validIndexes.length,
	};
}
