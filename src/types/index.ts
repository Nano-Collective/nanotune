import {z} from 'zod';

export interface ChatMessage {
	role: string;
	content: string;
}

export const ChatMessageSchema = z.object({
	role: z.string(),
	content: z.string(),
});

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

export const ConfigSchema = z
	.object({
		name: z.string(),
		version: z.string().default('1.0.0'),
		baseModel: z.string(),
		systemPrompt: z.string().optional(),
		contextMessage: ChatMessageSchema.optional(),
		training: TrainingConfigSchema,
		export: ExportConfigSchema,
	})
	.refine(data => data.contextMessage || data.systemPrompt, {
		message: 'Either contextMessage or systemPrompt must be provided',
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
	messages: ChatMessage[];
}

export type MatchMode =
	| 'exact'
	| 'contains'
	| 'startsWith'
	| 'semantic'
	| 'llm-judge';

/** SDK provider type for AI SDK integration */
export type SdkProvider = 'openai-compatible' | 'anthropic' | 'google';

/** Judge provider configuration stored in .nanotune/judge.json */
export interface JudgeProviderConfig {
	/** Display name (e.g. "OpenRouter", "Ollama") */
	name: string;
	/** API base URL */
	baseUrl: string;
	/** API key (optional for local providers, supports ${ENV_VAR} substitution) */
	apiKey?: string;
	/** Single model ID to use as judge */
	model: string;
	/** SDK provider type. Default: 'openai-compatible' */
	sdkProvider?: SdkProvider;
}

/** Judge criteria for llm-judge match mode */
export interface JudgeCriteria {
	/** Criterion name (e.g. "helpful", "accurate") */
	name: string;
	/** Description shown to the judge model */
	description: string;
}

/** Result from an LLM judge evaluation */
export interface JudgeResult {
	/** Whether the response passed the threshold */
	pass: boolean;
	/** Overall score (0-10) */
	score: number;
	/** Judge's explanation */
	reasoning: string;
	/** Per-criteria scores */
	criteriaScores: Record<string, number>;
}

export interface BenchmarkTest {
	id: number;
	prompt: string;
	/** Acceptable answers for string-matching modes. Optional when match is "llm-judge". */
	acceptable?: string[];
	category: string;
	/** Matching mode for this test. Default: "semantic" */
	match?: MatchMode;
	/** Case sensitive matching. Default: false */
	caseSensitive?: boolean;
	/** Criteria for llm-judge mode (e.g. ["helpful", "accurate"]). Uses built-in presets by name. */
	criteria?: string[];
	/** Score threshold for pass in llm-judge mode. Default: 7 */
	passThreshold?: number;
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
	/** LLM judge score (0-10), present when match mode is "llm-judge" */
	judgeScore?: number;
	/** LLM judge reasoning, present when match mode is "llm-judge" */
	judgeReasoning?: string;
	/** Per-criteria scores from LLM judge */
	judgeCriteriaScores?: Record<string, number>;
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
		/** Average judge score across llm-judge tests */
		avgJudgeScore?: number;
		/** Model used for judging */
		judgeModel?: string;
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
