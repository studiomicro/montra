import { sql } from 'drizzle-orm';
import { monthOf, monthRange, wibDateString, wibDayRangeUtcMs } from '#lib/shared/dates';
import { createTranslator } from '#lib/shared/i18n';
import { RetryLaterError, type JobMessage } from '#lib/shared/jobs';
import {
	BILL_REMINDERS_PER_DAY,
	billGroupDataKey,
	budgetDataKey,
	budgetThreshold,
	CLOSE_REMINDER_DEFAULT_HOUR,
	closeReminderDataKey,
	goalDataKey,
	goalThreshold,
	isQuietHour,
	lastWeekRange,
	notificationText,
	notificationUrl,
	nudgeDataKey,
	parseParams,
	weeklyDataKey,
	wibHour
} from '#lib/shared/notifications';
import type { PushPayload } from '#lib/shared/push';
import { amountIn, outIn } from '../budgets/math';
import { getActiveBudget } from '../budgets/repo';
import type { Db } from '../db';
import { getGoal } from '../goals/repo';
import { listActiveSubscriptions } from '../push/repo';
import { PushSendError, sendPushNotification } from '../push/send';
import type { VapidKeys } from '../push/vapid';
import { MAX_SPACE_MEMBERS } from '../spaces/access';
import { periodTotals, type TransactionFilter } from '../transactions/aggregate';
import { dueBillReminders } from '../subscriptions/reminders';
import { listWallets } from '../wallets/repo';
import {
	claimDelivery,
	createIfAbsent,
	finishDelivery,
	pushTarget,
	DELIVERY_CLAIM_STALE_MS,
	releaseDelivery,
	type CreateResult
} from './repo';

// FN-24 triggers: each reads stored rows through the same functions the screens use (FN-05 aggregates, FN-07
// budget, FN-10 goal progress) and creates notifications through `createIfAbsent` only. They return the rows
// they made or found (`created` tells which), so the caller enqueues one `send_push` per new row. No trigger
// sends a push itself.

const expenseFilter = (from: string, to: string): TransactionFilter => ({
	from,
	to,
	type: 'expense',
	categoryId: null,
	walletId: null,
	q: null
});

/** Live members (active accounts) of the live space `spaceId`; a space holds at most MAX_SPACE_MEMBERS. */
export async function liveMemberIds(db: Db, spaceId: string): Promise<string[]> {
	const rows = await db.all<{ userId: string }>(sql`select m.user_id as userId from space_members m
		join spaces s on s.id = m.space_id join users u on u.id = m.user_id
		where m.space_id = ${spaceId} and m.deleted_at is null and s.deleted_at is null
			and u.status = 'active'
		order by m.created_at, m.id limit ${MAX_SPACE_MEMBERS}`);
	return rows.map((r) => r.userId);
}

/** The rows a trigger produced (new or already there); refused ones (guard) are left out. */
const made = (results: (CreateResult | null)[]) =>
	results.filter((r): r is CreateResult => r !== null);

/**
 * Budget alerts for `spaceId` on the WIB date of `now`: this month's spending (the `periodTotals` sum Beranda
 * shows, in the budget's currency) against the live budget. At or past 100 % → `budget_100`; at or past 80 %
 * → `budget_80`; one per member per WIB month and threshold. Read-only when no threshold is reached.
 */
export async function evaluateBudget(
	db: Db,
	spaceId: string,
	now: number
): Promise<CreateResult[]> {
	const budget = await getActiveBudget(db, spaceId);
	if (!budget) return [];
	const month = monthOf(wibDateString(now));
	const { from, to } = monthRange(month);
	const totals = await periodTotals(db, spaceId, expenseFilter(from, to));
	const spentMinor = outIn(totals.totals, budget.currency);
	const threshold = budgetThreshold(spentMinor, budget.amountMinor);
	if (threshold === null) return [];
	const kind = threshold === 100 ? 'budget_100' : 'budget_80';
	const members = await liveMemberIds(db, spaceId);
	const results = [];
	for (const userId of members) {
		results.push(
			await createIfAbsent(
				db,
				{
					userId,
					kind,
					spaceId,
					dataKey: budgetDataKey(spaceId, month, threshold),
					params: { month, currency: budget.currency, budgetMinor: budget.amountMinor, spentMinor }
				},
				now
			)
		);
	}
	return made(results);
}

/**
 * Goal milestones after a contribution: the highest of 50 %/100 % the live goal has reached (FN-10
 * `goalProgressPercent`), once per goal, threshold and member, never again after a drop and a re-cross.
 */
export async function evaluateGoalMilestone(
	db: Db,
	spaceId: string,
	goalId: string,
	now: number
): Promise<CreateResult[]> {
	const goal = await getGoal(db, spaceId, goalId);
	if (!goal) return [];
	const threshold = goalThreshold(goal.percent);
	if (threshold === null) return [];
	const members = await liveMemberIds(db, spaceId);
	const results = [];
	for (const userId of members) {
		results.push(
			await createIfAbsent(
				db,
				{
					userId,
					kind: 'goal_milestone',
					spaceId,
					dataKey: goalDataKey(goalId, threshold),
					params: {
						goalId,
						name: goal.name,
						currency: goal.currency,
						threshold,
						savedMinor: goal.savedMinor,
						targetMinor: goal.targetAmountMinor
					}
				},
				now
			)
		);
	}
	return made(results);
}

/**
 * FN-26 bill reminders for `spaceId` on the WIB date of `now`: every live subscription whose reminder window
 * covers today (`dueBillReminders`) → one `bill_reminder` per live member, keyed per subscription and charge
 * date (`bill:{subscription}:{date}`), so a repeated tick never reminds twice. Preferences, active account and
 * live membership are checked inside `createIfAbsent`.
 *
 * Red team L1: a recipient gets at most BILL_REMINDERS_PER_DAY single reminders per WIB day, counted inside the
 * insert over every single bill reminder created today (dismissed or blanked ones included, so deleting and
 * recreating subscriptions cannot reset it). The bills past the cap become one grouped notification per space
 * and day ("N tagihan langganan lagi …", no names), so churning subscriptions costs a member at most
 * BILL_REMINDERS_PER_DAY + 1 pushes per space and day.
 */
export async function evaluateBills(db: Db, spaceId: string, now: number): Promise<CreateResult[]> {
	const today = wibDateString(now);
	const due = await dueBillReminders(db, spaceId, today);
	if (due.length === 0) return [];
	const members = await liveMemberIds(db, spaceId);
	const dayStart = wibDayRangeUtcMs(today).startMs;
	const createdToday = (userId: string) => sql`(select count(*) from space_notifications x
		where x.user_id = ${userId} and x.kind = 'bill_reminder' and x.created_at >= ${dayStart}
			and substr(x.data_key, 1, 5) = 'bill:')`;
	const results: (CreateResult | null)[] = [];
	for (const userId of members) {
		let over = 0;
		for (const bill of due) {
			const one = await createIfAbsent(
				db,
				{
					userId,
					kind: 'bill_reminder',
					spaceId,
					dataKey: bill.dataKey,
					params: {
						subscriptionId: bill.subscriptionId,
						name: bill.name,
						currency: bill.currency,
						amountMinor: bill.amountMinor,
						chargeOn: bill.nextChargeOn
					},
					guard: sql`${createdToday(userId)} < ${BILL_REMINDERS_PER_DAY}`
				},
				now
			);
			if (one) {
				results.push(one);
				continue;
			}
			// Refused: past today's cap (grouped below), or not allowed at all (preference, membership).
			const [row] = await db.all<{ n: number }>(sql`select ${createdToday(userId)} as n`);
			if ((row?.n ?? 0) >= BILL_REMINDERS_PER_DAY) over++;
		}
		if (over > 0)
			results.push(
				await createIfAbsent(
					db,
					{
						userId,
						kind: 'bill_reminder',
						spaceId,
						dataKey: billGroupDataKey(spaceId, today),
						params: { count: over, date: today }
					},
					now
				)
			);
	}
	return made(results);
}

/**
 * The daily "catat hari ini" nudge for `userId` on the WIB date `date`: created only while no live,
 * non-demo transaction (a balance adjustment, FN-37, is not a recorded payment) dated `date` exists in any space the user is a live member of (checked inside the
 * insert, owner decision 4).
 */
export async function evaluateDailyNudge(
	db: Db,
	userId: string,
	date: string,
	now: number
): Promise<CreateResult[]> {
	const noEntryToday = sql`not exists (select 1 from space_members m
		join spaces s on s.id = m.space_id
		join transactions t on t.space_id = m.space_id and t.deleted_at is null and t.occurred_on = ${date}
			and t.is_demo = 0 and t.type <> 'adjustment'
		where m.user_id = ${userId} and m.deleted_at is null and s.deleted_at is null)`;
	const result = await createIfAbsent(
		db,
		{
			userId,
			kind: 'daily_nudge',
			spaceId: null,
			dataKey: nudgeDataKey(date),
			params: { date },
			guard: noEntryToday
		},
		now
	);
	return made([result]);
}

/**
 * FN-34b: the evening "belum ditutup" reminder for `userId` on the WIB date `date`, at most once per user and
 * date (the key names the date, never the hour). Checked inside the insert, at the moment it runs: the WIB hour
 * of `now` has reached the user's chosen hour (CLOSE_REMINDER_DEFAULT_HOUR without one), and `date` is not
 * closed yet. Preference (on/off) and active account are checked by `createIfAbsent` as for every kind.
 */
export async function evaluateCloseReminder(
	db: Db,
	userId: string,
	date: string,
	now: number
): Promise<CreateResult[]> {
	const due = sql`${wibHour(now)} >= coalesce((select p.hour from notification_prefs p
			where p.user_id = ${userId} and p.kind = 'close_reminder'), ${CLOSE_REMINDER_DEFAULT_HOUR})
		and not exists (select 1 from day_closures d where d.user_id = ${userId} and d.closed_on = ${date})`;
	const result = await createIfAbsent(
		db,
		{
			userId,
			kind: 'close_reminder',
			spaceId: null,
			dataKey: closeReminderDataKey(date),
			params: { date },
			guard: due
		},
		now
	);
	return made([result]);
}

/**
 * The weekly summary for `userId`: last week's (Monday–Sunday WIB before `weekStart`) spending in the
 * personal space, through the same `periodTotals` sum Laporan uses, in the favourite wallet's currency (IDR
 * without wallets), like Laporan.
 */
export async function evaluateWeeklySummary(
	db: Db,
	userId: string,
	weekStart: string,
	now: number
): Promise<CreateResult[]> {
	const personal = await db.get<{ id: string }>(sql`select s.id as id from spaces s
		join space_members m on m.space_id = s.id
		where m.user_id = ${userId} and m.deleted_at is null and s.kind = 'personal' and s.deleted_at is null
		limit 1`);
	if (!personal) return [];
	const { from, to } = lastWeekRange(weekStart);
	const [wallets, totals] = await Promise.all([
		listWallets(db, personal.id),
		periodTotals(db, personal.id, expenseFilter(from, to))
	]);
	const currency = wallets.find((w) => w.isFavourite)?.currency ?? 'IDR';
	const result = await createIfAbsent(
		db,
		{
			userId,
			kind: 'weekly_summary',
			spaceId: null,
			dataKey: weeklyDataKey(weekStart),
			params: { from, to, currency, spentMinor: amountIn(totals.totals, currency, 'outMinor') }
		},
		now
	);
	return made([result]);
}

/** A retry after this many seconds finds a claim held by a dead attempt stale, so it can take it over. */
export const BUSY_RETRY_DELAY_S = Math.ceil(DELIVERY_CLAIM_STALE_MS / 1000) + 60;

/**
 * Thrown when at least one device still needs this push: `failed` sends were refused (retry at once), `busy`
 * devices are claimed by another attempt that may have died (retry after the claim goes stale). The queue
 * retries, then moves the message to the DLQ after max_retries.
 */
export class PushRetryError extends RetryLaterError {
	constructor(
		readonly failed: number,
		readonly busy: number
	) {
		super(`push: ${failed} failed, ${busy} in flight`, busy > 0 ? BUSY_RETRY_DELAY_S : 0);
	}
}

export type DeliverResult = 'unconfigured' | 'quiet' | 'gone' | 'closed' | 'delivered';

/**
 * Pushes stored notification `notificationId` to every live device of its recipient (FN-13's send path).
 * Without VAPID keys nothing is sent ('unconfigured'; the in-app row stands). In quiet hours (00:00–05:59 WIB)
 * nothing is sent. Each (notification, device) pair is claimed first, so a replayed message never pushes
 * twice to one device; 404/410 tombstones the subscription (inside `sendPushNotification`). Any other
 * failure releases its claim; a device claimed by another (possibly dead) attempt is left for later; then,
 * after every device was tried, PushRetryError asks the queue to retry (delayed past the stale-claim window
 * when a device was busy, so a dead attempt's device is not lost).
 *
 * Push text is Indonesian: the jobs Worker does not know a reader's language (the list renders per locale).
 */
export async function deliverPush(
	db: Db,
	notificationId: string,
	keys: VapidKeys | null,
	now: number
): Promise<DeliverResult> {
	if (!keys) return 'unconfigured';
	if (isQuietHour(now)) return 'quiet';
	const target = await pushTarget(db, notificationId);
	if (!target) return 'gone';
	const t = createTranslator('id');
	const params = parseParams(target.kind, target.params);
	// FN-34b red team L2: the day may have been closed after the reminder was created (a quiet-hour or retry delay
	// included): "Hari ini belum ditutup" is then untrue and is not sent.
	if (target.kind === 'close_reminder' && params && 'date' in params) {
		const closed = await db.get<{ one: number }>(sql`select 1 as one from day_closures
			where user_id = ${target.userId} and closed_on = ${params.date} limit 1`);
		if (closed) return 'closed';
	}
	const spaceName = target.space
		? target.space.kind === 'personal'
			? t.tr('Pribadi')
			: target.space.name
		: null;
	const payload: PushPayload = {
		...notificationText(target.kind, params, t, spaceName),
		url: notificationUrl(target.kind, params)
	};
	const subscriptions = await listActiveSubscriptions(db, target.userId, now);
	let failed = 0;
	let busy = 0;
	for (const sub of subscriptions) {
		const pair = { notificationId, subscriptionId: sub.id };
		const claim = await claimDelivery(db, { ...pair, userId: target.userId }, now);
		if (claim === 'done') continue;
		if (claim === 'busy') {
			busy++;
			continue;
		}
		try {
			await sendPushNotification(db, sub, payload, keys, now);
		} catch (e) {
			// Status only: the endpoint is a capability URL and is never logged.
			console.warn('jobs: push failed', e instanceof PushSendError ? e.status : 'network');
			await releaseDelivery(db, pair);
			failed++;
			continue;
		}
		// The push service has it. Record that; if recording fails, the claim is kept (never released) and the
		// device counts as delivered, so no retry of this message sends it again (a duplicate is worse than a
		// missing receipt).
		await finishDelivery(db, pair, now)
			.catch(() => finishDelivery(db, pair, now))
			.catch(() => console.warn('jobs: delivery not recorded; claim kept'));
	}
	if (failed > 0 || busy > 0) throw new PushRetryError(failed, busy);
	return 'delivered';
}

/**
 * After a confirmed contribution (FN-10 write path): creates the goal's milestone notifications synchronously
 * (so the list shows them on the next load) and enqueues one `send_push` per new row, so a slow push service
 * never delays the save. Never throws: the contribution is already stored, and a failure here only costs the
 * notification (logged without content).
 */
export async function notifyGoalMilestone(
	db: Db,
	queue: Queue,
	spaceId: string,
	goalId: string,
	now: number
): Promise<void> {
	try {
		const fresh = (await evaluateGoalMilestone(db, spaceId, goalId, now)).filter((m) => m.created);
		const messages: JobMessage[] = fresh.map((m) => ({ type: 'send_push', notificationId: m.id }));
		if (messages.length > 0) await queue.sendBatch(messages.map((body) => ({ body })));
	} catch (e) {
		console.error('notifications: goal milestone failed', e instanceof Error ? e.name : 'unknown');
	}
}
