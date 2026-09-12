import {rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp} from 'ink';
import {useCallback, useEffect, useState} from 'react';
import {
	ExitHint,
	Header,
	useAutoExit,
	useKeyInput,
} from '../components/index.js';
import {
	configExists,
	formatFileSize,
	getDirectorySize,
	getFusedModelDir,
	hasUsableFusedModel,
} from '../lib/config.js';
import {getBaseModelCacheDir, hasBaseModelCache} from '../lib/model-cache.js';

interface Props {
	options: {
		/** Skip the y/n confirmation — needed to run under CI or in a pipeline. */
		yes?: boolean;
		target?: string;
	};
	/**
	 * Override for the base-model cache directory. Production never passes
	 * this — it's here so tests can point at a throwaway directory instead
	 * of the real home directory (unlike the fused-model cache, which lives
	 * under the project dir and is already sandboxed via `process.chdir` in
	 * tests, the base cache is keyed off `os.homedir()`, which can't be
	 * safely monkeypatched: Node's ESM module namespace for a builtin is
	 * read-only at runtime, so patching it doesn't reach other modules'
	 * already-bound imports).
	 */
	baseModelCacheDir?: string;
}

const VALID_TARGETS = ['fused', 'base', 'all'] as const;
type CleanTarget = (typeof VALID_TARGETS)[number];

/**
 * Validate `--target`. Pulled out as a pure function (mirrors the
 * `--preset` validation in `benchmark.tsx`) so it's directly testable and
 * so `cli.tsx` can reuse it to decide whether there's anything to confirm
 * before requiring `--yes` in a non-interactive shell.
 */
export function validateCleanTarget(
	target: string | undefined,
): {target: CleanTarget} | {error: string} {
	if (target === undefined) {
		return {target: 'fused'};
	}
	if ((VALID_TARGETS as readonly string[]).includes(target)) {
		return {target: target as CleanTarget};
	}
	return {
		error: `Invalid target: ${target}. Valid targets: ${VALID_TARGETS.join(', ')}`,
	};
}

interface CleanEntry {
	label: string;
	dir: string;
	displayPath: string;
	sizeBytes: number;
	note: string;
}

function findCleanEntries(
	target: CleanTarget,
	hasProject: boolean,
	baseModelCacheDir: string,
): CleanEntry[] {
	const wantsFused = target === 'fused' || target === 'all';
	const wantsBase = target === 'base' || target === 'all';
	const entries: CleanEntry[] = [];

	if (wantsFused && hasProject) {
		const fusedDir = getFusedModelDir();
		if (hasUsableFusedModel(fusedDir)) {
			entries.push({
				label: 'Fused model cache',
				dir: fusedDir,
				displayPath: '.nanotune/models/fused',
				sizeBytes: getDirectorySize(fusedDir),
				note: 'kept to speed up repeat exports via --skip-fuse',
			});
		}
	}

	if (wantsBase && hasBaseModelCache(baseModelCacheDir)) {
		const home = homedir();
		entries.push({
			label: 'Base model cache',
			dir: baseModelCacheDir,
			displayPath: baseModelCacheDir.startsWith(home)
				? `~${baseModelCacheDir.slice(home.length)}`
				: baseModelCacheDir,
			sizeBytes: getDirectorySize(baseModelCacheDir),
			note: 'kept to speed up repeat `benchmark --base` runs',
		});
	}

	return entries;
}

type Status = 'confirm' | 'cleaning' | 'nothing' | 'done' | 'error';

export function CleanCommand({options, baseModelCacheDir}: Props) {
	const {exit} = useApp();
	const hasProject = configExists();
	const targetResult = validateCleanTarget(options.target);
	const resolvedBaseDir = baseModelCacheDir ?? getBaseModelCacheDir();

	const [entries] = useState<CleanEntry[]>(() =>
		'error' in targetResult
			? []
			: findCleanEntries(targetResult.target, hasProject, resolvedBaseDir),
	);
	const [freedBytes, setFreedBytes] = useState(0);

	const [status, setStatus] = useState<Status>(() => {
		if ('error' in targetResult) return 'error';
		if (targetResult.target === 'fused' && !hasProject) return 'error';
		if (entries.length === 0) return 'nothing';
		return options.yes ? 'cleaning' : 'confirm';
	});
	const [error, setError] = useState<string | null>(
		'error' in targetResult ? targetResult.error : null,
	);

	const doClean = useCallback(() => {
		let totalFreed = 0;
		const failures: string[] = [];
		for (const entry of entries) {
			try {
				rmSync(entry.dir, {recursive: true, force: true});
				totalFreed += entry.sizeBytes;
			} catch (err) {
				failures.push(
					`${entry.label}: ${err instanceof Error ? err.message : 'failed to remove'}`,
				);
			}
		}
		setFreedBytes(totalFreed);
		if (failures.length > 0) {
			setError(failures.join('\n'));
			setStatus('error');
		} else {
			setStatus('done');
		}
	}, [entries]);

	// `--yes` (or the initial `cleaning` state it sets above) skips straight
	// past the confirmation prompt.
	useEffect(() => {
		if (status === 'cleaning') {
			doClean();
		}
	}, [status, doClean]);

	useKeyInput(input => {
		if (status === 'confirm') {
			if (input.toLowerCase() === 'y') {
				setStatus('cleaning');
			} else if (input.toLowerCase() === 'n' || input === '\x1b') {
				exit();
			}
		} else if (
			status === 'done' ||
			status === 'nothing' ||
			status === 'error'
		) {
			exit();
		}
	});

	useAutoExit(
		status === 'done' || status === 'nothing' || status === 'error',
		status === 'error',
	);

	if (
		!('error' in targetResult) &&
		targetResult.target === 'fused' &&
		!hasProject
	) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Clean" />
				<StatusMessage variant="error">
					Not a Nanotune project. Run `nanotune init` first.
				</StatusMessage>
			</Box>
		);
	}

	const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
	const nothingMessage = (() => {
		if ('error' in targetResult) return '';
		if (targetResult.target === 'all') {
			return 'Nothing to clean — no fused or base model cache found.';
		}
		if (targetResult.target === 'base') {
			return 'Nothing to clean — no base model cache found.';
		}
		return 'Nothing to clean — no fused model cache found.';
	})();

	return (
		<Box flexDirection="column" padding={1}>
			<Header title="Clean" />

			{status === 'confirm' && (
				<Box flexDirection="column">
					{entries.map(entry => (
						<Text key={entry.dir}>
							{entry.label}:{' '}
							<Text color="cyan">{formatFileSize(entry.sizeBytes)}</Text> at{' '}
							<Text color="cyan">{entry.displayPath}</Text>
						</Text>
					))}
					{entries.length > 1 && (
						<Text>
							Total: <Text color="cyan">{formatFileSize(totalBytes)}</Text>
						</Text>
					)}
					{entries.map(entry => (
						<Text key={entry.dir} dimColor>
							{entries.length > 1 ? entry.label : 'This'} is {entry.note}.
						</Text>
					))}
					<Text> </Text>
					<Text>
						Remove {entries.length > 1 ? 'these' : 'it'}?{' '}
						<Text color="green">(y/n)</Text>
					</Text>
				</Box>
			)}

			{status === 'cleaning' && <Text>Removing cache...</Text>}

			{status === 'nothing' && (
				<Box flexDirection="column">
					<StatusMessage variant="info">{nothingMessage}</StatusMessage>
					<Text> </Text>
					<ExitHint>Press any key to exit</ExitHint>
				</Box>
			)}

			{status === 'done' && (
				<Box flexDirection="column">
					<StatusMessage variant="success">
						Removed {entries.map(e => e.label.toLowerCase()).join(' and ')}
					</StatusMessage>
					<Text> </Text>
					<Text>
						Freed: <Text color="cyan">{formatFileSize(freedBytes)}</Text>
					</Text>
					{entries.some(e => e.label === 'Fused model cache') && (
						<Text dimColor>
							The next `nanotune export` will re-fuse the adapter.
						</Text>
					)}
					{entries.some(e => e.label === 'Base model cache') && (
						<Text dimColor>
							The next `nanotune benchmark --base` will re-download and
							requantize the base model.
						</Text>
					)}
					<Text> </Text>
					<ExitHint>Press any key to exit</ExitHint>
				</Box>
			)}

			{status === 'error' && (
				<Box flexDirection="column">
					<StatusMessage variant="error">{error}</StatusMessage>
					<Text> </Text>
					<ExitHint>Press any key to exit</ExitHint>
				</Box>
			)}
		</Box>
	);
}
