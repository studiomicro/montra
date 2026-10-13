import { describe, expect, it } from 'vitest';
import { alurUangHref, flowRiwayatHref, parseFlowMonth, stepFlowMonth } from './money-flow';
import { parseRiwayatQuery } from './riwayat-query';

const TODAY = '2026-10-08';
const p = (s: string) => parseFlowMonth(new URLSearchParams(s), TODAY);

describe('parseFlowMonth', () => {
	it('reads ?p=YYYY-MM; anything else is this WIB month', () => {
		expect(p('p=2026-03')).toBe('2026-03');
		for (const s of ['', 'p=2026-13', 'p=x', 'p=2026-3', 'y=2025']) expect(p(s)).toBe('2026-10');
	});

	it('a future month or one before the 2000 floor is this month', () => {
		expect(p('p=2027-01')).toBe('2026-10');
		expect(p('p=1999-12')).toBe('2026-10');
		expect(p('p=2000-01')).toBe('2000-01');
	});
});

describe('alurUangHref / stepFlowMonth', () => {
	it('this month is the plain path', () => {
		expect(alurUangHref('2026-10', TODAY)).toBe('/alur-uang');
		expect(alurUangHref('2026-09', TODAY)).toBe('/alur-uang?p=2026-09');
	});

	it('steps over a year boundary, never into the future or past the floor', () => {
		expect(stepFlowMonth('2026-01', -1, TODAY)).toBe('2025-12');
		expect(stepFlowMonth('2026-09', 1, TODAY)).toBe('2026-10');
		expect(stepFlowMonth('2026-10', 1, TODAY)).toBeNull();
		expect(stepFlowMonth('2000-01', -1, TODAY)).toBeNull();
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

	it('rows without a category have no list of their own: no link', () => {
		expect(flowRiwayatHref('2026-09', { type: 'expense', categoryId: '', walletId: 'w1' })).toBe(
			null
		);
	});
});
