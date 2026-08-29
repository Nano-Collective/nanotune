import {realpathSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp} from 'ink';
import {useEffect, useState} from 'react';
import {
	DataTable,
	ExitHint,
	Header,
	useAutoExit,
	useKeyInput,
} from '../../components/index.js';
import {
	type BenchmarkComparison,
	compareBenchmarks,
	deltaColor,
	formatDelta,
	formatPercent,
	generateComparisonMarkdown,
} from '../../lib/benchmark-compare.js';
import {
	ensureBenchmarksDir,
	findLatestBenchmark,
	listBenchmarks,
	loadBenchmark,
	resolveBenchmarkPath,
} from '../../lib/config.js';

interface Props {
	fileA?: string;
	fileB?: string;
}

type Status = 'loading' | 'done' | 'error';

/**
 * Order two run paths chronologically so "before" always reads as "the
 * earlier state" regardless of which one the caller happened to resolve
 * first.
 */
export function orderByMtime(
	pathX: string,
	pathY: string,
): {beforePath: string; afterPath: string} {
	const mtimeX = statSync(pathX).mtimeMs;
	const mtimeY = statSync(pathY).mtimeMs;
	return mtimeX <= mtimeY
		? {beforePath: pathX, afterPath: pathY}
		: {beforePath: pathY, afterPath: pathX};
}

/**
 * Resolve the pair of runs to compare from 0, 1, or 2 CLI arguments.
 * - 2 args: explicit before/after, in the order given.
 * - 1 arg: that run vs. the latest run (falling back to the second-latest
 *   if the named run IS the latest).
 * - 0 args: the two most recent runs.
 */
export function resolveComparisonPair(
	fileA?: string,
	fileB?: string,
): {beforePath: string; afterPath: string} {
	if (fileA && fileB) {
		return {
			beforePath: resolveBenchmarkPath(fileA),
			afterPath: resolveBenchmarkPath(fileB),
		};
	}

	if (fileA) {
		const explicitPath = resolveBenchmarkPath(fileA);
		const latestPath = findLatestBenchmark();
		if (!latestPath) {
			throw new Error('No other benchmark runs found to compare against.');
		}

		// Compare resolved real paths, not raw strings — the same file can be
		// reached through differently-formatted paths (relative vs. absolute,
		// separator differences), and a false negative here would silently
		// compare a run against itself instead of falling back correctly.
		if (realpathSync(latestPath) === realpathSync(explicitPath)) {
			const all = listBenchmarks();
			if (all.length < 2) {
				throw new Error(
					'Need at least two saved benchmark runs to compare — only one exists.',
				);
			}
			return orderByMtime(all[1].path, explicitPath);
		}

		return orderByMtime(latestPath, explicitPath);
	}

	const all = listBenchmarks();
	if (all.length < 2) {
		throw new Error(
			`Need at least two saved benchmark runs to compare (found ${all.length}). Run \`nanotune benchmark\` again, or pass explicit files.`,
		);
	}
	return orderByMtime(all[0].path, all[1].path);
}

export function BenchmarkCompareCommand({fileA, fileB}: Props) {
	const {exit} = useApp();
	const [status, setStatus] = useState<Status>('loading');
	const [error, setError] = useState<string | null>(null);
	const [comparison, setComparison] = useState<BenchmarkComparison | null>(
		null,
	);
	const [savedPaths, setSavedPaths] = useState<{
		json: string;
		markdown: string;
	} | null>(null);

	useKeyInput((_input, key) => {
		if (key.escape || key.return) {
			exit();
		}
	});

	useAutoExit(status === 'done' || status === 'error', status === 'error');

	useEffect(() => {
		try {
			const {beforePath, afterPath} = resolveComparisonPair(fileA, fileB);
			const before = loadBenchmark(beforePath);
			const after = loadBenchmark(afterPath);

			const result = compareBenchmarks(before, after);

			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const benchmarksDir = ensureBenchmarksDir();
			const jsonPath = join(benchmarksDir, `compare-${timestamp}.json`);
			const markdownPath = join(benchmarksDir, `compare-${timestamp}.md`);
			writeFileSync(jsonPath, JSON.stringify(result, null, 2));
			writeFileSync(markdownPath, generateComparisonMarkdown(result));

			setComparison(result);
			setSavedPaths({json: jsonPath, markdown: markdownPath});
			setStatus('done');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Comparison failed');
			setStatus('error');
		}
	}, [fileA, fileB]);

	if (status === 'error') {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Benchmark Compare" />
				<StatusMessage variant="error">{error}</StatusMessage>
				<Text> </Text>
				<ExitHint>Press any key to exit</ExitHint>
			</Box>
		);
	}

	if (status === 'loading' || !comparison) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Benchmark Compare" />
			</Box>
		);
	}

	const regressed = comparison.flips.filter(f => f.direction === 'regressed');
	const fixed = comparison.flips.filter(f => f.direction === 'fixed');

	return (
		<Box flexDirection="column" padding={1}>
			<Header title="Benchmark Compare" />

			<Text>
				Before:{' '}
				<Text color="cyan">{comparison.before.model.split('/').pop()}</Text>{' '}
				{comparison.before.isBase && <Text dimColor>(base, control) </Text>}
				<Text dimColor>
					({comparison.before.passed}/{comparison.before.total},{' '}
					{formatPercent(comparison.before.passRate)})
				</Text>
			</Text>
			<Text>
				After:{' '}
				<Text color="cyan">{comparison.after.model.split('/').pop()}</Text>{' '}
				{comparison.after.isBase && <Text dimColor>(base, control) </Text>}
				<Text dimColor>
					({comparison.after.passed}/{comparison.after.total},{' '}
					{formatPercent(comparison.after.passRate)})
				</Text>
			</Text>
			<Text> </Text>
			<Text>
				Overall Delta:{' '}
				<Text bold color={deltaColor(comparison.overallDelta)}>
					{formatDelta(comparison.overallDelta)}
				</Text>
			</Text>

			<Text> </Text>
			<Text bold>By Category:</Text>
			<DataTable
				headers={['Category', 'Before', 'After', 'Delta']}
				columnWidths={[16, 14, 14, 8]}
				rows={comparison.categories.map(cat => [
					cat.category,
					`${cat.before.passed}/${cat.before.total} (${formatPercent(cat.before.rate)})`,
					`${cat.after.passed}/${cat.after.total} (${formatPercent(cat.after.rate)})`,
					formatDelta(cat.delta),
				])}
			/>

			<Text> </Text>
			<Text bold>
				Test Flips:{' '}
				<Text dimColor>
					({comparison.flips.length} total, {regressed.length} regressed,{' '}
					{fixed.length} fixed)
				</Text>
			</Text>
			{comparison.flips.length === 0 && (
				<Text dimColor>No tests flipped between runs.</Text>
			)}
			{regressed.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold color="red">
						Regressed (pass → fail):
					</Text>
					{regressed.map(flip => (
						<Text key={flip.id}>
							{'  '}[{flip.id}] {flip.category}: {flip.prompt}
						</Text>
					))}
				</Box>
			)}
			{fixed.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold color="green">
						Fixed (fail → pass):
					</Text>
					{fixed.map(flip => (
						<Text key={flip.id}>
							{'  '}[{flip.id}] {flip.category}: {flip.prompt}
						</Text>
					))}
				</Box>
			)}
			{(comparison.onlyInBefore.length > 0 ||
				comparison.onlyInAfter.length > 0) && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold dimColor>
						Not present in both runs:
					</Text>
					{comparison.onlyInBefore.length > 0 && (
						<Text dimColor>
							{'  '}Only in before: {comparison.onlyInBefore.join(', ')}
						</Text>
					)}
					{comparison.onlyInAfter.length > 0 && (
						<Text dimColor>
							{'  '}Only in after: {comparison.onlyInAfter.join(', ')}
						</Text>
					)}
				</Box>
			)}

			{savedPaths && (
				<>
					<Text> </Text>
					<Text dimColor>Saved: {savedPaths.markdown}</Text>
				</>
			)}

			<Text> </Text>
			<ExitHint>Press any key to exit</ExitHint>
		</Box>
	);
}
