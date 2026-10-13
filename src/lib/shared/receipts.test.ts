import { describe, expect, it } from 'vitest';
import {
	adjustmentsMinor,
	canSplit,
	itemCategoryHint,
	receiptDateCheck,
	receiptWalletGuess,
	reconcileReceipt
} from './receipts.ts';

const rp = (rupiah: number) => rupiah * 100;
const figures = (o: Partial<Parameters<typeof reconcileReceipt>[0]> = {}) => ({
	items: [rp(25_000), rp(30_000)],
	taxMinor: rp(5_500),
	serviceMinor: null,
	discountMinor: null,
	totalMinor: rp(60_500),
	...o
});

describe('reconcileReceipt (exact integer minor units)', () => {
	it('matches when items + tax + service − discount equals the total', () => {
		expect(reconcileReceipt(figures())).toEqual({ status: 'match', computedMinor: rp(60_500) });
		expect(
			reconcileReceipt(
				figures({ serviceMinor: rp(2_750), discountMinor: rp(5_000), totalMinor: rp(58_250) })
			).status
		).toBe('match');
	});

	it('is off by even one sen → mismatch with the computed figure', () => {
		expect(reconcileReceipt(figures({ totalMinor: rp(60_500) + 1 }))).toEqual({
			status: 'mismatch',
			computedMinor: rp(60_500),
			totalMinor: rp(60_500) + 1
		});
	});

	it('cannot be checked without every item amount or a total', () => {
		expect(reconcileReceipt(figures({ items: [rp(25_000), null] }))).toEqual({
			status: 'mismatch',
			computedMinor: null,
			totalMinor: rp(60_500)
		});
		expect(reconcileReceipt(figures({ totalMinor: null })).status).toBe('mismatch');
	});

	it('a receipt in another currency is always "Periksa totalnya"', () => {
		expect(reconcileReceipt(figures(), 'USD').status).toBe('mismatch');
		expect(reconcileReceipt(figures(), null).status).toBe('match');
	});

	it('stays exact past 2^53 when summing (BigInt)', () => {
		const big = 4_000_000_000_000_000;
		const r = reconcileReceipt({
			items: [big, big, big],
			taxMinor: null,
			serviceMinor: null,
			discountMinor: null,
			totalMinor: 9_007_199_254_740_991
		});
		expect(r).toEqual({
			status: 'mismatch',
			computedMinor: null,
			totalMinor: 9_007_199_254_740_991
		});
	});
});

describe('split rule (owner decision 5)', () => {
	it('tax + service − discount: positive → a row, zero → none, negative → no split', () => {
		expect(
			adjustmentsMinor({ taxMinor: rp(5_000), serviceMinor: rp(1_000), discountMinor: null })
		).toBe(rp(6_000));
		expect(canSplit({ taxMinor: rp(5_000), serviceMinor: null, discountMinor: rp(5_000) })).toBe(
			true
		);
		expect(
			adjustmentsMinor({ taxMinor: rp(5_000), serviceMinor: null, discountMinor: rp(5_000) })
		).toBe(0);
		expect(canSplit({ taxMinor: rp(1_000), serviceMinor: null, discountMinor: rp(5_000) })).toBe(
			false
		);
		expect(canSplit({ taxMinor: null, serviceMinor: null, discountMinor: null })).toBe(true);
	});
});

describe('receiptDateCheck (WIB calendar dates)', () => {
	const today = '2026-10-09';
	it('flags a date after today and one more than 2 years back', () => {
		expect(receiptDateCheck('2026-10-10', today)).toBe('future');
		expect(receiptDateCheck('2026-10-09', today)).toBe('ok');
		expect(receiptDateCheck('2024-10-09', today)).toBe('ok');
		expect(receiptDateCheck('2024-10-08', today)).toBe('old');
	});
	it('is a sanity bound on dates only, across month and leap-day ends', () => {
		expect(receiptDateCheck('2026-11-01', '2026-10-31')).toBe('future');
		expect(receiptDateCheck('2026-02-28', '2028-02-29')).toBe('old');
		expect(receiptDateCheck('2026-03-01', '2028-02-29')).toBe('ok');
	});
});

describe('itemCategoryHint (the shared keyword table)', () => {
	it('guesses from whole words of the item name, else nothing', () => {
		expect(itemCategoryHint('KOPI SUSU GULA AREN')).toBe('kopi');
		expect(itemCategoryHint('Parkir motor')).toBe('transportasi');
		expect(itemCategoryHint('GrabFood order')).toBe('pesan-antar-makanan');
		expect(itemCategoryHint('Indomie goreng')).toBeUndefined();
		expect(itemCategoryHint('kopiah')).toBeUndefined();
	});
});

describe('receiptWalletGuess', () => {
	const wallets = [
		{ id: 'w-usd', name: 'BCA USD', type: 'bank' as const, currency: 'USD', isFavourite: false },
		{ id: 'w-cash', name: 'Tunai', type: 'tunai' as const, currency: 'IDR', isFavourite: false },
		{ id: 'w-bca', name: 'BCA', type: 'bank' as const, currency: 'IDR', isFavourite: false },
		{ id: 'w-fav', name: 'GoPay', type: 'e_wallet' as const, currency: 'IDR', isFavourite: true }
	];
	it('takes the IDR wallet the payment line names, never a non-IDR one', () => {
		expect(receiptWalletGuess('DEBIT BCA', wallets)).toBe('w-bca');
		expect(receiptWalletGuess('TUNAI', wallets)).toBe('w-cash');
	});
	it('falls back to the favourite IDR wallet, then the first IDR one, then nothing', () => {
		expect(receiptWalletGuess('QRIS', wallets)).toBe('w-fav');
		expect(receiptWalletGuess('', wallets.slice(0, 3))).toBe('w-cash');
		expect(receiptWalletGuess('BCA', wallets.slice(0, 1))).toBe('');
	});
});
