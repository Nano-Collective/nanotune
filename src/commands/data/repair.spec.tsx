import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'ava';
import {execa} from 'execa';
import {render} from 'ink-testing-library';
import {createDefaultConfig, saveConfig} from '../../lib/config.js';
import {DataRepairCommand} from './repair.js';

const originalCwd = process.cwd();
const cliPath = fileURLToPath(new URL('../../cli.tsx', import.meta.url));
const tsxLoader = import.meta.resolve('tsx');
const originalTTY = process.stdin.isTTY;
let project: string;
let dataDir: string;
const example = JSON.stringify({messages: [{role: 'user', content: 'hello'}]}) + '\n';

test.beforeEach(() => {
	project = mkdtempSync(join(tmpdir(), 'nanotune-repair-cli-'));
	process.chdir(project);
	saveConfig(createDefaultConfig('test', 'org/model', {role: 'system', content: 'helpful'}));
	dataDir = join(project, '.nanotune', 'data');
	mkdirSync(dataDir);
});

test.afterEach.always(() => {
	process.chdir(originalCwd);
	process.exitCode = 0;
	process.stdin.isTTY = originalTTY;
	rmSync(project, {recursive: true, force: true});
});

async function runCli(args: string[]) {
	return execa(process.execPath, ['--import', tsxLoader, cliPath, 'data', 'repair', ...args], {cwd: project, reject: false, timeout: 10000});
}

test.serial('data repair --json works on Linux without a TTY and reports recoverable backups', async t => {
	const original = example + '{"messages":';
	writeFileSync(join(dataDir, 'train.jsonl'), original);
	const result = await runCli(['--json']);
	t.is(result.exitCode, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	t.is(report.quarantined, 1);
	t.is(report.examples, 1);
	t.is(readFileSync(report.backupPath, 'utf-8'), original);
	t.true(existsSync(report.quarantinePath));
	t.is(readFileSync(join(dataDir, 'train.jsonl'), 'utf-8'), example);
});

test.serial('data repair --eval --json modifies only the selected dataset', async t => {
	writeFileSync(join(dataDir, 'train.jsonl'), example + 'unchanged');
	writeFileSync(join(dataDir, 'valid.jsonl'), example + '{');
	const result = await runCli(['--eval', '--json']);
	t.is(result.exitCode, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	t.is(report.file, join(dataDir, 'valid.jsonl'));
	t.is(report.quarantined, 1);
	t.is(readFileSync(join(dataDir, 'train.jsonl'), 'utf-8'), example + 'unchanged');
});

test.serial('data repair --json reports a project error on stderr without partial JSON', async t => {
	rmSync(join(project, '.nanotune', 'config.json'));
	const result = await runCli(['--json']);
	t.is(result.exitCode, 1);
	t.is(result.stdout, '');
	t.true(result.stderr.includes('Not a Nanotune project'));
});

test.serial('the Ink repair screen reports backup paths and does not repeat repair on rerender', async t => {
	process.stdin.isTTY = true;
	writeFileSync(join(dataDir, 'train.jsonl'), example + '{');
	const instance = render(<DataRepairCommand />);
	try {
		await new Promise(resolve => setTimeout(resolve, 100));
		const output = instance.frames.join('\n').replace(/\s+/g, ' ');
		t.true(output.includes('Quarantined 1 malformed row.'));
		t.true(output.includes('Original backup:'));
		t.true(output.includes('Quarantine:'));
		const before = readdirSync(join(dataDir, 'quarantine'));
		writeFileSync(join(dataDir, 'train.jsonl'), example + 'new damage');
		instance.rerender(<DataRepairCommand />);
		await new Promise(resolve => setTimeout(resolve, 50));
		t.deepEqual(readdirSync(join(dataDir, 'quarantine')), before);
		t.is(readFileSync(join(dataDir, 'train.jsonl'), 'utf-8'), example + 'new damage');
	} finally {
		instance.unmount();
	}
});

test.serial('the Ink repair screen presents errors without mutating the dataset', async t => {
	writeFileSync(join(dataDir, 'train.jsonl'), example + '{');
	writeFileSync(join(dataDir, 'quarantine'), 'blocked');
	const instance = render(<DataRepairCommand />);
	try {
		const deadline = Date.now() + 3000;
		while (process.exitCode !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
		t.is(process.exitCode, 1);
		t.is(readFileSync(join(dataDir, 'train.jsonl'), 'utf-8'), example + '{');
	} finally {
		instance.unmount();
	}
});
