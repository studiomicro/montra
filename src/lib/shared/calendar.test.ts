import { describe, expect, it } from 'vitest';
import {
	calendarDay,
	calendarHref,
	calendarMonth,
	calendarNeighbours,
	MAX_STEPS,
	upcomingInMonth,
	type DueSeries,
	type DueSubscription
} from './calendar';
import { followingCharge } from './subscriptions';

const THIS = '2026-10';

describe('calendarMonth (FN-54 criterion 19)', () => {
	it.each([
		[null, THIS],
		['', THIS],
		['2026-13', THIS],
		['abc', THIS],
		['2026-1', THIS],
		['x'.repeat(200), THIS],
		['2026-10-01', THIS],
		// 23 months back is the first allowed month; 24 back is out.
		['2024-11', '2024-11'],
		['2024-10', THIS],
		// 2 ahead is the last allowed month; 3 ahead is out.
		['2026-12', '2026-12'],
		['2027-01', THIS],
		['2026-09', '2026-09']
	])('%s → %s', (param, month) => {
		expect(calendarMonth(param, THIS)).toBe(month);
	});
});

describe('calendarDay (criterion 19)', () => {
	it.each([
		[null, null],
		['2026-10-31', '2026-10-31'],
		['2026-10-01', '2026-10-01'],
		['2026-11-01', null],
		['2026-09-30', null],
		['2026-10-32', null],
		['2026-10-1', null],
		['2026-10-31x', null],
		['<script>', null]
	])('%s in 2026-10 → %s', (param, day) => {
		expect(calendarDay(param, THIS)).toBe(day);
	});
});

describe('calendarNeighbours and calendarHref', () => {
	it('stops at the window ends', () => {
		expect(calendarNeighbours(THIS, THIS)).toEqual({ prev: '2026-09', next: '2026-11' });
		expect(calendarNeighbours('2026-12', THIS)).toEqual({ prev: '2026-11', next: null });
		expect(calendarNeighbours('2024-11', THIS)).toEqual({ prev: null, next: '2024-12' });
	});

	it('this month has no query; a day always names its month', () => {
		expect(calendarHref(THIS, THIS)).toBe('/kalender');
		expect(calendarHref('2026-09', THIS)).toBe('/kalender?bulan=2026-09');
		expect(calendarHref(THIS, THIS, '2026-10-05')).toBe('/kalender?bulan=2026-10&hari=2026-10-05');
	});
});

const sub = (over: Partial<DueSubscription> = {}): DueSubscription => ({
	id: 's1',
	name: 'Netflix',
	amountMinor: 186_000,
	currency: 'IDR',
	schedule: { cycle: 'monthly', day: 31, month: null },
	nextChargeOn: '2026-10-31',
	walletName: 'BCA',
	isDemo: false,
	...over
});
const series = (over: Partial<DueSeries> = {}): DueSeries => ({
	id: 'r1',
	type: 'expense',
	title: 'Kos',
	category: null,
	amountMinor: 1_500_000,
	currency: 'IDR',
	schedule: { frequency: 'weekly', day: 1 },
	startOn: '2026-01-01',
	endOn: null,
	nextRunOn: '2026-10-19',
	status: 'active',
	walletName: null,
	...over
});

describe('upcomingInMonth (criterion 22)', () => {
	it('a monthly day-31 charge lands where followingCharge puts it (30 Nov, 31 Dec)', () => {
		const today = '2026-10-13';
		expect(upcomingInMonth('2026-10', today, [sub()], []).map((i) => i.date)).toEqual([
			'2026-10-31'
		]);
		expect(upcomingInMonth('2026-11', today, [sub()], []).map((i) => i.date)).toEqual([
			followingCharge(sub().schedule, '2026-10-31')
		]);
		expect(upcomingInMonth('2026-11', today, [sub()], [])[0]?.date).toBe('2026-11-30');
		expect(upcomingInMonth('2026-12', today, [sub()], [])[0]?.date).toBe('2026-12-31');
	});

	it('a weekly active series shows every Monday from today on, never a past date', () => {
		const today = '2026-10-13'; // a Tuesday
		const dates = upcomingInMonth('2026-10', today, [], [series()]).map((i) => i.date);
		expect(dates).toEqual(['2026-10-19', '2026-10-26']);
		expect(dates.every((d) => d >= today)).toBe(true);
	});

	it('never projects a past month, a paused or a stopped series, or a run after end_on', () => {
		const today = '2026-10-13';
		expect(upcomingInMonth('2026-09', today, [sub()], [series()])).toEqual([]);
		expect(upcomingInMonth('2026-10', today, [], [series({ status: 'paused' })])).toEqual([]);
		expect(upcomingInMonth('2026-10', today, [], [series({ status: 'stopped' })])).toEqual([]);
		expect(
			upcomingInMonth('2026-10', today, [], [series({ endOn: '2026-10-20' })]).map((i) => i.date)
		).toEqual(['2026-10-19']);
	});

	it('a stale stored next run (the cron is behind) still starts from today', () => {
		const dates = upcomingInMonth(
			'2026-10',
			'2026-10-13',
			[],
			[series({ nextRunOn: '2026-10-05' })]
		).map((i) => i.date);
		expect(dates).toEqual(['2026-10-19', '2026-10-26']);
	});

	it('a due-today charge is listed today; demo subscriptions keep their flag; sorted by date', () => {
		const items = upcomingInMonth(
			'2026-10',
			'2026-10-13',
			[
				sub({
					id: 's2',
					nextChargeOn: '2026-10-13',
					schedule: { cycle: 'monthly', day: 13, month: null }
				}),
				sub({ isDemo: true })
			],
			[series({ type: 'income' })]
		);
		expect(items.map((i) => [i.date, i.id])).toEqual([
			['2026-10-13', 's2'],
			['2026-10-19', 'r1'],
			['2026-10-26', 'r1'],
			['2026-10-31', 's1']
		]);
		expect(items.at(-1)?.isDemo).toBe(true);
		expect(items[1]?.type).toBe('income');
	});

	it('bounded: at most MAX_STEPS charges per item', () => {
		// A weekly bill viewed two months ahead takes ~11 steps; the cap is far above, and never exceeded.
		const weekly = sub({
			schedule: { cycle: 'weekly', day: 3, month: null },
			nextChargeOn: '2026-10-14'
		});
		const dec = upcomingInMonth('2026-12', '2026-10-13', [weekly], []);
		expect(dec.length).toBeGreaterThan(0);
		expect(dec.length).toBeLessThanOrEqual(MAX_STEPS);
	});
});
