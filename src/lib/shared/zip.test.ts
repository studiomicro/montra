import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readZip } from '../../../test/helpers/zip';
import { crc32, zipEntryName, zipStore, type ZipEntry } from './zip';

const enc = new TextEncoder();
const streamOf = (...chunks: (string | Uint8Array)[]) =>
	new ReadableStream<Uint8Array>({
		start(c) {
			for (const chunk of chunks) c.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk);
			c.close();
		}
	});
const entry = (name: string, ...chunks: (string | Uint8Array)[]): ZipEntry => ({
	name,
	open: () => streamOf(...chunks)
});

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('crc32', () => {
	it('matches the standard check value and continues across chunks', () => {
		expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
		expect(crc32(enc.encode('6789'), crc32(enc.encode('12345')))).toBe(0xcbf43926);
		expect(crc32(new Uint8Array(0))).toBe(0);
	});
});

describe('zipEntryName', () => {
	it('accepts relative names and refuses absolute, parent-escaping, empty or long ones', () => {
		expect(zipEntryName('transactions-01-pribadi.csv').length).toBe(27);
		expect(zipEntryName('a/b.json').length).toBe(8);
		for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', './a', 'x'.repeat(256)])
			expect(() => zipEntryName(bad), bad).toThrow(RangeError);
	});
});

describe('zipStore', () => {
	it('writes each entry byte for byte, readable through the central directory', async () => {
		const zip = await bytesOf(
			zipStore([
				entry('account.json', '{"a":1}'),
				entry('transactions-01-pribadi.csv', '﻿date,type\n', '2026-10-01,expense\n'),
				entry('kosong.csv')
			])
		);
		const files = readZip(zip);
		expect([...files.keys()]).toEqual([
			'account.json',
			'transactions-01-pribadi.csv',
			'kosong.csv'
		]);
		expect(
			new TextDecoder('utf-8', { ignoreBOM: true }).decode(files.get('transactions-01-pribadi.csv'))
		).toBe('﻿date,type\n2026-10-01,expense\n');
		expect(files.get('kosong.csv')?.length).toBe(0);
		// Store method: the entry's bytes appear in the archive as they are.
		expect(Buffer.from(zip).includes(Buffer.from('2026-10-01,expense'))).toBe(true);
	});

	it('gives identical bytes for identical entries (fixed file times)', async () => {
		const make = () => zipStore([entry('a.txt', 'satu'), entry('b.txt', 'dua')]);
		expect(await bytesOf(make())).toEqual(await bytesOf(make()));
	});

	it('an empty archive is just the end record', async () => {
		const zip = await bytesOf(zipStore([]));
		expect(zip.length).toBe(22);
		expect(readZip(zip).size).toBe(0);
	});

	it('refuses duplicate and unsafe names by erroring the stream', async () => {
		await expect(bytesOf(zipStore([entry('a', 'x'), entry('a', 'y')]))).rejects.toThrow(
			'duplicate'
		);
		await expect(bytesOf(zipStore([entry('../a', 'x')]))).rejects.toThrow('unsafe');
	});

	it('opens an entry only when the writer reaches it', async () => {
		const opened: string[] = [];
		const lazy = (name: string): ZipEntry => ({
			name,
			open: () => {
				opened.push(name);
				return streamOf(name);
			}
		});
		const reader = zipStore([lazy('a'), lazy('b')]).getReader();
		await reader.read(); // local header of a
		expect(opened).toEqual([]);
		await reader.read(); // data of a
		expect(opened).toEqual(['a']);
		await reader.read(); // data descriptor of a
		expect(opened).toEqual(['a']);
		await reader.cancel();
	});

	it('cancelling the download cancels the entry being read', async () => {
		let cancelled = false;
		const endless: ZipEntry = {
			name: 'endless.csv',
			open: () =>
				new ReadableStream<Uint8Array>({
					pull: (c) => c.enqueue(enc.encode('baris\n')),
					cancel: () => {
						cancelled = true;
					}
				})
		};
		const reader = zipStore([endless]).getReader();
		for (let i = 0; i < 5; i++) await reader.read();
		await reader.cancel();
		expect(cancelled).toBe(true);
	});

	it('streams a 48 MiB entry without holding it in memory (memory bound probe)', async () => {
		const CHUNK = 64 * 1024;
		const CHUNKS = 768; // 48 MiB
		let produced = 0;
		const big: ZipEntry = {
			name: 'besar.csv',
			open: () =>
				new ReadableStream<Uint8Array>(
					{
						pull(c) {
							if (produced === CHUNKS) return c.close();
							produced++;
							c.enqueue(new Uint8Array(CHUNK).fill(0x41 + (produced % 26)));
						}
					},
					{ highWaterMark: 0 }
				)
		};
		globalThis.gc?.();
		const before = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
		let peak = 0;
		let total = 0;
		const reader = zipStore([big]).getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total % (8 * 1024 * 1024) < CHUNK) {
				const now = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
				peak = Math.max(peak, now - before);
			}
		}
		expect(total).toBe(CHUNK * CHUNKS + 30 + 9 + 16 + 46 + 9 + 22);
		// Far below the 48 MiB that passed through (garbage not yet collected counts too).
		expect(peak).toBeLessThan(40 * 1024 * 1024);
		expect(produced).toBe(CHUNKS);
	});

	it.skipIf(!existsSync('/usr/bin/unzip'))(
		'opens with Info-ZIP unzip (test and extract) and Python zipfile',
		async () => {
			const csv = '﻿date,type,merchant\n2026-10-01,expense,"Kopi, susu"\n';
			const zip = await bytesOf(
				zipStore([entry('account.json', '{"ok":true}'), entry('transactions-01-pribadi.csv', csv)])
			);
			const dir = mkdtempSync(join(tmpdir(), 'fin-zip-'));
			try {
				const file = join(dir, 'ekspor.zip');
				writeFileSync(file, zip);
				expect(execFileSync('unzip', ['-t', file], { encoding: 'utf8' })).toContain(
					'No errors detected'
				);
				expect(
					execFileSync('unzip', ['-p', file, 'transactions-01-pribadi.csv'], { encoding: 'utf8' })
				).toBe(csv);
				if (existsSync('/usr/bin/python3'))
					expect(
						execFileSync(
							'python3',
							[
								'-I',
								'-c',
								'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(",".join(z.namelist()))',
								file
							],
							{ encoding: 'utf8' }
						).trim()
					).toBe('account.json,transactions-01-pribadi.csv');
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	);
});
