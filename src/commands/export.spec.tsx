import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {render} from 'ink-testing-library';
import {createDefaultConfig, initializeProjectDirs, saveConfig} from '../lib/config.js';
import {ExportCommand} from './export.js';

const originalCwd = process.cwd();
let project: string;

test.beforeEach(() => {
	project = mkdtempSync(join(tmpdir(), 'nanotune-export-card-'));
	process.chdir(project);
	initializeProjectDirs();
	saveConfig(createDefaultConfig('test-model', 'org/base-model', {role: 'system', content: 'Private prompt'}));
	writeFileSync(join(project, '.nanotune', 'adapters', 'adapters.safetensors'), 'adapter');
});

test.afterEach.always(() => {
	process.chdir(originalCwd);
	process.exitCode = 0;
	rmSync(project, {recursive: true, force: true});
});

const dependencies = {
	assertSupportedPlatform: () => {},
	checkLlamaCppInstalled: async () => true,
	installLlamaCpp: async function* () {},
	fuseAdapters: async (_base: string, _adapters: string, fused: string) => {
		mkdirSync(fused, {recursive: true});
		writeFileSync(join(fused, 'model.safetensors'), 'fused');
	},
	exportModel: async function* (_fused: string, output: string) {
		writeFileSync(output, 'GGUF');
		yield {step: 'Export complete!', progress: 100};
	},
};

async function waitForOutput(instance: ReturnType<typeof render>, expected: string) {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (instance.frames.join('\n').replace(/\s+/g, ' ').includes(expected)) return;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error(`Missing ${expected}: ${instance.frames.join('\n')}`);
}

test.serial('ExportCommand creates the card after successful export with CLI overrides', async t => {
	const instance = render(<ExportCommand options={{output: 'custom', quantization: 'q8_0'}} dependencies={dependencies} />);
	try {
		await waitForOutput(instance, 'Export complete!');
		t.true(instance.frames.join('\n').includes('Model card:'));
		const models = join(project, '.nanotune', 'models');
		t.true(existsSync(join(models, 'custom.gguf')));
		const card = readFileSync(join(models, 'README.md'), 'utf-8');
		t.true(card.includes('Artifact: custom.gguf'));
		t.true(card.includes('Quantization: q8_0'));
		t.false(card.includes('Private prompt'));
	} finally {
		instance.unmount();
	}
});

test.serial('ExportCommand preserves an existing model card and reports it', async t => {
	const path = join(project, '.nanotune', 'models', 'README.md');
	writeFileSync(path, 'Custom documentation\n');
	const instance = render(<ExportCommand options={{}} dependencies={dependencies} />);
	try {
		await waitForOutput(instance, 'existing README preserved');
		t.is(readFileSync(path, 'utf-8'), 'Custom documentation\n');
	} finally {
		instance.unmount();
	}
});

test.serial('ExportCommand does not create a card when conversion fails', async t => {
	const instance = render(<ExportCommand options={{}} dependencies={{...dependencies, exportModel: async function* () {throw new Error('Conversion failed');}}} />);
	try {
		await waitForOutput(instance, 'Conversion failed');
		t.false(existsSync(join(project, '.nanotune', 'models', 'README.md')));
		// Ink can paint the error before React runs the exit-code effect.
		const deadline = Date.now() + 3000;
		while (process.exitCode !== 1 && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		t.is(process.exitCode, 1);
	} finally {
		instance.unmount();
	}
});
