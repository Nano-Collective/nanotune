import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import type {ChatMessage, TrainingExample} from '../types/index.js';
import {getDataDir} from './config.js';

function ensureDataDir(): void {
	const dataDir = getDataDir();
	if (!existsSync(dataDir)) {
		mkdirSync(dataDir, {recursive: true});
	}
}

const TRAIN_FILE = 'train.jsonl';
const EVAL_FILE = 'valid.jsonl';

export function getTrainDataPath(): string {
	return join(getDataDir(), TRAIN_FILE);
}

export function getEvalDataPath(): string {
	return join(getDataDir(), EVAL_FILE);
}

export function countExamples(isEval = false): number {
	const path = isEval ? getEvalDataPath() : getTrainDataPath();
	if (!existsSync(path)) {
		return 0;
	}
	const content = readFileSync(path, 'utf-8').trim();
	if (!content) {
		return 0;
	}
	return content.split('\n').filter(line => line.trim()).length;
}

export function loadTrainingData(isEval = false): TrainingExample[] {
	const path = isEval ? getEvalDataPath() : getTrainDataPath();
	if (!existsSync(path)) {
		return [];
	}
	const content = readFileSync(path, 'utf-8').trim();
	if (!content) {
		return [];
	}
	return content
		.split('\n')
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as TrainingExample);
}

export function appendTrainingExample(
	example: TrainingExample,
	isEval = false,
): void {
	ensureDataDir();
	const path = isEval ? getEvalDataPath() : getTrainDataPath();
	const line = `${JSON.stringify(example)}\n`;
	appendFileSync(path, line);
}

export function appendToTrainingData(
	example: {
		/** Omitted, or empty, when the session has no system message — the
		 *  example is then just the user/assistant pair. */
		contextMessage?: ChatMessage | null;
		userInput: string;
		assistantOutput: string;
	},
	isEval = false,
): void {
	const {contextMessage} = example;
	const trainingExample: TrainingExample = {
		messages: [
			...(contextMessage?.content
				? [{role: contextMessage.role, content: contextMessage.content}]
				: []),
			{role: 'user', content: example.userInput},
			{role: 'assistant', content: example.assistantOutput},
		],
	};
	appendTrainingExample(trainingExample, isEval);
}

export function saveTrainingData(
	examples: TrainingExample[],
	isEval = false,
): void {
	ensureDataDir();
	const path = isEval ? getEvalDataPath() : getTrainDataPath();
	const content = `${examples.map(ex => JSON.stringify(ex)).join('\n')}\n`;
	writeFileSync(path, content);
}

export function deleteExample(index: number, isEval = false): void {
	const examples = loadTrainingData(isEval);
	if (index >= 0 && index < examples.length) {
		examples.splice(index, 1);
		saveTrainingData(examples, isEval);
	}
}

export function updateTrainingExample(
	index: number,
	example: TrainingExample,
	isEval = false,
): void {
	const examples = loadTrainingData(isEval);
	if (index >= 0 && index < examples.length) {
		examples[index] = example;
		saveTrainingData(examples, isEval);
	}
}

/**
 * Replaces the first user/assistant turn in `messages` with new content,
 * leaving every other message untouched — regardless of shape. Handles
 * examples missing a user and/or assistant message by inserting rather than
 * guessing a position, so malformed data is never silently dropped.
 */
export function mergeEditedTurn(
	messages: ChatMessage[],
	userInput: string,
	assistantOutput: string,
): ChatMessage[] {
	const userIdx = messages.findIndex(m => m.role === 'user');
	const assistantIdx = messages.findIndex(m => m.role === 'assistant');

	const updated = [...messages];
	if (userIdx >= 0) updated[userIdx] = {role: 'user', content: userInput};
	if (assistantIdx >= 0)
		updated[assistantIdx] = {role: 'assistant', content: assistantOutput};

	if (userIdx === -1 && assistantIdx === -1) {
		updated.push(
			{role: 'user', content: userInput},
			{role: 'assistant', content: assistantOutput},
		);
	} else if (userIdx === -1) {
		updated.splice(assistantIdx, 0, {role: 'user', content: userInput});
	} else if (assistantIdx === -1) {
		updated.splice(userIdx + 1, 0, {
			role: 'assistant',
			content: assistantOutput,
		});
	}
	return updated;
}

/**
 * Count the number of user/assistant turns in an example.
 * A turn is one user+assistant exchange pair.
 */
export function countTurns(example: TrainingExample): number {
	let turns = 0;
	for (const msg of example.messages) {
		if (msg.role === 'user') {
			turns++;
		}
	}
	return turns;
}

export interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

export function validateTrainingData(
	contextMessage: ChatMessage,
): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const examples = loadTrainingData();

	if (examples.length === 0) {
		errors.push('No training data found');
		return {valid: false, errors, warnings};
	}

	if (examples.length < 50) {
		warnings.push(
			`Only ${examples.length} examples found. Recommend at least 50 for good results.`,
		);
	}

	const seenInputs = new Set<string>();
	let duplicateCount = 0;
	let inconsistentPromptCount = 0;

	for (let i = 0; i < examples.length; i++) {
		const ex = examples[i];

		// Check structure
		if (!ex.messages || !Array.isArray(ex.messages)) {
			errors.push(
				`Example ${i + 1}: Invalid structure - missing messages array`,
			);
			continue;
		}

		if (ex.messages.length < 2) {
			errors.push(
				`Example ${i + 1}: Expected at least 2 messages, got ${ex.messages.length}`,
			);
			continue;
		}

		// Check all messages have role and content
		for (let j = 0; j < ex.messages.length; j++) {
			const msg = ex.messages[j];
			if (!msg.role) {
				errors.push(`Example ${i + 1}, message ${j + 1}: Missing role`);
			}
			if (!msg.content?.trim()) {
				errors.push(`Example ${i + 1}, message ${j + 1}: Empty content`);
			}
		}

		// Check for consecutive same-role messages (broken alternation)
		for (let j = 1; j < ex.messages.length; j++) {
			if (ex.messages[j].role === ex.messages[j - 1].role) {
				warnings.push(
					`Example ${i + 1}: Consecutive "${ex.messages[j].role}" messages at positions ${j} and ${j + 1}`,
				);
				break;
			}
		}

		// Check context message consistency (first message)
		const firstMsg = ex.messages[0];
		if (
			firstMsg.role !== contextMessage.role ||
			firstMsg.content !== contextMessage.content
		) {
			inconsistentPromptCount++;
		}

		// Check duplicates based on user-role messages
		const userMsg = ex.messages.find(m => m.role === 'user');
		const inputKey = userMsg?.content?.trim().toLowerCase();
		if (inputKey && seenInputs.has(inputKey)) {
			duplicateCount++;
		} else if (inputKey) {
			seenInputs.add(inputKey);
		}
	}

	if (inconsistentPromptCount > 0) {
		warnings.push(
			`${inconsistentPromptCount} examples have context messages that don't match config`,
		);
	}

	if (duplicateCount > 0) {
		warnings.push(`${duplicateCount} duplicate user inputs found`);
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

export interface DedupeResult {
	removedCount: number;
	/** 1-based positions (in the original file) that were removed. */
	removedIndexes: number[];
}

/**
 * Remove exact-duplicate examples: same messages (role + content, in order).
 * Deliberately stricter than validateTrainingData's duplicate warning (which
 * only compares the first user message) — removal must be provably safe, so
 * two examples that merely share the same input but differ in output or
 * context message are left alone.
 */
export function dedupeExamples(isEval = false): DedupeResult {
	const examples = loadTrainingData(isEval);
	const seen = new Set<string>();
	const kept: TrainingExample[] = [];
	const removedIndexes: number[] = [];

	examples.forEach((ex, i) => {
		const key = JSON.stringify(
			ex.messages.map(m => ({role: m.role, content: m.content})),
		);
		if (seen.has(key)) {
			removedIndexes.push(i + 1);
			return;
		}
		seen.add(key);
		kept.push(ex);
	});

	if (removedIndexes.length > 0) {
		saveTrainingData(kept, isEval);
	}

	return {removedCount: removedIndexes.length, removedIndexes};
}

export interface ContextFixResult {
	fixedCount: number;
}

/**
 * Rewrite each example's context message (messages[0]) to match the given
 * contextMessage, but only when a context message already exists. Never
 * inserts one where the example starts with a user message, since that
 * would change the example's shape rather than just fix a mismatch.
 */
export function fixContextMessages(
	contextMessage: ChatMessage,
	isEval = false,
): ContextFixResult {
	const examples = loadTrainingData(isEval);
	let fixedCount = 0;

	const updated = examples.map(ex => {
		const first = ex.messages[0];
		if (!first || first.role === 'user' || first.role === 'assistant') {
			return ex;
		}
		if (first.role === contextMessage.role && first.content === contextMessage.content) {
			return ex;
		}
		fixedCount++;
		return {
			messages: [
				{role: contextMessage.role, content: contextMessage.content},
				...ex.messages.slice(1),
			],
		};
	});

	if (fixedCount > 0) {
		saveTrainingData(updated, isEval);
	}

	return {fixedCount};
}

export interface ImportResult {
	imported: number;
	skipped: number;
	errors: string[];
}

/**
 * Parse a CSV file into an array of row arrays. Supports:
 *  - Quoted fields with embedded commas, newlines, and escaped quotes ("")
 *  - Unquoted fields
 *  - A leading UTF-8 BOM, as written by Excel and other spreadsheet tools
 *  - CRLF or LF line endings
 */
export function parseCSV(content: string): string[][] {
	const rows: string[][] = [];
	let field = '';
	let row: string[] = [];
	let inQuotes = false;
	let i = content.startsWith('\uFEFF') ? 1 : 0;

	while (i < content.length) {
		const ch = content[i];

		if (inQuotes) {
			if (ch === '"') {
				if (content[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += ch;
			i++;
			continue;
		}

		if (ch === '"') {
			inQuotes = true;
			i++;
			continue;
		}

		if (ch === ',') {
			row.push(field);
			field = '';
			i++;
			continue;
		}

		if (ch === '\r' && content[i + 1] === '\n') {
			row.push(field);
			rows.push(row);
			field = '';
			row = [];
			i += 2;
			continue;
		}

		if (ch === '\n' || ch === '\r') {
			row.push(field);
			rows.push(row);
			field = '';
			row = [];
			i++;
			continue;
		}

		field += ch;
		i++;
	}

	// Flush any trailing field/row
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	// Drop trailing entirely-empty rows (file ended with newline)
	while (rows.length > 0) {
		const last = rows[rows.length - 1];
		if (last.length === 1 && last[0] === '') {
			rows.pop();
		} else {
			break;
		}
	}

	return rows;
}

export function importFromCSV(
	filePath: string,
	contextMessage: ChatMessage,
): ImportResult {
	const errors: string[] = [];
	let imported = 0;
	let skipped = 0;

	const content = readFileSync(filePath, 'utf-8');
	const rows = parseCSV(content);

	if (rows.length === 0) {
		return {imported, skipped, errors};
	}

	// Skip the first row only when it is exactly the two column names. Matching
	// loosely — by substring, or on either column alone — silently drops real
	// rows such as `"explain the input parameter","..."` or `"input","a value"`.
	const firstRowLower = rows[0].map(c => c.trim().toLowerCase());
	const hasHeader =
		firstRowLower.length >= 2 &&
		firstRowLower[0] === 'input' &&
		firstRowLower[1] === 'output';
	const startIndex = hasHeader ? 1 : 0;

	for (let i = startIndex; i < rows.length; i++) {
		const row = rows[i];
		if (row.length < 2) {
			errors.push(`Line ${i + 1}: Expected 2 columns (input, output)`);
			skipped++;
			continue;
		}

		const input = row[0];
		const output = row[1];
		if (!input?.trim() || !output?.trim()) {
			errors.push(`Line ${i + 1}: Empty input or output`);
			skipped++;
			continue;
		}

		appendToTrainingData({
			contextMessage,
			userInput: input.trim(),
			assistantOutput: output.trim(),
		});
		imported++;
	}

	return {imported, skipped, errors};
}

export function importFromJSONL(
	filePath: string,
	contextMessage: ChatMessage,
): ImportResult {
	const errors: string[] = [];
	let imported = 0;
	let skipped = 0;

	const content = readFileSync(filePath, 'utf-8');
	const lines = content.split('\n').filter(line => line.trim());

	for (let i = 0; i < lines.length; i++) {
		try {
			const data = JSON.parse(lines[i]);

			// Preferred format: existing messages array — preserve verbatim.
			if (data.messages && Array.isArray(data.messages)) {
				if (data.messages.length >= 2) {
					const userMsg = data.messages.find(
						(m: ChatMessage) => m.role === 'user',
					);
					const assistantMsg = data.messages.find(
						(m: ChatMessage) => m.role === 'assistant',
					);

					if (userMsg?.content && assistantMsg?.content) {
						appendTrainingExample({messages: data.messages}, false);
						imported++;
						continue;
					}
				}

				errors.push(`Line ${i + 1}: messages array missing user/assistant`);
				skipped++;
				continue;
			}

			// Simple {input, output} format — wrap with the project context.
			if (data.input && data.output) {
				appendToTrainingData({
					contextMessage,
					userInput: data.input,
					assistantOutput: data.output,
				});
				imported++;
				continue;
			}

			errors.push(`Line ${i + 1}: Unrecognized format`);
			skipped++;
		} catch {
			errors.push(`Line ${i + 1}: Invalid JSON`);
			skipped++;
		}
	}

	return {imported, skipped, errors};
}

export function importFromJSON(
	filePath: string,
	contextMessage: ChatMessage,
): ImportResult {
	const errors: string[] = [];
	let imported = 0;
	let skipped = 0;

	const content = readFileSync(filePath, 'utf-8');
	const data = JSON.parse(content);

	if (!Array.isArray(data)) {
		return {imported: 0, skipped: 1, errors: ['Expected JSON array']};
	}

	for (let i = 0; i < data.length; i++) {
		const item = data[i];

		// Preferred format: existing messages array — preserve verbatim.
		if (item.messages && Array.isArray(item.messages)) {
			const userMsg = item.messages.find((m: ChatMessage) => m.role === 'user');
			const assistantMsg = item.messages.find(
				(m: ChatMessage) => m.role === 'assistant',
			);

			if (userMsg?.content && assistantMsg?.content) {
				appendTrainingExample({messages: item.messages}, false);
				imported++;
				continue;
			}

			errors.push(`Item ${i + 1}: messages array missing user/assistant`);
			skipped++;
			continue;
		}

		if (item.input && item.output) {
			appendToTrainingData({
				contextMessage,
				userInput: item.input,
				assistantOutput: item.output,
			});
			imported++;
			continue;
		}

		errors.push(`Item ${i + 1}: Unrecognized format`);
		skipped++;
	}

	return {imported, skipped, errors};
}

export function importData(
	filePath: string,
	contextMessage: ChatMessage,
): ImportResult {
	if (!existsSync(filePath)) {
		return {imported: 0, skipped: 0, errors: ['File not found']};
	}

	const ext = filePath.toLowerCase().split('.').pop();

	switch (ext) {
		case 'csv':
			return importFromCSV(filePath, contextMessage);
		case 'jsonl':
			return importFromJSONL(filePath, contextMessage);
		case 'json':
			return importFromJSON(filePath, contextMessage);
		default:
			return {
				imported: 0,
				skipped: 0,
				errors: [`Unsupported file format: ${ext}`],
			};
	}
}

export interface ExportResult {
	exported: number;
	skipped: number;
	errors: string[];
}

export function exportToJSONL(filePath: string, isEval = false): ExportResult {
	const examples = loadTrainingData(isEval);
	const content = examples.map(ex => JSON.stringify(ex)).join('\n');
	writeFileSync(filePath, examples.length > 0 ? `${content}\n` : '');
	return {exported: examples.length, skipped: 0, errors: []};
}

export function exportToJSON(filePath: string, isEval = false): ExportResult {
	const examples = loadTrainingData(isEval);
	writeFileSync(filePath, `${JSON.stringify(examples, null, 2)}\n`);
	return {exported: examples.length, skipped: 0, errors: []};
}

function csvEscape(value: string): string {
	if (/[",\r\n]/.test(value)) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

/**
 * CSV can only represent a single input/output pair per row, with no room
 * for a context message. Multi-turn examples are skipped (not truncated) so
 * that exporting then re-importing never silently drops turns.
 */
export function exportToCSV(filePath: string, isEval = false): ExportResult {
	const examples = loadTrainingData(isEval);
	const rows: string[] = ['input,output'];
	let exported = 0;
	let skipped = 0;
	const errors: string[] = [];

	examples.forEach((ex, i) => {
		if (countTurns(ex) > 1) {
			skipped++;
			errors.push(
				`Example ${i + 1}: multi-turn example cannot be represented in CSV, skipped`,
			);
			return;
		}

		const user = ex.messages.find(m => m.role === 'user');
		const assistant = ex.messages.find(m => m.role === 'assistant');
		if (!user?.content || !assistant?.content) {
			skipped++;
			errors.push(`Example ${i + 1}: missing user or assistant message, skipped`);
			return;
		}

		rows.push(`${csvEscape(user.content)},${csvEscape(assistant.content)}`);
		exported++;
	});

	writeFileSync(filePath, `${rows.join('\n')}\n`);
	return {exported, skipped, errors};
}

export function exportData(filePath: string, isEval = false): ExportResult {
	const ext = filePath.toLowerCase().split('.').pop();

	switch (ext) {
		case 'csv':
			return exportToCSV(filePath, isEval);
		case 'jsonl':
			return exportToJSONL(filePath, isEval);
		case 'json':
			return exportToJSON(filePath, isEval);
		default:
			return {
				exported: 0,
				skipped: 0,
				errors: [`Unsupported file format: ${ext}`],
			};
	}
}

/**
 * Mulberry32: small, fast, 32-bit seedable PRNG. Used so train/valid splits
 * are reproducible across runs when a seed is provided.
 */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** In-place Fisher-Yates shuffle. Returns the same array for chaining. */
function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

/**
 * Split training data into train and validation sets.
 * MLX requires a valid.jsonl file for training.
 * @param validationRatio - Portion of data to use for validation (default 10%)
 * @param seed - Optional seed for a reproducible split.
 */
export function splitTrainValidation(
	validationRatio = 0.1,
	seed?: number,
): {trainCount: number; validCount: number} {
	const allExamples = loadTrainingData();

	if (allExamples.length === 0) {
		return {trainCount: 0, validCount: 0};
	}

	const rng = seed === undefined ? Math.random : mulberry32(seed);
	const shuffled = shuffleInPlace([...allExamples], rng);

	// Calculate split - minimum 1 validation example if we have at least 2 total
	const validCount = Math.max(
		allExamples.length >= 2 ? 1 : 0,
		Math.floor(allExamples.length * validationRatio),
	);
	const trainCount = allExamples.length - validCount;

	const trainExamples = shuffled.slice(0, trainCount);
	const validExamples = shuffled.slice(trainCount);

	// Save both files
	saveTrainingData(trainExamples, false);
	saveTrainingData(validExamples, true);

	return {trainCount, validCount};
}

/**
 * Ensure validation set exists. If not, split from training data.
 */
export function ensureValidationSet(seed?: number): {
	trainCount: number;
	validCount: number;
} {
	const validCount = countExamples(true);
	const trainCount = countExamples(false);

	if (validCount === 0 && trainCount > 0) {
		// No validation set - create one by splitting
		return splitTrainValidation(0.1, seed);
	}

	return {trainCount, validCount};
}
