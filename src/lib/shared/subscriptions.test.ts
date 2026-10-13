import { describe, expect, it } from 'vitest';
import { isDateString, monthRange, wibDateString } from './dates';
import {
	billReminderDataKey,
	effectiveNextCharge,
	followingCharge,
	isBillReminderDue,
	isoWeekday,
	isValidSchedule,
	monthlyTotals,
	nextChargeOn,
	type BillingSchedule
} from './subscriptions';
import {
	catalogueEntry,
	isSubscriptionCategory,
	SUBSCRIPTION_CATALOGUE,
	SUBSCRIPTION_CATEGORIES
} from './subscriptions-catalogue';

const monthly = (day: number): BillingSchedule => ({ cycle: 'monthly', day, month: null });
const weekly = (day: number): BillingSchedule => ({ cycle: 'weekly', day, month: null });
const yearly = (month: number, day: number): BillingSchedule => ({ cycle: 'yearly', day, month });

describe('isValidSchedule', () => {
	it.each([
		[monthly(1), true],
		[monthly(31), true],
		[monthly(0), false],
		[monthly(32), false],
		[monthly(1.5), false],
		[{ cycle: 'monthly', day: 5, month: 2 } as BillingSchedule, false],
		[weekly(1), true],
		[weekly(7), true],
		[weekly(8), false],
		[weekly(0), false],
		[yearly(2, 29), true],
		[yearly(2, 30), false],
		[yearly(4, 31), false],
		[yearly(12, 31), true],
		[yearly(13, 1), false],
		[{ cycle: 'yearly', day: 1, month: null } as BillingSchedule, false]
	])('%j → %s', (schedule, ok) => {
		expect(isValidSchedule(schedule)).toBe(ok);
	});

	it('nextChargeOn refuses an invalid schedule', () => {
		expect(() => nextChargeOn(monthly(32), '2026-10-08')).toThrow(RangeError);
	});
});

describe('nextChargeOn: monthly, month-end clamp (AC3)', () => {
	// Billing day 31 from the 1st of every month of a non-leap (2026/2027) and a leap (2028) year: always that
	// month's last real day, never an invalid date.
	const lastDays: [string, string][] = [
		['2026-01', '2026-01-31'],
		['2026-02', '2026-02-28'],
		['2026-03', '2026-03-31'],
		['2026-04', '2026-04-30'],
		['2026-05', '2026-05-31'],
		['2026-06', '2026-06-30'],
		['2026-07', '2026-07-31'],
		['2026-08', '2026-08-31'],
		['2026-09', '2026-09-30'],
		['2026-10', '2026-10-31'],
		['2026-11', '2026-11-30'],
		['2026-12', '2026-12-31'],
		['2028-02', '2028-02-29'],
		['2100-02', '2100-02-28']
	];
	it.each(lastDays)('day 31 in %s → %s', (month, expected) => {
		expect(nextChargeOn(monthly(31), `${month}-01`)).toBe(expected);
		expect(nextChargeOn(monthly(31), expected)).toBe(expected);
	});

	it.each([
		[29, '2026-02-01', '2026-02-28'],
		[29, '2028-02-01', '2028-02-29'],
		[30, '2026-02-01', '2026-02-28'],
		[30, '2028-02-15', '2028-02-29'],
		[30, '2026-04-01', '2026-04-30'],
		[28, '2026-02-01', '2026-02-28']
	])('day %i from %s → %s', (day, from, expected) => {
		expect(nextChargeOn(monthly(day), from)).toBe(expected);
	});

	it('every result for every billing day across four years is a real calendar date', () => {
		for (let day = 1; day <= 31; day++) {
			let at = '2026-01-01';
			for (let i = 0; i < 48; i++) {
				const next = nextChargeOn(monthly(day), at);
				expect(isDateString(next), `${day} ${at}`).toBe(true);
				expect(next >= at).toBe(true);
				const { to } = monthRange(next.slice(0, 7));
				expect(Number(next.slice(8))).toBe(Math.min(day, Number(to.slice(8))));
				at = followingCharge(monthly(day), next);
			}
		}
	});

	it('a charge day already passed this month moves to next month, across the year end', () => {
		expect(nextChargeOn(monthly(5), '2026-10-08')).toBe('2026-11-05');
		expect(nextChargeOn(monthly(8), '2026-10-08')).toBe('2026-10-08');
		expect(nextChargeOn(monthly(5), '2026-12-20')).toBe('2027-01-05');
		expect(nextChargeOn(monthly(31), '2026-01-31')).toBe('2026-01-31');
		// After a clamped 28 February the following charge is 31 March again, not 28 March.
		expect(followingCharge(monthly(31), '2026-02-28')).toBe('2026-03-31');
		expect(followingCharge(monthly(31), '2026-01-31')).toBe('2026-02-28');
		expect(followingCharge(monthly(31), '2026-12-31')).toBe('2027-01-31');
	});
});

describe('nextChargeOn: yearly', () => {
	it.each([
		[yearly(3, 15), '2026-10-08', '2027-03-15'],
		[yearly(12, 25), '2026-10-08', '2026-12-25'],
		[yearly(10, 8), '2026-10-08', '2026-10-08'],
		[yearly(2, 29), '2026-01-01', '2026-02-28'],
		[yearly(2, 29), '2027-03-01', '2028-02-29'],
		[yearly(2, 29), '2028-02-29', '2028-02-29'],
		[yearly(1, 1), '2026-12-31', '2027-01-01']
	])('%j from %s → %s', (schedule, from, expected) => {
		expect(nextChargeOn(schedule, from)).toBe(expected);
	});

	it('following a leap-day charge lands on the next year’s last day of February', () => {
		expect(followingCharge(yearly(2, 29), '2028-02-29')).toBe('2029-02-28');
		expect(followingCharge(yearly(2, 29), '2031-02-28')).toBe('2032-02-29');
	});
});

describe('nextChargeOn: weekly (ISO weekday, Monday = 1)', () => {
	// 2026-10-08 is a Thursday (ISO 4).
	it.each([
		[4, '2026-10-08'],
		[5, '2026-10-09'],
		[7, '2026-10-11'],
		[1, '2026-10-12'],
		[3, '2026-10-14']
	])('weekday %i from Thursday 2026-10-08 → %s', (day, expected) => {
		expect(nextChargeOn(weekly(day), '2026-10-08')).toBe(expected);
	});

	it('isoWeekday', () => {
		expect(isoWeekday('2026-10-05')).toBe(1);
		expect(isoWeekday('2026-10-08')).toBe(4);
		expect(isoWeekday('2026-10-11')).toBe(7);
		expect(isoWeekday('1969-12-29')).toBe(1);
	});

	it('crosses month and year ends', () => {
		expect(nextChargeOn(weekly(1), '2026-12-29')).toBe('2027-01-04');
		expect(followingCharge(weekly(4), '2026-10-29')).toBe('2026-11-05');
	});
});

describe('effectiveNextCharge (AC4: never stale)', () => {
	it('recomputes a stored date that is today or past from the schedule and today', () => {
		expect(effectiveNextCharge(monthly(5), '2026-08-05', '2026-10-08')).toBe('2026-11-05');
		expect(effectiveNextCharge(monthly(8), '2026-09-08', '2026-10-08')).toBe('2026-10-08');
		expect(effectiveNextCharge(monthly(8), '2026-10-08', '2026-10-08')).toBe('2026-10-08');
	});

	it('keeps a future stored date (a charge already marked paid)', () => {
		expect(effectiveNextCharge(monthly(8), '2026-11-08', '2026-10-08')).toBe('2026-11-08');
		expect(effectiveNextCharge(yearly(1, 1), '2028-01-01', '2026-10-08')).toBe('2028-01-01');
	});

	it('moves a future stored date that is not an occurrence to the next one', () => {
		expect(effectiveNextCharge(monthly(20), '2026-11-08', '2026-10-08')).toBe('2026-11-20');
	});

	it('uses the WIB date: 23:30 WIB on 31 October is still October', () => {
		const lateOct = Date.UTC(2026, 9, 31, 16, 30); // 23:30 WIB, 31 Oct
		const earlyNov = Date.UTC(2026, 9, 31, 17, 30); // 00:30 WIB, 1 Nov
		expect(effectiveNextCharge(monthly(31), '2026-09-30', wibDateString(lateOct))).toBe(
			'2026-10-31'
		);
		expect(effectiveNextCharge(monthly(31), '2026-10-31', wibDateString(earlyNov))).toBe(
			'2026-11-30'
		);
	});
});

describe('bill reminder window', () => {
	it('is due from daysBefore ahead through the charge day, never after', () => {
		expect(isBillReminderDue('2026-10-10', 2, '2026-10-07')).toBe(false);
		expect(isBillReminderDue('2026-10-10', 2, '2026-10-08')).toBe(true);
		expect(isBillReminderDue('2026-10-10', 2, '2026-10-10')).toBe(true);
		expect(isBillReminderDue('2026-10-10', 2, '2026-10-11')).toBe(false);
		expect(isBillReminderDue('2026-10-10', 0, '2026-10-09')).toBe(false);
		expect(isBillReminderDue('2026-10-10', 0, '2026-10-10')).toBe(true);
	});

	it('keys one reminder per subscription and charge date', () => {
		expect(billReminderDataKey('s1', '2026-10-10')).toBe('bill:s1:2026-10-10');
		expect(billReminderDataKey('s1', '2026-11-10')).not.toBe(
			billReminderDataKey('s1', '2026-10-10')
		);
	});
});

describe('monthlyTotals (AC7)', () => {
	it('normalises yearly ÷ 12 and weekly × 52 ÷ 12, floored once, per currency', () => {
		expect(
			monthlyTotals([
				{ amountMinor: 18_600_000, currency: 'IDR', cycle: 'monthly' },
				{ amountMinor: 1_200_000_00, currency: 'IDR', cycle: 'yearly' },
				{ amountMinor: 10_000_00, currency: 'IDR', cycle: 'weekly' },
				{ amountMinor: 999, currency: 'USD', cycle: 'monthly' },
				{ amountMinor: 100, currency: 'EUR', cycle: 'yearly' }
			])
		).toEqual([
			// 186.000 + 100.000 + 10.000 × 52 / 12 (43.333,33…) = 329.333,33 → floored in sen.
			{ currency: 'IDR', totalMinor: 32_933_333 },
			{ currency: 'EUR', totalMinor: 8 },
			{ currency: 'USD', totalMinor: 999 }
		]);
	});

	it('is empty without subscriptions', () => {
		expect(monthlyTotals([])).toEqual([]);
	});

	it('is exact past 2^53 in the intermediate sum and null when the total itself is unsafe', () => {
		const cap = 10_000_000_000_000;
		const many = Array.from({ length: 100 }, () => ({
			amountMinor: cap,
			currency: 'IDR',
			cycle: 'weekly' as const
		}));
		// 100 × 10^13 × 52 / 12 = 4,333… × 10^15 (safe).
		expect(monthlyTotals(many)).toEqual([{ currency: 'IDR', totalMinor: 4_333_333_333_333_333 }]);
		const huge = Array.from({ length: 1000 }, () => many[0]!);
		expect(monthlyTotals(huge)).toEqual([{ currency: 'IDR', totalMinor: null }]);
	});
});

describe('catalogue (brand safety)', () => {
	it('has unique ids and names, known categories, and nothing but plain text', () => {
		const ids = SUBSCRIPTION_CATALOGUE.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(SUBSCRIPTION_CATALOGUE.map((e) => e.name)).size).toBe(ids.length);
		for (const entry of SUBSCRIPTION_CATALOGUE) {
			expect(Object.keys(entry).sort()).toEqual(['category', 'id', 'name']);
			expect(isSubscriptionCategory(entry.category)).toBe(true);
			expect(entry.id).toMatch(/^[a-z0-9-]{1,40}$/);
			expect(entry.name).not.toMatch(/https?:|\.(png|svg|jpe?g|webp)|</i);
		}
		expect(SUBSCRIPTION_CATALOGUE.length).toBeGreaterThanOrEqual(20);
		expect(SUBSCRIPTION_CATALOGUE.length).toBeLessThan(100);
	});

	it('finds entries by id only', () => {
		expect(catalogueEntry('netflix')?.name).toBe('Netflix');
		// FN-39 memberships: name and a bills-like category only, never a price.
		for (const [id, name] of [
			['gopay-plus', 'GoPay Plus'],
			['gofood-plus', 'GoFood Plus'],
			['grabunlimited', 'GrabUnlimited']
		] as const)
			expect(catalogueEntry(id)).toEqual({ id, name, category: 'lainnya' });
		expect(SUBSCRIPTION_CATEGORIES.lainnya.tileKey).toBe('tagihan');
		expect(catalogueEntry('gopay')).toBeNull();
		expect(catalogueEntry('constructor')).toBeNull();
		expect(catalogueEntry('')).toBeNull();
		expect(isSubscriptionCategory('__proto__')).toBe(false);
	});

	it('maps every category to an FN-06 preset expense tile', () => {
		for (const c of Object.values(SUBSCRIPTION_CATEGORIES))
			expect(['hiburan', 'tagihan', 'pendidikan']).toContain(c.tileKey);
	});
});
