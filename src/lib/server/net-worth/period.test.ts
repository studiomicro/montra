import { describe, expect, it } from 'vitest';
import type { ReportPeriod } from '#lib/shared/report-period';
import {
	groupChanges,
	shapeNetWorthPeriod,
	type LiveNetWorth,
	type PeriodSnapshot
} from './period';

const Q3: ReportPeriod = { kind: 'kuartal', year: '2026', quarter: 3 };
const TODAY = '2026-10-13';
const JT = 100_000_000; // Rp 1.000.000 in sen

const snap = (
	date: string,
	totalMinor: number,
	over: Partial<PeriodSnapshot> = {}
): PeriodSnapshot => ({ date, totalMinor, partial: false, classes: null, ...over });

function shape(
	rows: PeriodSnapshot[],
	before: PeriodSnapshot | null,
	over: { period?: ReportPeriod; today?: string; live?: LiveNetWorth | null; since?: string } = {}
) {
	return shapeNetWorthPeriod({
		period: over.period ?? Q3,
		today: over.today ?? TODAY,
		rows,
		before,
		groupsSince: over.since ?? null,
		live: over.live ?? null
	});
}

describe('opening, closing and change (AC 19–22)', () => {
	it('Q3 2026 from the 30 June, 31 July, 31 August and 30 September snapshots', () => {
		const r = shape(
			[snap('2026-07-31', 110 * JT), snap('2026-08-31', 120 * JT), snap('2026-09-30', 130 * JT)],
			snap('2026-06-30', 100 * JT)
		);
		expect(r.opening).toEqual({ minor: 100 * JT, date: '2026-06-30', basis: 'exact' });
		expect(r.closing).toEqual({ minor: 130 * JT, date: '2026-09-30', live: false, partial: false });
		expect(r.changeMinor).toBe(30 * JT);
		expect(r.points).toEqual([
			{ key: 'awal', date: '2026-06-30', minor: 100 * JT, partial: false },
			{ key: '2026-07', date: '2026-07-31', minor: 110 * JT, partial: false },
			{ key: '2026-08', date: '2026-08-31', minor: 120 * JT, partial: false },
			{ key: '2026-09', date: '2026-09-30', minor: 130 * JT, partial: false }
		]);
		expect(r.empty).toBe(false);
	});

	it('an opening 4 days early is `earlier`; 15 days early is too old: the first snapshot inside ("sejak")', () => {
		const rows = [snap('2026-07-04', 105 * JT), snap('2026-09-30', 130 * JT)];
		expect(shape(rows, snap('2026-06-26', 100 * JT)).opening).toEqual({
			minor: 100 * JT,
			date: '2026-06-26',
			basis: 'earlier'
		});
		const late = shape(rows, snap('2026-06-15', 90 * JT));
		expect(late.opening).toEqual({ minor: 105 * JT, date: '2026-07-04', basis: 'since_start' });
		expect(late.changeMinor).toBe(25 * JT);
		// Exactly 7 days before the day before still counts.
		expect(shape(rows, snap('2026-06-23', 1)).opening?.basis).toBe('earlier');
		expect(shape(rows, snap('2026-06-22', 1)).opening?.basis).toBe('since_start');
	});

	it('no complete snapshot at all: no opening, no change (never zero)', () => {
		const r = shape([snap('2026-08-01', 5 * JT, { partial: true })], null);
		expect(r.opening).toBeNull();
		expect(r.closing).toBeNull();
		expect(r.changeMinor).toBeNull();
		expect(r.empty).toBe(false);
	});

	it('a snapshot before the period is never its closing value; one snapshot alone gives no change', () => {
		const old = shape([], snap('2026-06-30', 100 * JT));
		expect(old.opening?.basis).toBe('exact');
		expect(old.closing).toBeNull();
		expect(old.changeMinor).toBeNull();
		const one = shape([snap('2026-08-10', 100 * JT)], null);
		expect(one.opening).toBeNull();
		expect(one.closing?.date).toBe('2026-08-10');
		expect(one.changeMinor).toBeNull();
	});

	it('a partial snapshot is never opening or closing; it is still the month point, flagged', () => {
		const r = shape(
			[
				snap('2026-07-31', 110 * JT),
				snap('2026-09-28', 128 * JT),
				snap('2026-09-30', 1, { partial: true })
			],
			snap('2026-06-30', 100 * JT, { partial: true })
		);
		expect(r.opening).toEqual({ minor: 110 * JT, date: '2026-07-31', basis: 'since_start' });
		expect(r.closing?.date).toBe('2026-09-28');
		expect(r.points.at(-1)).toEqual({
			key: '2026-09',
			date: '2026-09-30',
			minor: 1,
			partial: true
		});
	});
});

describe('gaps and WIB boundaries (AC 23, 28)', () => {
	it('a month without a snapshot is a gap: no value, nothing carried into it', () => {
		const r = shape([snap('2026-07-31', 110 * JT), snap('2026-09-30', 130 * JT)], null);
		expect(r.points.map((p) => [p.key, p.minor])).toEqual([
			['awal', 110 * JT], // "sejak 31 Jul": the first complete snapshot inside the period
			['2026-07', 110 * JT],
			['2026-08', null],
			['2026-09', 130 * JT]
		]);
	});

	it('months before the first record are left out, never drawn as gaps; later gaps stay', () => {
		const year: ReportPeriod = { kind: 'tahun', year: '2026' };
		const today = '2026-12-15';
		// Records start on 11 October: a since-start opening, then October to December (November a gap).
		const started = shape([snap('2026-10-11', 129 * JT), snap('2026-12-14', 175 * JT)], null, {
			period: year,
			today
		});
		expect(started.opening).toEqual({ minor: 129 * JT, date: '2026-10-11', basis: 'since_start' });
		expect(started.points.map((p) => [p.key, p.minor])).toEqual([
			['awal', 129 * JT],
			['2026-10', 129 * JT],
			['2026-11', null],
			['2026-12', 175 * JT]
		]);
		// One snapshot only (no opening): only from its month on.
		const one = shape([snap('2026-11-20', 5 * JT)], null, { period: year, today });
		expect(one.points.map((p) => [p.key, p.minor])).toEqual([
			['awal', null],
			['2026-11', 5 * JT],
			['2026-12', null]
		]);
		// Nothing recorded: the last month alone.
		expect(shape([], null, { period: year, today }).points.map((p) => p.key)).toEqual([
			'awal',
			'2026-12'
		]);
		// An opening from before the period keeps every month, gaps included.
		const exact = shape([snap('2026-12-14', 175 * JT)], snap('2025-12-31', 100 * JT), {
			period: year,
			today
		});
		expect(exact.points).toHaveLength(13);
	});

	it('31 Dec belongs to Q4 / 2026 and 1 Jan to Q1 / 2027', () => {
		const rows = [
			snap('2026-12-31', 7 * JT),
			snap('2027-01-01', 8 * JT),
			snap('2027-03-31', 9 * JT)
		];
		const today = '2027-06-01';
		const q4 = shape(
			rows.filter((r) => r.date <= '2026-12-31'),
			snap('2026-09-30', 6 * JT),
			{ period: { kind: 'kuartal', year: '2026', quarter: 4 }, today }
		);
		expect(q4.closing?.date).toBe('2026-12-31');
		expect(q4.points.at(-1)).toMatchObject({ key: '2026-12', date: '2026-12-31', minor: 7 * JT });
		const year2026 = shape(
			rows.filter((r) => r.date <= '2026-12-31'),
			null,
			{ period: { kind: 'tahun', year: '2026' }, today }
		);
		expect(year2026.points.at(-1)).toMatchObject({ key: '2026-12', minor: 7 * JT });
		// Q1 2027 opens on 31 Dec (exact) and its January point is the 1 January value.
		const q1 = shape(
			rows.filter((r) => r.date >= '2027-01-01'),
			snap('2026-12-31', 7 * JT),
			{ period: { kind: 'kuartal', year: '2027', quarter: 1 }, today }
		);
		expect(q1.opening).toEqual({ minor: 7 * JT, date: '2026-12-31', basis: 'exact' });
		expect(q1.points[1]).toMatchObject({ key: '2027-01', date: '2027-01-01', minor: 8 * JT });
		expect(q1.changeMinor).toBe(2 * JT);
		const year2027 = shape(
			rows.filter((r) => r.date >= '2027-01-01'),
			snap('2026-12-31', 7 * JT),
			{ period: { kind: 'tahun', year: '2027' }, today }
		);
		expect(year2027.opening?.date).toBe('2026-12-31');
	});

	it('rows outside the period passed in by mistake are ignored', () => {
		const r = shape([snap('2026-06-30', 1), snap('2026-10-01', 2)], null);
		expect(r.closing).toBeNull();
		expect(r.empty).toBe(true);
	});
});

describe('the live value of a running period (AC 24, 29, 30)', () => {
	const live = (over: Partial<LiveNetWorth> = {}): LiveNetWorth => ({
		totalMinor: 150 * JT,
		classes: [{ cls: 'wallets', minor: 150 * JT }],
		partial: false,
		rates: [],
		hasDemo: false,
		...over
	});
	const Q4: ReportPeriod = { kind: 'kuartal', year: '2026', quarter: 4 };

	it('closes with the live total ("sekarang"), which is also the current month point', () => {
		const r = shape([snap('2026-10-05', 140 * JT)], snap('2026-09-30', 130 * JT), {
			period: Q4,
			live: live({ partial: true })
		});
		expect(r.closing).toEqual({ minor: 150 * JT, date: TODAY, live: true, partial: true });
		expect(r.changeMinor).toBe(20 * JT);
		expect(r.points.at(-1)).toEqual({
			key: '2026-10',
			date: TODAY,
			minor: 150 * JT,
			partial: true
		});
	});

	it('a live value is ignored for a past period', () => {
		const r = shape([snap('2026-09-30', 130 * JT)], null, { live: live() });
		expect(r.closing?.live).toBe(false);
	});

	it('foreign rates show only when the live total used one', () => {
		const rates = [{ currency: 'USD', rate: '16000', date: '2026-10-12' }];
		expect(shape([], null, { period: Q4, live: live({ rates }) }).rates).toEqual(rates);
		expect(shape([], null, { period: Q4, live: live() }).rates).toBeNull();
	});

	it('only demo items: no live class, no snapshot: the empty state, badged', () => {
		const r = shape([], null, {
			period: Q4,
			live: live({ totalMinor: 0, classes: [], hasDemo: true })
		});
		expect(r.empty).toBe(true);
		expect(r.hasDemo).toBe(true);
	});

	it('the opening is never today’s own snapshot against the live total', () => {
		const r = shape([snap(TODAY, 140 * JT)], null, { period: Q4, live: live() });
		expect(r.opening).toBeNull();
		expect(r.changeMinor).toBeNull();
	});
});

describe('change by group (AC 25, 26)', () => {
	it('rows sum to the total change exactly, unchanged groups omitted, largest change first', () => {
		// Values whose float sum would drift: 0.1 + 0.2 style sen amounts at 2^53 scale.
		const big = 4_503_599_627_370_497;
		const opening = new Map([
			['wallets', BigInt(big)],
			['gold', 300n],
			['debt', -1_000n],
			['cash', 50n]
		]);
		const closing = new Map([
			['wallets', BigInt(big + 3)],
			['gold', 100n],
			['debt', -400n],
			['cash', 50n],
			['crypto', 7n]
		]);
		const rows = groupChanges(opening, closing);
		expect(rows.map((r) => [r.cls, r.changeMinor])).toEqual([
			['debt', 600],
			['gold', -200],
			['crypto', 7],
			['wallets', 3]
		]);
		expect(rows.find((r) => r.cls === 'crypto')).toMatchObject({
			openingMinor: 0,
			closingMinor: 7
		});
		const total = rows.reduce((s, r) => s + BigInt(r.changeMinor!), 0n);
		const sum = (m: Map<string, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n);
		expect(total).toBe(sum(closing) - sum(opening));
	});

	it('an unknown class key is shown as "other", never dropped', () => {
		const rows = groupChanges(
			new Map([['wallets', 10n]]),
			new Map([
				['wallets', 10n],
				['saham_asing', 5n]
			])
		);
		expect(rows).toEqual([{ cls: 'other', openingMinor: 0, closingMinor: 5, changeMinor: 5 }]);
	});

	it('both ends with classes: groups; either end without: null with the "tersedia mulai" date', () => {
		const withClasses = (date: string, w: number, g: number) =>
			snap(date, w + g, { classes: JSON.stringify({ wallets: w, gold: g }) });
		const both = shape([withClasses('2026-09-30', 120, 30)], withClasses('2026-06-30', 100, 10));
		expect(both.changeMinor).toBe(40);
		expect(both.groups).toEqual([
			{ cls: 'wallets', openingMinor: 100, closingMinor: 120, changeMinor: 20 },
			{ cls: 'gold', openingMinor: 10, closingMinor: 30, changeMinor: 20 }
		]);
		const oldStart = shape([withClasses('2026-09-30', 120, 30)], snap('2026-06-30', 110), {
			since: '2026-08-02'
		});
		expect(oldStart.changeMinor).toBe(40);
		expect(oldStart.groups).toBeNull();
		expect(oldStart.groupsSince).toBe('2026-08-02');
	});

	it('malformed classes JSON is no group split, never a guess', () => {
		for (const bad of ['[1,2]', '{"wallets":1.5}', '{"wallets":"7"}', 'nope'])
			expect(
				shape([snap('2026-09-30', 2, { classes: bad })], snap('2026-06-30', 1, { classes: '{}' }))
					.groups
			).toBeNull();
	});
});
