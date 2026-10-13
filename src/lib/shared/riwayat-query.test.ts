import { describe, expect, it } from 'vitest';
import {
	parseRiwayatQuery,
	periodPresets,
	presetOf,
	riwayatHref,
	viewFilter
} from './riwayat-query';

const TODAY = '2026-10-08';
const parse = (query: string) => parseRiwayatQuery(new URLSearchParams(query), TODAY);

describe('parseRiwayatQuery', () => {
	it('defaults to every row of the current WIB month', () => {
		const { view, cursor } = parse('');
		expect(view).toEqual({
			type: null,
			period: 'month',
			month: '2026-10',
			from: '2026-10-01',
			to: '2026-10-31',
			categoryId: null,
			walletId: null,
			q: '',
			recurring: false
		});
		expect(cursor).toBeNull();
	});

	it('reads a month, a type, a category, a wallet and a search term', () => {
		const { view } = parse('type=income&month=2026-02&category=c1&wallet=w1&q=Kopi');
		expect(view).toMatchObject({
			type: 'income',
			from: '2026-02-01',
			to: '2026-02-28',
			categoryId: 'c1',
			walletId: 'w1',
			q: 'Kopi'
		});
	});

	it('falls back instead of failing on bad input', () => {
		const { view } = parse(
			`type=penyesuaian&month=2026-13&period=range&from=x&to=2026-01-01&category=${'a'.repeat(65)}`
		);
		expect(view).toMatchObject({ type: null, period: 'month', month: '2026-10', categoryId: null });
		for (const type of ['__proto__', 'constructor', 'EXPENSE', 'toString', 'adjust'])
			expect(parse(`type=${type}`).view.type).toBeNull();
	});

	it('reads every transaction type, the balance adjustment chip included (FN-37)', () => {
		for (const type of ['expense', 'income', 'transfer', 'adjustment'] as const) {
			const { view } = parse(`type=${type}`);
			expect(view.type).toBe(type);
			expect(riwayatHref(view)).toContain(`type=${type}`);
		}
	});

	it('orders a reversed range and caps it at 366 days', () => {
		expect(parse('period=range&from=2026-10-31&to=2026-10-01').view).toMatchObject({
			period: 'range',
			from: '2026-10-01',
			to: '2026-10-31'
		});
		expect(parse('period=range&from=2020-01-01&to=2026-12-31').view).toMatchObject({
			from: '2020-01-01',
			to: '2020-12-31'
		});
	});

	it('cleans and caps the search term (control and zero-width characters stripped)', () => {
		expect(parse(`q=${encodeURIComponent('  ko​pi\u0007 ')}`).view.q).toBe('kopi');
		expect(parse(`q=${'x'.repeat(500)}`).view.q).toHaveLength(100);
	});
});

describe('riwayatHref and viewFilter', () => {
	it('round-trips a view through its URL', () => {
		const { view } = parse(
			'type=expense&period=range&from=2026-09-01&to=2026-09-15&wallet=w1&q=a b'
		);
		const href = riwayatHref(view);
		expect(href.startsWith('/riwayat?')).toBe(true);
		expect(parse(href.slice('/riwayat?'.length)).view).toEqual(view);
	});

	it('drops the type for "Semua" and adds a cursor only when given', () => {
		const { view } = parse('type=income');
		expect(riwayatHref(view, { type: null })).toBe('/riwayat?month=2026-10');
		expect(riwayatHref(view, {}, '2026-10-08.1.x')).toContain('cursor=2026-10-08.1.x');
	});

	it('maps a view to the aggregate filter (an empty search is no search)', () => {
		expect(viewFilter(parse('').view)).toEqual({
			from: '2026-10-01',
			to: '2026-10-31',
			type: null,
			categoryId: null,
			walletId: null,
			q: null,
			recurringOnly: false
		});
	});
});

describe('the "Aktif berulang" chip (FN-36)', () => {
	it('reads berulang=1 only, writes it back and keeps it across the other filters', () => {
		const { view } = parse('berulang=1&type=expense');
		expect(view.recurring).toBe(true);
		expect(viewFilter(view).recurringOnly).toBe(true);
		expect(riwayatHref(view)).toBe('/riwayat?type=expense&month=2026-10&berulang=1');
		expect(riwayatHref(view, { recurring: false })).toBe('/riwayat?type=expense&month=2026-10');
		for (const v of ['0', 'true', 'ya', ''])
			expect(parse(`berulang=${v}`).view.recurring).toBe(false);
		expect(parse(riwayatHref(view).slice('/riwayat?'.length)).view).toEqual(view);
	});
});

describe('the Transfer type chip', () => {
	it('reads type=transfer and writes it back', () => {
		const { view } = parse('type=transfer');
		expect(view.type).toBe('transfer');
		expect(riwayatHref(view)).toBe('/riwayat?type=transfer&month=2026-10');
		expect(viewFilter(view).type).toBe('transfer');
	});
});

describe('period chips (APP_PARITY § 3)', () => {
	const viewOf = (changes: Record<string, unknown>) => ({ ...parse('').view, ...changes });

	it('cover this month, 30 and 90 days, the year to date and the last 366 days, all ending today', () => {
		const presets = Object.fromEntries(periodPresets(TODAY).map((p) => [p.id, p.changes]));
		expect(presets.month).toMatchObject({ period: 'month', month: '2026-10' });
		expect(presets.d30).toEqual({ period: 'range', from: '2026-09-09', to: TODAY });
		expect(presets.d90).toEqual({ period: 'range', from: '2026-07-11', to: TODAY });
		expect(presets.year).toEqual({ period: 'range', from: '2026-01-01', to: TODAY });
		expect(presets.d366).toEqual({ period: 'range', from: '2025-10-08', to: TODAY });
	});

	it('every preset is a period the list accepts as is (never cut, never refused)', () => {
		for (const { changes } of periodPresets(TODAY)) {
			const href = riwayatHref(viewOf(changes));
			const { view } = parseRiwayatQuery(new URL(href, 'http://x').searchParams, TODAY);
			expect(presetOf(view, TODAY)).not.toBeNull();
			expect({ from: view.from, to: view.to }).toEqual({
				from: changes.from ?? '2026-10-01',
				to: changes.to ?? '2026-10-31'
			});
		}
	});

	it('names the chip a view matches; another month or a custom range matches none', () => {
		expect(presetOf(parse('').view, TODAY)).toBe('month');
		expect(presetOf(parse('period=range&from=2026-09-09&to=2026-10-08').view, TODAY)).toBe('d30');
		expect(presetOf(parse('month=2026-09').view, TODAY)).toBeNull();
		expect(presetOf(parse('period=range&from=2026-09-01&to=2026-09-03').view, TODAY)).toBeNull();
	});
});
