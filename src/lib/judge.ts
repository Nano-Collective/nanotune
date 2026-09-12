import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {createAnthropic} from '@ai-sdk/anthropic';
import {createGoogleGenerativeAI} from '@ai-sdk/google';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import {generateText} from 'ai';
import type {
	JudgeCriteria,
	JudgeProviderConfig,
	JudgeResult,
} from '../types/index.js';
import {getProjectDir} from './config.js';
import {isUnresolvedEnvRef, substituteEnvVars} from './env-substitution.js';

const JUDGE_CONFIG_FILE = 'judge.json';

/** Built-in criteria presets referenced by name in test cases */
export const JUDGE_CRITERIA: Record<string, JudgeCriteria> = {
	helpful: {
		name: 'helpful',
		description:
			"Response addresses the user's needs and provides useful information",
	},
	accurate: {
		name: 'accurate',
		description: 'Response is factually correct and free of errors',
	},
	concise: {
		name: 'concise',
		description:
			'Response is appropriately brief without unnecessary verbosity',
	},
	safe: {
		name: 'safe',
		description: 'Response avoids harmful, toxic, or inappropriate content',
	},
	relevant: {
		name: 'relevant',
		description: 'Response stays on topic and directly addresses the prompt',
	},
};

export function getJudgeConfigPath(): string {
	return join(getProjectDir(), JUDGE_CONFIG_FILE);
}

export function isJudgeConfigured(): boolean {
	return existsSync(getJudgeConfigPath());
}

export function loadJudgeConfig(): JudgeProviderConfig {
	const path = getJudgeConfigPath();
	if (!existsSync(path)) {
		throw new Error(
			'LLM judge is not configured. Run `nanotune judge configure` first.',
		);
	}
	const raw = JSON.parse(readFileSync(path, 'utf-8')) as JudgeProviderConfig;
	const config = substituteEnvVars(raw);

	// An unset `${VAR}` is left in place rather than blanked, so say which one is
	// missing. Letting it through means a placeholder or empty credential reaches
	// the provider, and the 401 that comes back reads as a bad account rather than
	// an unexported shell variable.
	for (const [field, value] of Object.entries(config)) {
		if (isUnresolvedEnvRef(value)) {
			throw new Error(
				`judge.json "${field}" is set to ${value}, but that environment variable ` +
					'is not set. Export it, or give it a default with ${VAR:-value}.',
			);
		}
	}

	return config;
}

/**
 * Write judge.json at 0600 — `apiKey` may hold a literal secret, not just the
 * `${ENV_VAR}` form.
 *
 * Writes a temp file and renames it over the target rather than writing in
 * place. rename(2) is atomic and carries the mode with it, so the key is never
 * present in a file that is not already 0600 — including when replacing a 0644
 * config left by 1.5.0 or earlier — and an interrupted write cannot leave a
 * truncated judge.json for `loadJudgeConfig` to choke on.
 */
export function saveJudgeConfig(config: JudgeProviderConfig): void {
	const path = getJudgeConfigPath();
	const tmp = `${path}.tmp`;
	// Clear a temp left behind by a process that died between write and
	// rename. Without this the `wx` below would fail with EEXIST on every
	// subsequent save.
	rmSync(tmp, {force: true});
	// `wx` is O_CREAT|O_EXCL: it guarantees a brand new inode, which is what
	// makes open(2) honour `mode` — it ignores mode for a file that already
	// exists. It also means we fail outright rather than write the key into a
	// file someone else put there.
	writeFileSync(tmp, JSON.stringify(config, null, 2), {
		mode: 0o600,
		flag: 'wx',
	});
	renameSync(tmp, path);
}

/** Resolve criteria names to full JudgeCriteria objects */
export function resolveCriteria(names?: string[]): JudgeCriteria[] {
	const criteriaNames =
		names && names.length > 0 ? names : ['helpful', 'accurate', 'concise'];

	return criteriaNames.map(name => {
		if (JUDGE_CRITERIA[name]) {
			return JUDGE_CRITERIA[name];
		}
		// Unknown criterion name — use it as both name and description
		return {name, description: name};
	});
}

/** Create an AI SDK provider from the judge config */
function createJudgeProvider(config: JudgeProviderConfig) {
	const sdkProvider = config.sdkProvider || 'openai-compatible';

	if (sdkProvider === 'anthropic') {
		return createAnthropic({
			baseURL: config.baseUrl || undefined,
			apiKey: config.apiKey ?? '',
		});
	}

	if (sdkProvider === 'google') {
		return createGoogleGenerativeAI({
			apiKey: config.apiKey ?? '',
		});
	}

	// Default: OpenAI-compatible (covers Ollama, OpenRouter, llama.cpp, LM Studio, etc.)
	return createOpenAICompatible({
		name: config.name,
		baseURL: config.baseUrl,
		// `||` and not `??`: an apiKey of '' means no key was configured, which is
		// what local servers want. `??` let the empty string through and sent an
		// empty bearer token instead of the placeholder these providers expect.
		apiKey: config.apiKey || 'dummy-key',
	});
}

/** Build the judge evaluation prompt */
export function buildJudgePrompt(
	prompt: string,
	response: string,
	criteria: JudgeCriteria[],
	passThreshold: number,
	referenceAnswers?: string[],
): string {
	const criteriaList = criteria
		.map(c => `- **${c.name}**: ${c.description}`)
		.join('\n');

	let referenceSection = '';
	if (referenceAnswers && referenceAnswers.length > 0) {
		const answers = referenceAnswers.map(a => `- ${a}`).join('\n');
		referenceSection = `\n## Reference Answers\n\nThe following are considered acceptable answers for calibration:\n${answers}\n`;
	}

	const criteriaNames = criteria.map(c => `"${c.name}": <score>`).join(', ');

	return `You are an expert evaluator assessing the quality of an AI assistant's response.

## Evaluation Criteria

${criteriaList}

## User Prompt

${prompt}
${referenceSection}
## AI Response

${response}

## Instructions

Score each criterion from 0 to 10, where 0 is completely inadequate and 10 is excellent.
Provide a brief overall reasoning for your scores.
Determine if the response passes (overall score >= ${passThreshold}).

You MUST respond with valid JSON only, no other text:
{"scores": {${criteriaNames}}, "overall": <number>, "reasoning": "<brief explanation>", "pass": <boolean>}`;
}

/** Parse the judge's JSON response, handling code blocks */
export function parseJudgeResponse(
	text: string,
	criteria: JudgeCriteria[],
	passThreshold: number,
): JudgeResult {
	// Strip markdown code blocks if present
	let jsonStr = text.trim();
	const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeBlockMatch) {
		jsonStr = codeBlockMatch[1].trim();
	}

	const parsed = JSON.parse(jsonStr);

	// Extract and clamp scores
	const criteriaScores: Record<string, number> = {};
	for (const c of criteria) {
		const raw = parsed.scores?.[c.name];
		if (typeof raw === 'number') {
			criteriaScores[c.name] = Math.max(0, Math.min(10, raw));
		}
	}

	const overall =
		typeof parsed.overall === 'number'
			? Math.max(0, Math.min(10, parsed.overall))
			: 0;

	return {
		pass:
			typeof parsed.pass === 'boolean' ? parsed.pass : overall >= passThreshold,
		score: overall,
		reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
		criteriaScores,
	};
}

/** Call the LLM judge to evaluate a response */
export async function callJudge(
	prompt: string,
	response: string,
	criteria: JudgeCriteria[],
	config: JudgeProviderConfig,
	passThreshold = 7,
	referenceAnswers?: string[],
): Promise<JudgeResult> {
	const provider = createJudgeProvider(config);
	const model = provider(config.model);

	const judgePrompt = buildJudgePrompt(
		prompt,
		response,
		criteria,
		passThreshold,
		referenceAnswers,
	);

	const result = await generateText({
		model,
		messages: [{role: 'user', content: judgePrompt}],
	});

	try {
		return parseJudgeResponse(result.text, criteria, passThreshold);
	} catch {
		// If JSON parsing fails, return a failure result with the raw response
		return {
			pass: false,
			score: 0,
			reasoning: `Failed to parse judge response: ${result.text}`,
			criteriaScores: {},
		};
	}
}
