import test from 'ava';
import {interactiveRequiredMessage, supportsRawMode} from './tty.js';

test('tty > supportsRawMode is true for a TTY stdin', t => {
	t.true(supportsRawMode({isTTY: true}));
});

test('tty > supportsRawMode is false for a piped stdin', t => {
	t.false(supportsRawMode({isTTY: false}));
});

test('tty > supportsRawMode is false when isTTY is undefined', t => {
	// Node leaves isTTY undefined (rather than false) for non-TTY streams, which
	// is exactly the case that used to blow up inside Ink.
	t.false(supportsRawMode({}));
});

test('tty > supportsRawMode requires a strict boolean true', t => {
	// Guard against a truthy-but-not-true value slipping through.
	t.false(supportsRawMode({isTTY: 1 as unknown as boolean}));
});

test('tty > interactiveRequiredMessage names the command', t => {
	const message = interactiveRequiredMessage('data add');
	t.true(message.includes('`nanotune data add`'));
});

test('tty > interactiveRequiredMessage explains the cause and the fix', t => {
	const message = interactiveRequiredMessage('chat');
	t.true(message.includes('not a TTY'));
	t.true(message.includes('terminal'));
});

test('tty > interactiveRequiredMessage is plain text, not a stack trace', t => {
	const message = interactiveRequiredMessage('init');
	t.false(message.includes('at '));
	t.true(message.split('\n').length <= 3);
});
