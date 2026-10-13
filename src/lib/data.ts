import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import type {ChatMessage, TrainingExample} from '../types/index.js';
import {
	getDataDir,
	loadConfig,
	resolveContextMessage,
	writeFileAtomic,
} from './config.js';
import {
	assertValidRatio,
	buildLeakGroups,
	contentFingerprint,
	displayBucketKey,
	fingerprintSet,
	majorityBucket,
	mulberry32,
	normalizeTags,
	type StratifyResult,
	shuffleInPlace,
	stratifyGroups,
	validTarget,
} from './stratified-split.js';

function ensureDataDir(): void {
	const dataDir = getDataDir();
	if (!existsSync(dataDir)) {
		mkdirSync(dataDir, {recursive: true});
	}
}

const TRAIN_FILE = 'train.jsonl';
const EVAL_FILE = 'valid.jsonl';
const SPLIT_MANIFEST_FILE = '.split-manifest.json';

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

export interface ParsedTrainingData {
	examples: TrainingExample[];
	/** One `Example N: invalid JSON` per unparseable line, in file order. */
	errors: string[];
}

/**
 * Read the dataset without throwing, collecting unparseable lines as errors
 * instead. `data validate` exists to find malformed training data, so it has
 * to survive encountering some and report the offending line like any other
 * check; the same goes for `data list`, which renders whatever it can.
 */
export function parseTrainingData(isEval = false): ParsedTrainingData {
	const examples: TrainingExample[] = [];
	const errors: string[] = [];
	const path = isEval ? getEvalDataPath() : getTrainDataPath();
	if (!existsSync(path)) {
		return {examples, errors};
	}
	const content = readFileSync(path, 'utf-8').trim();
	if (!content) {
		return {examples, errors};
	}
	const lines = content.split('\n').filter(line => line.trim());
	lines.forEach((line, i) => {
		try {
			examples.push(JSON.parse(line) as TrainingExample);
		} catch {
			errors.push(`Example ${i + 1}: invalid JSON`);
		}
	});
	return {examples, errors};
}

/**
 * Every example, or a throw naming the first bad line. Kept strict because
 * the mutating helpers load, transform and write the whole file back, so
 * quietly skipping a line here would delete it on the next save.
 */
export function loadTrainingData(isEval = false): TrainingExample[] {
	const {examples, errors} = parseTrainingData(isEval);
	if (errors.length > 0) {
		throw new Error(errors[0]);
	}
	return examples;
}

/**
 * `isEval` is required — never defaulted — on every helper that writes into the
 * dataset: a caller that forgets it silently appends to, or overwrites, the
 * wrong file. Read-only helpers keep the `isEval = false` default, where a
 * missing flag shows the wrong set but destroys nothing.
 */
export function appendTrainingExample(
	example: TrainingExample,
	isEval: boolean,
): void {
	ensureDataDir();
	const path = isEval ? getEvalDataPath() : getTrainDataPath();
	const line = `${JSON.stringify(example)}\n`;
	appendFileSync(path, line);
}

/**
 * Attach a file's `tags` to an example, dropping the key entirely when there
 * are none.
 *
 * The key is set rather than merged into the messages array, so an example
 * that never had tags keeps the exact bytes it always had: export,
 * re-import and `git diff` all stay quiet for datasets that predate tags.
 */
function withTags(example: TrainingExample, tags: unknown): TrainingExample {
	const display = normalizeTags(tags).display;
	if (display.length === 0) return example;
	return {...example, tags: display};
}

export function appendToTrainingData(
	example: {
		/** Omitted, or empty, when the session has no system message — the
		 *  example is then just the user/assistant pair. */
		contextMessage?: ChatMessage | null;
		userInput: string;
		assistantOutput: string;
		/** Category labels, for stratifying the train/validation split. Omitted
		 *  entirely when there are none, so an untagged dataset keeps its bytes. */
		tags?: string[];
	},
	isEval: boolean,
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
	const tags = normalizeTags(example.tags).display;
	if (tags.length > 0) {
		trainingExample.tags = tags;
	}
	appendTrainingExample(trainingExample, isEval);
}

export function saveTrainingData(
	examples: TrainingExample[],
	isEval: boolean,
): void {
	ensureDataDir();
	const path = isEval ? getEvalDataPath() : getTrainDataPath();
	const content = `${examples.map(ex => JSON.stringify(ex)).join('\n')}\n`;
	writeFileAtomic(path, content);
}

export function deleteExample(index: number, isEval: boolean): void {
	const examples = loadTrainingData(isEval);
	if (index >= 0 && index < examples.length) {
		examples.splice(index, 1);
		saveTrainingData(examples, isEval);
	}
}

export function updateTrainingExample(
	index: number,
	example: TrainingExample,
	isEval: boolean,
): void {
	const examples = loadTrainingData(isEval);
	if (index >= 0 && index < examples.length) {
		examples[index] = example;
		saveTrainingData(examples, isEval);
	}
}

/**
 * Locates the `turnIndex`-th turn's user/assistant message positions.
 * A turn is the Nth `user` message and the first `assistant` message
 * following it, up to (but not including) the next `user` message —
 * matching the pairing `countTurns` counts. Throws for a turn index past
 * the last existing turn, so every caller shares one definition of
 * "valid turn" rather than guessing independently.
 */
function turnBounds(
	messages: ChatMessage[],
	turnIndex: number,
): {userIdx: number; assistantIdx: number} {
	const userIndices: number[] = [];
	messages.forEach((m, i) => {
		if (m.role === 'user') userIndices.push(i);
	});

	if (turnIndex > 0 && turnIndex >= userIndices.length) {
		throw new Error(`Turn ${turnIndex + 1} does not exist`);
	}

	const userIdx = turnIndex < userIndices.length ? userIndices[turnIndex] : -1;
	const searchEnd =
		userIdx >= 0
			? (userIndices[turnIndex + 1] ?? messages.length)
			: (userIndices[0] ?? messages.length);

	let assistantIdx = -1;
	for (let i = userIdx >= 0 ? userIdx + 1 : 0; i < searchEnd; i++) {
		if (messages[i].role === 'assistant') {
			assistantIdx = i;
			break;
		}
	}
	return {userIdx, assistantIdx};
}

/**
 * Reads the current content of the `turnIndex`-th turn, for prefilling an
 * edit form. A missing user/assistant message in that turn reads back as
 * an empty string.
 */
export function getTurnContent(
	messages: ChatMessage[],
	turnIndex: number,
): {userContent: string; assistantContent: string} {
	const {userIdx, assistantIdx} = turnBounds(messages, turnIndex);
	return {
		userContent: userIdx >= 0 ? messages[userIdx].content : '',
		assistantContent: assistantIdx >= 0 ? messages[assistantIdx].content : '',
	};
}

/**
 * Reads every turn's content in one pass, for populating a turn picker
 * without re-scanning `messages` once per turn.
 */
export function getAllTurnsContent(
	messages: ChatMessage[],
): Array<{userContent: string; assistantContent: string}> {
	const userIndices: number[] = [];
	messages.forEach((m, i) => {
		if (m.role === 'user') userIndices.push(i);
	});

	return userIndices.map((userIdx, turnIndex) => {
		const searchEnd = userIndices[turnIndex + 1] ?? messages.length;
		let assistantContent = '';
		for (let i = userIdx + 1; i < searchEnd; i++) {
			if (messages[i].role === 'assistant') {
				assistantContent = messages[i].content;
				break;
			}
		}
		return {userContent: messages[userIdx].content, assistantContent};
	});
}

/**
 * Replaces the `turnIndex`-th user/assistant turn in `messages` with new
 * content, leaving every other turn untouched — regardless of shape.
 * Handles a turn missing a user and/or assistant message by inserting
 * rather than guessing a position, so malformed data is never silently
 * dropped.
 */
export function mergeEditedTurn(
	messages: ChatMessage[],
	turnIndex: number,
	userInput: string,
	assistantOutput: string,
): ChatMessage[] {
	const {userIdx, assistantIdx} = turnBounds(messages, turnIndex);

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
	/**
	 * The counts behind the duplicate and context-message warnings above.
	 *
	 * Both the Ink view and `--json` derive their per-check verdicts from these
	 * rather than pattern-matching the warning text, so rewording a warning can
	 * no longer silently flip a check.
	 */
	duplicateInputs: number;
	inconsistentContextMessages: number;
}

export function validateTrainingData(
	contextMessage: ChatMessage,
	isEval = false,
): ValidationResult {
	const warnings: string[] = [];
	const {examples, errors} = parseTrainingData(isEval);

	if (examples.length === 0) {
		// "No data" would be a lie when the file is full of lines we could not
		// parse - the parse errors already say what is wrong.
		if (errors.length === 0) {
			errors.push(
				isEval ? 'No validation data found' : 'No training data found',
			);
		}
		return {
			valid: false,
			errors,
			warnings,
			duplicateInputs: 0,
			inconsistentContextMessages: 0,
		};
	}

	// A validation set is a slice of the training data, so the 50-example floor
	// does not apply to it - warning about it would be noise on a correct split.
	if (!isEval && examples.length < 50) {
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
		duplicateInputs: duplicateCount,
		inconsistentContextMessages: inconsistentPromptCount,
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
export function dedupeExamples(isEval: boolean): DedupeResult {
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
	isEval: boolean,
): ContextFixResult {
	const examples = loadTrainingData(isEval);
	let fixedCount = 0;

	const updated = examples.map(ex => {
		const first = ex.messages[0];
		if (!first || first.role === 'user' || first.role === 'assistant') {
			return ex;
		}
		if (
			first.role === contextMessage.role &&
			first.content === contextMessage.content
		) {
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

/** Counts of the repairs `--fix` and `--rewrite-context` actually made. */
export interface ValidationFixes {
	duplicatesRemoved: number;
	contextMessagesRewritten: number;
}

/** The per-check verdicts `nanotune data validate` reports. */
export interface ValidationChecks {
	/** True when the set holds at least one example. */
	dataFileExists: boolean;
	validJsonStructure: boolean;
	contextMessageConsistency: boolean;
	noDuplicateInputs: boolean;
	/** Always true for a validation set — the 50-example floor is a training-set rule. */
	minimumExampleCount: boolean;
	/**
	 * True when no example appears in both train.jsonl and valid.jsonl.
	 *
	 * Only meaningful for the train set, where both files are in scope: a
	 * validation set cannot overlap itself. A duplicated example across the two
	 * makes the validation loss measure memorization of a string the model was
	 * just trained on, which reads as a better model and is not one.
	 */
	noTrainValidOverlap: boolean;
}

/** Everything `nanotune data validate` reports, as data. */
export interface ValidationReport {
	set: 'train' | 'eval';
	examples: number;
	valid: boolean;
	errors: string[];
	warnings: string[];
	checks: ValidationChecks;
	/** Null unless `--fix` or `--rewrite-context` ran. */
	fixes: ValidationFixes | null;
}

export interface ValidationOptions {
	/** Remove exact-duplicate examples before validating. */
	fix?: boolean;
	/** Rewrite mismatched context messages before validating. */
	rewriteContext?: boolean;
	isEval?: boolean;
}

/**
 * Compared by content fingerprint, the same normalization the split groups by,
 * so a pair that differs only in case or punctuation still counts: that is
 * exactly the pair whose validation loss tells you nothing.
 *
 * Uses the lenient parser rather than `loadTrainingData`, which throws on a
 * malformed line. A validation command that dies on the very problem it exists
 * to report cannot report anything else either.
 */
export function countTrainValidOverlap(): number {
	const train = new Set(
		parseTrainingData(false).examples.map(contentFingerprint),
	);
	if (train.size === 0) {
		return 0;
	}

	const seen = new Set<string>();
	let overlap = 0;
	for (const example of parseTrainingData(true).examples) {
		const fingerprint = contentFingerprint(example);
		// Count distinct examples, not repeats within valid.jsonl.
		if (seen.has(fingerprint)) continue;
		seen.add(fingerprint);
		if (train.has(fingerprint)) {
			overlap++;
		}
	}
	return overlap;
}

/**
 * Apply any requested fixes, then validate, and report both. Shared by the Ink
 * view and `--json` so the two cannot report different verdicts.
 *
 * Reads the project config itself, so it throws the same "Not a Nanotune
 * project" error `loadConfig` does when run outside a project.
 */
export function collectValidation({
	fix = false,
	rewriteContext = false,
	isEval = false,
}: ValidationOptions = {}): ValidationReport {
	const contextMessage = resolveContextMessage(loadConfig());

	// Rewrite context first: examples that only become identical after context
	// normalization must still be caught by dedupe in this pass.
	const contextFix = rewriteContext
		? fixContextMessages(contextMessage, isEval)
		: null;
	const dedupe = fix ? dedupeExamples(isEval) : null;

	// Count and validate after the fixes, so the report describes the data
	// actually left on disk rather than the state it was in on entry.
	const examples = countExamples(isEval);
	const result = validateTrainingData(contextMessage, isEval);
	const overlap = isEval ? 0 : countTrainValidOverlap();

	if (overlap > 0) {
		result.warnings.push(
			`${overlap} example${overlap === 1 ? '' : 's'} appear in both train.jsonl and valid.jsonl — validation loss will measure memorization, not generalization`,
		);
	}

	return {
		set: isEval ? 'eval' : 'train',
		examples,
		valid: result.valid,
		errors: result.errors,
		warnings: result.warnings,
		checks: {
			dataFileExists: examples > 0,
			validJsonStructure: result.errors.length === 0,
			contextMessageConsistency: result.inconsistentContextMessages === 0,
			noDuplicateInputs: result.duplicateInputs === 0,
			// A validation set is a slice of the training data, so the 50-example
			// floor does not apply to it — matching the rule `validateTrainingData`
			// already uses when deciding whether to warn.
			minimumExampleCount: isEval || examples >= 50,
			noTrainValidOverlap: overlap === 0,
		},
		fixes:
			contextFix || dedupe
				? {
						duplicatesRemoved: dedupe?.removedCount ?? 0,
						contextMessagesRewritten: contextFix?.fixedCount ?? 0,
					}
				: null,
	};
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

export interface ImportCSVOptions {
	/**
	 * Treat row 0 as data unconditionally, skipping header auto-detection.
	 * Needed when a headerless file's first data row is itself literally
	 * "input","output" — otherwise indistinguishable from a real header.
	 */
	headerless?: boolean;
}

export function importFromCSV(
	filePath: string,
	contextMessage: ChatMessage,
	isEval: boolean,
	options: ImportCSVOptions = {},
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
	// `options.headerless` bypasses this entirely for callers who already know
	// the file has no header, since a literal "input","output" data row is
	// otherwise indistinguishable from a real header.
	const firstRowLower = rows[0].map(c => c.trim().toLowerCase());
	const hasHeader =
		!options.headerless &&
		firstRowLower.length >= 2 &&
		firstRowLower[0] === 'input' &&
		firstRowLower[1] === 'output';
	const startIndex = hasHeader ? 1 : 0;
	// Read only when present, so every two-column CSV in the wild keeps
	// importing exactly as it did.
	const tagsIndex = 2;

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

		appendToTrainingData(
			{
				contextMessage,
				userInput: input.trim(),
				assistantOutput: output.trim(),
				tags: splitTagCell(row[tagsIndex]),
			},
			isEval,
		);
		imported++;
	}

	return {imported, skipped, errors};
}

export function importFromJSONL(
	filePath: string,
	contextMessage: ChatMessage,
	isEval: boolean,
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
						appendTrainingExample(
							withTags({messages: data.messages}, data.tags),
							isEval,
						);
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
				appendToTrainingData(
					{
						contextMessage,
						userInput: data.input,
						assistantOutput: data.output,
						tags: normalizeTags(data.tags).display,
					},
					isEval,
				);
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
	isEval: boolean,
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
				appendTrainingExample(
					withTags({messages: item.messages}, item.tags),
					isEval,
				);
				imported++;
				continue;
			}

			errors.push(`Item ${i + 1}: messages array missing user/assistant`);
			skipped++;
			continue;
		}

		if (item.input && item.output) {
			appendToTrainingData(
				{
					contextMessage,
					userInput: item.input,
					assistantOutput: item.output,
					tags: normalizeTags(item.tags).display,
				},
				isEval,
			);
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
	isEval: boolean,
	csvOptions: ImportCSVOptions = {},
): ImportResult {
	if (!existsSync(filePath)) {
		return {imported: 0, skipped: 0, errors: ['File not found']};
	}

	const ext = filePath.toLowerCase().split('.').pop();

	switch (ext) {
		case 'csv':
			return importFromCSV(filePath, contextMessage, isEval, csvOptions);
		case 'jsonl':
			return importFromJSONL(filePath, contextMessage, isEval);
		case 'json':
			return importFromJSON(filePath, contextMessage, isEval);
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
 * A semicolon inside a cell is the separator, not a comma: a comma is the
 * column delimiter, so a tag containing one would already have had to be
 * escaped by the writer, and re-splitting on it here would turn a single
 * tag into two that never existed.
 */
function splitTagCell(cell: string | undefined): string[] {
	if (!cell) return [];
	return cell
		.split(';')
		.map(tag => tag.trim())
		.filter(tag => tag.length > 0);
}

/**
 * CSV can only represent a single input/output pair per row, with no room
 * for a context message. Multi-turn examples are skipped (not truncated) so
 * that exporting then re-importing never silently drops turns.
 */
export function exportToCSV(filePath: string, isEval = false): ExportResult {
	const examples = loadTrainingData(isEval);
	// The tags column appears only when something has tags. An untagged dataset
	// exports to the same two columns it always has, so a round-trip through a
	// user's spreadsheet or script keeps working untouched.
	const hasTags = examples.some(
		ex => normalizeTags(ex?.tags).display.length > 0,
	);
	const rows: string[] = [hasTags ? 'input,output,tags' : 'input,output'];
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
			errors.push(
				`Example ${i + 1}: missing user or assistant message, skipped`,
			);
			return;
		}

		const cells = [csvEscape(user.content), csvEscape(assistant.content)];
		if (hasTags) {
			const tags = normalizeTags(ex?.tags).display;
			// Joined on ";" rather than "," because "," is the column delimiter
			// here, and a tag containing one would need its own quoting on the
			// way out and its own re-splitting on the way back in.
			cells.push(csvEscape(tags.join(';')));
		}
		rows.push(cells.join(','));
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
 * `auto` stratifies when the dataset carries categories and falls back to a
 * random split when it does not, which is every dataset written before this.
 * `on` asks for stratification and reports why when there was none to do.
 * `off` restores the old behaviour outright.
 */
export type StratifyMode = 'auto' | 'on' | 'off';

export interface SplitBucket {
	/** Normalized category name, safe to print. */
	category: string;
	total: number;
	validation: number;
}

export interface SplitResult {
	trainCount: number;
	validCount: number;
	/**
	 * `stratified` when categories drove the split, `random` when there was
	 * nothing to stratify on, and `unstratifiable` when the categories were too
	 * fine-grained to mean anything. Reported so `nanotune train` can say which
	 * it did rather than implying a stratified split that never happened.
	 */
	strategy: 'stratified' | 'random' | 'unstratifiable';
	/** In split order. Empty unless stratified. */
	buckets: SplitBucket[];
	/**
	 * Categories the validation set could not cover at this ratio. Named rather
	 * than quietly left out, since a rare category absent from validation is the
	 * whole problem this exists to solve.
	 */
	unrepresentedCategories: string[];
	/**
	 * Validation examples the ratio asked for that near-duplicate grouping made
	 * impossible to fill. Zero unless the dataset holds duplicates.
	 */
	shortfall: number;
}

/** Everything one pass over the dataset produces, reused by both split paths. */
interface DatasetLayout {
	/** Near-duplicate groups, as example indexes. */
	groups: number[][];
	/** The category each group is filed under, indexed by group. */
	bucketOfGroup: string[];
	/** Every example's own category, indexed by example. */
	bucketOfExample: string[];
}

/**
 * MLX requires a valid.jsonl file for training, so one has to exist.
 */
export function splitTrainValidation(
	validationRatio = 0.1,
	seed?: number,
	stratify: StratifyMode = 'auto',
): SplitResult {
	// Before anything is read or written. A NaN ratio reaches `slice(0, NaN)`,
	// which is the empty array, and writes train.jsonl empty; a ratio of 1
	// reaches `slice(0, -1)` one line later and drops an example. Both are
	// unrecoverable once the rename lands, so they fail here instead.
	assertValidRatio(validationRatio);

	const allExamples = loadTrainingData();

	if (allExamples.length === 0) {
		return emptySplitResult();
	}

	const rng = seed === undefined ? Math.random : mulberry32(seed);
	const layout = describeDataset(allExamples);

	let split;
	if (stratify === 'off') {
		split = legacyRandomSplit(allExamples, validationRatio, rng);
	} else {
		const plan = stratifyGroups(
			layout.groups,
			layout.bucketOfGroup,
			validationRatio,
			rng,
		);
		// No usable categories. Still group-aware: near-duplicate leakage has
		// nothing to do with stratification, and an untagged dataset is exactly
		// where a duplicated pair is most likely to sit on both sides.
		split = plan.fallback
			? groupedRandomSplit(allExamples, layout, validationRatio, rng)
			: stratifiedSplit(allExamples, layout, plan, rng);
	}

	const {trainExamples, validExamples, result} = split;

	// The last line of defence before a rewrite. Both writes replace a whole
	// file, so a bug that drops or duplicates an example is not a wrong number
	// in a report — it is a user's training data deleted, with no copy
	// anywhere, the moment the atomic rename succeeds. Both sides are compared
	// against the input by content fingerprint, which catches a dropped example
	// and a duplicated one alike. Everything needed is already in memory, so
	// this costs one pass over the data.
	assertSplitIsAPermutation(allExamples, trainExamples, validExamples);

	// Write valid.jsonl before truncating train.jsonl. Each write is atomic
	// (writeFileAtomic), so the only interruption window left is between the
	// two calls - and with this order that window's worst case is both files
	// temporarily containing the validation examples (a recoverable
	// duplicate), never train.jsonl losing them before they land anywhere.
	saveTrainingData(validExamples, true);
	saveTrainingData(trainExamples, false);

	// Recorded only once both writes have landed, so the manifest can never
	// describe a split that did not happen.
	const validationFingerprint = fingerprintSet(validExamples);
	const previous = readSplitManifest();
	writeSplitManifest({
		version: 1,
		createdAt: new Date().toISOString(),
		...(seed === undefined ? {} : {seed}),
		validationRatio,
		stratify,
		strategy: result.strategy,
		trainCount: result.trainCount,
		validCount: result.validCount,
		validationFingerprint,
		...(previous && previous.validationFingerprint !== validationFingerprint
			? {replacedValidationFingerprint: previous.validationFingerprint}
			: {}),
	});

	return result;
}

/**
 * Taking the tail of the shuffled array is what the original implementation
 * did, so this reproduces its output exactly. It does not keep near-duplicates
 * together — that is what `--stratify off` is for.
 */
function legacyRandomSplit(
	allExamples: TrainingExample[],
	validationRatio: number,
	rng: () => number,
): {
	trainExamples: TrainingExample[];
	validExamples: TrainingExample[];
	result: SplitResult;
} {
	const shuffled = shuffleInPlace([...allExamples], rng);
	const validCount = validTarget(allExamples.length, validationRatio);
	const trainCount = allExamples.length - validCount;

	return {
		trainExamples: shuffled.slice(0, trainCount),
		validExamples: shuffled.slice(trainCount),
		result: {
			trainCount,
			validCount,
			strategy: 'random',
			buckets: [],
			unrepresentedCategories: [],
			shortfall: 0,
		},
	};
}

/**
 * Walks the shuffled order from the end — the same end the legacy split took
 * from — taking whole leak groups and skipping any group that would overshoot
 * the budget. On a dataset with no duplicates every group is one example, so
 * this reduces to the legacy selection byte for byte; grouping only changes the
 * answer where there was something to group.
 */
function groupedRandomSplit(
	allExamples: TrainingExample[],
	layout: DatasetLayout,
	validationRatio: number,
	rng: () => number,
): {
	trainExamples: TrainingExample[];
	validExamples: TrainingExample[];
	result: SplitResult;
} {
	// Shuffling indexes rather than examples produces the same permutation for
	// the same seed — both start from the identity order — so this stays
	// reproducible while still knowing which group each example belongs to.
	const order = shuffleInPlace(
		allExamples.map((_, index) => index),
		rng,
	);
	const {groupOfExample, groupSize} = indexGroups(allExamples.length, layout);

	const wanted = validTarget(allExamples.length, validationRatio);
	const heldOut = new Array<boolean>(allExamples.length).fill(false);
	const takenGroups = new Set<number>();
	let held = 0;

	for (let i = order.length - 1; i >= 0 && held < wanted; i--) {
		const index = order[i];
		const group = groupOfExample[index];
		if (takenGroups.has(group)) continue;
		if (held + groupSize[group] > wanted) continue;
		takenGroups.add(group);
		heldOut[index] = true;
		held += groupSize[group];
	}

	const validExamples = allExamples.filter((_, index) => heldOut[index]);
	const trainExamples = allExamples.filter((_, index) => !heldOut[index]);

	return {
		trainExamples,
		validExamples,
		result: {
			trainCount: trainExamples.length,
			validCount: validExamples.length,
			strategy: 'random',
			buckets: [],
			unrepresentedCategories: [],
			shortfall: wanted - held,
		},
	};
}

function indexGroups(
	exampleCount: number,
	layout: DatasetLayout,
): {groupOfExample: number[]; groupSize: number[]} {
	const groupOfExample = new Array<number>(exampleCount);
	const groupSize = layout.groups.map(indexes => indexes.length);
	layout.groups.forEach((indexes, group) => {
		for (const index of indexes) groupOfExample[index] = group;
	});
	return {groupOfExample, groupSize};
}

/**
 * Near-duplicate grouping comes first because a group is held out or kept as a
 * unit, so it has to be settled before any category is given a budget.
 */
function describeDataset(allExamples: TrainingExample[]): DatasetLayout {
	const bucketOfExample = allExamples.map(
		example => normalizeTags(example?.tags).bucket,
	);
	const groups = buildLeakGroups(allExamples.map(contentFingerprint));
	const bucketOfGroup = groups.map(indexes =>
		majorityBucket(indexes.map(index => bucketOfExample[index])),
	);
	return {groups, bucketOfGroup, bucketOfExample};
}

function stratifiedSplit(
	allExamples: TrainingExample[],
	layout: DatasetLayout,
	plan: StratifyResult,
	rng: () => number,
): {
	trainExamples: TrainingExample[];
	validExamples: TrainingExample[];
	result: SplitResult;
} {
	const {groupOfExample} = indexGroups(allExamples.length, layout);

	const heldOutIndexesByBucket = new Map<string, number[]>();
	for (const index of plan.validIndexes) {
		const key = layout.bucketOfGroup[groupOfExample[index]];
		const bucket = heldOutIndexesByBucket.get(key);
		if (bucket) bucket.push(index);
		else heldOutIndexesByBucket.set(key, [index]);
	}

	// Which groups were held out is already decided — `stratifyGroups` used the
	// rng for that, and shuffling the chosen set afterwards would have nothing
	// left to decide.
	const heldOut = new Array<boolean>(allExamples.length).fill(false);
	for (const bucket of heldOutIndexesByBucket.values()) {
		for (const index of bucket) {
			heldOut[index] = true;
		}
	}

	// Filtered in file order rather than concatenated from the shuffle, so both
	// files keep reading in the order the user wrote them.
	const validExamples = allExamples.filter((_, index) => heldOut[index]);
	const trainExamples = allExamples.filter((_, index) => !heldOut[index]);

	return {
		trainExamples,
		validExamples,
		result: {
			trainCount: trainExamples.length,
			validCount: validExamples.length,
			strategy: 'stratified',
			buckets: plan.buckets.map(bucket => ({
				category: displayBucketKey(bucket.key),
				total: bucket.size,
				validation: bucket.valid,
			})),
			unrepresentedCategories: plan.unrepresentedBuckets.map(displayBucketKey),
			shortfall: plan.shortfall,
		},
	};
}

/**
 * Every write here replaces a whole file, so an off-by-one in the allocation
 * is not a wrong number in a report — it is a user's training data deleted,
 * with no copy anywhere, the moment the atomic rename succeeds.
 */
function assertSplitIsAPermutation(
	allExamples: TrainingExample[],
	trainExamples: TrainingExample[],
	validExamples: TrainingExample[],
): void {
	const expected = allExamples.map(contentFingerprint).sort();
	const actual = [...trainExamples, ...validExamples]
		.map(contentFingerprint)
		.sort();

	if (expected.length === actual.length) {
		if (expected.every((fingerprint, index) => fingerprint === actual[index])) {
			return;
		}
		throw new Error(
			'Refusing to write the split: the same example would land in both train.jsonl and valid.jsonl. Nothing was written.',
		);
	}

	throw new Error(
		`Refusing to write the split: ${expected.length} examples in, ${actual.length} out. Nothing was written.`,
	);
}

function emptySplitResult(): SplitResult {
	return {
		trainCount: 0,
		validCount: 0,
		strategy: 'random',
		buckets: [],
		unrepresentedCategories: [],
		shortfall: 0,
	};
}

/**
 * The problem this exists for: a user trains, gets a validation loss, deletes
 * valid.jsonl and re-splits, trains again, and compares the two numbers. They
 * were measured against different held-out data, so the comparison is
 * meaningless — and nothing on screen says so, because each run in isolation
 * looked perfectly normal.
 */
export interface SplitManifest {
	version: 1;
	/** ISO timestamp, for saying *when* the set changed. */
	createdAt: string;
	seed?: number;
	validationRatio: number;
	stratify: StratifyMode;
	strategy: SplitResult['strategy'];
	trainCount: number;
	validCount: number;
	/** Digest of the held-out examples. Order-independent. */
	validationFingerprint: string;
	/**
	 * Digest of the validation set this split replaced, when it replaced a
	 * different one.
	 *
	 * Without this the second split simply overwrites the record of the first,
	 * which erases the evidence at the exact moment it is needed: a user trains,
	 * gets a number, re-splits, trains again, and compares the two as if they
	 * were measured against the same data.
	 */
	replacedValidationFingerprint?: string;
}

function getSplitManifestPath(): string {
	return join(getDataDir(), SPLIT_MANIFEST_FILE);
}

/**
 * Lenient on purpose: a corrupt or hand-edited manifest is not worth failing a
 * training run over. It only ever adds a warning, and losing the warning is
 * better than losing the run.
 */
export function readSplitManifest(): SplitManifest | null {
	const path = getSplitManifestPath();
	if (!existsSync(path)) {
		return null;
	}
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SplitManifest;
		if (
			parsed?.version !== 1 ||
			typeof parsed.validationFingerprint !== 'string'
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function writeSplitManifest(manifest: SplitManifest): void {
	// Best effort by design: the split itself has already succeeded and the
	// dataset is on disk. Failing to record what we did must not undo that, and
	// must not fail the run either.
	try {
		ensureDataDir();
		writeFileAtomic(
			getSplitManifestPath(),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
	} catch {
		// Nothing to do: the warning below simply will not appear next time.
	}
}

/**
 * Returns `null` when there is nothing to say: no manifest, or a validation
 * set that still matches the one the split chose.
 */
export function describeValidationSetDrift(): string | null {
	const manifest = readSplitManifest();
	if (!manifest) {
		return null;
	}

	const current = parseTrainingData(true).examples;
	if (current.length === 0) {
		return null;
	}

	const when = new Date(manifest.createdAt);
	const stamp = Number.isNaN(when.getTime())
		? ''
		: ` on ${when.toISOString().slice(0, 10)}`;

	// Re-split first. The file matching this manifest proves only that nothing
	// has touched valid.jsonl since; it says nothing about the set it replaced.
	if (
		manifest.replacedValidationFingerprint !== undefined &&
		manifest.replacedValidationFingerprint !== manifest.validationFingerprint
	) {
		return (
			`The validation set was re-split${stamp}. Evaluation numbers from earlier ` +
			'runs were measured against different data and are not comparable.'
		);
	}

	if (fingerprintSet(current) === manifest.validationFingerprint) {
		return null;
	}

	return (
		`The validation set has changed since the last split${stamp}. ` +
		'Evaluation numbers from earlier runs were measured against different data and are not comparable.'
	);
}

/**
 * Ensure validation set exists. If not, split from training data.
 */
export function ensureValidationSet(
	seed?: number,
	stratify: StratifyMode = 'auto',
	validationRatio = 0.1,
): SplitResult & {didSplit: boolean} {
	const validCount = countExamples(true);
	const trainCount = countExamples(false);

	if (validCount === 0 && trainCount > 0) {
		// No validation set - create one by splitting.
		const result = splitTrainValidation(validationRatio, seed, stratify);
		// A single example cannot be split, so valid.jsonl stays empty and the
		// next call lands here again. Reporting didSplit for that no-op would
		// repeat "Split 1 examples into 1 train / 0 validation." on every run.
		return {...result, didSplit: result.validCount > 0};
	}

	return {...emptySplitResult(), trainCount, validCount, didSplit: false};
}

/**
 * Clamp a paginated list's page/selection to what still exists after items are
 * removed, so deleting the last row on the last page falls back to the
 * previous page instead of stranding the user on an empty one.
 */
export function clampPagination(
	total: number,
	page: number,
	selectedIndex: number,
	pageSize: number,
): {page: number; selectedIndex: number} {
	const nextPage = Math.min(page, Math.max(0, Math.ceil(total / pageSize) - 1));
	const pageCount = Math.min(pageSize, total - nextPage * pageSize);
	return {
		page: nextPage,
		selectedIndex: Math.max(0, Math.min(selectedIndex, pageCount - 1)),
	};
}
