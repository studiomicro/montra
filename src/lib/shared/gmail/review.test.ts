import { describe, expect, it } from 'vitest';
import { gmailMessageUrl, groupReview, type GmailReviewRow } from './review.ts';

const at = (iso: string) => Date.parse(iso);

function row(
	o: Partial<GmailReviewRow> & Pick<GmailReviewRow, 'id' | 'receivedAt'>
): GmailReviewRow {
	return {
		gmailId: '18c0a1b2c3d4e5f6',
		state: 'saved',
		title: 'Kedai Kopi Senja',
		amountMinor: 2_800_000,
		currency: 'IDR',
		direction: 'expense',
		senderDomain: 'notifikasi.bank-qris.example',
		subject: 'Transaksi QRIS Berhasil',
		scan: null,
		...o
	};
}

const scan = (id: string, kind: 'hourly' | 'lookback' = 'hourly') => ({
	id,
	kind,
	days: kind === 'lookback' ? 7 : null,
	createdAt: at('2026-10-31T10:00:00+07:00'),
	undoneAt: null,
	undoable: true
});

describe('groupReview (AC 15)', () => {
	it('groups per WIB day (23:30 WIB on a month end stays on that day) then per scan', () => {
		const days = groupReview([
			row({ id: 'a', receivedAt: at('2026-11-01T00:30:00+07:00'), scan: scan('s2') }),
			row({ id: 'b', receivedAt: at('2026-10-31T23:30:00+07:00'), scan: scan('s1') }),
			row({ id: 'c', receivedAt: at('2026-10-31T23:00:00+07:00'), scan: scan('lb', 'lookback') }),
			row({ id: 'd', receivedAt: at('2026-10-31T22:00:00+07:00'), scan: scan('s1') })
		]);
		expect(days.map((d) => d.date)).toEqual(['2026-11-01', '2026-10-31']);
		expect(days[1]!.scans.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
			['s1', ['b', 'd']],
			['lb', ['c']]
		]);
	});

	it('the day total is the integer sum of the listed saved expenses only', () => {
		const day = at('2026-10-20T10:00:00+07:00');
		const [d] = groupReview([
			row({ id: 'a', receivedAt: day, amountMinor: 2_800_000 }),
			row({ id: 'b', receivedAt: day - 1, amountMinor: 1_250_050 }),
			row({ id: 'c', receivedAt: day - 2, state: 'draft', amountMinor: 999 }),
			row({ id: 'd', receivedAt: day - 3, state: 'duplicate', amountMinor: 999 }),
			row({ id: 'e', receivedAt: day - 4, direction: 'income', amountMinor: 500 }),
			row({
				id: 'f',
				receivedAt: day - 5,
				state: 'cancelled',
				amountMinor: null,
				title: null,
				direction: null
			})
		]);
		expect(d!.savedOutMinor).toBe(4_050_050);
		expect(Number.isSafeInteger(d!.savedOutMinor)).toBe(true);
	});
});

describe('gmailMessageUrl (AC 20)', () => {
	it('is built from stored ids only, with the address escaped', () => {
		expect(gmailMessageUrl('pemilik@gmail.example', '18c0a1b2c3d4e5f6')).toBe(
			'https://mail.google.com/mail/u/pemilik%40gmail.example/#all/18c0a1b2c3d4e5f6'
		);
		expect(gmailMessageUrl('a/b?c#d@x.example', 'abc')).toBe(
			'https://mail.google.com/mail/u/a%2Fb%3Fc%23d%40x.example/#all/abc'
		);
	});

	it('no link without an address or for an id that is not a Gmail hex id', () => {
		expect(gmailMessageUrl(null, 'abc')).toBeNull();
		for (const bad of ['', 'x/../y', 'javascript:1', 'a'.repeat(33), 'abc def'])
			expect(gmailMessageUrl('pemilik@gmail.example', bad)).toBeNull();
	});
});
