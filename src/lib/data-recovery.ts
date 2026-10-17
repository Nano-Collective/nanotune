import {isUtf8} from 'node:buffer';
import {createHash, randomUUID} from 'node:crypto';
import {
	appendFileSync,
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {z} from 'zod';
import {ChatMessageSchema} from '../types/index.js';
import {writeFileAtomic} from './config.js';
import {withDataLock} from './data-lock.js';

const TAIL_BYTES = 4096;
const ExampleSchema = z.object({messages: z.array(ChatMessageSchema)});

function isExampleRow(text: string): boolean {
	try {
		return ExampleSchema.safeParse(JSON.parse(text)).success;
	} catch {
		return false;
	}
}

const JournalSchema = z.object({
	version: z.literal(1),
	originalSize: z.int().nonnegative(),
	tail: z.string(),
	content: z
		.string()
		.refine(text => text.endsWith('\n') && isExampleRow(text.trim())),
	checksum: z.string(),
});

function journalPath(path: string): string {
	return `${path}.append-journal.json`;
}

function checksum(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

function syncFile(path: string, flags: 'r' | 'r+' = 'r+'): void {
	const fd = openSync(path, flags);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function syncDirectory(path: string): void {
	// Windows does not allow opening a directory as a normal file descriptor.
	if (process.platform === 'win32') return;
	syncFile(path, 'r');
}

function durableWrite(path: string, content: string | Uint8Array): void {
	writeFileAtomic(path, content, {flush: true});
	syncDirectory(dirname(path));
}

class InvalidAppendJournalError extends Error {
	constructor(path: string) {
		super(
			`Invalid append journal ${journalPath(path)}; dataset and journal were preserved. Run nanotune data repair${basename(path) === 'valid.jsonl' ? ' --eval' : ''} to back up both files and quarantine the invalid journal.`,
		);
	}
}

/** Caller holds the shared data lock, including throughout journal removal. */
function recover(path: string): boolean {
	const journal = journalPath(path);
	if (!existsSync(journal)) return false;
	const serialized = readFileSync(journal, 'utf-8');
	let raw: unknown;
	try {
		raw = JSON.parse(serialized);
	} catch {
		throw new InvalidAppendJournalError(path);
	}
	const parsed = JournalSchema.safeParse(raw);
	if (
		!parsed.success ||
		checksum(parsed.data.content) !== parsed.data.checksum
	) {
		throw new InvalidAppendJournalError(path);
	}
	const intent = parsed.data;
	const current = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
	const expected = Buffer.from(intent.content);
	const tailStart = Math.max(0, intent.originalSize - TAIL_BYTES);
	const tail = current
		.subarray(tailStart, intent.originalSize)
		.toString('base64');
	const suffix = current.subarray(intent.originalSize);
	if (
		current.length < intent.originalSize ||
		tail !== intent.tail ||
		suffix.length > expected.length ||
		!expected.subarray(0, suffix.length).equals(suffix)
	) {
		throw new Error(
			`Cannot recover ${path}: it changed after the append was journaled. Dataset and journal were preserved.`,
		);
	}
	if (!suffix.equals(expected)) {
		durableWrite(
			path,
			Buffer.concat([current.subarray(0, intent.originalSize), expected]),
		);
	} else {
		syncFile(path);
	}
	rmSync(journal);
	syncDirectory(dirname(path));
	return true;
}

/** Read paths recover only when a journal exists, avoiding a lock on normal reads. */
export function recoverDatasetAppend(path: string): boolean {
	if (!existsSync(journalPath(path))) return false;
	return withDataLock(() => recover(path));
}

function readBytes(fd: number, start: number, length: number): Buffer {
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const count = readSync(fd, buffer, offset, length - offset, start + offset);
		if (count === 0)
			throw new Error('Dataset changed while reading its append boundary.');
		offset += count;
	}
	return buffer;
}

/** Read just the last nonblank row, including rows larger than one buffer. */
function assertLastRow(fd: number, size: number, path: string): void {
	let position = size;
	let tail = Buffer.alloc(0);
	while (position > 0) {
		const start = Math.max(0, position - TAIL_BYTES);
		tail = Buffer.concat([readBytes(fd, start, position - start), tail]);
		position = start;
		let end = tail.length;
		while (end > 0) {
			if (tail[end - 1] === 0x0a) end--;
			const boundary = tail.lastIndexOf(0x0a, end - 1);
			if (boundary < 0 && position > 0) break;
			const row = tail.subarray(boundary + 1, end);
			const text = row.toString('utf-8').trim();
			if (!text) {
				end = Math.max(0, boundary);
				continue;
			}
			try {
				if (isUtf8(row) && ExampleSchema.safeParse(JSON.parse(text)).success)
					return;
			} catch {
				// A broken trailing row must be quarantined before adding new data.
			}
			throw new Error(
				`Malformed trailing row in ${basename(path)}. Run nanotune data repair${basename(path) === 'valid.jsonl' ? ' --eval' : ''} before appending.`,
			);
		}
	}
}

/** Write-ahead journal, flushed before the dataset is touched. */
export function appendDatasetRecord(path: string, content: string): void {
	if (!content.endsWith('\n') || !isExampleRow(content.trim())) {
		throw new Error(
			'Cannot append an invalid training example. Expected a messages array with string roles and content.',
		);
	}
	withDataLock(() => {
		recover(path);
		const fd = openSync(path, 'a+');
		try {
			const size = fstatSync(fd).size;
			assertLastRow(fd, size, path);
			const tail = readBytes(
				fd,
				Math.max(0, size - TAIL_BYTES),
				Math.min(size, TAIL_BYTES),
			);
			const appended = `${size > 0 && tail.at(-1) !== 0x0a ? '\n' : ''}${content}`;
			const journal = journalPath(path);
			durableWrite(
				journal,
				JSON.stringify({
					version: 1,
					originalSize: size,
					tail: tail.toString('base64'),
					content: appended,
					checksum: checksum(appended),
				}),
			);
			appendFileSync(fd, appended);
			fsyncSync(fd);
			rmSync(journal);
			syncDirectory(dirname(path));
		} finally {
			closeSync(fd);
		}
	});
}

export interface DataRepairReport {
	file: string;
	examples: number;
	quarantined: number;
	backupPath: string | null;
	quarantinePath: string | null;
	journalRecovered: boolean;
	journalQuarantinePath: string | null;
}

/** Preserve every original byte before quarantining malformed rows. */
export function repairDataset(path: string): DataRepairReport {
	return withDataLock(() => {
		let journalRecovered = false;
		let invalidJournal = false;
		try {
			journalRecovered = recover(path);
		} catch (error) {
			if (!(error instanceof InvalidAppendJournalError)) throw error;
			invalidJournal = true;
		}
		const report: DataRepairReport = {
			file: path,
			examples: 0,
			quarantined: 0,
			backupPath: null,
			quarantinePath: null,
			journalRecovered,
			journalQuarantinePath: null,
		};
		if (invalidJournal) {
			const quarantineDir = join(dirname(path), 'quarantine');
			mkdirSync(quarantineDir, {recursive: true});
			syncDirectory(dirname(path));
			const name = `${basename(path, '.jsonl')}-${randomUUID()}`;
			if (existsSync(path)) {
				report.backupPath = join(quarantineDir, `${name}.backup.jsonl`);
				durableWrite(report.backupPath, readFileSync(path));
			}
			report.journalQuarantinePath = join(
				quarantineDir,
				`${name}.append-journal.json`,
			);
			durableWrite(
				report.journalQuarantinePath,
				readFileSync(journalPath(path)),
			);
			// Both originals have durable backups before the journal is removed.
			rmSync(journalPath(path));
			syncDirectory(dirname(path));
		}
		if (!existsSync(path)) return report;
		const original = readFileSync(path);
		const kept: Buffer[] = [];
		const rejected: Array<{
			line: number;
			rawBase64: string;
			text: string;
			reason: string;
		}> = [];
		let start = 0;
		let line = 1;
		while (start < original.length) {
			const newline = original.indexOf(0x0a, start);
			const end = newline < 0 ? original.length : newline + 1;
			const raw = original.subarray(start, end);
			const text = raw.toString('utf-8').trim();
			let reason: string | null = null;
			if (!isUtf8(raw)) {
				reason = 'Invalid UTF-8';
			} else if (text) {
				try {
					if (ExampleSchema.safeParse(JSON.parse(text)).success)
						report.examples++;
					else reason = 'Invalid messages structure';
				} catch {
					reason = 'Invalid JSON';
				}
			}
			if (reason)
				rejected.push({
					line,
					rawBase64: raw.toString('base64'),
					text: raw.toString('utf-8'),
					reason,
				});
			else kept.push(raw);
			start = end;
			line++;
		}
		if (rejected.length === 0) return report;
		const quarantineDir = join(dirname(path), 'quarantine');
		mkdirSync(quarantineDir, {recursive: true});
		syncDirectory(dirname(path));
		const name = `${basename(path, '.jsonl')}-${randomUUID()}`;
		report.backupPath ??= join(quarantineDir, `${name}.backup.jsonl`);
		report.quarantinePath = join(quarantineDir, `${name}.quarantine.jsonl`);
		if (!invalidJournal) durableWrite(report.backupPath, original);
		durableWrite(
			report.quarantinePath,
			`${rejected.map(row => JSON.stringify(row)).join('\n')}\n`,
		);
		durableWrite(path, Buffer.concat(kept));
		report.quarantined = rejected.length;
		return report;
	});
}
