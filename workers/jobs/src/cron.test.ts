import { describe, expect, it, vi } from 'vitest';
import type { JobMessage } from '#lib/shared/jobs';
import {
	cronUtcHours,
	JOBS_CRON,
	MAX_PAGES_PER_TICK,
	runCronTick,
	utcToWibHours,
	type CronDeps
} from './cron';

describe('jobs cron', () => {
	it('parses the hour field', () => {
		expect(cronUtcHours('0 23,0-16 * * *')).toEqual([
			0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 23
		]);
	});

	it('runs hourly from 06:00 to 23:00 WIB exactly', () => {
		const wib = utcToWibHours(cronUtcHours(JOBS_CRON));
		expect(wib).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
	});

	it('the wrangler config uses the same expression', async () => {
		const { readFileSync } = await import('node:fs');
		expect(readFileSync('workers/jobs/wrangler.jsonc', 'utf8')).toContain(`"${JOBS_CRON}"`);
	});
});

describe('runCronTick (FN-24)', () => {
	const utc = (iso: string) => Date.parse(iso);

	function fakeDeps(spaceCount: number, userCount: number) {
		const ids = (prefix: string, n: number) =>
			Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(5, '0')}`);
		const spaces = ids('s', spaceCount);
		const users = ids('u', userCount);
		const page = (all: string[], after: string, limit: number) =>
			all.filter((id) => id > after).slice(0, limit);
		const sent: JobMessage[][] = [];
		const cursors = new Map<string, string>();
		const deps: CronDeps = {
			getCursor: async (key) => cursors.get(key) ?? null,
			setCursor: async (key, value) => {
				cursors.set(key, value);
			},
			spacesWithBudget: async (after, limit) => page(spaces, after, limit),
			spacesWithSubscriptions: async () => [],
			spacesWithDueSeries: async () => [],
			usersWanting: async (_kind, after, limit) => page(users, after, limit),
			usersDueCloseReminder: async (_today, _hour, after, limit) => page(users, after, limit),
			gmailConnectionsDue: null,
			enqueue: async (messages) => {
				sent.push(messages);
			}
		};
		return { deps, sent, cursors };
	}

	it('every open tick enqueues one budget_check per budget space, in pages of at most 100', async () => {
		const { deps, sent } = fakeDeps(250, 0);
		const counts = await runCronTick(deps, utc('2026-10-08T03:00:00Z')); // 10:00 WIB Thursday
		expect(counts).toEqual({
			budgets: 250,
			bills: 0,
			recurring: 0,
			nudges: 0,
			closeReminders: 0,
			budgetStreaks: 250,
			summaries: 0,
			gmail: 0
		});
		const checks = sent.filter((batch) => batch[0]?.type === 'budget_check');
		expect(checks.map((batch) => batch.length)).toEqual([100, 100, 50]);
		expect(new Set(checks.flat().map((m) => (m as { spaceId: string }).spaceId)).size).toBe(250);
	});

	it('the 07:00 WIB tick adds one daily_nudge per user, dated with the WIB day', async () => {
		const { deps, sent } = fakeDeps(0, 2);
		const counts = await runCronTick(deps, utc('2026-10-08T00:00:00Z'));
		expect(counts.nudges).toBe(2);
		expect(sent.flat().filter((m) => m.type === 'daily_nudge')).toEqual([
			{ type: 'daily_nudge', userId: 'u-00000', date: '2026-10-08' },
			{ type: 'daily_nudge', userId: 'u-00001', date: '2026-10-08' }
		]);
	});

	it('Monday 06:00 WIB (Sunday 23:00 UTC) adds the weekly summary for that Monday', async () => {
		const { deps, sent } = fakeDeps(0, 1);
		const counts = await runCronTick(deps, utc('2026-10-11T23:00:00Z'));
		expect(counts).toEqual({
			budgets: 0,
			bills: 0,
			recurring: 0,
			nudges: 0,
			closeReminders: 1,
			budgetStreaks: 0,
			summaries: 1,
			gmail: 0
		});
		expect(sent.flat().filter((m) => m.type === 'weekly_summary')).toEqual([
			{ type: 'weekly_summary', userId: 'u-00000', weekStart: '2026-10-12' }
		]);
	});

	it('FN-26: every open tick enqueues one bill_check per space with a subscription; none in quiet hours', async () => {
		const { deps, sent } = fakeDeps(0, 0);
		const subs = ['s-a', 's-b'];
		deps.spacesWithSubscriptions = async (after, limit) =>
			subs.filter((id) => id > after).slice(0, limit);
		expect((await runCronTick(deps, utc('2026-10-08T03:00:00Z'))).bills).toBe(2);
		expect(sent.flat()).toEqual([
			{ type: 'bill_check', spaceId: 's-a' },
			{ type: 'bill_check', spaceId: 's-b' }
		]);
		sent.length = 0;
		// The rotation wraps: the next open tick checks every space again (keys dedupe).
		expect((await runCronTick(deps, utc('2026-10-08T04:00:00Z'))).bills).toBe(2);
		sent.length = 0;
		expect((await runCronTick(deps, utc('2026-10-08T20:00:00Z'))).bills).toBe(0);
		expect(sent).toEqual([]);
	});

	it('FN-36: from 06:00 WIB every open tick enqueues one recurring_check per space with a due series', async () => {
		const { deps, sent, cursors } = fakeDeps(0, 0);
		const asked: string[] = [];
		const due = ['s-a', 's-b', 's-c'];
		deps.spacesWithDueSeries = async (today, after, limit) => {
			asked.push(today);
			return due.filter((id) => id > after).slice(0, limit);
		};
		// 06:00 WIB on 12 November is 23:00 UTC on the 11th: the WIB day is asked for.
		expect((await runCronTick(deps, utc('2026-11-11T23:00:00Z'))).recurring).toBe(3);
		expect(asked).toEqual(['2026-11-12']);
		expect(sent.flat()).toEqual(
			due.map((spaceId) => ({ type: 'recurring_check', spaceId, date: '2026-11-12' }))
		);
		expect(JSON.parse(cursors.get('cron:recurring_check')!)).toMatchObject({ done: true });
		sent.length = 0;
		// The rotation wraps: the next tick asks again (the handler creates nothing twice).
		expect((await runCronTick(deps, utc('2026-11-12T00:00:00Z'))).recurring).toBe(3);
		sent.length = 0;
		// 03:00 WIB (quiet hours, a misfired tick): nothing.
		expect((await runCronTick(deps, utc('2026-11-12T20:00:00Z'))).recurring).toBe(0);
		expect(sent).toEqual([]);
	});

	it('quiet hours enqueue nothing', async () => {
		const { deps, sent } = fakeDeps(5, 5);
		expect(await runCronTick(deps, utc('2026-10-08T20:00:00Z'))).toEqual({
			budgets: 0,
			bills: 0,
			recurring: 0,
			nudges: 0,
			closeReminders: 0,
			budgetStreaks: 0,
			summaries: 0,
			gmail: 0
		});
		expect(sent).toEqual([]);
	});

	const HOUR = 3_600_000;
	const CAP = MAX_PAGES_PER_TICK * 100;
	const idsOf = (sent: JobMessage[][], type: JobMessage['type'], field: 'spaceId' | 'userId') =>
		sent
			.flat()
			.filter((m) => m.type === type)
			.map((m) => (m as Record<string, string>)[field]);

	it('L3: past the cap the next tick continues where the last stopped, so every space is checked; then it wraps', async () => {
		const { deps, sent } = fakeDeps(CAP + 50, 0);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const at = utc('2026-10-08T03:00:00Z');
		expect((await runCronTick(deps, at)).budgets).toBe(CAP);
		expect((await runCronTick(deps, at + HOUR)).budgets).toBe(50);
		const seen = idsOf(sent, 'budget_check', 'spaceId');
		expect(new Set(seen).size).toBe(CAP + 50);
		expect(seen).toHaveLength(CAP + 50);
		sent.length = 0;
		expect((await runCronTick(deps, at + 2 * HOUR)).budgets).toBe(CAP);
		expect(idsOf(sent, 'budget_check', 'spaceId')[0]).toBe('s-00000');
		vi.restoreAllMocks();
	});

	it('L3: the daily nudge pass finishes on later ticks of the same day, once, and restarts the next day', async () => {
		const { deps, sent } = fakeDeps(0, CAP + 50);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const seven = utc('2026-10-08T00:00:00Z');
		expect((await runCronTick(deps, seven)).nudges).toBe(CAP);
		expect((await runCronTick(deps, seven + HOUR)).nudges).toBe(50);
		expect((await runCronTick(deps, seven + 2 * HOUR)).nudges).toBe(0);
		expect(new Set(idsOf(sent, 'daily_nudge', 'userId')).size).toBe(CAP + 50);
		expect((await runCronTick(deps, seven + 24 * HOUR)).nudges).toBe(CAP);
		vi.restoreAllMocks();
	});

	it('L3: the weekly pass continues through Monday and never runs again that week', async () => {
		const { deps } = fakeDeps(0, CAP + 1);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const monday6 = utc('2026-10-11T23:00:00Z');
		expect((await runCronTick(deps, monday6)).summaries).toBe(CAP);
		expect((await runCronTick(deps, monday6 + HOUR)).summaries).toBe(1);
		expect((await runCronTick(deps, monday6 + 2 * HOUR)).summaries).toBe(0);
		expect((await runCronTick(deps, monday6 + 25 * HOUR)).summaries).toBe(0); // Tuesday
		vi.restoreAllMocks();
	});

	it('FN-34b: the close reminder is an endless rotation: an early tick never ends the day for a later hour', async () => {
		const { deps, sent, cursors } = fakeDeps(0, 2);
		const at = (wib: number) => utc(`2026-10-08T${String(wib - 7).padStart(2, '0')}:00:00Z`);
		// 07:00 and 20:00 WIB the same day: every user is enqueued on both ticks (the hour is checked by the
		// handler, inside the guarded insert), dated with that WIB day.
		expect((await runCronTick(deps, at(7))).closeReminders).toBe(2);
		expect(JSON.parse(cursors.get('cron:close_reminder')!)).toMatchObject({ round: 'all' });
		expect((await runCronTick(deps, at(20))).closeReminders).toBe(2);
		const reminders = sent.flat().filter((m) => m.type === 'close_reminder');
		expect(reminders).toHaveLength(4);
		expect(reminders.every((m) => 'date' in m && m.date === '2026-10-08')).toBe(true);
		// 23:30 WIB on the last day of October is still the 31st; quiet hours enqueue none.
		sent.length = 0;
		await runCronTick(deps, utc('2026-10-31T16:00:00Z'));
		expect(sent.flat().find((m) => m.type === 'close_reminder')).toMatchObject({
			date: '2026-10-31'
		});
		expect((await runCronTick(deps, utc('2026-10-31T20:00:00Z'))).closeReminders).toBe(0);
	});

	it('FN-34b: the budget-streak pass enqueues yesterday once per WIB day, from 06:00, per budget space', async () => {
		const { deps, sent } = fakeDeps(3, 0);
		const six = utc('2026-10-31T23:00:00Z'); // 06:00 WIB on 1 November
		expect((await runCronTick(deps, six)).budgetStreaks).toBe(3);
		expect(sent.flat().filter((m) => m.type === 'budget_streak_snapshot')).toEqual([
			{ type: 'budget_streak_snapshot', spaceId: 's-00000', date: '2026-10-31' },
			{ type: 'budget_streak_snapshot', spaceId: 's-00001', date: '2026-10-31' },
			{ type: 'budget_streak_snapshot', spaceId: 's-00002', date: '2026-10-31' }
		]);
		// Later ticks the same day: the round is done. The next day: a new round for the new yesterday.
		expect((await runCronTick(deps, six + HOUR)).budgetStreaks).toBe(0);
		expect((await runCronTick(deps, six + 17 * HOUR)).budgetStreaks).toBe(0);
		sent.length = 0;
		expect((await runCronTick(deps, six + 24 * HOUR)).budgetStreaks).toBe(3);
		expect(sent.flat().find((m) => m.type === 'budget_streak_snapshot')).toMatchObject({
			date: '2026-11-01'
		});
	});

	it('a malformed stored cursor starts the round over instead of skipping anyone', async () => {
		const { deps, cursors } = fakeDeps(3, 0);
		cursors.set('cron:budget_check', '{not json');
		expect((await runCronTick(deps, utc('2026-10-08T03:00:00Z'))).budgets).toBe(3);
	});

	it('stops at the page cap per tick', async () => {
		const { deps } = fakeDeps(MAX_PAGES_PER_TICK * 100 + 5, 0);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const counts = await runCronTick(deps, utc('2026-10-08T03:00:00Z'));
		expect(counts.budgets).toBe(MAX_PAGES_PER_TICK * 100);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('FN-19 Gmail: every open tick enqueues one hourly gmail_check per due connection, windowed by the WIB hour', async () => {
		const { deps, sent } = fakeDeps(0, 0);
		const connections = Array.from({ length: 150 }, (_, i) => `g-${String(i).padStart(4, '0')}`);
		deps.gmailConnectionsDue = async (after, limit) =>
			connections.filter((id) => id > after).slice(0, limit);
		const counts = await runCronTick(deps, utc('2026-10-08T23:00:00Z')); // 06:00 WIB Friday
		expect(counts.gmail).toBe(150);
		const checks = sent.flat().filter((m) => m.type === 'gmail_check');
		expect(checks[0]).toEqual({
			type: 'gmail_check',
			connectionId: 'g-0000',
			kind: 'hourly',
			window: '2026-10-09T06',
			page: 0
		});
		// The same hour again: that round is done, nothing is enqueued twice.
		expect((await runCronTick(deps, utc('2026-10-08T23:00:00Z'))).gmail).toBe(0);
		// The next hour is a new round.
		expect((await runCronTick(deps, utc('2026-10-09T00:00:00Z'))).gmail).toBe(150);
	});

	it('FN-19 Gmail: nothing in quiet hours, and nothing while the jobs Worker is not configured for Gmail', async () => {
		const { deps } = fakeDeps(0, 0);
		const due = vi.fn(async () => ['g-1']);
		deps.gmailConnectionsDue = due;
		expect((await runCronTick(deps, utc('2026-10-08T20:00:00Z'))).gmail).toBe(0); // 03:00 WIB
		expect(due).not.toHaveBeenCalled();
		deps.gmailConnectionsDue = null;
		expect((await runCronTick(deps, utc('2026-10-08T05:00:00Z'))).gmail).toBe(0);
	});
});
