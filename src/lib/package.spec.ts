import {readFileSync} from 'node:fs';
import test from 'ava';

const packageJson = JSON.parse(
	readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {files: string[]};

test('publishes runtime files without compiled specs', t => {
	t.deepEqual(packageJson.files, [
		'dist',
		'!dist/**/*.spec.*',
		'README.md',
		'LICENSE.md',
		'CHANGELOG.md',
	]);
});
