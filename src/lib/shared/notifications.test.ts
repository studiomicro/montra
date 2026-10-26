import { describe, expect, it } from 'vitest';
import { createTranslator } from './i18n';
import {
	CLOSE_REMINDER_DEFAULT_HOUR,
	CLOSE_REMINDER_HOURS,
	closeReminderDataKey,
	parseReminderHour,
	billGroupDataKey,
	budgetDataKey,
	budgetThreshold,
	goalDataKey,
	goalThreshold,
	isQuietHour,
	lastWeekRange,
	notificationText,
	notificationUrl,
	nudgeDataKey,
	parseParams,
	prefsFrom,
	tickPlan,
	weekStart,
	weeklyDataKey,
	wibWeekday
} from './notifications';

const utc = (iso: string) => Date.parse(iso);
/** formatMoney puts a no-break space after the symbol. */
const nb = (text: string) => text.replace(/Rp /g, 'Rp\u00a0');

describe('budgetThreshold (exact, BigInt)', () => {
	it('fires 80 at exactly 80 % and 100 at exactly the budget, never before', () => {
		expect(budgetThreshold(0, 1_000_000)).toBeNull();
		expect(budgetThreshold(799_999, 1_000_000)).toBeNull();
		expect(budgetThreshold(800_000, 1_000_000)).toBe(80);
		expect(budgetThreshold(999_999, 1_000_000)).toBe(80);
		expect(budgetThreshold(1_000_000, 1_000_000)).toBe(100);
		expect(budgetThreshold(5_000_000, 1_000_000)).toBe(100);
	});

	it('rounds nothing: 80 % of an odd budget is reached only by the exact product', () => {
		// 80 % of 3 is 2.4: 2 is below, 3 is the whole budget.
		expect(budgetThreshold(2, 3)).toBeNull();
		expect(budgetThreshold(3, 3)).toBe(100);
		expect(budgetThreshold(4, 5)).toBe(80);
	});

	it('handles amounts near 2^53 without float error, and "too large" (null) is past every budget', () => {
		const max = Number.MAX_SAFE_INTEGER;
		expect(budgetThreshold(max, max)).toBe(100);
		expect(budgetThreshold(max - 1, max)).toBe(80);
		expect(budgetThreshold(null, 1_000)).toBe(100);
	});

	it('a missing or invalid budget never fires', () => {
		expect(budgetThreshold(10, 0)).toBeNull();
		expect(budgetThreshold(10, -5)).toBeNull();
	});
});

describe('goalThreshold', () => {
	it('picks the highest milestone reached', () => {
		expect(goalThreshold(0)).toBeNull();
		expect(goalThreshold(49)).toBeNull();
		expect(goalThreshold(50)).toBe(50);
		expect(goalThreshold(99)).toBe(50);
		expect(goalThreshold(100)).toBe(100);
		expect(goalThreshold(180)).toBe(100);
	});
});

describe('dedupe keys', () => {
	it('encode the natural key: space + WIB month + threshold, goal + threshold, date, week', () => {
		expect(budgetDataKey('s1', '2026-10', 80)).toBe('budget:s1:2026-10:80');
		expect(budgetDataKey('s1', '2026-11', 80)).not.toBe(budgetDataKey('s1', '2026-10', 80));
		expect(goalDataKey('g1', 50)).toBe('goal:g1:50');
		expect(nudgeDataKey('2026-10-08')).toBe('nudge:2026-10-08');
		expect(weeklyDataKey('2026-10-12')).toBe('weekly:2026-10-12');
	});
});

describe('WIB schedule', () => {
	it('quiet hours are 00:00–05:59 WIB', () => {
		expect(isQuietHour(utc('2026-10-08T17:00:00Z'))).toBe(true); // 00:00 WIB
		expect(isQuietHour(utc('2026-10-08T22:59:59Z'))).toBe(true); // 05:59:59 WIB
		expect(isQuietHour(utc('2026-10-08T23:00:00Z'))).toBe(false); // 06:00 WIB
		expect(isQuietHour(utc('2026-10-09T16:59:59Z'))).toBe(false); // 23:59:59 WIB
	});

	it('weekdays and weeks follow the WIB calendar date', () => {
		expect(wibWeekday('2026-10-08')).toBe(4); // Thursday
		expect(wibWeekday('2026-10-12')).toBe(1); // Monday
		expect(weekStart('2026-10-11')).toBe('2026-10-05'); // Sunday belongs to the week before
		expect(weekStart('2026-10-12')).toBe('2026-10-12');
		expect(lastWeekRange('2026-10-12')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
		// Across a year boundary.
		expect(lastWeekRange('2026-01-05')).toEqual({ from: '2025-12-29', to: '2026-01-04' });
	});

	it('Monday 06:00 WIB is Sunday 23:00 UTC: the weekly summary uses the WIB day', () => {
		const plan = tickPlan(utc('2026-10-11T23:00:00Z'));
		expect(plan).toEqual({
			today: '2026-10-12',
			budgets: true,
			bills: true,
			recurring: true,
			nudge: false,
			closeReminder: true,
			budgetStreak: true,
			weekly: true
		});
	});

	it('the nudge may run from 07:00 WIB, the weekly summary all Monday (the cron cursor runs each once)', () => {
		expect(tickPlan(utc('2026-10-07T23:00:00Z'))).toMatchObject({ nudge: false, weekly: false });
		expect(tickPlan(utc('2026-10-08T00:00:00Z'))).toMatchObject({ nudge: true, weekly: false });
		expect(tickPlan(utc('2026-10-08T01:00:00Z'))).toMatchObject({ nudge: true, weekly: false });
		expect(tickPlan(utc('2026-10-12T01:00:00Z'))).toMatchObject({ nudge: true, weekly: true });
		expect(tickPlan(utc('2026-10-13T01:00:00Z'))).toMatchObject({ weekly: false });
	});

	it('nothing at all is planned in quiet hours (a manual or misfired tick)', () => {
		expect(tickPlan(utc('2026-10-08T20:00:00Z'))).toMatchObject({
			budgets: false,
			bills: false,
			recurring: false,
			nudge: false,
			closeReminder: false,
			budgetStreak: false,
			weekly: false
		});
	});

	it('23:30 WIB on the last day of a month is still that month; 00:30 WIB on the 1st is the next', () => {
		expect(tickPlan(utc('2026-10-31T16:30:00Z')).today).toBe('2026-10-31');
		expect(tickPlan(utc('2026-10-31T17:30:00Z')).today).toBe('2026-11-01');
	});
});

describe('preferences', () => {
	it('every kind is on without a row; stored rows win; unknown kinds are ignored', () => {
		expect(prefsFrom([])).toEqual({
			budget_80: true,
			budget_100: true,
			goal_milestone: true,
			bill_reminder: true,
			daily_nudge: true,
			close_reminder: true,
			weekly_summary: true
		});
		expect(
			prefsFrom([
				{ kind: 'daily_nudge', enabled: false },
				{ kind: 'mystery', enabled: false }
			])
		).toMatchObject({ daily_nudge: false, budget_80: true });
	});
});

describe('params and text', () => {
	const id = createTranslator('id');
	const en = createTranslator('en');

	it('parses only the shape a kind stores', () => {
		const budget = JSON.stringify({
			month: '2026-10',
			currency: 'IDR',
			budgetMinor: 100_000_000,
			spentMinor: 85_000_000
		});
		expect(parseParams('budget_80', budget)).toMatchObject({ spentMinor: 85_000_000 });
		expect(parseParams('budget_80', '{"month":"2026-10"}')).toBeNull();
		expect(parseParams('budget_80', 'not json')).toBeNull();
		expect(parseParams('budget_80', null)).toBeNull();
		expect(
			parseParams('budget_80', JSON.stringify({ ...JSON.parse(budget), spentMinor: 1.5 }))
		).toBeNull();
		expect(parseParams('daily_nudge', '{"date":"2026-10-08"}')).toEqual({ date: '2026-10-08' });
	});

	it('budget text is rupiah through formatMoney, in the reader’s language', () => {
		const params = {
			month: '2026-10',
			currency: 'IDR',
			budgetMinor: 100_000_000,
			spentMinor: 85_000_000
		};
		expect(notificationText('budget_80', params, id, 'Pribadi')).toEqual({
			title: 'Anggaran hampir habis',
			body: nb('Rp 850.000 dari Rp 1.000.000 sudah terpakai bulan ini · Pribadi')
		});
		expect(notificationText('budget_100', params, en, 'Personal')).toEqual({
			title: 'Budget used up',
			body: nb('Rp 850.000 of Rp 1.000.000 spent this month · Personal')
		});
		expect(notificationText('budget_100', { ...params, spentMinor: null }, id, 'X').body).toContain(
			'Total terlalu besar untuk ditampilkan'
		);
	});

	it('goal and weekly text', () => {
		const goal = {
			goalId: 'g1',
			name: 'Liburan',
			currency: 'IDR',
			threshold: 50 as const,
			savedMinor: 50_000_000,
			targetMinor: 100_000_000
		};
		expect(notificationText('goal_milestone', goal, id, 'Keluarga')).toEqual({
			title: 'Liburan: setengah jalan',
			body: nb('Rp 500.000 dari Rp 1.000.000 terkumpul · Keluarga')
		});
		expect(notificationText('goal_milestone', { ...goal, threshold: 100 }, en, 'X').title).toBe(
			'Liburan: goal reached'
		);
		const weekly = {
			from: '2026-10-05',
			to: '2026-10-11',
			currency: 'IDR',
			spentMinor: 12_345_600
		};
		expect(notificationText('weekly_summary', weekly, id, null).body).toBe(
			nb('Pengeluaran 5 Okt–11 Okt: Rp 123.456')
		);
	});

	it('links are fixed same-origin paths; a goal link only carries an id-shaped value', () => {
		expect(notificationUrl('budget_80', null)).toBe('/');
		expect(notificationUrl('weekly_summary', null)).toBe('/laporan');
		expect(notificationUrl('daily_nudge', null)).toBe('/riwayat/baru');
		const goal = (goalId: string) => ({
			goalId,
			name: 'x',
			currency: 'IDR',
			threshold: 50 as const,
			savedMinor: 1,
			targetMinor: 2
		});
		expect(notificationUrl('goal_milestone', goal('3f2a-11'))).toBe('/kekayaan/tabungan/3f2a-11');
		expect(notificationUrl('goal_milestone', goal('//evil.test'))).toBe('/dompet');
	});
});

describe('grouped bill reminders (FN-26, red team L1)', () => {
	it('parses and renders the grouped form without any subscription name', () => {
		const params = parseParams('bill_reminder', JSON.stringify({ count: 3, date: '2026-10-08' }));
		expect(params).toEqual({ count: 3, date: '2026-10-08' });
		expect(
			parseParams('bill_reminder', JSON.stringify({ count: 0, date: '2026-10-08' }))
		).toBeNull();
		expect(notificationText('bill_reminder', params, createTranslator('en'), 'Rumah')).toEqual({
			title: '3 more subscription bills are due soon',
			body: 'Rumah'
		});
		expect(notificationUrl('bill_reminder', params)).toBe('/langganan');
		expect(billGroupDataKey('s1', '2026-10-08')).toBe('bills:s1:2026-10-08');
	});
});

describe('evening close reminder (FN-34b)', () => {
	it('offers exactly the hours the jobs cron ticks on, 20:00 WIB by default', () => {
		expect([...CLOSE_REMINDER_HOURS]).toEqual([
			6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23
		]);
		expect(CLOSE_REMINDER_DEFAULT_HOUR).toBe(20);
	});

	it('a form hour is a whole hour 06–23 or refused (null), never clamped', () => {
		expect(parseReminderHour('20')).toBe(20);
		expect(parseReminderHour('06')).toBe(6);
		expect(parseReminderHour('6')).toBe(6);
		expect(parseReminderHour('23')).toBe(23);
		for (const bad of ['5', '0', '24', '-1', '20.5', '20:30', ' 20', '', 'abc', '1e1', '007'])
			expect(parseReminderHour(bad), bad).toBeNull();
	});

	it('one key per WIB date, text in both languages, opens /beruntun', () => {
		expect(closeReminderDataKey('2026-10-08')).toBe('close:2026-10-08');
		expect(parseParams('close_reminder', '{"date":"2026-10-08"}')).toEqual({ date: '2026-10-08' });
		expect(parseParams('close_reminder', '{"x":1}')).toBeNull();
		expect(notificationUrl('close_reminder', null)).toBe('/beruntun');
		const id = createTranslator('id');
		const en = createTranslator('en');
		expect(notificationText('close_reminder', null, id, null).title).toBe('Hari ini belum ditutup');
		expect(notificationText('close_reminder', null, en, null).title).toBe(
			'Today is not closed yet'
		);
	});

	it('the reminder and the budget-streak pass may run on every open tick, never in quiet hours', () => {
		expect(tickPlan(utc('2026-10-07T23:00:00Z'))).toMatchObject({
			closeReminder: true,
			budgetStreak: true
		});
		expect(tickPlan(utc('2026-10-08T13:00:00Z'))).toMatchObject({ closeReminder: true });
		expect(tickPlan(utc('2026-10-08T20:00:00Z'))).toMatchObject({
			closeReminder: false,
			budgetStreak: false
		});
	});
});
