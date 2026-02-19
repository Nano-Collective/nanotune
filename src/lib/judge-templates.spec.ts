import test from 'ava';
import {PROVIDER_TEMPLATES} from './judge-templates.js';
import type {JudgeProviderConfig} from '../types/index.js';

test('PROVIDER_TEMPLATES contains expected number of templates', t => {
	t.is(PROVIDER_TEMPLATES.length, 15);
});

test('Each template has required fields', t => {
	for (const template of PROVIDER_TEMPLATES) {
		t.truthy(template.id, `Template should have an id`);
		t.truthy(template.name, `Template ${template.id} should have a name`);
		t.true(
			Array.isArray(template.fields),
			`Template ${template.id} should have fields array`,
		);
		t.is(
			typeof template.buildConfig,
			'function',
			`Template ${template.id} should have buildConfig function`,
		);
	}
});

test('Each template has a model field', t => {
	for (const template of PROVIDER_TEMPLATES) {
		const modelField = template.fields.find(f => f.name === 'model');
		t.truthy(
			modelField,
			`Template ${template.id} should have a model field`,
		);
	}
});

test('Ollama template builds config correctly', t => {
	const template = PROVIDER_TEMPLATES.find(t => t.id === 'ollama');
	t.truthy(template);

	const config = template!.buildConfig({
		providerName: 'ollama',
		baseUrl: 'http://localhost:11434/v1',
		model: 'llama3.2',
	});

	t.is(config.name, 'ollama');
	t.is(config.baseUrl, 'http://localhost:11434/v1');
	t.is(config.model, 'llama3.2');
	t.is(config.apiKey, undefined);
});

test('OpenRouter template builds config correctly', t => {
	const template = PROVIDER_TEMPLATES.find(t => t.id === 'openrouter');
	t.truthy(template);

	const config = template!.buildConfig({
		providerName: 'OpenRouter',
		apiKey: 'sk-test-key',
		model: 'anthropic/claude-haiku',
	});

	t.is(config.name, 'OpenRouter');
	t.is(config.baseUrl, 'https://openrouter.ai/api/v1');
	t.is(config.apiKey, 'sk-test-key');
	t.is(config.model, 'anthropic/claude-haiku');
});

test('Anthropic template sets sdkProvider correctly', t => {
	const template = PROVIDER_TEMPLATES.find(t => t.id === 'anthropic');
	t.truthy(template);

	const config = template!.buildConfig({
		providerName: 'anthropic',
		apiKey: 'sk-ant-test',
		model: 'claude-haiku-4-5-20251001',
	});

	t.is(config.sdkProvider, 'anthropic');
	t.is(config.baseUrl, 'https://api.anthropic.com/v1');
});

test('Google Gemini template sets sdkProvider correctly', t => {
	const template = PROVIDER_TEMPLATES.find(t => t.id === 'gemini');
	t.truthy(template);

	const config = template!.buildConfig({
		apiKey: 'test-key',
		model: 'gemini-3-flash-preview',
		providerName: 'Gemini',
	});

	t.is(config.sdkProvider, 'google');
});

test('Custom template builds config with optional apiKey', t => {
	const template = PROVIDER_TEMPLATES.find(t => t.id === 'custom');
	t.truthy(template);

	// Without API key
	const configNoKey = template!.buildConfig({
		providerName: 'My Provider',
		baseUrl: 'http://localhost:8000/v1',
		model: 'my-model',
		apiKey: '',
	});
	t.is(configNoKey.apiKey, undefined);

	// With API key
	const configWithKey = template!.buildConfig({
		providerName: 'My Provider',
		baseUrl: 'http://localhost:8000/v1',
		model: 'my-model',
		apiKey: 'my-key',
	});
	t.is(configWithKey.apiKey, 'my-key');
});

test('buildConfig returns single model string not array', t => {
	for (const template of PROVIDER_TEMPLATES) {
		const answers: Record<string, string> = {};
		for (const field of template.fields) {
			answers[field.name] = field.default || `test-${field.name}`;
		}
		// Ensure model is set
		answers.model = 'test-model';

		const config: JudgeProviderConfig = template.buildConfig(answers);
		t.is(typeof config.model, 'string', `Template ${template.id} model should be a string`);
		t.false(Array.isArray(config.model), `Template ${template.id} model should not be an array`);
	}
});

test('Templates with sensitive fields mark them correctly', t => {
	const templatesWithApiKey = PROVIDER_TEMPLATES.filter(t =>
		t.fields.some(f => f.name === 'apiKey'),
	);

	for (const template of templatesWithApiKey) {
		const apiKeyField = template.fields.find(f => f.name === 'apiKey');
		t.true(
			apiKeyField?.sensitive,
			`Template ${template.id} apiKey field should be marked sensitive`,
		);
	}
});

test('All template IDs are unique', t => {
	const ids = PROVIDER_TEMPLATES.map(t => t.id);
	const uniqueIds = new Set(ids);
	t.is(ids.length, uniqueIds.size);
});
