import { describe, expect, it } from 'vitest';
import { wibDateString } from './dates';
import { createTranslator } from './i18n';
import { nextChargeOn } from './subscriptions';
import {
	followingRun,
	isValidRecurringSchedule,
	nextRunOn,
	recurringDedupeKey,
	restartRunOn,
	scheduleLabel
} from './recurring';

const monthly = (day: number) => ({ frequency: 'monthly' as const, day });
const weekly = (day: number) => ({ frequency: 'weekly' as const, day });

describe('recurring schedule (FN-36)', () => {
	it('validates the day per frequency', () => {
		expect(isValidRecurringSchedule(monthly(1))).toBe(true);
		expect(isValidRecurringSchedule(monthly(31))).toBe(true);
		expect(isValidRecurringSchedule(monthly(0))).toBe(false);
		expect(isValidRecurringSchedule(monthly(32))).toBe(false);
		expect(isValidRecurringSchedule(weekly(7))).toBe(true);
		expect(isValidRecurringSchedule(weekly(8))).toBe(false);
		expect(isValidRecurringSchedule(monthly(1.5))).toBe(false);
		expect(() => nextRunOn(weekly(9), '2026-10-08')).toThrow(RangeError);
	});

	it('day 12 monthly: the 12th of this month, then the 12th of the next', () => {
		expect(nextRunOn(monthly(12), '2026-10-08')).toBe('2026-10-12');
		expect(nextRunOn(monthly(12), '2026-10-12')).toBe('2026-10-12');
		expect(followingRun(monthly(12), '2026-10-12')).toBe('2026-11-12');
		expect(followingRun(monthly(12), '2026-12-12')).toBe('2027-01-12');
	});

	it('day 31 clamps to short months, then returns to 31 (criterion 3)', () => {
		const s = monthly(31);
		const runs = ['2026-01-31'];
		for (let i = 0; i < 6; i++) runs.push(followingRun(s, runs.at(-1)!));
		expect(runs).toEqual([
			'2026-01-31',
			'2026-02-28',
			'2026-03-31',
			'2026-04-30',
			'2026-05-31',
			'2026-06-30',
			'2026-07-31'
		]);
		// Leap year February.
		expect(followingRun(s, '2028-01-31')).toBe('2028-02-29');
	});

	it('days 29 and 30 clamp in February only', () => {
		expect(followingRun(monthly(29), '2027-01-29')).toBe('2027-02-28');
		expect(followingRun(monthly(29), '2027-02-28')).toBe('2027-03-29');
		expect(followingRun(monthly(29), '2028-01-29')).toBe('2028-02-29');
		expect(followingRun(monthly(30), '2026-01-30')).toBe('2026-02-28');
		expect(followingRun(monthly(30), '2026-02-28')).toBe('2026-03-30');
	});

	it('is the same rule as subscription billing (one implementation)', () => {
		for (const day of [1, 15, 28, 29, 30, 31])
			for (const from of ['2026-02-01', '2026-02-27', '2028-02-28', '2026-12-31'])
				expect(nextRunOn(monthly(day), from)).toBe(
					nextChargeOn({ cycle: 'monthly', day, month: null }, from)
				);
	});

	it('weekly: the next given ISO weekday on or after the date', () => {
		// 2026-10-08 is a Thursday (4).
		expect(nextRunOn(weekly(4), '2026-10-08')).toBe('2026-10-08');
		expect(nextRunOn(weekly(1), '2026-10-08')).toBe('2026-10-12');
		expect(followingRun(weekly(4), '2026-10-08')).toBe('2026-10-15');
		// Across a month and a year end.
		expect(followingRun(weekly(4), '2026-12-31')).toBe('2027-01-07');
	});

	it('restart never backfills: the first run on or after both the start and today', () => {
		expect(restartRunOn(monthly(5), '2026-01-01', '2026-10-08')).toBe('2026-11-05');
		expect(restartRunOn(monthly(12), '2026-10-01', '2026-10-08')).toBe('2026-10-12');
		expect(restartRunOn(monthly(5), '2026-12-01', '2026-10-08')).toBe('2026-12-05');
		expect(restartRunOn(monthly(8), '2026-10-08', '2026-10-08')).toBe('2026-10-08');
	});

	it('WIB boundary instants map to the right run date (criterion 11)', () => {
		// 23:30 WIB on 31 October is still 31 October; 00:30 WIB on 1 November is 1 November.
		const lastEvening = wibDateString(Date.parse('2026-10-31T16:30:00Z'));
		const firstNight = wibDateString(Date.parse('2026-10-31T17:30:00Z'));
		expect(lastEvening).toBe('2026-10-31');
		expect(firstNight).toBe('2026-11-01');
		expect(nextRunOn(monthly(31), lastEvening)).toBe('2026-10-31');
		expect(nextRunOn(monthly(1), lastEvening)).toBe('2026-11-01');
		expect(nextRunOn(monthly(31), firstNight)).toBe('2026-11-30');
		expect(nextRunOn(monthly(1), firstNight)).toBe('2026-11-01');
	});

	it('one dedupe key per series and date', () => {
		expect(recurringDedupeKey('abc', '2026-10-12')).toBe('recurring:abc:2026-10-12');
	});

	it('labels the schedule in both languages', () => {
		const id = createTranslator('id');
		const en = createTranslator('en');
		expect(scheduleLabel(monthly(12), id)).toBe('Tiap tanggal 12');
		expect(scheduleLabel(weekly(1), id)).toBe('Tiap minggu pada Senin');
		expect(scheduleLabel(monthly(12), en)).toBe('Every month on day 12');
		expect(scheduleLabel(weekly(1), en)).toBe('Every week on Monday');
	});
});
