import test from 'ava';
import {render} from 'ink-testing-library';
import {TrainingDone} from './TrainingDone.js';

function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI.
	return text.replace(/\u001B\[[0-9;]*m/g, '').replace(/\s+/g, ' ');
}

function frameOf(
	progress: Parameters<typeof TrainingDone>[0]['progress'],
): string {
	const instance = render(<TrainingDone progress={progress} />);
	const output = stripAnsi(instance.frames.join('\n'));
	instance.unmount();
	return output;
}

const base = {iteration: 20, totalIterations: 100};

test('a restored early stop names the checkpoint and offers export', t => {
	const frame = frameOf({
		...base,
		earlyStopped: true,
		restoredBest: true,
		bestIteration: 100,
		bestValLoss: 0.8,
		trainLoss: 1.2,
	});
	t.true(frame.includes('Stopped early'));
	t.true(frame.includes('Validation loss stopped improving.'));
	t.true(frame.includes('Restored checkpoint at iteration 100'));
	t.true(frame.includes('0.8000'));
	t.true(frame.includes('nanotune export'));
	t.false(frame.includes('last saved adapter was kept'));
	t.false(frame.includes('Final loss'));
});

test('an early stop with nothing saved does not offer export', t => {
	const frame = frameOf({
		...base,
		earlyStopped: true,
		restoredBest: false,
		trainLoss: 1.2,
	});
	t.true(frame.includes('Stopped early'));
	t.true(frame.includes('last saved adapter was kept'));
	t.false(frame.includes('nanotune export'));
	t.false(frame.includes('Final loss'));
});

test('a finished run shows the final loss and offers export', t => {
	const frame = frameOf({...base, trainLoss: 0.42});
	t.true(frame.includes('Training complete!'));
	t.true(frame.includes('Final loss'));
	t.true(frame.includes('0.4200'));
	t.true(frame.includes('nanotune export'));
	t.false(frame.includes('Stopped early'));
});
