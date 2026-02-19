import type {JudgeProviderConfig} from '../types/index.js';

export interface TemplateField {
	name: string;
	prompt: string;
	default?: string;
	required?: boolean;
	sensitive?: boolean;
	validator?: (value: string) => string | undefined;
}

export interface ProviderTemplate {
	id: string;
	name: string;
	fields: TemplateField[];
	buildConfig: (answers: Record<string, string>) => JudgeProviderConfig;
}

const urlValidator = (value: string): string | undefined => {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (!['http:', 'https:'].includes(url.protocol)) {
			return 'URL must use http or https protocol';
		}
		return undefined;
	} catch {
		return 'Invalid URL format';
	}
};

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
	{
		id: 'ollama',
		name: 'Ollama',
		fields: [
			{
				name: 'providerName',
				prompt: 'Provider name',
				default: 'ollama',
				required: true,
			},
			{
				name: 'baseUrl',
				prompt: 'Base URL',
				default: 'http://localhost:11434/v1',
				validator: urlValidator,
			},
			{
				name: 'model',
				prompt: 'Model name',
				default: '',
				required: true,
			},
		],
		buildConfig: answers => ({
			name: answers.providerName || 'ollama',
			baseUrl: answers.baseUrl || 'http://localhost:11434/v1',
			model: answers.model,
		}),
	},
	{
		id: 'llama-cpp',
		name: 'llama.cpp server',
		fields: [
			{
				name: 'providerName',
				prompt: 'Provider name',
				default: 'llama-cpp',
				required: true,
			},
			{
				name: 'baseUrl',
				prompt: 'Base URL',
				default: 'http://localhost:8080/v1',
				validator: urlValidator,
			},
			{
				name: 'model',
				prompt: 'Model name',
				default: '',
				required: true,
			},
		],
		buildConfig: answers => ({
			name: answers.providerName || 'llama-cpp',
			baseUrl: answers.baseUrl || 'http://localhost:8080/v1',
			model: answers.model,
		}),
	},
	{
		id: 'lmstudio',
		name: 'LM Studio',
		fields: [
			{
				name: 'providerName',
				prompt: 'Provider name',
				default: 'lmstudio',
				required: true,
			},
			{
				name: 'baseUrl',
				prompt: 'Base URL',
				default: 'http://localhost:1234/v1',
				validator: urlValidator,
			},
			{
				name: 'model',
				prompt: 'Model name',
				default: '',
				required: true,
			},
		],
		buildConfig: answers => ({
			name: answers.providerName || 'lmstudio',
			baseUrl: answers.baseUrl || 'http://localhost:1234/v1',
			model: answers.model,
		}),
	},
	{
		id: 'gemini',
		name: 'Google Gemini',
		fields: [
			{
				name: 'apiKey',
				prompt: 'API Key (from https://aistudio.google.com/apikey)',
				required: true,
				sensitive: true,
			},
			{
				name: 'model',
				prompt: 'Model name',
				default: 'gemini-3-flash-preview',
				required: true,
			},
			{
				name: 'providerName',
				prompt: 'Provider name',
				default: 'Gemini',
			},
		],
		buildConfig: answers => ({
			name: answers.providerName || 'Gemini',
			sdkProvider: 'google',
			baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
			apiKey: answers.apiKey,
			model: answers.model,
		}),
	},
	{
		id: 'openrouter',
		name: 'OpenRouter',
		fields: [
			{
				name: 'apiKey',
				prompt: 'API Key',
				required: true,
				sensitive: true,
			},
			{
				name: 'model',
				prompt: 'Model name',
				default: '',
				required: true,
			},
			{
				name: 'providerName',
				prompt: 'Provider name',
				default: 'OpenRouter',
			},
		],
		buildConfig: answers => ({
			name: answers.providerName || 'OpenRouter',
			baseUrl: 'https://openrouter.ai/api/v1',
			apiKey: answers.apiKey,
			model: answers.model,
		}),
	},
	{
		id: 'openai',
		name: 'OpenAI',
		fields: [
			{
				name: 'apiKey',
				prompt: 'API Key',
				required: true,
				sensitive: true,
			},
			{
				name: 'model',
				prompt: 'Model name',
				default: '',
				required: true,
			},
			{
				name: 'providerName',
				prompt: 'Provider name',
				default: 'openai',
			},
		],
		buildConfig: answers => ({
			name: answers.providerName || 'openai',
			baseUrl: 'https://api.openai.com/v1',
			apiKey: answers.apiKey,
			model: answers.model,
		}),
	},
	{
		id: 'anthropic',
		name: 'Anthropic Claude',
		fields: [
			{
				name: 'apiKey',
				prompt: 'API Key',
				required: true,
				sensitive: true,
			},
			{
				name: 'model',
				prompt: 'Model name',
				default: '',
				required: true,
			},
			{
				name: 'providerName',
				prompt: 'Provider name',
				default: 'anthropic',
			},
		],
		buildConfig: answers => ({
			name: answers.providerName || 'anthropic',
			sdkProvider: 'anthropic',
			baseUrl: 'https://api.anthropic.com/v1',
			apiKey: answers.apiKey,
			model: answers.model,
		}),
	},
	{
		id: 'mistral',
		name: 'Mistral AI',
		fields: [
			{
				name: 'apiKey',
				prompt: 'API Key',
				required: true,
				sensitive: true,
			},
			{
				name: 'model',
				prompt: 'Model name',
				default: '',
				required: true,
			},
			{
				name: 'providerName',
				prompt: 'Provider name',
				default: 'Mistral',
			},
		],
		buildConfig: answers => ({
			name: answers.providerName || 'Mistral',
			baseUrl: 'https://api.mistral.ai/v1',
			apiKey: answers.apiKey,
			model: answers.model,
		}),
	},
	{
		id: 'z-ai',
		name: 'Z.ai',
		fields: [
			{
				name: 'providerName',
				prompt: 'Provider name',
				default: 'Z.ai',
				required: true,
			},
			{
				name: 'apiKey',
				prompt: 'API Key',
				required: true,
				sensitive: true,
			},
			{
				name: 'model',
				prompt: 'Model name',
				default: 'glm-5',
				required: true,
			},
		],
		buildConfig: answers => ({
			name: answers.providerName || 'Z.ai',
			baseUrl: 'https://api.z.ai/api/paas/v4/',
			apiKey: answers.apiKey,
			model: answers.model,
		}),
	},
	{
		id: 'z-ai-coding',
		name: 'Z.ai Coding Subscription',
		fields: [
			{
				name: 'providerName',
				prompt: 'Provider name',
				default: 'Z.ai Coding Subscription',
				required: true,
			},
			{
				name: 'apiKey',
				prompt: 'API Key',
				required: true,
				sensitive: true,
			},
			{
				name: 'model',
				prompt: 'Model name',
				default: 'glm-5',
				required: true,
			},
		],
		buildConfig: answers => ({
			name: answers.providerName || 'Z.ai Coding Subscription',
			baseUrl: 'https://api.z.ai/api/coding/paas/v4/',
			apiKey: answers.apiKey,
			model: answers.model,
		}),
	},
	{
		id: 'github-models',
		name: 'GitHub Models',
		fields: [
			{
				name: 'apiKey',
				prompt: 'GitHub Token (PAT with models:read scope)',
				required: true,
				sensitive: true,
			},
			{
				name: 'model',
				prompt: 'Model name',
				default: '',
				required: true,
			},
			{
				name: 'providerName',
				prompt: 'Provider name',
				default: 'GitHub Models',
			},
		],
		buildConfig: answers => ({
			name: answers.providerName || 'GitHub Models',
			baseUrl: 'https://models.github.ai/inference',
			apiKey: answers.apiKey,
			model: answers.model,
		}),
	},
	{
		id: 'kimi-code',
		name: 'Kimi Code',
		fields: [
			{
				name: 'apiKey',
				prompt: 'API Key',
				required: true,
				sensitive: true,
			},
			{
				name: 'model',
				prompt: 'Model name',
				default: 'kimi-for-coding',
				required: true,
			},
			{
				name: 'providerName',
				prompt: 'Provider name',
				default: 'Kimi Code',
			},
		],
		buildConfig: answers => ({
			name: answers.providerName || 'Kimi Code',
			sdkProvider: 'anthropic',
			baseUrl: 'https://api.kimi.com/coding/v1',
			apiKey: answers.apiKey,
			model: answers.model,
		}),
	},
	{
		id: 'minimax-coding',
		name: 'MiniMax Coding Plan',
		fields: [
			{
				name: 'apiKey',
				prompt: 'API Key',
				required: true,
				sensitive: true,
			},
			{
				name: 'model',
				prompt: 'Model name',
				default: 'MiniMax-M2.5',
				required: true,
			},
			{
				name: 'providerName',
				prompt: 'Provider name',
				default: 'MiniMax Coding',
			},
		],
		buildConfig: answers => ({
			name: answers.providerName || 'MiniMax Coding',
			sdkProvider: 'anthropic',
			baseUrl: 'https://api.minimax.io/anthropic/v1',
			apiKey: answers.apiKey,
			model: answers.model,
		}),
	},
	{
		id: 'poe',
		name: 'Poe',
		fields: [
			{
				name: 'apiKey',
				prompt: 'API Key (from poe.com/api_key)',
				required: true,
				sensitive: true,
			},
			{
				name: 'model',
				prompt: 'Model name',
				default: '',
				required: true,
			},
			{
				name: 'providerName',
				prompt: 'Provider name',
				default: 'Poe',
			},
		],
		buildConfig: answers => ({
			name: answers.providerName || 'Poe',
			baseUrl: 'https://api.poe.com/v1',
			apiKey: answers.apiKey,
			model: answers.model,
		}),
	},
	{
		id: 'custom',
		name: 'Custom Provider',
		fields: [
			{
				name: 'providerName',
				prompt: 'Provider name',
				required: true,
			},
			{
				name: 'baseUrl',
				prompt: 'Base URL',
				required: true,
				validator: urlValidator,
			},
			{
				name: 'apiKey',
				prompt: 'API Key (optional)',
				required: false,
				sensitive: true,
			},
			{
				name: 'model',
				prompt: 'Model name',
				required: true,
			},
		],
		buildConfig: answers => {
			const config: JudgeProviderConfig = {
				name: answers.providerName,
				baseUrl: answers.baseUrl,
				model: answers.model,
			};
			if (answers.apiKey) {
				config.apiKey = answers.apiKey;
			}
			return config;
		},
	},
];
