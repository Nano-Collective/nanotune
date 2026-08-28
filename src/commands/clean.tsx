import {existsSync, rmSync} from 'node:fs';
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
} from '../lib/config.js';

interface Props {
	options: {
		/** Skip the y/n confirmation — needed to run under CI or in a pipeline. */
		yes?: boolean;
	};
}

type Status = 'confirm' | 'cleaning' | 'nothing' | 'done' | 'error';

export function CleanCommand({options}: Props) {
	const {exit} = useApp();
	const fusedDir = getFusedModelDir();
	const hasProject = configExists();
	const fusedExists = hasProject && existsSync(fusedDir);

	const [status, setStatus] = useState<Status>(() => {
		if (!hasProject) return 'error';
		if (!fusedExists) return 'nothing';
		return options.yes ? 'cleaning' : 'confirm';
	});
	const [errorMessage, setErrorMessage] = useState(
		'Not a Nanotune project. Run `nanotune init` first.',
	);
	const [sizeLabel] = useState<string | null>(
		fusedExists ? formatFileSize(getDirectorySize(fusedDir)) : null,
	);

	const doClean = useCallback(() => {
		try {
			rmSync(fusedDir, {recursive: true, force: true});
			setStatus('done');
		} catch (err) {
			setErrorMessage(
				err instanceof Error
					? err.message
					: 'Failed to remove fused model cache',
			);
			setStatus('error');
		}
	}, [fusedDir]);

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

	if (status === 'error' && !hasProject) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Clean" />
				<StatusMessage variant="error">{errorMessage}</StatusMessage>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1}>
			<Header title="Clean" />

			{status === 'confirm' && (
				<Box flexDirection="column">
					<Text>
						Fused model cache: <Text color="cyan">{sizeLabel}</Text> at{' '}
						<Text color="cyan">.nanotune/models/fused</Text>
					</Text>
					<Text dimColor>
						This is kept to speed up repeat exports via --skip-fuse.
					</Text>
					<Text> </Text>
					<Text>
						Remove it? <Text color="green">(y/n)</Text>
					</Text>
				</Box>
			)}

			{status === 'cleaning' && <Text>Removing fused model cache...</Text>}

			{status === 'nothing' && (
				<Box flexDirection="column">
					<StatusMessage variant="info">
						Nothing to clean — no fused model cache found.
					</StatusMessage>
					<Text> </Text>
					<ExitHint>Press any key to exit</ExitHint>
				</Box>
			)}

			{status === 'done' && (
				<Box flexDirection="column">
					<StatusMessage variant="success">
						Removed fused model cache
					</StatusMessage>
					<Text> </Text>
					<Text>
						Freed: <Text color="cyan">{sizeLabel}</Text>
					</Text>
					<Text dimColor>
						The next `nanotune export` will re-fuse the adapter.
					</Text>
					<Text> </Text>
					<ExitHint>Press any key to exit</ExitHint>
				</Box>
			)}

			{status === 'error' && hasProject && (
				<Box flexDirection="column">
					<StatusMessage variant="error">{errorMessage}</StatusMessage>
					<Text> </Text>
					<ExitHint>Press any key to exit</ExitHint>
				</Box>
			)}
		</Box>
	);
}
