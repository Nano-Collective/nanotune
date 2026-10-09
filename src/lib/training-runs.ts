import {randomUUID} from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
} from 'node:fs';
import {join, relative} from 'node:path';
import {z} from 'zod';
import type {TrainingProgress} from '../types/index.js';
import {type TrainingConfig, TrainingConfigSchema} from '../types/index.js';
import {
	getProjectDir,
	initializeProjectDirs,
	writeFileAtomic,
} from './config.js';
import type {TrainingLossPoint} from './mlx.js';

const RUNS_DIR = 'runs';

export const TrainingRunRecordSchema = z.object({
	id: z.string().uuid(),
	startedAt: z.string().datetime(),
	finishedAt: z.string().datetime().nullable(),
	status: z.enum(['running', 'completed', 'stopped', 'failed']),
	baseModel: z.string(),
	training: TrainingConfigSchema,
	examples: z.object({
		train: z.number().int().nonnegative(),
		validation: z.number().int().nonnegative(),
	}),
	durationMs: z.number().int().nonnegative(),
	lossHistory: z.array(
		z.object({
			iteration: z.number().int().nonnegative(),
			trainLoss: z.number().finite().optional(),
			valLoss: z.number().finite().optional(),
		}),
	),
	finalTrainLoss: z.number().finite().nullable(),
	finalValLoss: z.number().finite().nullable(),
	resume: z.boolean(),
	adapterPath: z.string(),
	adapterModifiedAt: z.string().datetime().nullable(),
	error: z.string().optional(),
	resumedFromRunId: z.string().uuid().nullable().optional(),
	earlyStopped: z.boolean().optional(),
	restoredBest: z.boolean().optional(),
	bestIteration: z.number().int().nonnegative().optional(),
	bestValLoss: z.number().finite().optional(),
});

export type TrainingRunRecord = z.infer<typeof TrainingRunRecordSchema>;

/** Save before expensive work, then refresh on loss reports and finalization. */
export function startTrainingRun(options: {
	baseModel: string;
	training: TrainingConfig;
	examples: {train: number; validation: number};
	adapterFile: string;
	resume: boolean;
}) {
	const startedAt = new Date();
	const initialAdapter = existsSync(options.adapterFile)
		? statSync(options.adapterFile)
		: null;
	const before = initialAdapter?.mtimeMs ?? null;
	const previous =
		options.resume && before !== null
			? listTrainingRuns().find(
					run => run.adapterModifiedAt === initialAdapter?.mtime.toISOString(),
				)
			: undefined;
	const record: TrainingRunRecord = {
		id: randomUUID(),
		startedAt: startedAt.toISOString(),
		finishedAt: null,
		status: 'running',
		baseModel: options.baseModel,
		training: options.training,
		examples: options.examples,
		durationMs: 0,
		lossHistory: [],
		finalTrainLoss: null,
		finalValLoss: null,
		resume: options.resume,
		resumedFromRunId: previous?.id ?? null,
		adapterPath: relative(process.cwd(), options.adapterFile),
		adapterModifiedAt: null,
	};
	function persist() {
		record.durationMs = Math.max(0, Date.now() - startedAt.getTime());
		const adapter = existsSync(options.adapterFile)
			? statSync(options.adapterFile)
			: null;
		if (adapter && (before === null || adapter.mtimeMs !== before)) {
			record.adapterModifiedAt = adapter.mtime.toISOString();
		}
		saveTrainingRun(record);
	}
	persist();
	return {
		checkpoint: persist,
		selection(progress: TrainingProgress) {
			record.earlyStopped = progress.earlyStopped;
			record.restoredBest = progress.restoredBest;
			record.bestIteration = progress.bestIteration;
			record.bestValLoss = progress.bestValLoss;
			persist();
		},
		update(point: TrainingLossPoint) {
			record.lossHistory.push(point);
			if (point.trainLoss !== undefined)
				record.finalTrainLoss = point.trainLoss;
			if (point.valLoss !== undefined) record.finalValLoss = point.valLoss;
			persist();
		},
		finish(status: 'completed' | 'stopped' | 'failed', error?: string) {
			record.status = status;
			record.finishedAt = new Date().toISOString();
			if (error) record.error = error;
			persist();
		},
	};
}

export function getTrainingRunsDir(): string {
	return join(getProjectDir(), RUNS_DIR);
}

/** Create the local-only run-history directory when a record is written. */
export function ensureTrainingRunsDir(): string {
	const dir = getTrainingRunsDir();
	mkdirSync(dir, {recursive: true});
	return dir;
}

/** Persist a complete record with an atomic rename so readers never see partial JSON. */
export function saveTrainingRun(record: TrainingRunRecord): string {
	const validated = TrainingRunRecordSchema.parse(record);
	// Back-fill `runs/` in projects initialized by older Nanotune versions too.
	initializeProjectDirs();
	const dir = ensureTrainingRunsDir();
	const filename = `${validated.id}.json`;
	const path = join(dir, filename);
	writeFileAtomic(path, `${JSON.stringify(validated, null, 2)}\n`);
	return path;
}

/** Read valid run records newest first; a corrupt/incomplete file is skipped. */
export function listTrainingRuns(): TrainingRunRecord[] {
	const dir = getTrainingRunsDir();
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir)
		.filter(name => name.endsWith('.json'))
		.map(name => {
			try {
				return TrainingRunRecordSchema.parse(
					JSON.parse(readFileSync(join(dir, name), 'utf8')),
				);
			} catch {
				return null;
			}
		})
		.filter((record): record is TrainingRunRecord => record !== null)
		.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Compact terminal summary; `--json` exposes each complete loss history. */
export function formatTrainingRuns(runs: TrainingRunRecord[]): string {
	if (runs.length === 0) {
		return 'No training runs found.';
	}
	return runs
		.map(run => {
			const losses =
				run.finalTrainLoss === null
					? 'no loss points'
					: `train ${run.finalTrainLoss.toFixed(4)}${
							run.finalValLoss === null
								? ''
								: ` / validation ${run.finalValLoss.toFixed(4)}`
						}`;
			return [
				run.startedAt,
				run.status,
				run.baseModel,
				`${run.training.iterations} iterations`,
				`lr ${run.training.learningRate}, batch ${run.training.batchSize}, ${run.training.fineTuneType}, rank ${run.training.loraRank}, alpha ${run.training.loraAlpha}`,
				`${run.examples.train} train / ${run.examples.validation} validation`,
				`${Math.round(run.durationMs / 1000)}s`,
				losses,
			].join('  ');
		})
		.join('\n');
}
