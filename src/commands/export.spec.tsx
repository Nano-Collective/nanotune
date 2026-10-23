import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {render} from 'ink-testing-library';
import {createDefaultConfig, initializeProjectDirs, saveConfig} from '../lib/config.js';
import {writeModelCard} from '../lib/model-card.js';
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
	writeModelCard,
	checkLlamaCppInstalled: async () => true,
	installLlamaCpp: async function* () {},
	checkConvertDependencies: async () => true,
	installConvertDependencies: async function* () {},
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
	let conversionFinished = false;
	let cardWritten = false;
	const instance = render(<ExportCommand options={{output: 'custom', quantization: 'q8_0'}} dependencies={{
		...dependencies,
		exportModel: async function* (fused, output) {
			yield* dependencies.exportModel(fused, output);
			conversionFinished = true;
		},
		writeModelCard: async (...args) => {
			t.true(conversionFinished);
			t.true(existsSync(args[1]));
			// Simulate I/O to let Ink display the fourth step while it runs.
			await new Promise(resolve => setTimeout(resolve, 50));
			cardWritten = true;
			return writeModelCard(...args);
		},
	}} />);
	try {
		await waitForOutput(instance, 'Export complete!');
		t.true(cardWritten);
		t.true(instance.frames.join('\n').includes('Step 4/4: Writing model card'));
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

test.serial('ExportCommand reports a card generation error as a warning after successful conversion', async t => {
	const instance = render(<ExportCommand options={{}} dependencies={{
		...dependencies,
		writeModelCard: async () => {throw new Error('Permission denied');},
	}} />);
	try {
		await waitForOutput(instance, 'Export complete!');
		await waitForOutput(instance, 'Model card could not be written: Permission denied');
		const output = instance.frames.join('\n').replace(/\s+/g, ' ');
		t.true(output.includes('Output:'));
		t.false(output.includes('Export failed'));
		t.is(process.exitCode ?? 0, 0);
		t.is(readFileSync(join(project, '.nanotune', 'models', 'test-model-q4_k_m.gguf'), 'utf-8'), 'GGUF');
	} finally {
		instance.unmount();
	}
});

test.serial('ExportCommand preserves success when the real card writer encounters a blocked README', async t => {
	mkdirSync(join(project, '.nanotune', 'models', 'README.md'));
	const instance = render(<ExportCommand options={{}} dependencies={dependencies} />);
	try {
		await waitForOutput(instance, 'Export complete!');
		await waitForOutput(instance, 'Model card could not be written:');
		await waitForOutput(instance, 'is not a file');
		t.true(existsSync(join(project, '.nanotune', 'models', 'test-model-q4_k_m.gguf')));
		t.is(process.exitCode ?? 0, 0);
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

test.serial('ExportCommand installs the conversion dependencies before it spends time fusing', async t => {
	const order: string[] = [];
	const instance = render(<ExportCommand options={{}} dependencies={{
		...dependencies,
		checkConvertDependencies: async () => false,
		installConvertDependencies: async function* () {
			order.push('install');
			yield 'Installing PyTorch (needed to convert to GGUF)...';
		},
		fuseAdapters: async (...args) => {
			order.push('fuse');
			await dependencies.fuseAdapters(...args);
		},
	}} />);
	try {
		await waitForOutput(instance, 'Export complete!');
		t.deepEqual(order, ['install', 'fuse']);
	} finally {
		instance.unmount();
	}
});

test.serial('ExportCommand stops with the install error when the conversion dependencies cannot be installed', async t => {
	let fused = false;
	const instance = render(<ExportCommand options={{}} dependencies={{
		...dependencies,
		checkConvertDependencies: async () => false,
		installConvertDependencies: async function* () {
			throw new Error('pip refuses to install torch');
		},
		fuseAdapters: async () => {
			fused = true;
		},
	}} />);
	try {
		await waitForOutput(instance, 'pip refuses to install torch');
		t.false(fused);
	} finally {
		instance.unmount();
	}
});

test.serial('ExportCommand rejects an unknown quantization before it fuses anything', async t => {
	let fused = false;
	let checked = false;
	const instance = render(<ExportCommand options={{quantization: 'q9'}} dependencies={{
		...dependencies,
		checkLlamaCppInstalled: async () => {
			checked = true;
			return true;
		},
		fuseAdapters: async () => {
			fused = true;
		},
	}} />);
	try {
		await waitForOutput(instance, 'Invalid --quantization "q9": expected one of f16, q8_0, q4_k_m, q4_k_s.');
		t.false(fused);
		t.false(checked);
	} finally {
		instance.unmount();
	}
});
