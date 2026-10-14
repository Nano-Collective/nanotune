import {existsSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {z} from 'zod';
import type {Config, QuantizationType} from '../types/index.js';
import {listBenchmarks} from './config.js';
import {countExamples} from './data.js';

const SavedBenchmarkSchema = z.object({
	model: z.string(),
	timestamp: z.string().datetime(),
	isBase: z.boolean().optional(),
	warning: z.string().optional(),
	summary: z
		.object({
			total: z.int().positive(),
			passed: z.int().nonnegative(),
			failed: z.int().nonnegative(),
			passRate: z.number().min(0).max(1),
		})
		.refine(
			value =>
				value.passed + value.failed === value.total &&
				Math.abs(value.passRate - value.passed / value.total) < 1e-6,
		),
});

type SavedBenchmark = z.infer<typeof SavedBenchmarkSchema>;

/** Keep user-supplied names inside one Markdown line/table cell. */
function markdown(value: string): string {
	return value
		.replace(/[\r\n]+/g, ' ')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/[\\`*_\[\]|#]/g, '\\$&');
}

/** Saved results are optional; unrelated or malformed reports are ignored. */
function latestMatchingBenchmark(outputPath: string): SavedBenchmark | null {
	let latest: SavedBenchmark | null = null;
	for (const file of listBenchmarks()) {
		try {
			const parsed = SavedBenchmarkSchema.safeParse(
				JSON.parse(readFileSync(file.path, 'utf-8')),
			);
			if (!parsed.success) continue;
			const result = parsed.data;
			if (result.isBase || resolve(result.model) !== resolve(outputPath)) {
				continue;
			}
			if (
				!latest ||
				Date.parse(result.timestamp) > Date.parse(latest.timestamp)
			) {
				latest = result;
			}
		} catch {
			// A report may be incomplete or unreadable; it must not block export.
		}
	}
	return latest;
}

interface ModelCardOptions {
	config: Config;
	outputPath: string;
	quantization: QuantizationType;
	trainExamples: number;
	validationExamples: number;
	benchmark: SavedBenchmark | null;
}

export function renderModelCard({
	config,
	outputPath,
	quantization,
	trainExamples,
	validationExamples,
	benchmark,
}: ModelCardOptions): string {
	const training = config.training;
	const lines = [
		'---',
		`base_model: ${JSON.stringify(config.baseModel)}`,
		'base_model_relation: finetune',
		'pipeline_tag: text-generation',
		'library_name: gguf',
		'tags:',
		'  - gguf',
		'  - nanotune',
		'---',
		'',
		`# ${markdown(config.name)}`,
		'',
		'Fine-tuned and exported with Nanotune for use with GGUF-compatible tools such as llama.cpp.',
		'',
		'## Model details',
		'',
		`- Base model: ${markdown(config.baseModel)}`,
		`- Artifact: ${markdown(basename(outputPath))}`,
		`- Quantization: ${quantization}`,
		`- Fine-tuning method: ${training.fineTuneType}`,
		'',
		'## Training configuration',
		'',
		'These settings reflect the project configuration at export time; training-time overrides or later configuration changes may differ.',
		'',
		'| Parameter | Value |',
		'| --- | --- |',
		`| Iterations | ${training.iterations} |`,
		`| Learning rate | ${training.learningRate} |`,
		`| Batch size | ${training.batchSize} |`,
		`| Trainable layers | ${training.numLayers} |`,
		`| Maximum sequence length | ${training.maxSeqLength} |`,
		`| Seed | ${training.seed} |`,
	];
	if (training.fineTuneType !== 'full') {
		lines.push(
			`| LoRA rank | ${training.loraRank} |`,
			`| LoRA alpha | ${training.loraAlpha} |`,
			`| LoRA dropout | ${training.loraDropout} |`,
		);
	}
	lines.push(
		'',
		'## Dataset',
		'',
		'Counts reflect the local dataset files at export time. Training examples and prompts are not included in this card.',
		'',
		`- Training examples: ${trainExamples}`,
		`- Validation examples: ${validationExamples}`,
		`- Total examples: ${trainExamples + validationExamples}`,
		'',
		'## Evaluation',
		'',
	);
	if (benchmark) {
		lines.push(
			'Latest saved benchmark for this artifact path. It may predate this export and does not establish the performance of newly exported weights.',
			'',
			`- Benchmark date: ${markdown(benchmark.timestamp)}`,
			`- Passed: ${benchmark.summary.passed}/${benchmark.summary.total}`,
			`- Pass rate: ${(benchmark.summary.passRate * 100).toFixed(1)}%`,
		);
		if (benchmark.warning) {
			lines.push(
				'',
				`Partial benchmark: ${markdown(benchmark.warning)}. The pass rate covers only tests that ran.`,
			);
		}
	} else {
		lines.push('No saved benchmark results are available for this artifact.');
	}
	lines.push(
		'',
		'## Intended use and limitations',
		'',
		'Describe the intended use, dataset sources, and limitations before publishing. Review the base model and dataset licenses and add the appropriate license metadata; Nanotune does not infer a license.',
		'',
	);
	return lines.join('\n');
}

function existingCard(path: string): boolean {
	if (!existsSync(path)) return false;
	if (!statSync(path).isFile()) {
		throw new Error(`Cannot write model card: ${path} is not a file.`);
	}
	return true;
}

/** Create beside the GGUF, preserving a README the user has already edited. */
export function writeModelCard(
	config: Config,
	outputPath: string,
	quantization: QuantizationType,
): {path: string; created: boolean} {
	const path = join(dirname(outputPath), 'README.md');
	if (existingCard(path)) return {path, created: false};
	const card = renderModelCard({
		config,
		outputPath,
		quantization,
		trainExamples: countExamples(),
		validationExamples: countExamples(true),
		benchmark: latestMatchingBenchmark(outputPath),
	});
	try {
		writeFileSync(path, card, {flag: 'wx'});
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code === 'EEXIST' &&
			existingCard(path)
		) {
			return {path, created: false};
		}
		throw error;
	}
	return {path, created: true};
}
