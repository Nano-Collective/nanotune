import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {execa} from 'execa';
import type {Config} from '../types/index.js';
import {createDefaultConfig} from './config.js';
import {renderModelCard, writeModelCard} from './model-card.js';

const config = createDefaultConfig('shell-helper', 'Qwen/Qwen2.5-0.5B-Instruct', {
	role: 'system',
	content: 'PRIVATE PROMPT: do not publish',
});

function render(overrides: Partial<Parameters<typeof renderModelCard>[0]> = {}) {
	return renderModelCard({
		config,
		outputPath: '/models/shell-helper-q4_k_m.gguf',
		quantization: 'q4_k_m',
		trainExamples: 90,
		validationExamples: 10,
		benchmark: null,
		...overrides,
	});
}

test.serial('model card includes Hub metadata, training settings, and dataset counts', t => {
	const card = render();
	t.true(card.startsWith('---\nbase_model: "Qwen/Qwen2.5-0.5B-Instruct"\n'));
	t.true(card.includes('pipeline_tag: text-generation'));
	t.true(card.includes('library_name: gguf'));
	t.true(card.includes('# shell-helper'));
	t.true(card.includes('Artifact: shell-helper-q4\\_k\\_m.gguf'));
	t.true(card.includes('| LoRA rank | 8 |'));
	t.true(card.includes('| LoRA alpha | 20 |'));
	t.true(card.includes('| LoRA dropout | 0 |'));
	t.true(card.includes('Training examples: 90'));
	t.true(card.includes('Validation examples: 10'));
	t.true(card.includes('Total examples: 100'));
	t.true(card.includes('No saved benchmark results'));
	t.false(card.includes('PRIVATE PROMPT'));
	t.false(card.includes('\nlicense:'));
	t.true(card.endsWith('\n'));
});

test.serial('full fine-tuning omits unused LoRA parameters', t => {
	const card = render({
		config: {...config, training: {...config.training, fineTuneType: 'full'}},
	});
	t.true(card.includes('Fine-tuning method: full'));
	t.false(card.includes('| LoRA'));
});

test.serial('DoRA includes the configured adapter parameters and output overrides', t => {
	const card = render({
		config: {
			...config,
			training: {...config.training, fineTuneType: 'dora', loraRank: 16},
		},
		outputPath: '/models/custom.gguf',
		quantization: 'q8_0',
	});
	t.true(card.includes('Fine-tuning method: dora'));
	t.true(card.includes('| LoRA rank | 16 |'));
	t.true(card.includes('Artifact: custom.gguf'));
	t.true(card.includes('Quantization: q8_0'));
});

test.serial('names cannot break frontmatter or inject Markdown rows and headings', t => {
	const specialConfig: Config = {
		...config,
		name: 'demo\n# injected | <script>',
		baseModel: 'org/model"\nlicense: fake',
	};
	const card = render({config: specialConfig});
	const baseModelLine = card.split('\n')[1];
	t.is(JSON.parse(baseModelLine.slice('base_model: '.length)), specialConfig.baseModel);
	t.false(card.includes('\nlicense: fake'));
	t.false(card.includes('\n# injected'));
	t.false(card.includes('<script>'));
	t.true(card.includes('\\|'));
});

const originalCwd = process.cwd();
let project: string;
let models: string;
let benchmarks: string;
let output: string;

test.beforeEach(() => {
	project = mkdtempSync(join(tmpdir(), 'nanotune-model-card-'));
	models = join(project, '.nanotune', 'models');
	benchmarks = join(project, '.nanotune', 'benchmarks');
	mkdirSync(models, {recursive: true});
	mkdirSync(benchmarks, {recursive: true});
	output = join(models, 'shell-helper-q4_k_m.gguf');
	writeFileSync(output, 'GGUF');
	process.chdir(project);
});

test.afterEach.always(() => {
	process.chdir(originalCwd);
	rmSync(project, {recursive: true, force: true});
});

function benchmark(overrides: Record<string, unknown> = {}) {
	return {
		model: output,
		timestamp: '2026-10-15T12:00:00.000Z',
		isBase: false,
		summary: {total: 4, passed: 3, failed: 1, passRate: 0.75},
		...overrides,
	};
}

function saveBenchmark(name: string, data: unknown) {
	writeFileSync(join(benchmarks, `benchmark-${name}.json`), JSON.stringify(data));
}

test.serial('writeModelCard writes beside the GGUF with both dataset counts', t => {
	const dataDir = join(project, '.nanotune', 'data');
	mkdirSync(dataDir);
	const example = JSON.stringify({messages: [{role: 'user', content: 'SECRET'}]});
	writeFileSync(join(dataDir, 'train.jsonl'), `${example}\n\n${example}\n`);
	writeFileSync(join(dataDir, 'valid.jsonl'), `${example}\n`);
	const result = writeModelCard(config, output, 'q4_k_m');
	t.deepEqual(result, {path: join(models, 'README.md'), created: true});
	const card = readFileSync(result.path, 'utf-8');
	t.true(card.includes('Training examples: 2'));
	t.true(card.includes('Validation examples: 1'));
	t.true(card.includes('Total examples: 3'));
	t.false(card.includes('SECRET'));
});

test.serial('writeModelCard handles missing dataset and benchmark directories', t => {
	rmSync(benchmarks, {recursive: true});
	const result = writeModelCard(config, output, 'f16');
	const card = readFileSync(result.path, 'utf-8');
	t.true(card.includes('Total examples: 0'));
	t.true(card.includes('No saved benchmark results'));
});

test.serial('writeModelCard uses the newest matching evaluation date', t => {
	saveBenchmark('newer', benchmark());
	// Write the older report last to prove mtime is not the evaluation date.
	saveBenchmark('older', benchmark({timestamp: '2026-10-14T12:00:00.000Z'}));
	saveBenchmark('unrelated', benchmark({model: join(project, 'other', 'shell-helper-q4_k_m.gguf')}));
	saveBenchmark('base', benchmark({isBase: true}));
	saveBenchmark('invalid-summary', benchmark({summary: {total: 4, passed: 3, failed: 1, passRate: 0.99}}));
	writeFileSync(join(benchmarks, 'benchmark-corrupt.json'), '{');
	const result = writeModelCard(config, output, 'q4_k_m');
	const card = readFileSync(result.path, 'utf-8');
	t.true(card.includes('Benchmark date: 2026-10-15T12:00:00.000Z'));
	t.false(card.includes('Benchmark date: 2026-10-14'));
	t.true(card.includes('Passed: 3/4'));
	t.true(card.includes('Pass rate: 75.0%'));
	t.true(card.includes('may predate this export'));
});

test.serial('writeModelCard does not claim evaluation for unrelated or invalid runs', t => {
	saveBenchmark('other', benchmark({model: '/other.gguf'}));
	saveBenchmark('base', benchmark({isBase: true}));
	saveBenchmark('invalid-date', benchmark({timestamp: 'yesterday'}));
	saveBenchmark('invalid', {model: output});
	const result = writeModelCard(config, output, 'q4_k_m');
	t.true(readFileSync(result.path, 'utf-8').includes('No saved benchmark results'));
});

test.serial('writeModelCard reports a saved zero-test benchmark without a misleading pass rate', t => {
	saveBenchmark('empty', benchmark({summary: {total: 0, passed: 0, failed: 0, passRate: 0}}));
	const result = writeModelCard(config, output, 'q4_k_m');
	const card = readFileSync(result.path, 'utf-8');
	t.true(card.includes('Benchmark date: 2026-10-15T12:00:00.000Z'));
	t.true(card.includes('Tests run: 0'));
	t.true(card.includes('No tests were run; a pass rate is not available.'));
	t.false(card.includes('Pass rate: 0.0%'));
	t.false(card.includes('No saved benchmark results'));
});

const modelCardModule = new URL('./model-card.ts', import.meta.url).href;

async function runCardWriter(code: string) {
	return execa(process.execPath, ['--import=tsx', '--input-type=module', '-e', `
		import fs from 'node:fs';
		import {syncBuiltinESMExports} from 'node:module';
		import {writeModelCard} from ${JSON.stringify(modelCardModule)};
		process.chdir(${JSON.stringify(project)});
		const config = ${JSON.stringify(config)};
		const output = ${JSON.stringify(output)};
		const cardPath = ${JSON.stringify(join(models, 'README.md'))};
		${code}
	`], {cwd: originalCwd, reject: false});
}

test.serial('writeModelCard leaves no partial README after a crash and recovers the orphaned temp', async t => {
	const crashed = await runCardWriter(`
		const write = fs.writeFileSync;
		fs.writeFileSync = (path, ...args) => {
			if (String(path) === cardPath + '.tmp-' + process.pid) {
				write(path, '---\\nbase_model:');
				process.exit(42);
			}
			return write(path, ...args);
		};
		syncBuiltinESMExports();
		writeModelCard(config, output, 'q4_k_m');
	`);
	t.is(crashed.exitCode, 42, crashed.stderr);
	t.false(existsSync(join(models, 'README.md')));
	t.true(readdirSync(models).some(name => name.startsWith('README.md.tmp-')));
	const result = writeModelCard(config, output, 'q4_k_m');
	t.true(result.created);
	t.true(readFileSync(result.path, 'utf-8').includes('## Evaluation'));
	t.false(readdirSync(models).some(name => name.startsWith('README.md.tmp-')));
});

test.serial('writeModelCard preserves a README created concurrently before atomic publication', async t => {
	const result = await runCardWriter(`
		const link = fs.linkSync;
		fs.linkSync = (source, destination) => {
			fs.writeFileSync(destination, 'Concurrent user documentation\\n');
			return link(source, destination);
		};
		syncBuiltinESMExports();
		console.log(JSON.stringify(writeModelCard(config, output, 'q4_k_m')));
	`);
	t.is(result.exitCode, 0, result.stderr);
	t.false(JSON.parse(result.stdout).created);
	t.is(readFileSync(join(models, 'README.md'), 'utf-8'), 'Concurrent user documentation\n');
	t.false(readdirSync(models).some(name => name.startsWith('README.md.tmp-')));
});

test.serial('writeModelCard labels partial benchmark results', t => {
	saveBenchmark('partial', benchmark({warning: 'Server exited early'}));
	const result = writeModelCard(config, output, 'q4_k_m');
	const card = readFileSync(result.path, 'utf-8');
	t.true(card.includes('Partial benchmark: Server exited early'));
	t.true(card.includes('pass rate covers only tests that ran'));
});

test.serial('writeModelCard preserves an existing README on re-export', t => {
	const path = join(models, 'README.md');
	writeFileSync(path, 'My custom model card\n');
	t.deepEqual(writeModelCard(config, output, 'q4_k_m'), {path, created: false});
	t.is(readFileSync(path, 'utf-8'), 'My custom model card\n');
});

test.serial('writeModelCard follows nested output paths instead of the project root', t => {
	const nested = join(models, 'release');
	mkdirSync(nested);
	const result = writeModelCard(config, join(nested, 'custom.gguf'), 'q8_0');
	t.is(result.path, join(nested, 'README.md'));
	t.true(readFileSync(result.path, 'utf-8').includes('Artifact: custom.gguf'));
});

test.serial('writeModelCard propagates write failures', t => {
	t.throws(() => writeModelCard(config, join(models, 'missing', 'model.gguf'), 'f16'));
});

test.serial('writeModelCard rejects a directory at the README path', t => {
	mkdirSync(join(models, 'README.md'));
	t.throws(() => writeModelCard(config, output, 'q4_k_m'), {message: /is not a file/});
});
