import { describe, expect, it } from 'vitest';
import {
	laporanHref,
	laporanRiwayatHref,
	parseLaporanQuery,
	periodRange,
	stepPeriod,
	switchMode,
	type LaporanView
} from './laporan-query';

const TODAY = '2026-10-08';
const q = (s: string, today = TODAY) => parseLaporanQuery(new URLSearchParams(s), today);
const month = (m: string, direction: 'keluar' | 'masuk' = 'keluar'): LaporanView => ({
	mode: 'bulan',
	month: m,
	direction
});
const year = (y: string, direction: 'keluar' | 'masuk' = 'keluar'): LaporanView => ({
	mode: 'tahun',
	year: y,
	direction
});

describe('parseLaporanQuery', () => {
	it('defaults to this WIB month and money out', () => {
		expect(q('')).toEqual(month('2026-10'));
	});

	it('reads a month, a year (which wins) and the direction', () => {
		expect(q('p=2026-03&arah=masuk')).toEqual(month('2026-03', 'masuk'));
		expect(q('y=2025')).toEqual(year('2025'));
		expect(q('y=2025&p=2026-03')).toEqual(year('2025'));
	});

	it('clamps the future to now and the past to the floor', () => {
		expect(q('p=2027-01')).toEqual(month('2026-10'));
		expect(q('y=2099')).toEqual(year('2026'));
		expect(q('p=1999-12')).toEqual(month('2026-10')); // outside the date helpers' 2000–2099: unparsable
		expect(q('y=1990')).toEqual(year('2000'));
	});

	it('keeps the old FN-09 links working', () => {
		expect(q('period=bulan-lalu')).toEqual(month('2026-09'));
		expect(q('period=bulan-lalu', '2027-01-01')).toEqual(month('2026-12'));
		expect(q('period=tahun-ini&arah=masuk')).toEqual(year('2026', 'masuk'));
	});

	it('anything else is this month, money out (never throws)', () => {
		for (const s of [
			'p=2026-13',
			'p=26-01',
			'y=20x6',
			'y=02026',
			'period=__proto__',
			'arah=semua',
			`p=${'x'.repeat(5000)}`
		])
			expect(q(s)).toEqual(month('2026-10'));
	});
});

describe('the Bulanan/Tahunan form field (m)', () => {
	it('switches the named period into the other mode; the same mode or junk changes nothing', () => {
		expect(q('p=2025-03&m=tahun&arah=masuk')).toEqual(year('2025', 'masuk'));
		expect(q('y=2024&m=bulan')).toEqual(month('2024-12'));
		expect(q('y=2026&m=bulan')).toEqual(month('2026-10'));
		expect(q('m=tahun')).toEqual(year('2026'));
		expect(q('y=2024&m=tahun')).toEqual(year('2024'));
		expect(q('p=2025-03&m=semua')).toEqual(month('2025-03'));
	});
});

describe('laporanHref', () => {
	it('this month, money out is plain /laporan; everything round-trips', () => {
		expect(laporanHref(month('2026-10'), TODAY)).toBe('/laporan');
		for (const v of [
			month('2026-09', 'masuk'),
			year('2026'),
			year('2024', 'masuk'),
			month('2026-10', 'masuk')
		]) {
			const href = laporanHref(v, TODAY);
			expect(q(new URL(href, 'http://x').searchParams.toString())).toEqual(v);
		}
		expect(laporanHref(year('2026'), TODAY)).toBe('/laporan?y=2026');
		expect(laporanHref(month('2026-09', 'masuk'), TODAY)).toBe('/laporan?p=2026-09&arah=masuk');
	});
});

describe('periodRange (WIB dates)', () => {
	it('a whole month (leap February too), a past year, this year through today', () => {
		expect(periodRange(month('2026-10'), TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
		expect(periodRange(month('2028-02'), '2028-03-31')).toEqual({
			from: '2028-02-01',
			to: '2028-02-29'
		});
		expect(periodRange(year('2025'), TODAY)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
		expect(periodRange(year('2027'), '2027-01-01')).toEqual({
			from: '2027-01-01',
			to: '2027-01-01'
		});
	});
});

describe('stepPeriod and switchMode', () => {
	it('steps across a year boundary; never into the future or past the floor', () => {
		expect(stepPeriod(month('2026-01'), -1, TODAY)).toEqual(month('2025-12'));
		expect(stepPeriod(month('2026-10'), 1, TODAY)).toBeNull();
		expect(stepPeriod(month('2000-01'), -1, TODAY)).toBeNull();
		expect(stepPeriod(year('2025', 'masuk'), 1, TODAY)).toEqual(year('2026', 'masuk'));
		expect(stepPeriod(year('2026'), 1, TODAY)).toBeNull();
		expect(stepPeriod(year('2000'), -1, TODAY)).toBeNull();
	});

	it('a month opens its year; a year opens its last month so far', () => {
		expect(switchMode(month('2025-03', 'masuk'), 'tahun', TODAY)).toEqual(year('2025', 'masuk'));
		expect(switchMode(year('2026'), 'bulan', TODAY)).toEqual(month('2026-10'));
		expect(switchMode(year('2024'), 'bulan', TODAY)).toEqual(month('2024-12'));
		expect(switchMode(year('2024'), 'tahun', TODAY)).toEqual(year('2024'));
	});
});

describe('laporanRiwayatHref', () => {
	it('the same dates and direction, optionally one category; no category filter for ""', () => {
		const range = { from: '2026-10-08', to: '2026-10-08' };
		expect(laporanRiwayatHref(range, 'keluar')).toBe(
			'/riwayat?type=expense&period=range&from=2026-10-08&to=2026-10-08'
		);
		expect(laporanRiwayatHref(range, 'masuk', 'c1')).toBe(
			'/riwayat?type=income&period=range&from=2026-10-08&to=2026-10-08&category=c1'
		);
		expect(laporanRiwayatHref(range, 'keluar', '')).not.toContain('category');
	});
});
