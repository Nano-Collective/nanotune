import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {AddressInfo, Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {downloadToFile, fetchJson} from './download.js';
import {HttpError} from './retry.js';

async function endpoint(respond: (req: IncomingMessage, res: ServerResponse) => void) {
	const sockets = new Set<Socket>();
	const server = createServer(respond);
	server.on('connection', socket => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}

test('release metadata retries HTTP failures and preserves request headers', async t => {
	let calls = 0;
	const delays: number[] = [];
	const server = await endpoint((req, res) => {
		t.is(req.headers.accept, 'application/vnd.github.v3+json');
		res.writeHead(++calls < 3 ? 502 : 200, {'content-type': 'application/json'});
		res.end(calls < 3 ? 'unavailable' : '{"tag_name":"b123"}');
	});
	try {
		t.deepEqual(await fetchJson(server.url, {headers: {Accept: 'application/vnd.github.v3+json'}}, {
			sleep: async ms => {delays.push(ms);},
		}), {tag_name: 'b123'});
		t.is(calls, 3);
		t.deepEqual(delays, [1000, 2000]);
	} finally {await server.close();}
});

test('metadata retries a socket reset after successful response headers', async t => {
	let calls = 0;
	const server = await endpoint((_req, res) => {
		if (++calls === 1) {
			res.writeHead(200, {'content-length': '1000'});
			res.write('{"tag_name":');
			setTimeout(() => res.destroy(), 10);
		} else {res.end('{"tag_name":"b123"}');}
	});
	try {
		t.deepEqual(await fetchJson(server.url, undefined, {sleep: async () => {}}), {tag_name: 'b123'});
		t.is(calls, 2);
	} finally {await server.close();}
});

test('malformed release JSON fails immediately', async t => {
	let calls = 0;
	const server = await endpoint((_req, res) => {calls++; res.end('not json');});
	try {
		await t.throwsAsync(fetchJson(server.url), {instanceOf: SyntaxError});
		t.is(calls, 1);
	} finally {await server.close();}
});

test('a retried stream replaces partial bytes and publishes only on success', async t => {
	const dir = mkdtempSync(join(tmpdir(), 'nanotune-download-'));
	const dest = join(dir, 'script.py');
	writeFileSync(dest, 'old script');
	let calls = 0;
	const server = await endpoint((_req, res) => {
		if (++calls === 1) {
			res.writeHead(200, {'content-length': '1000'});
			res.write('partial bytes that must not remain');
			setTimeout(() => res.destroy(), 10);
		} else {res.end('new script');}
	});
	try {
		await downloadToFile(server.url, dest, {sleep: async () => {
			t.is(readFileSync(dest, 'utf-8'), 'old script');
		}});
		t.is(calls, 2);
		t.is(readFileSync(dest, 'utf-8'), 'new script');
		t.deepEqual(readdirSync(dir), ['script.py']);
	} finally {await server.close(); rmSync(dir, {recursive: true, force: true});}
});

for (const status of [403, 404, 502]) {
	test(`failed download (${status}) leaves no partial destination or temp file`, async t => {
		const dir = mkdtempSync(join(tmpdir(), 'nanotune-download-'));
		let calls = 0;
		const server = await endpoint((_req, res) => {calls++; res.writeHead(status); res.end('failed');});
		try {
			await t.throwsAsync(downloadToFile(server.url, join(dir, 'script.py'), {sleep: async () => {}}), {instanceOf: HttpError});
			t.is(calls, status === 502 ? 3 : 1);
			t.deepEqual(readdirSync(dir), []);
		} finally {await server.close(); rmSync(dir, {recursive: true, force: true});}
	});
}

test('rate-limit Retry-After reaches the wait from an actual HTTP response', async t => {
	let calls = 0;
	const delays: number[] = [];
	const server = await endpoint((_req, res) => {
		res.writeHead(++calls === 1 ? 403 : 200, {'retry-after': '60'});
		res.end(calls === 1 ? 'limited' : '{}');
	});
	try {
		await fetchJson(server.url, undefined, {sleep: async ms => {delays.push(ms);}});
		t.is(calls, 2);
		t.deepEqual(delays, [60_000]);
	} finally {await server.close();}
});

test('exhausted body failures remove partial files rather than mark a script installed', async t => {
	const dir = mkdtempSync(join(tmpdir(), 'nanotune-download-'));
	let calls = 0;
	const server = await endpoint((_req, res) => {
		calls++;
		res.writeHead(200, {'content-length': '1000'});
		res.write('partial');
		setTimeout(() => res.destroy(), 10);
	});
	try {
		await t.throwsAsync(downloadToFile(server.url, join(dir, 'script.py'), {sleep: async () => {}}));
		t.is(calls, 3);
		t.deepEqual(readdirSync(dir), []);
	} finally {await server.close(); rmSync(dir, {recursive: true, force: true});}
});

test('aborting a streaming download cleans up and preserves the destination', async t => {
	const dir = mkdtempSync(join(tmpdir(), 'nanotune-download-'));
	const dest = join(dir, 'script.py');
	writeFileSync(dest, 'old script');
	const controller = new AbortController();
	let calls = 0;
	const server = await endpoint((_req, res) => {
		calls++;
		res.writeHead(200, {'content-length': '1000'});
		res.write('partial');
		setTimeout(() => controller.abort(), 20);
	});
	try {
		await t.throwsAsync(downloadToFile(server.url, dest, {signal: controller.signal}), {name: 'AbortError'});
		t.is(calls, 1);
		t.is(readFileSync(dest, 'utf-8'), 'old script');
		t.deepEqual(readdirSync(dir), ['script.py']);
	} finally {await server.close(); rmSync(dir, {recursive: true, force: true});}
});
