import {randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {rename, rm} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {HttpError, type RetryOptions, retry} from './retry.js';

async function checkedFetch(
	url: string,
	init?: RequestInit,
): Promise<Response> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const error = new HttpError(
			url,
			response.status,
			response.statusText,
			response.headers.get('retry-after'),
		);
		// Release the failed response before opening another connection.
		await response.body?.cancel();
		throw error;
	}
	return response;
}

/** Retry metadata reads through body consumption, not just response headers. */
export async function fetchJson<T>(
	url: string,
	init?: RequestInit,
	options: RetryOptions = {},
): Promise<T> {
	const signal = options.signal ?? init?.signal ?? undefined;
	return retry(
		async () => {
			const response = await checkedFetch(url, {
				...init,
				signal,
			});
			return (await response.json()) as T;
		},
		{...options, signal},
	);
}

/** Retry the entire transfer; publish only a completely downloaded file. */
export async function downloadToFile(
	url: string,
	destPath: string,
	options: RetryOptions = {},
): Promise<void> {
	const tempPath = `${destPath}.${randomUUID()}.tmp`;
	try {
		await retry(async () => {
			const response = await checkedFetch(url, {signal: options.signal});
			if (!response.body) throw new Error(`No response body for ${url}`);
			// 'w' truncates the failed attempt instead of appending to it.
			await pipeline(response.body, createWriteStream(tempPath, {flags: 'w'}), {
				signal: options.signal,
			});
		}, options);
		await rename(tempPath, destPath);
	} finally {
		await rm(tempPath, {force: true});
	}
}
