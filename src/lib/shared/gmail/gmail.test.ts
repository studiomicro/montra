import { describe, expect, it } from 'vitest';
import { base64urlEncode } from '../base64url.ts';
import { GMAIL_BACKOFF_MAX_S, gmailBackoffSeconds } from './backoff.ts';
import { LOOKBACK_DAYS, lookbackAllowed, lookbackDaysOf } from './lookback.ts';
import { decodeEncodedWords, isExcludedByLabel, parseGmailMessage } from './message.ts';
import { GMAIL_QUERY_MAX, GMAIL_SENDER_TERMS, gmailQuery } from './query.ts';

const b64 = (text: string) => base64urlEncode(new TextEncoder().encode(text));

/** A Gmail `messages.get` (format=full) answer around `payload`. */
function message(payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	return {
		id: 'm1',
		threadId: 't1',
		labelIds: ['INBOX'],
		internalDate: '1791480725000',
		payload,
		...extra
	};
}
const headers = (subject = 'Transaksi QRIS Berhasil') => [
	{ name: 'From', value: 'Bank Contoh <noreply@notifikasi.bank-qris.example>' },
	{ name: 'Subject', value: subject },
	{ name: 'Message-ID', value: '<a@b.example>' },
	{ name: 'Date', value: 'Thu, 08 Oct 2026 07:32:06 +0000' }
];
const textPart = (text: string, mimeType = 'text/plain') => ({
	mimeType,
	filename: '',
	headers: [{ name: 'Content-Type', value: `${mimeType}; charset=utf-8` }],
	body: { size: text.length, data: b64(text) }
});

describe('gmailQuery (PRD § 5): a prefilter from constants and one integer', () => {
	it('excludes Promotions and Social, lists after an epoch integer, names senders and subject words', () => {
		const q = gmailQuery(1791480725);
		expect(q.startsWith('-category:promotions -category:social after:1791480725 ')).toBe(true);
		expect(q).toContain('from:(bca OR mandiri');
		expect(q).toContain('subject:(qris OR struk OR invoice OR tagihan OR "bukti pembayaran"');
		for (const term of GMAIL_SENDER_TERMS) expect(q).toContain(term);
		expect(q.length).toBeLessThanOrEqual(GMAIL_QUERY_MAX);
	});

	it('has balanced parentheses and quotes', () => {
		const q = gmailQuery(0);
		let depth = 0;
		for (const c of q) {
			if (c === '(') depth++;
			if (c === ')') depth--;
			expect(depth).toBeGreaterThanOrEqual(0);
		}
		expect(depth).toBe(0);
		expect((q.match(/"/g) ?? []).length % 2).toBe(0);
	});

	it('refuses anything but a non-negative integer (no user text can reach q)', () => {
		for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
			expect(() => gmailQuery(bad)).toThrow(RangeError);
		expect(() => gmailQuery('1 OR from:x' as unknown as number)).toThrow(RangeError);
	});
});

describe('gmailBackoffSeconds: 1 s base, doubling, jitter below 1 s, cap 64 s', () => {
	it('doubles from 1 s with jitter and caps at 64 s', () => {
		expect(gmailBackoffSeconds(0, 0)).toBe(1);
		expect(gmailBackoffSeconds(0, 0.5)).toBe(2);
		expect(gmailBackoffSeconds(1, 0)).toBe(2);
		expect(gmailBackoffSeconds(3, 0.2)).toBe(9);
		expect(gmailBackoffSeconds(6, 0.9)).toBe(GMAIL_BACKOFF_MAX_S);
		expect(gmailBackoffSeconds(40, 0.9)).toBe(GMAIL_BACKOFF_MAX_S);
	});

	it('stays within [2^n, 2^n + 1) before the cap for any random value', () => {
		for (let n = 0; n < 6; n++)
			for (const r of [0, 0.001, 0.5, 0.999, 1, 5, -1]) {
				const s = gmailBackoffSeconds(n, r);
				expect(s).toBeGreaterThanOrEqual(2 ** n);
				expect(s).toBeLessThanOrEqual(2 ** n + 1);
			}
		expect(gmailBackoffSeconds(Number.NaN, Number.NaN)).toBe(1);
	});
});

describe('look-back values', () => {
	it('accepts only the listed values and compares with the plan maximum', () => {
		for (const d of LOOKBACK_DAYS) expect(lookbackDaysOf(String(d))).toBe(d);
		for (const bad of ['', '14', '366', '7.0', '-7', '0365', '1e2', '__proto__'])
			expect(lookbackDaysOf(bad)).toBeNull();
		expect(lookbackAllowed(7, 7)).toBe(true);
		expect(lookbackAllowed(30, 7)).toBe(false);
		expect(lookbackAllowed(365, 365)).toBe(true);
	});
});

describe('parseGmailMessage (PRD § 7.3)', () => {
	it('reads headers, the plain body, labels and internalDate', () => {
		const parsed = parseGmailMessage(
			message({
				mimeType: 'text/plain',
				headers: headers(),
				body: { data: b64('Nominal : Rp 28.000,00') }
			})
		);
		expect(parsed.kind).toBe('ok');
		if (parsed.kind !== 'ok') return;
		expect(parsed.mail).toMatchObject({
			gmailId: 'm1',
			internalDate: 1791480725000,
			labelIds: ['INBOX'],
			messageId: '<a@b.example>',
			date: '2026-10-08T07:32:06.000Z',
			fromAddress: 'noreply@notifikasi.bank-qris.example',
			subject: 'Transaksi QRIS Berhasil',
			text: 'Nominal : Rp 28.000,00'
		});
	});

	it('never decodes an attachment: a part with a filename or attachmentId is skipped, even inline bytes', () => {
		const parsed = parseGmailMessage(
			message({
				mimeType: 'multipart/mixed',
				headers: headers(),
				parts: [
					textPart('Lihat lampiran.'),
					{
						mimeType: 'text/plain',
						filename: 'struk.txt',
						headers: [],
						body: { size: 20, data: b64('Total Rp 99.999.999') }
					},
					{ mimeType: 'application/pdf', filename: '', body: { attachmentId: 'ANGjdJ8', size: 1 } },
					{
						mimeType: 'text/html',
						filename: '',
						body: { attachmentId: 'x', data: b64('<p>Rp 1</p>') }
					}
				]
			})
		);
		expect(parsed.kind === 'ok' && parsed.mail.text).toBe('Lihat lampiran.');
	});

	it('prefers the plain part; HTML is turned into text with scripts dropped, never kept as markup', () => {
		const parsed = parseGmailMessage(
			message({
				mimeType: 'multipart/alternative',
				headers: headers(),
				parts: [textPart('<script>alert(1)</script><p>Total <b>Rp 25.000</b></p>', 'text/html')]
			})
		);
		expect(parsed.kind === 'ok' && parsed.mail.text).toBe('Total Rp 25.000');
	});

	it('decodes RFC 2047 subjects (B and Q) and a non-UTF-8 charset without throwing', () => {
		expect(decodeEncodedWords('=?UTF-8?B?VHJhbnNha3NpIFFSSVMgQmVyaGFzaWw=?=')).toBe(
			'Transaksi QRIS Berhasil'
		);
		expect(decodeEncodedWords('=?ISO-8859-1?Q?Caf=E9_1234567890?=')).toBe('Café 1234567890');
		expect(decodeEncodedWords('=?x-unknown?B?!!!?=')).toBe('=?x-unknown?B?!!!?=');
		const latin = base64urlEncode(Uint8Array.from([0x52, 0x70, 0x20, 0xe9, 0xff, 0x31]));
		const parsed = parseGmailMessage(
			message({
				mimeType: 'text/plain',
				headers: [...headers(), { name: 'Content-Type', value: 'text/plain; charset=bogus-8' }],
				body: { data: latin }
			})
		);
		expect(parsed.kind).toBe('ok');
	});

	it('hostile shapes end malformed (or parse safely) and never throw', () => {
		let nested: Record<string, unknown> = textPart('Rp 5.000');
		for (let i = 0; i < 50; i++) nested = { mimeType: 'multipart/mixed', parts: [nested] };
		expect(parseGmailMessage(message({ ...nested, headers: headers() })).kind).toBe('malformed');
		const many = {
			mimeType: 'multipart/mixed',
			headers: headers(),
			parts: Array.from({ length: 1000 }, () => textPart('Rp 1'))
		};
		expect(parseGmailMessage(message(many)).kind).toBe('malformed');
		for (const bad of [
			null,
			'x',
			[],
			{ id: 'm1' },
			message({ mimeType: 'text/plain', body: { data: '###' } }),
			{ ...message({ mimeType: 'text/plain' }), id: '../x' },
			message({ mimeType: 'multipart/mixed', parts: 'nope' })
		])
			expect(() => parseGmailMessage(bad)).not.toThrow();
		expect(parseGmailMessage({ id: 'm1' }).kind).toBe('malformed');
		expect(parseGmailMessage(message({ mimeType: 'text/plain', body: { data: '###' } })).kind).toBe(
			'malformed'
		);
	});

	it('excluded labels: Promotions, Social, Spam, Trash, Draft, Sent', () => {
		for (const l of ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'SPAM', 'TRASH', 'DRAFT', 'SENT'])
			expect(isExcludedByLabel(['INBOX', l])).toBe(true);
		expect(isExcludedByLabel(['INBOX', 'CATEGORY_UPDATES', 'IMPORTANT'])).toBe(false);
	});
});
