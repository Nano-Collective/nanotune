import {existsSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {Spinner, StatusMessage} from '@inkjs/ui';
import {Box, Text, useApp} from 'ink';
import {useCallback, useEffect, useState} from 'react';
import {
	ExitHint,
	Header,
	Progress,
	StatusBadge,
	useAutoExit,
	useKeyInput,
} from '../components/index.js';
import {
	configExists,
	formatFileSize,
	getAdaptersDir,
	getDirectorySize,
	getFusedModelDir,
	getModelsDir,
	loadConfig,
} from '../lib/config.js';
import {
	checkLlamaCppInstalled,
	exportModel,
	installLlamaCpp,
} from '../lib/llama-cpp.js';
import {fuseAdapters} from '../lib/mlx.js';
import {assertSupportedPlatform} from '../lib/platform.js';
import type {QuantizationType} from '../types/index.js';

interface Props {
	options: {
		quantization?: string;
		output?: string;
		skipFuse?: boolean;
	};
}

type Status =
	| 'checking'
	| 'installing'
	| 'fusing'
	| 'converting'
	| 'done'
	| 'error';

interface Step {
	name: string;
	status: 'pending' | 'running' | 'done' | 'error';
}

/**
 * `--skip-fuse` relies on a fused model from a previous export. Pulled out
 * as a pure function so it's testable without rendering the full command
 * (which asserts Apple Silicon up front).
 */
export function skipFuseValidationError(
	skipFuse: boolean | undefined,
	fusedModelExists: boolean,
): string | null {
	if (skipFuse && !fusedModelExists) {
		return 'No fused model found at .nanotune/models/fused. Run `nanotune export` without --skip-fuse first.';
	}
	return null;
}

export function ExportCommand({options}: Props) {
	const {exit} = useApp();
	const [status, setStatus] = useState<Status>('checking');
	const [error, setError] = useState<string | null>(null);
	const [progress, setProgress] = useState(0);
	const [currentStep, setCurrentStep] = useState('');
	const [outputPath, setOutputPath] = useState<string | null>(null);
	const [fileSize, setFileSize] = useState<string | null>(null);
	const [fusedCacheInfo, setFusedCacheInfo] = useState<string | null>(null);
	const [steps, setSteps] = useState<Step[]>([
		{name: 'Fusing adapters', status: 'pending'},
		{name: 'Converting to GGUF', status: 'pending'},
		{name: 'Quantizing', status: 'pending'},
	]);

	useKeyInput((_input, key) => {
		if (key.escape || key.return) {
			exit();
		}
	});

	useAutoExit(status === 'done' || status === 'error', status === 'error');

	const updateStep = useCallback((index: number, newStatus: Step['status']) => {
		setSteps(prev =>
			prev.map((s, i) => (i === index ? {...s, status: newStatus} : s)),
		);
	}, []);

	const run = useCallback(async () => {
		try {
			// Fail fast on unsupported hardware rather than after a multi-minute
			// adapter fuse, when the llama.cpp download finds no matching asset.
			assertSupportedPlatform();

			// Check project exists
			if (!configExists()) {
				setError('Not a Nanotune project. Run `nanotune init` first.');
				setStatus('error');
				return;
			}

			const config = loadConfig();
			const adaptersDir = getAdaptersDir();
			const modelsDir = getModelsDir();
			const fusedModelPath = getFusedModelDir();

			// Check adapters exist
			const adapterFile = join(adaptersDir, 'adapters.safetensors');
			if (!existsSync(adapterFile)) {
				setError('No trained adapters found. Run `nanotune train` first.');
				setStatus('error');
				return;
			}

			// Fail fast with a clear message rather than a cryptic error deep
			// inside GGUF conversion if --skip-fuse is passed with no fused
			// model on disk (e.g. after `nanotune clean`).
			const skipFuseError = skipFuseValidationError(
				options.skipFuse,
				existsSync(fusedModelPath),
			);
			if (skipFuseError) {
				setError(skipFuseError);
				setStatus('error');
				return;
			}

			// Check llama.cpp
			setStatus('checking');
			const hasLlamaCpp = await checkLlamaCppInstalled();
			if (!hasLlamaCpp) {
				setStatus('installing');
				for await (const msg of installLlamaCpp()) {
					setCurrentStep(msg);
				}
			}

			// Determine output paths
			const quantization = (options.quantization ||
				config.export.quantization) as QuantizationType;
			const outputName =
				options.output || `${config.export.outputName}-${quantization}`;
			const finalOutputPath = join(modelsDir, `${outputName}.gguf`);

			// Step 1: Fuse adapters
			if (!options.skipFuse) {
				setStatus('fusing');
				updateStep(0, 'running');
				setCurrentStep('Fusing adapters with base model...');
				setProgress(10);

				await fuseAdapters(config.baseModel, adaptersDir, fusedModelPath);

				updateStep(0, 'done');
				setProgress(33);
			} else {
				updateStep(0, 'done');
				setProgress(33);
			}

			// Steps 2 & 3: Convert and Quantize
			setStatus('converting');
			updateStep(1, 'running');

			for await (const update of exportModel(
				fusedModelPath,
				finalOutputPath,
				quantization,
			)) {
				setCurrentStep(update.step);
				if (update.step.includes('Step 2')) {
					updateStep(1, 'running');
					updateStep(2, 'pending');
					setProgress(50);
				} else if (update.step.includes('Quantizing')) {
					updateStep(1, 'done');
					updateStep(2, 'running');
					setProgress(75);
				} else if (update.progress === 100) {
					updateStep(1, 'done');
					updateStep(2, 'done');
					setProgress(100);
				}
			}

			// Get file size
			if (existsSync(finalOutputPath)) {
				const stats = statSync(finalOutputPath);
				setFileSize(formatFileSize(stats.size));
			}

			// The fused model cache is kept for faster re-exports via
			// --skip-fuse; surface its size so it isn't a silent disk cost.
			if (existsSync(fusedModelPath)) {
				setFusedCacheInfo(formatFileSize(getDirectorySize(fusedModelPath)));
			}

			setOutputPath(finalOutputPath);
			setStatus('done');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Export failed');
			setStatus('error');
		}
	}, [options.quantization, options.output, options.skipFuse, updateStep]);

	useEffect(() => {
		run();
	}, [run]);

	if (!configExists()) {
		return (
			<Box flexDirection="column" padding={1}>
				<Header title="Export" />
				<StatusMessage variant="error">
					Not a Nanotune project. Run `nanotune init` first.
				</StatusMessage>
			</Box>
		);
	}

	const config = loadConfig();
	const quantization = options.quantization || config.export.quantization;

	return (
		<Box flexDirection="column" padding={1}>
			<Header title="Export" />

			<Box flexDirection="column" marginBottom={1}>
				<Text>
					Model: <Text color="cyan">{config.baseModel}</Text>
				</Text>
				<Text>
					Quantization: <Text color="cyan">{quantization}</Text>
				</Text>
			</Box>

			{(status === 'checking' || status === 'installing') && (
				<Box flexDirection="column">
					{status === 'checking' && (
						<Spinner label="Checking dependencies..." />
					)}
					{status === 'installing' && (
						<Box flexDirection="column">
							<Spinner label="Installing llama.cpp..." />
							<Text dimColor>{currentStep}</Text>
						</Box>
					)}
				</Box>
			)}

			{(status === 'fusing' || status === 'converting') && (
				<Box flexDirection="column">
					<Box flexDirection="column" marginBottom={1}>
						{steps.map((step, i) => (
							<Box key={step.name}>
								<Box width={3}>
									{step.status === 'pending' && (
										<StatusBadge status="pending" />
									)}
									{step.status === 'running' && <Spinner />}
									{step.status === 'done' && <StatusBadge status="success" />}
									{step.status === 'error' && <StatusBadge status="error" />}
								</Box>
								<Text
									color={step.status === 'running' ? 'yellow' : undefined}
									dimColor={step.status === 'pending'}
								>
									Step {i + 1}/3: {step.name}
								</Text>
							</Box>
						))}
					</Box>

					<Progress percent={progress} />

					<Text dimColor>{currentStep}</Text>
				</Box>
			)}

			{status === 'done' && (
				<Box flexDirection="column">
					<StatusMessage variant="success">Export complete!</StatusMessage>
					<Text> </Text>
					<Text>
						Output: <Text color="cyan">{outputPath}</Text>
					</Text>
					{fileSize && (
						<Text>
							Size: <Text color="cyan">{fileSize}</Text>
						</Text>
					)}
					{fusedCacheInfo && (
						<Text dimColor>
							Fused model cache: {fusedCacheInfo} at .nanotune/models/fused
							(kept for faster re-exports — run `nanotune clean` to remove)
						</Text>
					)}
					<Text> </Text>
					<Text bold>Test your model:</Text>
					<Text dimColor>llama-cli -m {outputPath} -p "Your prompt here"</Text>
					<Text> </Text>
					<Text>
						Next: <Text color="cyan">nanotune benchmark</Text>
					</Text>
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
