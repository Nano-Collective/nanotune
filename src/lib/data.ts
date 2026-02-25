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

export function appendToTrainingData(
	example: {
		contextMessage: ChatMessage;
		userInput: string;
		assistantOutput: string;
	},
	isEval = false,
): void {
	ensureDataDir();
	const path = isEval ? getEvalDataPath() : getTrainDataPath();
	const trainingExample: TrainingExample = {
		messages: [
			{
				role: example.contextMessage.role,
				content: example.contextMessage.content,
			},
			{role: 'user', content: example.userInput},
			{role: 'assistant', content: example.assistantOutput},
		],
	};
	const line = `${JSON.stringify(trainingExample)}\n`;
	appendFileSync(path, line);
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

export function updateExample(
	index: number,
	example: {
		contextMessage: ChatMessage;
		userInput: string;
		assistantOutput: string;
	},
	isEval = false,
): void {
	const examples = loadTrainingData(isEval);
	if (index >= 0 && index < examples.length) {
		examples[index] = {
			messages: [
				{
					role: example.contextMessage.role,
					content: example.contextMessage.content,
				},
				{role: 'user', content: example.userInput},
				{role: 'assistant', content: example.assistantOutput},
			],
		};
		saveTrainingData(examples, isEval);
	}
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

export interface ImportResult {
	imported: number;
	skipped: number;
	errors: string[];
}

export function importFromCSV(
	filePath: string,
	contextMessage: ChatMessage,
): ImportResult {
	const errors: string[] = [];
	let imported = 0;
	let skipped = 0;

	const content = readFileSync(filePath, 'utf-8');
	const lines = content.split('\n').filter(line => line.trim());

	// Skip header if present
	const hasHeader =
		lines[0]?.toLowerCase().includes('input') ||
		lines[0]?.toLowerCase().includes('output');
	const startIndex = hasHeader ? 1 : 0;

	for (let i = startIndex; i < lines.length; i++) {
		const line = lines[i];
		// Simple CSV parsing (handles quoted fields)
		const match = line.match(/^"?([^"]*)"?,\s*"?([^"]*)"?$/);
		if (!match) {
			errors.push(`Line ${i + 1}: Invalid CSV format`);
			skipped++;
			continue;
		}

		const [, input, output] = match;
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

			// Check if it's already in the right format
			if (data.messages && Array.isArray(data.messages)) {
				if (data.messages.length >= 2) {
					const userMsg = data.messages.find(
						(m: ChatMessage) => m.role === 'user',
					);
					const assistantMsg = data.messages.find(
						(m: ChatMessage) => m.role === 'assistant',
					);

					if (userMsg?.content && assistantMsg?.content) {
						appendToTrainingData({
							contextMessage,
							userInput: userMsg.content,
							assistantOutput: assistantMsg.content,
						});
						imported++;
						continue;
					}
				}
			}

			// Check for simple input/output format
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

		if (item.messages && Array.isArray(item.messages)) {
			const userMsg = item.messages.find((m: ChatMessage) => m.role === 'user');
			const assistantMsg = item.messages.find(
				(m: ChatMessage) => m.role === 'assistant',
			);

			if (userMsg?.content && assistantMsg?.content) {
				appendToTrainingData({
					contextMessage,
					userInput: userMsg.content,
					assistantOutput: assistantMsg.content,
				});
				imported++;
				continue;
			}
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

/**
 * Split training data into train and validation sets.
 * MLX requires a valid.jsonl file for training.
 * @param validationRatio - Portion of data to use for validation (default 10%)
 */
export function splitTrainValidation(validationRatio = 0.1): {
	trainCount: number;
	validCount: number;
} {
	const allExamples = loadTrainingData();

	if (allExamples.length === 0) {
		return {trainCount: 0, validCount: 0};
	}

	// Shuffle examples for random split
	const shuffled = [...allExamples].sort(() => Math.random() - 0.5);

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
export function ensureValidationSet(): {
	trainCount: number;
	validCount: number;
} {
	const _validPath = getEvalDataPath();
	const validCount = countExamples(true);
	const trainCount = countExamples(false);

	if (validCount === 0 && trainCount > 0) {
		// No validation set - create one by splitting
		return splitTrainValidation();
	}

	return {trainCount, validCount};
}
