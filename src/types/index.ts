import {z} from 'zod';

export const TrainingConfigSchema = z.object({
	iterations: z.number().default(150),
	learningRate: z.number().default(5e-5),
	batchSize: z.number().default(4),
	numLayers: z.number().default(16),
	stepsPerEval: z.number().default(50),
	saveEvery: z.number().default(50),
});

export const ExportConfigSchema = z.object({
	quantization: z.enum(['f16', 'q8_0', 'q4_k_m', 'q4_k_s']).default('q4_k_m'),
	outputName: z.string(),
});

export const ConfigSchema = z.object({
	name: z.string(),
	version: z.string().default('1.0.0'),
	baseModel: z.string(),
	systemPrompt: z.string(),
	training: TrainingConfigSchema,
	export: ExportConfigSchema,
});

export type Config = z.infer<typeof ConfigSchema>;
export type TrainingConfig = z.infer<typeof TrainingConfigSchema>;
export type ExportConfig = z.infer<typeof ExportConfigSchema>;

export interface TrainingProgress {
	iteration: number;
	totalIterations: number;
	trainLoss: number;
	valLoss?: number;
}

export interface TrainingExample {
	messages: Array<{
		role: 'system' | 'user' | 'assistant';
		content: string;
	}>;
}

export type MatchMode = 'exact' | 'contains' | 'startsWith' | 'semantic';

export interface BenchmarkTest {
	id: number;
	prompt: string;
	acceptable: string[];
	category: string;
	/** Matching mode for this test. Default: "semantic" */
	match?: MatchMode;
	/** Case sensitive matching. Default: false */
	caseSensitive?: boolean;
}

export interface BenchmarkTestResult {
	id: number;
	prompt: string;
	expected: string[];
	actual: string;
	passed: boolean;
	category: string;
	latencyMs?: number;
}

export interface BenchmarkResult {
	model: string;
	timestamp: string;
	summary: {
		total: number;
		passed: number;
		failed: number;
		passRate: number;
		avgLatencyMs?: number;
	};
	categories: Record<string, {passed: number; total: number}>;
	// All test results with full details
	results: BenchmarkTestResult[];
	// Legacy - kept for backwards compatibility
	failures: Array<{
		id: number;
		prompt: string;
		expected: string[];
		actual: string;
	}>;
}

export interface DependencyStatus {
	python: boolean;
	pythonVersion?: string;
	mlx: boolean;
	llamaCpp: boolean;
}

export type QuantizationType = 'f16' | 'q8_0' | 'q4_k_m' | 'q4_k_s';
