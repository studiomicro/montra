import { describe, expect, it } from 'vitest';
import { createTranslator } from '#lib/shared/i18n';
import {
	joinMeta,
	rowMeta as rawMeta,
	rowTile,
	rowTitle,
	signedAmount,
	type ListedRow
} from './row-text';

/** The meta with its non-breaking spaces shown as plain ones, for readable expectations. */
const rowMeta = (...args: Parameters<typeof rawMeta>) => rawMeta(...args).replace(/\u00a0/g, ' ');
const id = createTranslator('id');
const en = createTranslator('en');
// 2026-10-07 09:32 UTC = 16:32 WIB.
const AT = Date.UTC(2026, 9, 7, 9, 32);
const base: ListedRow = {
	type: 'expense',
	amountMinor: 2_500_000,
	title: 'Kopi susu',
	occurredOn: '2026-10-07',
	occurredAt: AT,
	category: { name: 'Makan & Minum', isPreset: true },
	wallet: { name: 'Tunai' },
	toWallet: null
};

describe('row lines', () => {
	it('second line: WIB time · category · wallet', () => {
		expect(rowMeta(base, id)).toBe('16.32 · Makan & Minum · Tunai');
		expect(rowMeta(base, en)).toBe(`16:32 · ${en.tr('Makan & Minum')} · Tunai`);
	});
	it('a transfer reads "from → to"', () => {
		const transfer: ListedRow = {
			...base,
			type: 'transfer',
			category: null,
			wallet: { name: 'BCA' },
			toWallet: { name: 'Tunai' }
		};
		expect(rowMeta(transfer, id)).toBe('16.32 · BCA → Tunai');
		expect(rowTitle({ ...transfer, title: null }, id)).toBe('Transfer');
	});
	it('leaves the time out when the row has none (back-dated without a time)', () => {
		expect(rowMeta({ ...base, occurredOn: '2026-10-05' }, id)).toBe('Makan & Minum · Tunai');
	});
	it('Terbaru leads with the day', () => {
		expect(rowMeta(base, id, { withDate: true })).toBe('7 Okt, 16.32 · Makan & Minum · Tunai');
		expect(rowMeta({ ...base, occurredOn: '2026-10-05' }, id, { withDate: true })).toBe(
			'5 Okt · Makan & Minum · Tunai'
		);
	});
	it('falls back to the category, then "Tanpa kategori"', () => {
		expect(rowTitle({ ...base, title: null }, id)).toBe('Makan & Minum');
		expect(rowTitle({ ...base, title: null, category: null }, id)).toBe('Tanpa kategori');
		expect(rowMeta({ ...base, category: null }, id)).toBe('16.32 · Tanpa kategori · Tunai');
	});
	it('signs expenses and decreasing adjustments only', () => {
		expect(signedAmount(base)).toBe(-2_500_000);
		expect(signedAmount({ ...base, type: 'income' })).toBe(2_500_000);
		expect(signedAmount({ ...base, type: 'transfer' })).toBe(2_500_000);
		const adjustment = { ...base, type: 'adjustment' as const, category: null };
		expect(signedAmount({ ...adjustment, adjustmentDirection: 'increase' })).toBe(2_500_000);
		expect(signedAmount({ ...adjustment, adjustmentDirection: 'decrease' })).toBe(-2_500_000);
	});
	it('a balance adjustment (FN-37) has no category: "Saldo disesuaikan · wallet", titled by default', () => {
		const adjustment: ListedRow = {
			...base,
			type: 'adjustment',
			title: null,
			category: null,
			wallet: { name: 'BCA' },
			adjustmentDirection: 'increase'
		};
		expect(rowTitle(adjustment, id)).toBe('Penyesuaian saldo');
		expect(rowTitle(adjustment, en)).toBe('Balance adjustment');
		expect(rowTitle({ ...adjustment, title: 'Cocokkan' }, id)).toBe('Cocokkan');
		expect(rowMeta(adjustment, id)).toBe('16.32 · Saldo disesuaikan · BCA');
		expect(rowMeta(adjustment, en)).toBe('16:32 · Balance adjusted · BCA');
	});
	it('never lets a wrapped meta line start with "·" (the dot binds to the segment before it)', () => {
		const meta = rawMeta({ ...base, wallet: { name: 'Mandiri Tabungan' } }, id, { withDate: true });
		expect(meta).toBe('7 Okt, 16.32\u00a0· Makan & Minum\u00a0· Mandiri Tabungan');
		expect(meta).not.toMatch(/ ·/);
	});
	it('joinMeta drops empty segments', () => {
		expect(joinMeta(['5 Okt', null, '', 'BCA'])).toBe('5 Okt\u00a0· BCA');
	});
	it('rowTile gives a transfer the transfer glyph and an uncategorised row "Lainnya"', () => {
		expect(rowTile({ type: 'transfer', category: null })).toBe('transfer');
		expect(rowTile({ type: 'expense', category: null })).toBe('lain');
		expect(rowTile({ type: 'expense', category: { tileKey: 'kopi' } })).toBe('kopi');
	});
});
