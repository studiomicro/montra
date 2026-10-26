import { describe, expect, it } from 'vitest';
import { alurUangHref, flowRiwayatHref } from './money-flow';
import { parseRiwayatQuery } from './riwayat-query';

const TODAY = '2026-10-08';

describe('alurUangHref', () => {
	it('this month is the plain path; another month is ?p=', () => {
		expect(alurUangHref('2026-10', TODAY)).toBe('/alur-uang');
		expect(alurUangHref('2026-09', TODAY)).toBe('/alur-uang?p=2026-09');
	});
});

describe('flowRiwayatHref', () => {
	it('links the same month with the type, category and wallet, which Riwayat reads back', () => {
		const href = flowRiwayatHref('2026-09', { type: 'income', categoryId: 'c1', walletId: 'w1' });
		expect(href).toBe('/riwayat?type=income&month=2026-09&category=c1&wallet=w1');
		const { view } = parseRiwayatQuery(new URL(`http://x${href}`).searchParams, TODAY);
		expect(view).toMatchObject({
			type: 'income',
			period: 'month',
			from: '2026-09-01',
			to: '2026-09-30',
			categoryId: 'c1',
			walletId: 'w1'
		});
		expect(flowRiwayatHref('2026-09', { type: null, walletId: 'w1' })).toBe(
			'/riwayat?month=2026-09&wallet=w1'
		);
	});

	it('a quarter or year links its date range, which Riwayat reads back (FN-53)', () => {
		const href = flowRiwayatHref(
			{ from: '2026-07-01', to: '2026-09-30' },
			{ type: 'expense', categoryId: 'c1', walletId: 'w1' }
		);
		expect(href).toBe(
			'/riwayat?type=expense&period=range&from=2026-07-01&to=2026-09-30&category=c1&wallet=w1'
		);
		const { view } = parseRiwayatQuery(new URL(`http://x${href}`).searchParams, TODAY);
		expect(view).toMatchObject({ period: 'range', from: '2026-07-01', to: '2026-09-30' });
		// A leap year's 366 days are one Riwayat range too.
		const year = flowRiwayatHref({ from: '2024-01-01', to: '2024-12-31' }, { type: null });
		expect(
			parseRiwayatQuery(new URL(`http://x${year}`).searchParams, '2026-10-08').view
		).toMatchObject({ period: 'range', from: '2024-01-01', to: '2024-12-31' });
	});

	it('a folded node (FN-53 "Lainnya" / "Dompet lainnya") has no list: no link', () => {
		const range = { from: '2026-01-01', to: '2026-10-08' };
		expect(flowRiwayatHref(range, { type: 'expense', categoryId: '*' })).toBeNull();
		expect(flowRiwayatHref(range, { type: null, walletId: '*' })).toBeNull();
		expect(flowRiwayatHref(range, { type: 'income', categoryId: 'c1', walletId: '*' })).toBeNull();
	});

	it('rows without a category have no list of their own: no link', () => {
		expect(flowRiwayatHref('2026-09', { type: 'expense', categoryId: '', walletId: 'w1' })).toBe(
			null
		);
	});
});
