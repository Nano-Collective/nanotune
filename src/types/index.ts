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
	/** Total time for this query in milliseconds */
	latencyMs?: number;
	/** Time to first token in milliseconds */
	ttftMs?: number;
	/** Generation time in milliseconds (excluding TTFT) */
	generationTimeMs?: number;
	/** Tokens generated */
	tokensGenerated?: number;
	/** Tokens per second */
	tokensPerSecond?: number;
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

/** Benchmark hardware presets for common device profiles */
export type BenchmarkPreset = 'low' | 'medium' | 'high' | 'ultra';

/** Configuration for a benchmark preset */
export interface PresetConfig {
	/** Preset name */
	name: string;
	/** Description of the hardware profile */
	description: string;
	/** CPU threads to use (undefined = auto) */
	threads?: number;
	/** GPU layers to offload (undefined = auto/max, 0 = CPU only) */
	gpuLayers?: number;
	/** Context size in tokens */
	ctxSize: number;
	/** Batch size for prompt processing */
	batchSize: number;
	/** Maximum tokens to generate */
	maxTokens: number;
}

/** Preset configurations for different hardware profiles */
export const BENCHMARK_PRESETS: Record<BenchmarkPreset, PresetConfig> = {
	low: {
		name: 'Low-End',
		description: 'Low-end hardware (older laptops, minimal GPU)',
		threads: 4,
		gpuLayers: 0, // CPU only
		ctxSize: 2048,
		batchSize: 512,
		maxTokens: 50,
	},
	medium: {
		name: 'Medium',
		description: 'Mid-range hardware (modern laptops, integrated GPU)',
		threads: 8,
		gpuLayers: 20, // Partial GPU offload
		ctxSize: 4096,
		batchSize: 1024,
		maxTokens: 100,
	},
	high: {
		name: 'High-End',
		description: 'High-end hardware (Apple Silicon M1/M2/M3, discrete GPU)',
		threads: undefined, // Auto
		gpuLayers: undefined, // Max/all layers
		ctxSize: 8192,
		batchSize: 2048,
		maxTokens: 150,
	},
	ultra: {
		name: 'Ultra',
		description: 'Maximum performance (latest Apple Silicon, max resources)',
		threads: undefined, // Auto
		gpuLayers: undefined, // Max/all layers
		ctxSize: 16384,
		batchSize: 4096,
		maxTokens: 200,
	},
};
