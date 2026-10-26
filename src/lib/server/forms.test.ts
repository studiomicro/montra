import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import {
	amountMinorFromText,
	BodyBudgetExceeded,
	boundedId,
	expectedUpdatedAt,
	FORM_BODY_MAX_BYTES,
	idField,
	readFormBody,
	textField,
	wholeAmountMinor
} from './forms';

const post = (body: BodyInit | null, type?: string) =>
	new Request('http://localhost/masuk', {
		method: 'POST',
		body,
		headers: type ? { 'content-type': type } : {}
	});

async function status(request: Request): Promise<number> {
	try {
		await readFormBody(request);
		return 200;
	} catch (e) {
		if (isHttpError(e)) return e.status;
		throw e;
	}
}

describe('readFormBody', () => {
	it('reads a url-encoded form', async () => {
		const form = await readFormBody(
			post('email=a%40b.co&password=x', 'application/x-www-form-urlencoded')
		);
		expect(textField(form, 'email')).toBe('a@b.co');
		expect(textField(form, 'missing')).toBe('');
	});

	it('charges each buffer growth to `charge`; a refusal throws BodyBudgetExceeded (FN-16a red team L4)', async () => {
		const type = 'application/x-www-form-urlencoded';
		const body = `a=${'x'.repeat(200_000)}`;
		const charged: number[] = [];
		const form = await readFormBody(post(body, type), 300_000, 5_000, 5_000, (n) => {
			charged.push(n);
			return true;
		});
		expect(textField(form, 'a')).toHaveLength(200_000);
		// The buffer is sized to the declared length: all of it charged, in steps, nothing more.
		expect(charged.reduce((a, b) => a + b, 0)).toBe(body.length);
		await expect(
			readFormBody(post(body, type), 300_000, 5_000, 5_000, (n) => n <= 64 * 1024)
		).rejects.toBeInstanceOf(BodyBudgetExceeded);
	});

	it('answers 415 for JSON, text/plain and no content type', async () => {
		expect(await status(post('{"a":1}', 'application/json'))).toBe(415);
		expect(await status(post('a=1', 'text/plain'))).toBe(415);
		expect(await status(post('a=1'))).toBe(415);
	});

	it('answers 400 for an oversized body, declared or streamed', async () => {
		const big = 'a=' + 'x'.repeat(FORM_BODY_MAX_BYTES + 10);
		expect(await status(post(big, 'application/x-www-form-urlencoded'))).toBe(400);
		const stream = new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode(big));
				c.close();
			}
		});
		const chunked = new Request('http://localhost/masuk', {
			method: 'POST',
			body: stream,
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			duplex: 'half'
		} as RequestInit);
		expect(await status(chunked)).toBe(400);
	});

	it('a caller-given cap replaces the default, both ways', async () => {
		const type = 'application/x-www-form-urlencoded';
		const mid = 'a=' + 'x'.repeat(FORM_BODY_MAX_BYTES + 10);
		const form = await readFormBody(post(mid, type), FORM_BODY_MAX_BYTES * 2);
		expect(textField(form, 'a')).toHaveLength(FORM_BODY_MAX_BYTES + 10);
		let refused = 0;
		try {
			await readFormBody(post('a=' + 'x'.repeat(100), type), 50);
		} catch (e) {
			if (isHttpError(e)) refused = e.status;
		}
		expect(refused).toBe(400);
	});

	it('a slow body declaring 8 MiB holds only what arrived, and is cut off at the deadline (FN-27 N4)', async () => {
		const declared = 8 * 1024 * 1024;
		let cancelled = false;
		const slow = new Request('http://localhost/barang', {
			method: 'POST',
			body: new ReadableStream({
				start(c) {
					c.enqueue(new TextEncoder().encode('a=1'));
					// …and nothing more: the client holds the connection open.
				},
				cancel() {
					cancelled = true;
				}
			}),
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				'content-length': String(declared)
			},
			duplex: 'half'
		} as RequestInit);
		const before = process.memoryUsage().arrayBuffers;
		const pending = readFormBody(slow, declared + 1, 200).then(
			() => 200,
			(e) => (isHttpError(e) ? e.status : 500)
		);
		await new Promise((r) => setTimeout(r, 50));
		// Not the declared 8 MiB: memory follows the bytes that arrived.
		expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(1024 * 1024);
		expect(await pending).toBe(408);
		expect(cancelled).toBe(true);
	});

	it('R17: a slow but steady body completes past the idle limit; a stalled one is refused after idle', async () => {
		const trickle = (pieces: string[], gapMs: number, stallAfter = Infinity) =>
			new Request('http://localhost/barang', {
				method: 'POST',
				body: new ReadableStream({
					async start(c) {
						for (const [i, piece] of pieces.entries()) {
							if (i >= stallAfter) return; // stops sending, never closes
							await new Promise((r) => setTimeout(r, gapMs));
							c.enqueue(new TextEncoder().encode(piece));
						}
						c.close();
					}
				}),
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				duplex: 'half'
			} as RequestInit);
		const pieces = ['a=1', '&b=', '2', '&c=', '3', '&d=', '4', '&e=5'];
		// 8 pieces 40 ms apart (~320 ms in all), idle limit 150 ms, total 5 s: completes.
		const started = Date.now();
		const steady = await readFormBody(trickle(pieces, 40), 1024, 5_000, 150);
		expect(Date.now() - started).toBeGreaterThan(150);
		expect(textField(steady, 'e')).toBe('5');
		// The same sender stalling after 2 pieces: refused once 150 ms pass without bytes, long before 5 s.
		const stalledAt = Date.now();
		let stalled = 0;
		try {
			await readFormBody(trickle(pieces, 40, 2), 1024, 5_000, 150);
		} catch (e) {
			stalled = isHttpError(e) ? e.status : 500;
		}
		expect(stalled).toBe(408);
		expect(Date.now() - stalledAt).toBeLessThan(2_000);
	});

	it('a declared length is read into one buffer; a body longer than declared is refused (FN-27 L3)', async () => {
		const streamed = (text: string, declared: number) =>
			new Request('http://localhost/masuk', {
				method: 'POST',
				body: new ReadableStream({
					start(c) {
						c.enqueue(new TextEncoder().encode(text));
						c.close();
					}
				}),
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					'content-length': String(declared)
				},
				duplex: 'half'
			} as RequestInit);
		const exact = await readFormBody(streamed('a=1&b=2', 7));
		expect(textField(exact, 'b')).toBe('2');
		expect(await status(streamed('a=1&b=2', 3))).toBe(400);
		const shorter = await readFormBody(streamed('a=1', 50));
		expect(textField(shorter, 'a')).toBe('1');
	});

	it('answers 400 for a malformed multipart body', async () => {
		expect(await status(post('garbage', 'multipart/form-data; boundary=zzz'))).toBe(400);
	});

	it('treats __proto__ and constructor as plain field names', async () => {
		const form = await readFormBody(
			post('__proto__=x&constructor=y', 'application/x-www-form-urlencoded')
		);
		expect(textField(form, '__proto__')).toBe('x');
		expect(({} as Record<string, unknown>).x).toBeUndefined();
	});
});

describe('wholeAmountMinor', () => {
	it('reads whole units, plain or grouped in threes, in the currency’s minor units', () => {
		expect(wholeAmountMinor('1.250.000', 'IDR')).toBe(125_000_000);
		expect(wholeAmountMinor(' 25000 ', 'IDR')).toBe(2_500_000);
		expect(wholeAmountMinor('1.500', 'JPY')).toBe(1500);
		expect(wholeAmountMinor('007', 'IDR')).toBe(700);
	});

	it('reads a blank field as 0', () => {
		expect(wholeAmountMinor('', 'IDR')).toBe(0);
		expect(wholeAmountMinor('   ', 'IDR')).toBe(0);
	});

	it.each([
		'12.50',
		'1.000,50',
		'12,50',
		'1e3',
		'1 250',
		'-5',
		'+5',
		'1.25.000',
		'12345678901234',
		'٣'
	])('refuses %j, never reinterpreting it', (text) => {
		expect(wholeAmountMinor(text, 'IDR')).toBeNull();
	});
});

describe('amountMinorFromText (FN-47: the one server rule for typed amounts)', () => {
	it.each([
		['12,50', 'USD', 'id', 1250],
		['12,5', 'USD', 'id', 1250],
		['12,', 'USD', 'id', 1200],
		[',50', 'USD', 'id', 50],
		['0,5', 'EUR', 'id', 50],
		['1.234,56', 'CNY', 'id', 123_456],
		['1.250.000', 'SGD', 'id', 125_000_000],
		[' 007,01 ', 'MYR', 'id', 701],
		['12.50', 'USD', 'en', 1250],
		['1,234.56', 'HKD', 'en', 123_456],
		['.5', 'AUD', 'en', 50],
		['25000', 'TWD', 'en', 2_500_000],
		['', 'USD', 'id', 0],
		['9.999.999.999.999,99', 'GBP', 'id', 999_999_999_999_999]
	] as const)('reads %j in %s (%s) as %d', (text, currency, locale, minor) => {
		expect(amountMinorFromText(text, currency, locale)).toBe(minor);
	});

	it.each([
		['12,345', 'id'],
		['12.345', 'en'],
		['0,001', 'id'],
		['12.50', 'id'],
		['12,50', 'en'],
		['1.25,50', 'id'],
		['1,25.50', 'en'],
		['1.234.5,00', 'id'],
		[',', 'id'],
		['12,5a', 'id'],
		['12,-5', 'id'],
		['-12,50', 'id'],
		['1e3', 'en'],
		['1 250,50', 'id'],
		['12,50,5', 'id'],
		['12345678901234,00', 'id'],
		['١٢,٥٠', 'id']
	] as const)('refuses %j (%s), never rounding or cutting it', (text, locale) => {
		expect(amountMinorFromText(text, 'USD', locale)).toBeNull();
	});

	it('IDR and JPY keep the whole-unit contract exactly, in either language', () => {
		for (const locale of ['id', 'en'] as const) {
			for (const text of [
				'1.250.000',
				' 25000 ',
				'007',
				'',
				'12.50',
				'12,50',
				'25,50',
				'1,250',
				'1e3'
			])
				for (const currency of ['IDR', 'JPY'])
					expect(amountMinorFromText(text, currency, locale)).toBe(
						wholeAmountMinor(text, currency)
					);
		}
		expect(amountMinorFromText('25,50', 'IDR', 'id')).toBeNull();
		expect(amountMinorFromText('1.500', 'JPY', 'en')).toBe(1500);
	});
});

describe('form ids and updated_at', () => {
	const form = (fields: Record<string, string>) => {
		const f = new FormData();
		for (const [k, v] of Object.entries(fields)) f.set(k, v);
		return f;
	};

	it('reads an updated_at or -1 (matches nothing)', () => {
		expect(expectedUpdatedAt(form({ updatedAt: '1791413561226' }))).toBe(1791413561226);
		expect(expectedUpdatedAt(form({ debitUpdatedAt: '42' }), 'debitUpdatedAt')).toBe(42);
		for (const updatedAt of ['', '1e3', '-1', '9'.repeat(16)])
			expect(expectedUpdatedAt(form({ updatedAt }))).toBe(-1);
	});

	it('drops over-long ids', () => {
		expect(idField(form({ id: 'a'.repeat(64) }), 'id')).toBe('a'.repeat(64));
		expect(idField(form({ id: 'a'.repeat(65) }), 'id')).toBe('');
		expect(idField(form({}), 'id')).toBe('');
		expect(boundedId('b'.repeat(65))).toBe('');
	});
});
