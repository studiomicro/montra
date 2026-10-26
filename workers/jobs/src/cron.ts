import { SCHEDULE_PAGE_SIZE } from '#lib/server/notifications/schedule';
import { addDays, wibHour } from '#lib/shared/dates';
import type { JobMessage } from '#lib/shared/jobs';
import { tickPlan, type NotificationKind } from '#lib/shared/notifications';

/** Hourly 06:00–23:00 WIB (UTC+7). Cron Triggers run in UTC. Keep in sync with workers/jobs/wrangler.jsonc. */
export const JOBS_CRON = '0 23,0-16 * * *';

export function cronUtcHours(expr: string): number[] {
	const field = expr.trim().split(/\s+/)[1] ?? '';
	const hours = new Set<number>();
	for (const part of field.split(',')) {
		const [from, to] = part.split('-').map(Number);
		if (from === undefined || Number.isNaN(from)) continue;
		for (let h = from; h <= (to ?? from); h++) hours.add(h);
	}
	return [...hours].sort((a, b) => a - b);
}

export function utcToWibHours(hours: number[]): number[] {
	return hours.map((h) => (h + 7) % 24).sort((a, b) => a - b);
}

/** Most keyset pages one tick walks per kind (SCHEDULE_PAGE_SIZE each); the next tick continues from there. */
export const MAX_PAGES_PER_TICK = 100;

export interface CronDeps {
	spacesWithBudget(afterId: string, limit: number): Promise<string[]>;
	spacesWithSubscriptions(afterId: string, limit: number): Promise<string[]>;
	/** FN-36: live spaces with a recurring series due on or before `today` (WIB). */
	spacesWithDueSeries(today: string, afterId: string, limit: number): Promise<string[]>;
	usersWanting(kind: NotificationKind, afterId: string, limit: number): Promise<string[]>;
	/** FN-34b: users whose close reminder for `today` is due at WIB `hour` and not sent yet (red team L1). */
	usersDueCloseReminder(
		today: string,
		hour: number,
		afterId: string,
		limit: number
	): Promise<string[]>;
	/**
	 * FN-19 Gmail: connected connections with automatic checks on, not held back, whose owner is still a member of
	 * the target space; null when the jobs Worker is not configured for Gmail (no check is enqueued).
	 */
	gmailConnectionsDue: ((afterId: string, limit: number) => Promise<string[]>) | null;
	enqueue(messages: JobMessage[]): Promise<void>;
	/** The stored walk position of `key` (null when none); kept in D1 (`app_meta`), so it survives ticks. */
	getCursor(key: string): Promise<string | null>;
	setCursor(key: string, value: string): Promise<void>;
}

/**
 * Where a walk stands: `round` names one pass (the WIB day of a nudge pass, the Monday of a weekly pass,
 * `all` for the endless budget rotation), `after` the last id enqueued, `done` that this round finished.
 */
interface Cursor {
	round: string;
	after: string;
	done: boolean;
}

/** `app_meta` keys of the walks (one row per kind, overwritten in place, so they never pile up). */
const CURSOR_KEYS = {
	budget_check: 'cron:budget_check',
	bill_check: 'cron:bill_check',
	recurring_check: 'cron:recurring_check',
	daily_nudge: 'cron:daily_nudge',
	close_reminder: 'cron:close_reminder',
	budget_streak: 'cron:budget_streak',
	weekly_summary: 'cron:weekly_summary',
	gmail_check: 'cron:gmail_check'
} as const;

/** The WIB hour of a tick (`YYYY-MM-DDTHH`): the window of its hourly Gmail scans. */
function wibHourWindow(utcMs: number): string {
	return new Date(utcMs + 7 * 60 * 60 * 1000).toISOString().slice(0, 13);
}

function readCursor(raw: string | null, round: string): Cursor {
	try {
		const c = raw ? (JSON.parse(raw) as Partial<Cursor>) : null;
		if (c && c.round === round && typeof c.after === 'string' && typeof c.done === 'boolean')
			return { round, after: c.after, done: c.done };
	} catch {
		// A malformed value starts the round over (never skips anyone).
	}
	return { round, after: '', done: false };
}

/**
 * Enqueues one message per id, page by page, from the stored position of `key` in `round`, at most
 * MAX_PAGES_PER_TICK pages; stores where it stopped, so the next tick continues and every id is reached within
 * ceil(ids / (pages × page size)) ticks. A finished round is marked done; `wrap` starts the next round at once
 * on the following tick (budgets), otherwise the round stays done until its `round` changes (nudge, weekly).
 */
async function walk(
	deps: CronDeps,
	key: string,
	round: string,
	wrap: boolean,
	page: (afterId: string) => Promise<string[]>,
	message: (id: string) => JobMessage
): Promise<number> {
	const cursor = readCursor(await deps.getCursor(key), round);
	if (cursor.done && !wrap) return 0;
	let after = cursor.done ? '' : cursor.after;
	let count = 0;
	for (let i = 0; i < MAX_PAGES_PER_TICK; i++) {
		const ids = await page(after);
		if (ids.length > 0) {
			await deps.enqueue(ids.map(message));
			count += ids.length;
			after = ids[ids.length - 1] as string;
		}
		if (ids.length < SCHEDULE_PAGE_SIZE) {
			await deps.setCursor(key, JSON.stringify({ round, after: '', done: true }));
			return count;
		}
	}
	await deps.setCursor(key, JSON.stringify({ round, after, done: false }));
	console.warn('jobs: cron page cap reached, continuing next tick', { what: key, count });
	return count;
}

/**
 * One hourly tick (FN-24) at `scheduledTime`. Budgets: every tick, an endless rotation over every space with a
 * live budget. Daily nudge: from the 07:00 WIB tick on, until that day's pass over every user is done. Weekly
 * summary: from Monday's 06:00 WIB tick on, until that Monday's pass is done. Nothing in quiet hours. The walk
 * positions are stored, so no space or user is left out however many there are. Every handler dedupes on its
 * notification key, so a repeated tick never creates a notification twice.
 */
export async function runCronTick(
	deps: CronDeps,
	scheduledTime: number
): Promise<{
	budgets: number;
	bills: number;
	recurring: number;
	nudges: number;
	closeReminders: number;
	budgetStreaks: number;
	summaries: number;
	gmail: number;
}> {
	const plan = tickPlan(scheduledTime);
	const size = SCHEDULE_PAGE_SIZE;
	const budgets = plan.budgets
		? await walk(
				deps,
				CURSOR_KEYS.budget_check,
				'all',
				true,
				(after) => deps.spacesWithBudget(after, size),
				(spaceId) => ({ type: 'budget_check', spaceId })
			)
		: 0;
	// FN-26: the same endless rotation over spaces with a live subscription (keys dedupe repeated ticks).
	const bills = plan.bills
		? await walk(
				deps,
				CURSOR_KEYS.bill_check,
				'all',
				true,
				(after) => deps.spacesWithSubscriptions(after, size),
				(spaceId) => ({ type: 'bill_check', spaceId })
			)
		: 0;
	// FN-36: the same endless rotation over spaces with a due recurring series, on every open tick (from 06:00
	// WIB). The handler creates each instance once per series and date, so a repeated tick changes nothing.
	const recurring = plan.recurring
		? await walk(
				deps,
				CURSOR_KEYS.recurring_check,
				'all',
				true,
				(after) => deps.spacesWithDueSeries(plan.today, after, size),
				(spaceId) => ({ type: 'recurring_check', spaceId, date: plan.today })
			)
		: 0;
	const nudges = plan.nudge
		? await walk(
				deps,
				CURSOR_KEYS.daily_nudge,
				plan.today,
				false,
				(after) => deps.usersWanting('daily_nudge', after, size),
				(userId) => ({ type: 'daily_nudge', userId, date: plan.today })
			)
		: 0;
	// FN-34b evening reminder: an endless rotation like budgets, never a once-a-day round. Each user's own hour is
	// checked inside the guarded insert, so an early tick finding nobody due must not end the day's round (a
	// round marked done at 06:00 would cancel every 20:00 reminder). The key is the date: one per user and day.
	// Red team L1: only users due now and not yet reminded or closed are listed, never every active user.
	const closeReminders = plan.closeReminder
		? await walk(
				deps,
				CURSOR_KEYS.close_reminder,
				'all',
				true,
				(after) => deps.usersDueCloseReminder(plan.today, wibHour(scheduledTime), after, size),
				(userId) => ({ type: 'close_reminder', userId, date: plan.today })
			)
		: 0;
	// FN-34b budget streak: yesterday's verdict for every space with a live budget, one pass per WIB day from the
	// first open tick (06:00), when yesterday is over for every space at once.
	const yesterday = addDays(plan.today, -1);
	const budgetStreaks = plan.budgetStreak
		? await walk(
				deps,
				CURSOR_KEYS.budget_streak,
				plan.today,
				false,
				(after) => deps.spacesWithBudget(after, size),
				(spaceId) => ({ type: 'budget_streak_snapshot', spaceId, date: yesterday })
			)
		: 0;
	const summaries = plan.weekly
		? await walk(
				deps,
				CURSOR_KEYS.weekly_summary,
				plan.today,
				false,
				(after) => deps.usersWanting('weekly_summary', after, size),
				(userId) => ({ type: 'weekly_summary', userId, weekStart: plan.today })
			)
		: 0;
	// FN-19 Gmail: one check per due connection on every open tick (the scan of a connection and WIB hour is
	// unique, so a repeated tick opens nothing twice). Each check lists from where the previous one got to, so mail
	// of the quiet night hours is picked up at 06:00 WIB.
	const due = deps.gmailConnectionsDue;
	const window = wibHourWindow(scheduledTime);
	const gmail =
		plan.recurring && due
			? await walk(
					deps,
					CURSOR_KEYS.gmail_check,
					window,
					false,
					(after) => due(after, size),
					(connectionId) => ({ type: 'gmail_check', connectionId, kind: 'hourly', window, page: 0 })
				)
			: 0;
	return { budgets, bills, recurring, nudges, closeReminders, budgetStreaks, summaries, gmail };
}
