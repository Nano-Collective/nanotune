import test from 'ava';
import {render} from 'ink-testing-library';
import {LossChart} from './LossChart.js';
import {Progress} from './Progress.js';

// --- Progress ---------------------------------------------------------------

test('Progress renders a bar of exactly the requested width', t => {
	const {lastFrame} = render(<Progress percent={50} width={10} />);
	const frame = lastFrame() ?? '';
	const filled = (frame.match(/█/g) ?? []).length;
	const empty = (frame.match(/░/g) ?? []).length;
	t.is(filled + empty, 10);
	t.is(filled, 5);
});

test('Progress clamps above 100', t => {
	// The clamp is the point: a caller computing percent from a ratio can
	// overshoot, and an unclamped bar would repeat() a negative count and throw.
	const {lastFrame} = render(<Progress percent={250} width={8} />);
	const frame = lastFrame() ?? '';
	t.is((frame.match(/█/g) ?? []).length, 8);
	t.is((frame.match(/░/g) ?? []).length, 0);
	t.true(frame.includes('100%'));
});

test('Progress clamps below 0', t => {
	const {lastFrame} = render(<Progress percent={-40} width={8} />);
	const frame = lastFrame() ?? '';
	t.is((frame.match(/█/g) ?? []).length, 0);
	t.is((frame.match(/░/g) ?? []).length, 8);
	t.true(frame.includes('0%'));
});

test('Progress rounds the percentage it prints', t => {
	const {lastFrame} = render(<Progress percent={66.6} width={10} />);
	t.true((lastFrame() ?? '').includes('67%'));
});

test('Progress shows a label only when given one', t => {
	const labelled = render(<Progress percent={10} label="Training" />);
	t.true((labelled.lastFrame() ?? '').includes('Training:'));

	const bare = render(<Progress percent={10} />);
	t.false((bare.lastFrame() ?? '').includes(':'));
});

// --- LossChart --------------------------------------------------------------

test('LossChart says so when there is no data', t => {
	const {lastFrame} = render(<LossChart data={[]} />);
	t.true((lastFrame() ?? '').includes('No data yet'));
});

test('LossChart uses the supplied label in both states', t => {
	const empty = render(<LossChart data={[]} label="Validation" />);
	t.true((empty.lastFrame() ?? '').includes('Validation: No data yet'));

	const withData = render(<LossChart data={[1, 2]} label="Validation" />);
	t.true((withData.lastFrame() ?? '').includes('Validation'));
});

test('LossChart labels the axis with the real min and max, to 2dp', t => {
	const {lastFrame} = render(<LossChart data={[0.5, 2.25, 1.125]} />);
	const frame = lastFrame() ?? '';
	t.true(frame.includes('2.25'), 'max');
	t.true(frame.includes('0.50'), 'min');
});

test('LossChart survives a flat series', t => {
	// max - min is 0 here, and the normaliser divides by it. The `|| 1` guard is
	// what stops every point becoming NaN and the chart rendering blank.
	const {lastFrame} = render(<LossChart data={[1.5, 1.5, 1.5]} height={4} />);
	const frame = lastFrame() ?? '';
	t.false(frame.includes('NaN'));
	t.true(frame.includes('1.50'));
	t.true(frame.includes('●'), 'still plots points');
});

test('LossChart handles a single point', t => {
	const {lastFrame} = render(<LossChart data={[0.75]} />);
	const frame = lastFrame() ?? '';
	t.false(frame.includes('NaN'));
	t.true(frame.includes('0.75'));
});

test('LossChart downsamples rather than overflowing its width', t => {
	// 200 points into a 20-wide chart: the sampling step keeps the rendered rows
	// bounded, which is what stops a long training run wrapping the terminal.
	const data = Array.from({length: 200}, (_, i) => 200 - i);
	const {lastFrame} = render(<LossChart data={data} width={20} height={5} />);
	const rows = (lastFrame() ?? '')
		.split('\n')
		.map(line => line.replace(/[^●│ ]/g, ''))
		.filter(line => line.includes('●') || line.includes('│'));
	t.true(rows.length > 0);
	for (const row of rows) {
		t.true(row.trim().length <= 25, `row too wide: ${row.length}`);
	}
});

test('LossChart draws one row per unit of height', t => {
	const data = [4, 3, 2, 1];
	const {lastFrame} = render(<LossChart data={data} height={6} width={10} />);
	const plotted = (lastFrame() ?? '')
		.split('\n')
		.filter(line => /[●│]/.test(line));
	// Every plotted row comes from the height loop, so there can never be more
	// of them than the height asked for.
	t.true(plotted.length <= 6);
	t.true(plotted.length > 0);
});

/**
 * The plot area sits inside a single-line border, and the border character is
 * the same U+2502 the chart uses to connect points — so a naive scan cannot
 * tell them apart. Take what is between the first and last one on each line.
 */
function plotArea(frame: string): (string | null)[] {
	return frame.split('\n').map(line => {
		const first = line.indexOf('│');
		const last = line.lastIndexOf('│');
		return first === -1 || last === first ? null : line.slice(first + 1, last);
	});
}

test('LossChart plots a descending series as a descending line', t => {
	// Loss going down is the thing a user watches for, so a chart drawn upside
	// down would be the worst bug this component could have — and it would still
	// render perfectly plausibly.
	const {lastFrame} = render(
		<LossChart data={[10, 5, 1]} height={5} width={10} />,
	);
	const rows = plotArea(lastFrame() ?? '');
	const rowOf = (column: number) =>
		rows.findIndex(row => row !== null && row[column] === '●');

	const highest = rowOf(0);
	const middle = rowOf(1);
	const lowest = rowOf(2);

	t.true(highest !== -1 && middle !== -1 && lowest !== -1, 'all three plotted');
	// Row 0 is the top of the chart, and the largest loss normalises to it.
	t.true(highest < middle, 'first point should sit above the second');
	t.true(middle < lowest, 'second point should sit above the third');
});

test('LossChart plots an ascending series the other way up', t => {
	const {lastFrame} = render(
		<LossChart data={[1, 5, 10]} height={5} width={10} />,
	);
	const rows = plotArea(lastFrame() ?? '');
	const rowOf = (column: number) =>
		rows.findIndex(row => row !== null && row[column] === '●');
	t.true(rowOf(0) > rowOf(2), 'rising loss should render bottom-left to top-right');
});
