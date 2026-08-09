import test from 'ava';
import {
	assertSupportedPlatform,
	isSupportedPlatform,
	unsupportedPlatformMessage,
} from './platform.js';

test('platform > Apple Silicon macOS is supported', t => {
	t.true(isSupportedPlatform({platform: 'darwin', arch: 'arm64'}));
});

test('platform > Intel macOS is not supported', t => {
	t.false(isSupportedPlatform({platform: 'darwin', arch: 'x64'}));
});

test('platform > Linux arm64 is not supported', t => {
	t.false(isSupportedPlatform({platform: 'linux', arch: 'arm64'}));
});

test('platform > Windows is not supported', t => {
	t.false(isSupportedPlatform({platform: 'win32', arch: 'x64'}));
});

test('platform > message reports what was actually detected', t => {
	const message = unsupportedPlatformMessage({
		platform: 'linux',
		arch: 'x64',
	});
	t.true(message.includes('linux/x64'));
	t.true(message.includes('Apple Silicon'));
});

test('platform > assert throws on unsupported hardware', t => {
	const error = t.throws(() =>
		assertSupportedPlatform({platform: 'linux', arch: 'x64'}),
	);
	t.true(error?.message.includes('linux/x64'));
});

test('platform > assert is a no-op on supported hardware', t => {
	t.notThrows(() => {
		assertSupportedPlatform({platform: 'darwin', arch: 'arm64'});
	});
});
