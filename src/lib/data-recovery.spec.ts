import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {execa} from 'execa';
import {appendTrainingExample, countExamples, loadTrainingData, repairTrainingData} from './data.js';
import {recoverDatasetAppend} from './data-recovery.js';

const originalCwd = process.cwd();
const dataModule = new URL('./data.ts', import.meta.url).href;
let project: string;
let dataDir: string;
let path: string;

const first = {messages: [{role: 'user', content: 'first'}, {role: 'assistant', content: 'answer'}]};
const second = {messages: [{role: 'user', content: '第二条 🙂'}, {role: 'assistant', content: 'second answer'}]};
const line = (example: typeof first) => `${JSON.stringify(example)}\n`;

test.beforeEach(() => {
	project = mkdtempSync(join(tmpdir(), 'nanotune-data-recovery-'));
	dataDir = join(project, '.nanotune', 'data');
	mkdirSync(dataDir, {recursive: true});
	path = join(dataDir, 'train.jsonl');
	process.chdir(project);
});

test.afterEach.always(() => {
	process.chdir(originalCwd);
	rmSync(project, {recursive: true, force: true});
});

async function crashAppend(stage: 'before' | 'partial' | 'complete' | 'cleanup', isEval = false) {
	return execa(process.execPath, ['--import=tsx', '--input-type=module', '-e', `
		import fs from 'node:fs';
		import {syncBuiltinESMExports} from 'node:module';
		import {appendTrainingExample} from ${JSON.stringify(dataModule)};
		process.chdir(${JSON.stringify(project)});
		const append = fs.appendFileSync;
		fs.appendFileSync = (file, content, ...options) => {
			if (${JSON.stringify(stage)} === 'before') process.exit(42);
			const bytes = Buffer.from(content);
			if (${JSON.stringify(stage)} === 'partial') {
				const cut = bytes.indexOf(Buffer.from('第二')) + 1;
				append(file, bytes.subarray(0, cut));
				process.exit(42);
			}
			append(file, content, ...options);
			if (${JSON.stringify(stage)} === 'complete') process.exit(42);
		};
		if (${JSON.stringify(stage)} === 'cleanup') {
			const remove = fs.rmSync;
			fs.rmSync = (file, ...options) => {
				if (String(file).endsWith('.append-journal.json')) process.exit(42);
				return remove(file, ...options);
			};
		}
		syncBuiltinESMExports();
		appendTrainingExample(${JSON.stringify(second)}, ${isEval});
	`], {cwd: originalCwd, reject: false, timeout: 10000});
}

for (const stage of ['before', 'partial', 'complete', 'cleanup'] as const) {
	test.serial(`recovers exactly once after a process crashes at append stage ${stage}`, async t => {
		writeFileSync(path, line(first));
		const crashed = await crashAppend(stage);
		t.is(crashed.exitCode, 42, crashed.stderr);
		t.true(existsSync(`${path}.append-journal.json`));
		t.deepEqual(loadTrainingData(), [first, second]);
		t.deepEqual(loadTrainingData(), [first, second]);
		t.false(existsSync(`${path}.append-journal.json`));
		t.false(existsSync(join(project, '.nanotune', 'data.lock')));
		appendTrainingExample(first, false);
		t.deepEqual(loadTrainingData(), [first, second, first]);
	});
}

test.serial('countExamples also recovers pending appends before reporting a count', async t => {
	writeFileSync(path, line(first));
	t.is((await crashAppend('partial')).exitCode, 42);
	t.is(countExamples(), 2);
	t.false(existsSync(`${path}.append-journal.json`));
});

test.serial('validation recovery leaves the training set untouched', async t => {
	writeFileSync(path, line(first));
	const evalPath = join(dataDir, 'valid.jsonl');
	writeFileSync(evalPath, line(first));
	t.is((await crashAppend('partial', true)).exitCode, 42);
	t.deepEqual(loadTrainingData(true), [first, second]);
	t.is(readFileSync(path, 'utf-8'), line(first));
});

test.serial('recovery itself can crash without losing the journal or changing the dataset', async t => {
	writeFileSync(path, line(first));
	t.is((await crashAppend('partial')).exitCode, 42);
	const partial = readFileSync(path);
	const crashed = await execa(process.execPath, ['--import=tsx', '--input-type=module', '-e', `
		import fs from 'node:fs';
		import {syncBuiltinESMExports} from 'node:module';
		import {loadTrainingData} from ${JSON.stringify(dataModule)};
		process.chdir(${JSON.stringify(project)});
		const write = fs.writeFileSync;
		fs.writeFileSync = (file, ...options) => {
			if (String(file).startsWith(${JSON.stringify(path + '.tmp-')})) {
				write(file, 'partial recovery');
				process.exit(43);
			}
			return write(file, ...options);
		};
		syncBuiltinESMExports();
		loadTrainingData();
	`], {cwd: originalCwd, reject: false, timeout: 10000});
	t.is(crashed.exitCode, 43, crashed.stderr);
	t.deepEqual(readFileSync(path), partial);
	t.true(existsSync(`${path}.append-journal.json`));
	t.deepEqual(loadTrainingData(), [first, second]);
	t.false(readdirSync(dataDir).some(name => name.includes('.tmp-')));
});

test.serial('a new append recovers the pending one first and does not duplicate it', async t => {
	writeFileSync(path, line(first));
	t.is((await crashAppend('complete')).exitCode, 42);
	appendTrainingExample(first, false);
	t.deepEqual(loadTrainingData(), [first, second, first]);
});

test.serial('append refuses an unjournaled truncated tail without changing any bytes', t => {
	const original = `${line(first)}{"messages":[`;
	writeFileSync(path, original);
	t.throws(() => appendTrainingExample(second, false), {message: /data repair/});
	t.is(readFileSync(path, 'utf-8'), original);
	t.false(existsSync(`${path}.append-journal.json`));
});

test.serial('append handles a large Unicode row without a final newline', t => {
	const large = {messages: [{role: 'user', content: '你好🙂'.repeat(5000)}]};
	writeFileSync(path, JSON.stringify(large));
	appendTrainingExample(second, false);
	t.deepEqual(loadTrainingData(), [large, second]);
});

test.serial('repair preserves all good rows and creates a byte-for-byte backup and quarantine', t => {
	const broken = Buffer.from('{"messages":[');
	const original = Buffer.concat([Buffer.from(line(first)), Buffer.from('not-json\r\n'), Buffer.from(line(second)), broken]);
	writeFileSync(path, original);
	const report = repairTrainingData();
	t.is(report.quarantined, 2);
	t.is(report.examples, 2);
	t.deepEqual(loadTrainingData(), [first, second]);
	t.deepEqual(readFileSync(report.backupPath!), original);
	const rows = readFileSync(report.quarantinePath!, 'utf-8').trim().split('\n').map(row => JSON.parse(row));
	t.deepEqual(rows.map(row => row.line), [2, 4]);
	t.deepEqual(Buffer.from(rows[0].rawBase64, 'base64'), Buffer.from('not-json\r\n'));
	t.deepEqual(Buffer.from(rows[1].rawBase64, 'base64'), broken);
	const again = repairTrainingData();
	t.is(again.quarantined, 0);
	t.is(again.backupPath, null);
});

test.serial('repair quarantines invalid message structures and preserves blank lines and duplicate good rows', t => {
	writeFileSync(path, `${line(first)}\n{"messages":"bad"}\n${line(first)}`);
	const report = repairTrainingData();
	t.is(report.quarantined, 1);
	t.deepEqual(loadTrainingData(), [first, first]);
	t.true(readFileSync(path, 'utf-8').includes('\n\n'));
});

test.serial('repair of validation data does not modify training data', t => {
	writeFileSync(path, line(first));
	writeFileSync(join(dataDir, 'valid.jsonl'), `${line(second)}{`);
	const report = repairTrainingData(true);
	t.is(report.quarantined, 1);
	t.is(readFileSync(path, 'utf-8'), line(first));
	t.deepEqual(loadTrainingData(true), [second]);
});

test.serial('repair handles missing and entirely malformed files', t => {
	t.is(repairTrainingData().quarantined, 0);
	writeFileSync(path, '{\nnot-json');
	const report = repairTrainingData();
	t.is(report.quarantined, 2);
	t.is(readFileSync(path, 'utf-8'), '');
	appendTrainingExample(first, false);
	t.deepEqual(loadTrainingData(), [first]);
});

test.serial('repair recovers a journaled append before checking for malformed rows', async t => {
	writeFileSync(path, line(first));
	t.is((await crashAppend('partial')).exitCode, 42);
	const report = repairTrainingData();
	t.true(report.journalRecovered);
	t.is(report.quarantined, 0);
	t.deepEqual(loadTrainingData(), [first, second]);
});

test.serial('repair leaves the dataset untouched if its quarantine cannot be written', t => {
	const original = `${line(first)}{`;
	writeFileSync(path, original);
	writeFileSync(join(dataDir, 'quarantine'), 'blocked');
	t.throws(() => repairTrainingData());
	t.is(readFileSync(path, 'utf-8'), original);
});

test.serial('invalid and checksum-mismatched journals preserve both files and fail clearly', t => {
	writeFileSync(path, line(first));
	for (const bad of ['{', JSON.stringify({version: 1, originalSize: 0, tail: '', content: line(second), checksum: 'bad'})]) {
		writeFileSync(`${path}.append-journal.json`, bad);
		t.throws(() => recoverDatasetAppend(path), {message: /Invalid append journal/});
		t.is(readFileSync(path, 'utf-8'), line(first));
		t.is(readFileSync(`${path}.append-journal.json`, 'utf-8'), bad);
	}
});

test.serial('recovery refuses unexpected dataset changes instead of truncating them', t => {
	writeFileSync(path, `${line(first)}user-edited bytes`);
	const content = line(second);
	writeFileSync(`${path}.append-journal.json`, JSON.stringify({version: 1, originalSize: Buffer.byteLength(line(first)), tail: Buffer.from(line(first)).toString('base64'), content, checksum: createHash('sha256').update(content).digest('hex')}));
	const original = readFileSync(path);
	t.throws(() => recoverDatasetAppend(path), {message: /it changed/});
	t.deepEqual(readFileSync(path), original);
	t.true(existsSync(`${path}.append-journal.json`));
});

test.serial('two real appenders preserve every example while sharing the recovery journal', async t => {
	const script = (prefix: string) => `
		import {appendTrainingExample} from ${JSON.stringify(dataModule)};
		process.chdir(${JSON.stringify(project)});
		for (let i = 0; i < 20; i++) appendTrainingExample({messages: [{role: 'user', content: ${JSON.stringify(prefix)} + i}]}, false);
	`;
	await Promise.all(['a', 'b'].map(prefix => execa(process.execPath, ['--import=tsx', '--input-type=module', '-e', script(prefix)], {cwd: originalCwd, timeout: 10000})));
	const rows = loadTrainingData();
	t.is(rows.length, 40);
	t.is(new Set(rows.map(row => row.messages[0].content)).size, 40);
	t.false(existsSync(`${path}.append-journal.json`));
});

test.serial('repair quarantines invalid UTF-8 without losing the original bytes', t => {
	const invalid = Buffer.concat([Buffer.from('{"messages":[{"role":"user","content":"'), Buffer.from([0xff]), Buffer.from('"}]}\n')]);
	const original = Buffer.concat([Buffer.from(line(first)), invalid]);
	writeFileSync(path, original);
	t.throws(() => appendTrainingExample(second, false), {message: /data repair/});
	const report = repairTrainingData();
	t.is(report.quarantined, 1);
	t.deepEqual(readFileSync(report.backupPath!), original);
	const row = JSON.parse(readFileSync(report.quarantinePath!, 'utf-8'));
	t.is(row.reason, 'Invalid UTF-8');
	t.deepEqual(Buffer.from(row.rawBase64, 'base64'), invalid);
	t.deepEqual(loadTrainingData(), [first]);
});

test.serial('a quarantine write failure after the backup is saved leaves the dataset unchanged', async t => {
	const original = `${line(first)}{`;
	writeFileSync(path, original);
	const failed = await execa(process.execPath, ['--import=tsx', '--input-type=module', '-e', `
		import fs from 'node:fs';
		import {syncBuiltinESMExports} from 'node:module';
		import {repairTrainingData} from ${JSON.stringify(dataModule)};
		process.chdir(${JSON.stringify(project)});
		const write = fs.writeFileSync;
		fs.writeFileSync = (file, ...options) => {
			if (String(file).includes('.quarantine.jsonl.tmp-')) throw new Error('quarantine write failed');
			return write(file, ...options);
		};
		syncBuiltinESMExports();
		repairTrainingData();
	`], {cwd: originalCwd, reject: false, timeout: 10000});
	t.is(failed.exitCode, 1);
	t.true(failed.stderr.includes('quarantine write failed'));
	t.is(readFileSync(path, 'utf-8'), original);
	const backups = readdirSync(join(dataDir, 'quarantine'));
	t.is(backups.length, 1);
	t.is(readFileSync(join(dataDir, 'quarantine', backups[0]), 'utf-8'), original);
});

test.serial('a journal publication failure occurs before the dataset is appended', async t => {
	writeFileSync(path, line(first));
	const failed = await execa(process.execPath, ['--import=tsx', '--input-type=module', '-e', `
		import fs from 'node:fs';
		import {syncBuiltinESMExports} from 'node:module';
		import {appendTrainingExample} from ${JSON.stringify(dataModule)};
		process.chdir(${JSON.stringify(project)});
		const write = fs.writeFileSync;
		fs.writeFileSync = (file, ...options) => {
			if (String(file).includes('.append-journal.json.tmp-')) throw new Error('journal write failed');
			return write(file, ...options);
		};
		syncBuiltinESMExports();
		appendTrainingExample(${JSON.stringify(second)}, false);
	`], {cwd: originalCwd, reject: false, timeout: 10000});
	t.is(failed.exitCode, 1);
	t.true(failed.stderr.includes('journal write failed'));
	t.is(readFileSync(path, 'utf-8'), line(first));
	t.false(existsSync(`${path}.append-journal.json`));
	t.false(readdirSync(dataDir).some(name => name.includes('.tmp-')));
});

test.serial('concurrent readers recover one crashed append without losing or duplicating records', async t => {
	writeFileSync(path, line(first));
	t.is((await crashAppend('partial')).exitCode, 42);
	const script = `
		import {loadTrainingData} from ${JSON.stringify(dataModule)};
		process.chdir(${JSON.stringify(project)});
		console.log(JSON.stringify(loadTrainingData()));
	`;
	const readers = await Promise.all(Array.from({length: 4}, () => execa(process.execPath, ['--import=tsx', '--input-type=module', '-e', script], {cwd: originalCwd, timeout: 10000})));
	for (const reader of readers) t.deepEqual(JSON.parse(reader.stdout), [first, second]);
	t.deepEqual(loadTrainingData(), [first, second]);
	t.false(existsSync(`${path}.append-journal.json`));
});

test.serial('journal content must be a complete example even when its checksum matches', t => {
	writeFileSync(path, line(first));
	const content = '{"broken":true}\n';
	writeFileSync(`${path}.append-journal.json`, JSON.stringify({version: 1, originalSize: Buffer.byteLength(line(first)), tail: Buffer.from(line(first)).toString('base64'), content, checksum: createHash('sha256').update(content).digest('hex')}));
	t.throws(() => recoverDatasetAppend(path), {message: /Invalid append journal/});
	t.is(readFileSync(path, 'utf-8'), line(first));
	t.true(existsSync(`${path}.append-journal.json`));
});
