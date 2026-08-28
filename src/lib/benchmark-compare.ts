import type {BenchmarkResult} from '../types/index.js';

export interface CategoryDelta {
	category: string;
	before: {passed: number; total: number; rate: number};
	after: {passed: number; total: number; rate: number};
	delta: number;
}

export interface TestFlip {
	id: number;
	prompt: string;
	category: string;
	beforePassed: boolean;
	afterPassed: boolean;
	direction: 'fixed' | 'regressed';
}

export interface BenchmarkComparison {
	before: {
		model: string;
		timestamp: string;
		passed: number;
		total: number;
		passRate: number;
		isBase?: boolean;
	};
	after: {
		model: string;
		timestamp: string;
		passed: number;
		total: number;
		passRate: number;
		isBase?: boolean;
	};
	overallDelta: number;
	categories: CategoryDelta[];
	flips: TestFlip[];
	onlyInBefore: number[];
	onlyInAfter: number[];
}

/**
 * Diff two saved benchmark runs. Tests are matched by id, so the comparison
 * stays meaningful even if `before` and `after` ran against slightly
 * different `tests.json` versions — ids present in only one run are reported
 * via `onlyInBefore`/`onlyInAfter` rather than silently ignored.
 */
export function compareBenchmarks(
	before: BenchmarkResult,
	after: BenchmarkResult,
): BenchmarkComparison {
	const categories = diffCategories(before.categories, after.categories);
	const {flips, onlyInBefore, onlyInAfter} = diffTests(
		before.results,
		after.results,
	);

	return {
		before: {
			model: before.model,
			timestamp: before.timestamp,
			passed: before.summary.passed,
			total: before.summary.total,
			passRate: before.summary.passRate,
			isBase: before.isBase,
		},
		after: {
			model: after.model,
			timestamp: after.timestamp,
			passed: after.summary.passed,
			total: after.summary.total,
			passRate: after.summary.passRate,
			isBase: after.isBase,
		},
		overallDelta: after.summary.passRate - before.summary.passRate,
		categories,
		flips,
		onlyInBefore,
		onlyInAfter,
	};
}

function diffCategories(
	beforeCategories: Record<string, {passed: number; total: number}>,
	afterCategories: Record<string, {passed: number; total: number}>,
): CategoryDelta[] {
	const names = new Set([
		...Object.keys(beforeCategories),
		...Object.keys(afterCategories),
	]);

	return [...names].sort().map(category => {
		const beforeStats = beforeCategories[category] ?? {passed: 0, total: 0};
		const afterStats = afterCategories[category] ?? {passed: 0, total: 0};
		const beforeRate =
			beforeStats.total > 0 ? beforeStats.passed / beforeStats.total : 0;
		const afterRate =
			afterStats.total > 0 ? afterStats.passed / afterStats.total : 0;

		return {
			category,
			before: {...beforeStats, rate: beforeRate},
			after: {...afterStats, rate: afterRate},
			delta: afterRate - beforeRate,
		};
	});
}

function diffTests(
	beforeResults: BenchmarkResult['results'],
	afterResults: BenchmarkResult['results'],
): Pick<BenchmarkComparison, 'flips' | 'onlyInBefore' | 'onlyInAfter'> {
	const beforeById = new Map(beforeResults.map(r => [r.id, r]));
	const afterById = new Map(afterResults.map(r => [r.id, r]));

	const flips: TestFlip[] = [];
	const onlyInBefore: number[] = [];
	const onlyInAfter: number[] = [];

	for (const [id, beforeTest] of beforeById) {
		const afterTest = afterById.get(id);
		if (!afterTest) {
			onlyInBefore.push(id);
			continue;
		}
		if (beforeTest.prompt !== afterTest.prompt) {
			// Same id, different prompt — `tests.json` was edited between runs,
			// so this isn't the same test. Reporting a pass/fail flip here would
			// be comparing two unrelated tests; treat it like a dropped id on
			// one side and an added id on the other instead.
			onlyInBefore.push(id);
			onlyInAfter.push(id);
			continue;
		}
		if (beforeTest.passed !== afterTest.passed) {
			flips.push({
				id,
				prompt: afterTest.prompt,
				category: afterTest.category,
				beforePassed: beforeTest.passed,
				afterPassed: afterTest.passed,
				direction: afterTest.passed ? 'fixed' : 'regressed',
			});
		}
	}

	for (const id of afterById.keys()) {
		if (!beforeById.has(id)) {
			onlyInAfter.push(id);
		}
	}

	flips.sort((a, b) => a.id - b.id);
	onlyInBefore.sort((a, b) => a - b);
	onlyInAfter.sort((a, b) => a - b);

	return {flips, onlyInBefore, onlyInAfter};
}

export function formatPercent(rate: number): string {
	return `${Math.round(rate * 100)}%`;
}

export function formatDelta(delta: number): string {
	const pct = Math.round(delta * 100);
	if (pct === 0) return '±0%';
	return pct > 0 ? `+${pct}%` : `${pct}%`;
}

/**
 * Color for a delta value, using the same rounding as {@link formatDelta} so
 * a delta that displays as "±0%" never renders green or red.
 */
export function deltaColor(delta: number): 'green' | 'red' | undefined {
	const pct = Math.round(delta * 100);
	if (pct === 0) return undefined;
	return pct > 0 ? 'green' : 'red';
}

export function generateComparisonMarkdown(
	comparison: BenchmarkComparison,
): string {
	const lines: string[] = [];

	lines.push('# Benchmark Comparison', '');
	lines.push(
		`**Before:** ${comparison.before.model}${comparison.before.isBase ? ' (base, control)' : ''} — ${comparison.before.passed}/${comparison.before.total} (${formatPercent(comparison.before.passRate)}) — ${new Date(comparison.before.timestamp).toLocaleString()}`,
	);
	lines.push(
		`**After:** ${comparison.after.model}${comparison.after.isBase ? ' (base, control)' : ''} — ${comparison.after.passed}/${comparison.after.total} (${formatPercent(comparison.after.passRate)}) — ${new Date(comparison.after.timestamp).toLocaleString()}`,
	);
	lines.push('');
	lines.push(`**Overall Delta:** ${formatDelta(comparison.overallDelta)}`);
	lines.push('');

	lines.push('## Per-Category', '');
	lines.push('| Category | Before | After | Delta |');
	lines.push('| --- | --- | --- | --- |');
	for (const cat of comparison.categories) {
		lines.push(
			`| ${cat.category} | ${cat.before.passed}/${cat.before.total} (${formatPercent(cat.before.rate)}) | ${cat.after.passed}/${cat.after.total} (${formatPercent(cat.after.rate)}) | ${formatDelta(cat.delta)} |`,
		);
	}
	lines.push('');

	lines.push('## Test Flips', '');
	if (comparison.flips.length === 0) {
		lines.push('No tests flipped between runs.');
	} else {
		const regressed = comparison.flips.filter(f => f.direction === 'regressed');
		const fixed = comparison.flips.filter(f => f.direction === 'fixed');

		if (regressed.length > 0) {
			lines.push(`### Regressed (pass → fail) — ${regressed.length}`, '');
			for (const flip of regressed) {
				lines.push(`- **#${flip.id}** [${flip.category}] ${flip.prompt}`);
			}
			lines.push('');
		}

		if (fixed.length > 0) {
			lines.push(`### Fixed (fail → pass) — ${fixed.length}`, '');
			for (const flip of fixed) {
				lines.push(`- **#${flip.id}** [${flip.category}] ${flip.prompt}`);
			}
			lines.push('');
		}
	}

	if (comparison.onlyInBefore.length > 0 || comparison.onlyInAfter.length > 0) {
		lines.push('## Tests Not Present In Both Runs', '');
		if (comparison.onlyInBefore.length > 0) {
			lines.push(
				`- Only in before run: ${comparison.onlyInBefore.map(id => `#${id}`).join(', ')}`,
			);
		}
		if (comparison.onlyInAfter.length > 0) {
			lines.push(
				`- Only in after run: ${comparison.onlyInAfter.map(id => `#${id}`).join(', ')}`,
			);
		}
		lines.push('');
	}

	return lines.join('\n');
}
