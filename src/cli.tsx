#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {Command} from 'commander';
import {render} from 'ink';
import type {ReactElement} from 'react';
import {interactiveRequiredMessage, supportsRawMode} from './lib/tty.js';

const pkg = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
) as {version: string};

/**
 * Render a command that cannot work without a keyboard (prompts, menus, the
 * chat REPL). Without a TTY we print one clear line instead of letting Ink
 * throw "Raw mode is not supported" and spray a React stack trace.
 */
function renderInteractive(name: string, node: ReactElement): void {
	if (!supportsRawMode()) {
		console.error(interactiveRequiredMessage(name));
		process.exitCode = 1;
		return;
	}
	render(node);
}

const program = new Command();

program
	.name('nanotune')
	.description(
		'A simple, interactive CLI for fine-tuning small language models on Apple Silicon. No YAML configs, no complex flags - just an interactive CLI that guides you through the process. ⚒️',
	)
	.version(pkg.version);

// Init command
program
	.command('init')
	.description('Initialize a new fine-tuning project')
	.action(async () => {
		const {InitCommand} = await import('./commands/init.js');
		renderInteractive('init', <InitCommand />);
	});

// Data commands
const dataCommand = program.command('data').description('Manage training data');

dataCommand
	.command('add')
	.description('Interactively add training examples')
	.action(async () => {
		const {DataAddCommand} = await import('./commands/data/add.js');
		renderInteractive('data add', <DataAddCommand />);
	});

dataCommand
	.command('import <file>')
	.description('Import training data from file (JSONL, CSV, or JSON)')
	.option('-y, --yes', 'Skip the confirmation prompt (for scripts and CI)')
	.action(async (file: string, options: {yes?: boolean}) => {
		const {DataImportCommand} = await import('./commands/data/import.js');
		// Without a TTY there is no way to answer the prompt, so require --yes.
		if (!options.yes && !supportsRawMode()) {
			console.error(interactiveRequiredMessage('data import'));
			console.error('Pass --yes to import without confirmation.');
			process.exitCode = 1;
			return;
		}
		render(<DataImportCommand file={file} yes={options.yes} />);
	});

dataCommand
	.command('export <file>')
	.description('Export training data to file (JSONL, CSV, or JSON)')
	.option('-y, --yes', 'Skip the overwrite confirmation prompt (for scripts and CI)')
	.action(async (file: string, options: {yes?: boolean}) => {
		const {DataExportCommand} = await import('./commands/data/export.js');
		// Without a TTY there is no way to answer the overwrite prompt, so require --yes.
		if (!options.yes && !supportsRawMode()) {
			console.error(interactiveRequiredMessage('data export'));
			console.error('Pass --yes to export without confirmation.');
			process.exitCode = 1;
			return;
		}
		render(<DataExportCommand file={file} yes={options.yes} />);
	});

dataCommand
	.command('list')
	.alias('ls')
	.description('View training data')
	.action(async () => {
		const {DataListCommand} = await import('./commands/data/list.js');
		renderInteractive('data list', <DataListCommand />);
	});

dataCommand
	.command('validate')
	.description('Validate training data format and quality')
	.option('--fix', 'Remove exact-duplicate examples')
	.option(
		'--rewrite-context',
		"Rewrite each example's context message to match the current config",
	)
	.action(async (options: {fix?: boolean; rewriteContext?: boolean}) => {
		const {DataValidateCommand} = await import('./commands/data/validate.js');
		render(
			<DataValidateCommand
				fix={options.fix}
				rewriteContext={options.rewriteContext}
			/>,
		);
	});

// Train command
program
	.command('train')
	.description('Train the model with LoRA fine-tuning')
	.option('-i, --iterations <n>', 'Number of training iterations')
	.option('--lr <rate>', 'Learning rate')
	.option('--resume', 'Resume from last checkpoint')
	.option('--dry-run', 'Validate config without training')
	.action(async options => {
		const {TrainCommand} = await import('./commands/train.js');
		render(<TrainCommand options={options} />);
	});

// Export command
program
	.command('export')
	.description('Export trained model to GGUF format')
	.option(
		'-q, --quantization <type>',
		'Quantization type (f16, q8_0, q4_k_m, q4_k_s)',
	)
	.option('-o, --output <name>', 'Output filename')
	.option('--skip-fuse', 'Skip adapter fusion (if already fused)')
	.action(async options => {
		const {ExportCommand} = await import('./commands/export.js');
		render(<ExportCommand options={options} />);
	});

// Benchmark command
program
	.command('benchmark')
	.description('Run benchmarks against a test dataset')
	.option('-m, --model <path>', 'Path to model file')
	.option('-d, --dataset <path>', 'Path to benchmark dataset')
	.option('-t, --timeout <ms>', 'Timeout per test in milliseconds')
	.option(
		'--preset <name>',
		'Hardware preset: low, medium, high, or ultra (overrides individual flags)',
	)
	.option('--threads <n>', 'Number of CPU threads to use (default: auto)')
	.option(
		'--gpu-layers <n>',
		'Number of GPU layers to offload (default: auto/max)',
	)
	.option('--ctx-size <n>', 'Context size in tokens (default: 4096)')
	.option(
		'--batch-size <n>',
		'Batch size for prompt processing (default: 2048)',
	)
	.option('--cpu-only', 'Disable GPU and use CPU only')
	.option(
		'--max-tokens <n>',
		'Maximum tokens to generate per test (default: 50)',
	)
	.option('--temperature <n>', 'Sampling temperature (default: 0.8)')
	.option('--seed <n>', 'Random seed for reproducibility')
	.action(async options => {
		const {BenchmarkCommand} = await import('./commands/benchmark.js');
		render(<BenchmarkCommand options={options} />);
	});

// Chat command
program
	.command('chat')
	.description('Chat with an exported model in an interactive REPL')
	.option('-m, --model <path>', 'Path to GGUF file (default: latest export)')
	.option('-s, --system <text>', "Override the project's system message")
	.option(
		'--preset <name>',
		'Hardware preset: low, medium, high, or ultra (overrides individual flags)',
	)
	.option('--threads <n>', 'Number of CPU threads to use (default: auto)')
	.option(
		'--gpu-layers <n>',
		'Number of GPU layers to offload (default: auto/max)',
	)
	.option('--ctx-size <n>', 'Context size in tokens (default: 4096)')
	.option(
		'--batch-size <n>',
		'Batch size for prompt processing (default: 2048)',
	)
	.option('--cpu-only', 'Disable GPU and use CPU only')
	.option(
		'--max-tokens <n>',
		'Maximum tokens to generate per reply (default: 256)',
	)
	.option('--temperature <n>', 'Sampling temperature (default: 0.8)')
	.option('--top-p <n>', 'Top-p sampling (default: 0.9)')
	.option('--seed <n>', 'Random seed for reproducibility')
	.action(async options => {
		const {ChatCommand} = await import('./commands/chat.js');
		renderInteractive('chat', <ChatCommand options={options} />);
	});

// Judge commands
const judgeCommand = program
	.command('judge')
	.description('Configure and test the LLM judge');

judgeCommand
	.command('configure')
	.description('Set up the LLM provider for judge evaluations')
	.action(async () => {
		const {JudgeConfigureCommand} = await import('./commands/judge.js');
		renderInteractive('judge configure', <JudgeConfigureCommand />);
	});

judgeCommand
	.command('test')
	.description('Test the configured LLM judge with a sample evaluation')
	.action(async () => {
		const {JudgeTestCommand} = await import('./commands/judge.js');
		render(<JudgeTestCommand />);
	});

// Status command
program
	.command('status')
	.description('Show current project status')
	.action(async () => {
		const {StatusCommand} = await import('./commands/status.js');
		render(<StatusCommand />);
	});

program.parse();
