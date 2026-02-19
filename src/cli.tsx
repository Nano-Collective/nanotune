#!/usr/bin/env node
import {Command} from 'commander';
import {render} from 'ink';

const program = new Command();

program
	.name('nanotune')
	.description(
		'A simple, interactive CLI for fine-tuning small language models on Apple Silicon. No YAML configs, no complex flags - just an interactive CLI that guides you through the process. ⚒️',
	)
	.version('1.0.0');

// Init command
program
	.command('init')
	.description('Initialize a new fine-tuning project')
	.action(async () => {
		const {InitCommand} = await import('./commands/init.js');
		render(<InitCommand />);
	});

// Data commands
const dataCommand = program.command('data').description('Manage training data');

dataCommand
	.command('add')
	.description('Interactively add training examples')
	.action(async () => {
		const {DataAddCommand} = await import('./commands/data/add.js');
		render(<DataAddCommand />);
	});

dataCommand
	.command('import <file>')
	.description('Import training data from file (JSONL, CSV, or JSON)')
	.action(async (file: string) => {
		const {DataImportCommand} = await import('./commands/data/import.js');
		render(<DataImportCommand file={file} />);
	});

dataCommand
	.command('list')
	.alias('ls')
	.description('View training data')
	.action(async () => {
		const {DataListCommand} = await import('./commands/data/list.js');
		render(<DataListCommand />);
	});

dataCommand
	.command('validate')
	.description('Validate training data format and quality')
	.action(async () => {
		const {DataValidateCommand} = await import('./commands/data/validate.js');
		render(<DataValidateCommand />);
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

// Judge commands
const judgeCommand = program
	.command('judge')
	.description('Configure and test the LLM judge');

judgeCommand
	.command('configure')
	.description('Set up the LLM provider for judge evaluations')
	.action(async () => {
		const {JudgeConfigureCommand} = await import('./commands/judge.js');
		render(<JudgeConfigureCommand />);
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
