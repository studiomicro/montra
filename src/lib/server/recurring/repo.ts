import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import {
	followingRun,
	recurringDedupeKey,
	restartRunOn,
	type RecurringAttention,
	type RecurringFrequency,
	type RecurringSchedule,
	type RecurringStatus,
	type RecurringType
} from '#lib/shared/recurring';
import type { TileKey } from '#lib/shared/transactions';
import type { Db } from '../db';
import { D1_STATEMENTS_PER_INVOCATION } from '../db/statement-count';
import { recurringTransactions } from '../db/schema';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { insertTransactions, MAX_TRANSACTIONS_PER_SPACE } from '../transactions/repo';
import { newId } from '../util';
import type { RecurringInput } from './validation';

// FN-36 recurring transactions. Every page function runs only after `requireSpaceAccess` admitted
// `scope.userId` to `scope.spaceId`; each write repeats that membership (`isLiveMember`) inside its own
// statement, so a removal in between changes nothing. Ids from a form are only ever looked up inside the space:
// another space's id reads as missing. The cron functions (`spacesWithDueSeries`, `runDueSeries`) write through
// `insertTransactions`, which re-checks the series' member, wallet, category and the space's cap in the insert.

/** Most live series one space holds; also the list's row cap and the cron's per-space bound. */
export const MAX_SERIES_PER_SPACE = 100;
/** Most instances one `runDueSeries` call attempts (one queue message); a follow-up message continues. */
export const MAX_INSTANCES_PER_RUN = 100;
/** Generated transactions the series page lists. */
export const SERIES_INSTANCES_LIMIT = 12;

export interface RecurringSeries {
	id: string;
	type: RecurringType;
	amountMinor: number;
	currency: string;
	walletId: string;
	/** The wallet's name while it is still there (archived included). */
	walletName: string | null;
	categoryId: string;
	category: { name: string; tileKey: TileKey; isPreset: boolean } | null;
	title: string | null;
	note: string | null;
	schedule: RecurringSchedule;
	startOn: string;
	endOn: string | null;
	nextRunOn: string;
	status: RecurringStatus;
	attention: RecurringAttention | null;
	updatedAt: number;
}

/** `missing`: no such live series in this space (same answer for another space's id). `stale`: changed meanwhile. */
export type SeriesWriteResult = 'ok' | 'stale' | 'missing';

interface Row {
	id: string;
	type: RecurringType;
	amountMinor: number | null;
	currency: string | null;
	walletId: string | null;
	walletName: string | null;
	categoryId: string | null;
	categoryName: string | null;
	categoryTile: TileKey | null;
	categoryPreset: number | null;
	title: string | null;
	note: string | null;
	frequency: RecurringFrequency | null;
	intervalDay: number | null;
	startOn: string | null;
	endOn: string | null;
	nextRunOn: string | null;
	status: RecurringStatus;
	attention: RecurringAttention | null;
	updatedAt: number;
}

/** A live row (the CHECK guarantees its content); null for anything else. */
function series(r: Row): RecurringSeries | null {
	const {
		amountMinor,
		currency,
		walletId,
		categoryId,
		frequency,
		intervalDay,
		startOn,
		nextRunOn
	} = r;
	if (
		amountMinor === null ||
		!currency ||
		!walletId ||
		!categoryId ||
		!frequency ||
		intervalDay === null ||
		!startOn ||
		!nextRunOn
	)
		return null;
	return {
		id: r.id,
		type: r.type,
		amountMinor,
		currency,
		walletId,
		walletName: r.walletName,
		categoryId,
		category:
			r.categoryName !== null && r.categoryTile
				? { name: r.categoryName, tileKey: r.categoryTile, isPreset: r.categoryPreset === 1 }
				: null,
		title: r.title,
		note: r.note,
		schedule: { frequency, day: intervalDay },
		startOn,
		endOn: r.endOn,
		nextRunOn,
		status: r.status,
		attention: r.attention,
		updatedAt: r.updatedAt
	};
}

async function select(db: Db, spaceId: string, extra: SQL | null): Promise<RecurringSeries[]> {
	const rows =
		await db.all<Row>(sql`select r.id as id, r.type as type, r.amount_minor as amountMinor,
			r.currency as currency, r.wallet_id as walletId, w.name as walletName, r.category_id as categoryId,
			c.name as categoryName, c.tile_key as categoryTile, c.is_preset as categoryPreset, r.title as title,
			r.note as note, r.frequency as frequency, r.interval_day as intervalDay, r.start_on as startOn,
			r.end_on as endOn, r.next_run_on as nextRunOn, r.status as status, r.attention as attention,
			r.updated_at as updatedAt
		from recurring_transactions r
		left join wallets w on w.id = r.wallet_id and w.space_id = r.space_id
		left join categories c on c.id = r.category_id and c.space_id = r.space_id
		where r.space_id = ${spaceId} and r.deleted_at is null ${extra ? sql`and ${extra}` : sql``}
		order by case r.status when 'active' then 0 when 'paused' then 1 else 2 end, r.next_run_on, r.id
		limit ${MAX_SERIES_PER_SPACE}`);
	return rows.map(series).filter((s): s is RecurringSeries => s !== null);
}

/** The space's live series: active first (soonest next run first), then paused, then stopped. Bounded. */
export function listSeries(db: Db, spaceId: string): Promise<RecurringSeries[]> {
	return select(db, spaceId, null);
}

/** One live series of this space; null for an unknown, deleted or other-space id. */
export async function getSeries(
	db: Db,
	spaceId: string,
	id: string
): Promise<RecurringSeries | null> {
	const [row] = await select(db, spaceId, sql`r.id = ${id}`);
	return row ?? null;
}

/** One generated transaction as the series page lists it. */
export interface SeriesInstance {
	id: string;
	amountMinor: number;
	currency: string;
	title: string | null;
	occurredOn: string;
}

/** The series' most recent live generated transactions, newest first (bounded). */
export async function listSeriesInstances(
	db: Db,
	spaceId: string,
	seriesId: string
): Promise<SeriesInstance[]> {
	return db.all<SeriesInstance>(sql`select t.id as id, t.amount_minor as amountMinor,
			t.currency as currency, t.title as title, t.occurred_on as occurredOn
		from transactions t
		where t.space_id = ${spaceId} and t.recurring_series_id = ${seriesId} and t.deleted_at is null
		order by t.occurred_on desc, t.id desc
		limit ${SERIES_INSTANCES_LIMIT}`);
}

/**
 * SQL condition: the wallet is a live wallet of the space in `currency` and the category a visible category of
 * the space of the series' kind: what the cron's insert will demand of every instance (`refsHold`).
 */
function refsHold(spaceId: string, input: RecurringInput): SQL {
	return sql`exists (select 1 from wallets w where w.id = ${input.walletId} and w.space_id = ${spaceId}
			and w.currency = ${input.currency} and w.deleted_at is null)
		and exists (select 1 from categories c where c.id = ${input.categoryId} and c.space_id = ${spaceId}
			and c.kind = ${input.type} and c.deleted_at is null and c.is_hidden = 0)`;
}

const liveCount = (spaceId: string) =>
	sql`(select count(*) from recurring_transactions x where x.space_id = ${spaceId}
		and x.deleted_at is null)`;

/** `updated_at` of a write that expected `expected`: always later, even within the same millisecond. */
const nextUpdatedAt = (expected: number, now: number) => Math.max(now, expected + 1);

/**
 * Creates a series whose first instance is the first run on or after both its start date and `today` (never a
 * backfilled past date). One guarded insert: refused past MAX_SERIES_PER_SPACE live series (concurrent creates
 * cannot pass the cap), when the wallet or category went meanwhile, or when the membership went.
 */
export async function createSeries(
	db: Db,
	scope: SpaceScope,
	input: RecurringInput,
	today: string,
	now: number
): Promise<{ ok: true; id: string } | { ok: false; reason: 'limit' | 'gone' }> {
	const { spaceId, userId } = scope;
	const id = newId();
	const [, inserted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.insert(recurringTransactions)
			.select(
				sql`select ${id}, ${spaceId}, ${input.type}, ${input.amountMinor}, ${input.currency},
					${input.categoryId}, ${input.walletId}, ${input.title}, ${input.note},
					${input.schedule.frequency}, ${input.schedule.day}, ${input.startOn}, ${input.endOn},
					${restartRunOn(input.schedule, input.startOn, today)}, 'active', null, ${userId}, ${now}, ${now},
					null, ${currentSpaceSeq(spaceId)}
				where ${isLiveMember(spaceId, userId)} and ${liveCount(spaceId)} < ${MAX_SERIES_PER_SPACE}
					and ${refsHold(spaceId, input)}`
			)
			.returning({ id: recurringTransactions.id })
	]);
	if (inserted.length === 1) return { ok: true, id };
	const [count] = await db.all<{ n: number }>(sql`select ${liveCount(spaceId)} as n`);
	return { ok: false, reason: (count?.n ?? 0) >= MAX_SERIES_PER_SPACE ? 'limit' : 'gone' };
}

/** The guarded tail of every page write: this live series of this space, as loaded, the writer a member. */
const writable = (scope: SpaceScope, id: string, expectedUpdatedAt: number) =>
	and(
		eq(recurringTransactions.id, id),
		eq(recurringTransactions.spaceId, scope.spaceId),
		eq(recurringTransactions.updatedAt, expectedUpdatedAt),
		isNull(recurringTransactions.deletedAt),
		isLiveMember(scope.spaceId, scope.userId)
	);

async function whyNot(db: Db, spaceId: string, id: string): Promise<'stale' | 'missing'> {
	return (await getSeries(db, spaceId, id)) ? 'stale' : 'missing';
}

/**
 * "Ubah seri": saves the template and schedule. Only instances created after this write use it; no existing
 * transaction is touched. A changed schedule or start date, or a series flagged "Perlu perhatian", restarts
 * from the first run on or after the start and `today` (never a backfill); otherwise the next run is kept. The
 * editor takes the series over (the cron then writes on their behalf) and the flag is cleared. A stopped series
 * is not edited. `refs`: the wallet or category went between the form check and the write.
 */
export async function updateSeries(
	db: Db,
	scope: SpaceScope,
	current: RecurringSeries,
	input: RecurringInput,
	expectedUpdatedAt: number,
	today: string,
	now: number
): Promise<SeriesWriteResult | 'stopped' | 'refs'> {
	if (current.status === 'stopped') return 'stopped';
	const { schedule } = input;
	const restart =
		current.attention !== null ||
		current.schedule.frequency !== schedule.frequency ||
		current.schedule.day !== schedule.day ||
		current.startOn !== input.startOn;
	const r = recurringTransactions;
	const [, updated] = await db.batch([
		bumpSpaceSeq(db, scope.spaceId),
		db
			.update(r)
			.set({
				type: input.type,
				amountMinor: input.amountMinor,
				currency: input.currency,
				walletId: input.walletId,
				categoryId: input.categoryId,
				title: input.title,
				note: input.note,
				frequency: schedule.frequency,
				intervalDay: schedule.day,
				startOn: input.startOn,
				endOn: input.endOn,
				...(restart ? { nextRunOn: restartRunOn(schedule, input.startOn, today) } : {}),
				attention: null,
				createdByUserId: scope.userId,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(scope.spaceId)
			})
			.where(
				and(
					writable(scope, current.id, expectedUpdatedAt),
					sql`${r.status} <> 'stopped'`,
					refsHold(scope.spaceId, input)
				)
			)
			.returning({ id: r.id })
	]);
	if (updated.length === 1) return 'ok';
	const now2 = await getSeries(db, scope.spaceId, current.id);
	if (!now2) return 'missing';
	if (now2.updatedAt !== expectedUpdatedAt) return 'stale';
	return now2.status === 'stopped' ? 'stopped' : 'refs';
}

/** "Jeda": an active series is skipped by the cron until resumed. */
export async function pauseSeries(
	db: Db,
	scope: SpaceScope,
	id: string,
	expectedUpdatedAt: number,
	now: number
): Promise<SeriesWriteResult | 'stopped'> {
	return setStatus(db, scope, id, expectedUpdatedAt, now, 'paused', sql`status = 'active'`, {});
}

/**
 * "Lanjutkan": a paused series becomes active again from the first run on or after both its start and `today`
 * (owner decision B: the dates that passed while paused are never backfilled); stopped instead when that run is
 * past its end date. The resuming member takes the series over and any flag is cleared.
 */
export async function resumeSeries(
	db: Db,
	scope: SpaceScope,
	current: RecurringSeries,
	expectedUpdatedAt: number,
	today: string,
	now: number
): Promise<SeriesWriteResult | 'stopped'> {
	const next = restartRunOn(current.schedule, current.startOn, today);
	const ended = current.endOn !== null && next > current.endOn;
	return setStatus(
		db,
		scope,
		current.id,
		expectedUpdatedAt,
		now,
		ended ? 'stopped' : 'active',
		// `updated_at` (in `writable`) pins the schedule the restart was computed from.
		sql`status = 'paused'`,
		{ nextRunOn: next, attention: null, createdByUserId: scope.userId }
	);
}

/** "Hentikan": the series never creates another instance (its transactions stay). Final. */
export async function stopSeries(
	db: Db,
	scope: SpaceScope,
	id: string,
	expectedUpdatedAt: number,
	now: number
): Promise<SeriesWriteResult | 'stopped'> {
	return setStatus(db, scope, id, expectedUpdatedAt, now, 'stopped', sql`status <> 'stopped'`, {
		attention: null
	});
}

async function setStatus(
	db: Db,
	scope: SpaceScope,
	id: string,
	expectedUpdatedAt: number,
	now: number,
	status: RecurringStatus,
	from: SQL,
	extra: Partial<typeof recurringTransactions.$inferInsert>
): Promise<SeriesWriteResult | 'stopped'> {
	const [, updated] = await db.batch([
		bumpSpaceSeq(db, scope.spaceId),
		db
			.update(recurringTransactions)
			.set({
				...extra,
				status,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(scope.spaceId)
			})
			.where(and(writable(scope, id, expectedUpdatedAt), from))
			.returning({ id: recurringTransactions.id })
	]);
	if (updated.length === 1) return 'ok';
	const current = await getSeries(db, scope.spaceId, id);
	if (!current) return 'missing';
	if (current.updatedAt !== expectedUpdatedAt) return 'stale';
	return current.status === 'stopped' ? 'stopped' : 'stale';
}

/**
 * "Hapus seri": a content-free tombstone (only id, space, type, status, timestamps and seq remain). Its
 * transactions stay as they are, still pointing at it (their badge then has no series to open).
 */
export async function deleteSeries(
	db: Db,
	scope: SpaceScope,
	id: string,
	expectedUpdatedAt: number,
	now: number
): Promise<SeriesWriteResult> {
	const [, deleted] = await db.batch([
		bumpSpaceSeq(db, scope.spaceId),
		db
			.update(recurringTransactions)
			.set({
				amountMinor: null,
				currency: null,
				walletId: null,
				categoryId: null,
				title: null,
				note: null,
				frequency: null,
				intervalDay: null,
				startOn: null,
				endOn: null,
				nextRunOn: null,
				attention: null,
				status: 'stopped',
				deletedAt: now,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(scope.spaceId)
			})
			.where(writable(scope, id, expectedUpdatedAt))
			.returning({ id: recurringTransactions.id })
	]);
	return deleted.length === 1 ? 'ok' : whyNot(db, scope.spaceId, id);
}

// ---- The jobs cron (workers/jobs) ----

/**
 * SQL (alias `r`): a live, active series with an instance due on or before `today` (WIB) within its end date,
 * that the cron should try. A series flagged `refs` or `member` waits for the user ("Perlu perhatian": editing or
 * resuming it clears the flag and restarts from today), at no cost to the cron. One flagged `limit` is tried
 * again only while its space is under MAX_TRANSACTIONS_PER_SPACE (`runDueSeries` checks that once per space).
 */
const due = (today: string) => sql`r.status = 'active' and r.deleted_at is null
	and r.next_run_on <= ${today} and (r.end_on is null or r.next_run_on <= r.end_on)
	and (r.attention is null or r.attention = 'limit')`;

/** Live spaces with a due series, by id, after `afterId` (one keyset page of the cron's walk). */
export async function spacesWithDueSeries(
	db: Db,
	today: string,
	afterId: string,
	limit: number
): Promise<string[]> {
	const rows = await db.all<{ id: string }>(sql`select distinct r.space_id as id
		from recurring_transactions r join spaces s on s.id = r.space_id
		where ${due(today)} and s.deleted_at is null and r.space_id > ${afterId}
		order by r.space_id limit ${limit}`);
	return rows.map((r) => r.id);
}

/**
 * D1 statements the recurring work of one jobs Worker invocation may use, shared by every `recurring_check` of
 * the queue batch (`handleBatch` hands them one budget and runs them after the batch's other jobs). D1 allows
 * 1,000 queries per Worker invocation on Workers Paid, 50 on Free
 * (https://developers.cloudflare.com/d1/platform/limits/, checked 2026-10-08). Every statement of a `db.batch`
 * is counted as one query here (conservative), so at least 700 stay for the other jobs of a batch of 10.
 */
export const RECURRING_STATEMENTS_PER_INVOCATION = 300;
/** Most instances one `db.batch` of the cron attempts. */
const INSTANCES_PER_BATCH = 20;
/** Worst-case statements of one `attemptInstances` call: seq bump, check, flag bump; per attempt insert, advance, flag. */
const batchCost = (attempts: number) => 3 + 3 * attempts;

/** D1 statements left to the recurring work of this invocation; every cron call takes its cost before it runs. */
export interface D1Budget {
	left: number;
}

/**
 * The recurring budget of an invocation whose other jobs already used `usedByOthers` statements: at most
 * RECURRING_STATEMENTS_PER_INVOCATION, and never more than what is left of D1_STATEMENTS_PER_INVOCATION
 * (FN-36 red team L3: other jobs 750 + recurring 300 went past 1,000).
 */
export const recurringBudget = (usedByOthers = 0): D1Budget => ({
	left: Math.max(
		0,
		Math.min(RECURRING_STATEMENTS_PER_INVOCATION, D1_STATEMENTS_PER_INVOCATION - usedByOthers)
	)
});

/**
 * The `recurring_check` handler of one jobs Worker invocation: every message shares one budget, created at the
 * first recurring check from what the invocation's other jobs already used (`statementsUsed`).
 */
export function recurringChecker(db: Db, statementsUsed: () => number) {
	let budget: D1Budget | undefined;
	return (spaceId: string, today: string, now: number): Promise<RecurringRun> => {
		budget ??= recurringBudget(statementsUsed());
		return runDueSeries(db, spaceId, today, now, budget);
	};
}

/** What the cron reads of a due series. */
export interface DueRow {
	id: string;
	type: RecurringType;
	amountMinor: number;
	currency: string;
	walletId: string;
	categoryId: string;
	title: string | null;
	note: string | null;
	frequency: RecurringFrequency;
	intervalDay: number;
	endOn: string | null;
	nextRunOn: string;
	attention: RecurringAttention | null;
	createdByUserId: string | null;
	updatedAt: number;
}

/**
 * One planned instance: series `s` on `runOn`, while the series still has `updatedAt` (as read, or as the
 * earlier attempts of the same batch leave it: each advance sets `max(now, updated_at + 1)`).
 */
export interface DueAttempt {
	s: DueRow;
	runOn: string;
	updatedAt: number;
}

/**
 * What one attempt did: `created` the instance; `advanced` it already existed (live or deleted: a deleted
 * generated row is never recreated) so only the next run moved on; `changed` the series was edited, paused,
 * stopped or advanced meanwhile (nothing written); otherwise refused for the reason it was flagged with.
 */
export type InstanceResult = 'created' | 'advanced' | 'changed' | RecurringAttention;

const keyExists = (spaceId: string, key: string) => sql`exists (select 1 from transactions x
	where x.space_id = ${spaceId} and x.source = 'manual' and x.dedupe_key = ${key})`;

/**
 * Attempts `attempts` in order in one `db.batch` (D1 runs it as one transaction), two statements each:
 * 1. the insert, through the one transaction write path (`insertTransactions`: the series' member still a live
 *    member, the wallet live in the series' currency, the category visible and of its kind, the space under
 *    MAX_TRANSACTIONS_PER_SPACE), only while the series is still active, at `updatedAt` and due on `runOn`, and
 *    no transaction of the space ever had its dedupe key `recurring:<id>:<date>` (a tombstone counts: a deleted
 *    instance stays deleted);
 * 2. the advance to the following run (stopped when that is past the end date), only while it is still due on
 *    that date and a transaction with that dedupe key exists (just inserted, or from before).
 * A repeated or concurrent attempt (queue redelivery, overlapping ticks) finds the date already advanced and
 * writes nothing; the unique index `transactions_dedupe_uq` stands behind the guard. Refused attempts are then
 * explained with one select and flagged in one more batch. One result per attempt; null for an attempt after a
 * refused one of the same series (its series did not move, so it wrote nothing). Takes at most
 * `batchCost(attempts.length)` statements from `budget`.
 */
export async function attemptInstances(
	db: Db,
	spaceId: string,
	attempts: readonly DueAttempt[],
	now: number,
	budget: D1Budget
): Promise<(InstanceResult | null)[]> {
	if (attempts.length === 0) return [];
	const r = recurringTransactions;
	const writes: BatchItem<'sqlite'>[] = attempts.flatMap(({ s, runOn, updatedAt }) => {
		const key = recurringDedupeKey(s.id, runOn);
		const following = followingRun({ frequency: s.frequency, day: s.intervalDay }, runOn);
		return [
			insertTransactions(
				db,
				{ spaceId, userId: s.createdByUserId ?? '' },
				[
					{
						id: newId(),
						input: {
							type: s.type,
							amountMinor: s.amountMinor,
							currency: s.currency,
							walletId: s.walletId,
							transferToWalletId: null,
							categoryId: s.categoryId,
							title: s.title,
							note: s.note,
							occurredOn: runOn,
							occurredTime: null
						},
						origin: { source: 'manual', dedupeKey: key, isDemo: false },
						recurringSeriesId: s.id
					}
				],
				now,
				() => sql`exists (select 1 from recurring_transactions r where r.id = ${s.id}
						and r.space_id = ${spaceId} and r.status = 'active' and r.deleted_at is null
						and r.next_run_on = ${runOn} and r.updated_at = ${updatedAt})
					and not ${keyExists(spaceId, key)}`
			),
			db
				.update(r)
				.set({
					nextRunOn: following,
					status: sql`case when ${r.endOn} is not null and ${following} > ${r.endOn}
						then 'stopped' else ${r.status} end`,
					attention: null,
					updatedAt: sql`max(${now}, ${r.updatedAt} + 1)`,
					seq: currentSpaceSeq(spaceId)
				})
				.where(
					and(
						eq(r.id, s.id),
						eq(r.spaceId, spaceId),
						eq(r.status, 'active'),
						isNull(r.deletedAt),
						eq(r.nextRunOn, runOn),
						keyExists(spaceId, key)
					)
				)
				.returning({ id: r.id })
		];
	});
	budget.left -= 1 + writes.length;
	const [, ...out] = (await db.batch([bumpSpaceSeq(db, spaceId), ...writes])) as unknown[];
	const results: (InstanceResult | null)[] = [];
	const refused = new Map<string, number>(); // series id -> index of its refused attempt
	attempts.forEach(({ s }, i) => {
		if (refused.has(s.id)) {
			results.push(null);
			return;
		}
		const wrote = (n: number) => (out[n] as unknown[]).length === 1;
		if (wrote(2 * i)) results.push('created');
		else if (wrote(2 * i + 1)) results.push('advanced');
		else {
			refused.set(s.id, i);
			results.push(null);
		}
	});
	if (refused.size > 0) await explain(db, spaceId, attempts, refused, results, now, budget);
	return results;
}

/** After refused inserts: why each was refused, and the series flagged with it (unless it changed meanwhile). */
async function explain(
	db: Db,
	spaceId: string,
	attempts: readonly DueAttempt[],
	refused: ReadonlyMap<string, number>,
	results: (InstanceResult | null)[],
	now: number,
	budget: D1Budget
): Promise<void> {
	budget.left -= 1;
	const rows = await db.all<{
		id: string;
		live: number;
		nextRunOn: string | null;
		updatedAt: number;
		member: number;
		n: number;
	}>(sql`select r.id as id, (r.status = 'active' and r.deleted_at is null) as live,
			r.next_run_on as nextRunOn, r.updated_at as updatedAt,
			exists (select 1 from space_members m join spaces sp on sp.id = m.space_id
				where m.space_id = r.space_id and m.user_id = r.created_by_user_id
				and m.deleted_at is null and sp.deleted_at is null) as member,
			(select count(*) from transactions t where t.space_id = ${spaceId} and t.deleted_at is null) as n
		from recurring_transactions r
		where r.space_id = ${spaceId} and r.id in (${sql.join(
			[...refused.keys()].map((id) => sql`${id}`),
			sql`, `
		)})`);
	const byId = new Map(rows.map((row) => [row.id, row]));
	const r = recurringTransactions;
	const flags: BatchItem<'sqlite'>[] = [];
	for (const [id, i] of refused) {
		const { s, runOn, updatedAt } = attempts[i] as DueAttempt;
		const state = byId.get(id);
		// Edited, paused, stopped, deleted or advanced meanwhile (same `updated_at` means same creator too).
		if (!state?.live || state.nextRunOn !== runOn || state.updatedAt !== updatedAt) {
			results[i] = 'changed';
			continue;
		}
		const reason: RecurringAttention =
			state.n >= MAX_TRANSACTIONS_PER_SPACE ? 'limit' : state.member ? 'refs' : 'member';
		results[i] = reason;
		if (s.attention === reason && updatedAt === s.updatedAt) continue;
		flags.push(
			db
				.update(r)
				.set({
					attention: reason,
					updatedAt: sql`max(${now}, ${r.updatedAt} + 1)`,
					seq: currentSpaceSeq(spaceId)
				})
				.where(
					and(
						eq(r.id, id),
						eq(r.spaceId, spaceId),
						eq(r.status, 'active'),
						isNull(r.deletedAt),
						eq(r.nextRunOn, runOn),
						eq(r.updatedAt, updatedAt)
					)
				)
		);
	}
	if (flags.length === 0) return;
	budget.left -= 1 + flags.length;
	await db.batch([bumpSpaceSeq(db, spaceId), ...flags]);
}

/** The space's due series (MAX_SERIES_PER_SPACE bounds a space, so one page holds them all) and its live row count. */
function dueSeries(db: Db, spaceId: string, today: string) {
	return db.all<DueRow & { n: number }>(sql`select r.id as id, r.type as type,
			r.amount_minor as amountMinor, r.currency as currency, r.wallet_id as walletId,
			r.category_id as categoryId, r.title as title, r.note as note, r.frequency as frequency,
			r.interval_day as intervalDay, r.end_on as endOn, r.next_run_on as nextRunOn,
			r.attention as attention, r.created_by_user_id as createdByUserId, r.updated_at as updatedAt,
			(select count(*) from transactions t where t.space_id = ${spaceId} and t.deleted_at is null) as n
		from recurring_transactions r
		where r.space_id = ${spaceId} and ${due(today)}
		order by r.id limit ${MAX_SERIES_PER_SPACE}`);
}

/**
 * The runs of `s` due on or before `today` within its end date, oldest first, at most `max`, each with the
 * `updated_at` the advances before it leave (`max(now, updated_at + 1)` each).
 */
export function dueRuns(s: DueRow, today: string, now: number, max: number): DueAttempt[] {
	const schedule = { frequency: s.frequency, day: s.intervalDay };
	const runs: DueAttempt[] = [];
	let runOn = s.nextRunOn;
	let updatedAt = s.updatedAt;
	while (runs.length < max && runOn <= today && (s.endOn === null || runOn <= s.endOn)) {
		runs.push({ s, runOn, updatedAt });
		runOn = followingRun(schedule, runOn);
		updatedAt = Math.max(now, updatedAt + 1);
	}
	return runs;
}

/** Counts per outcome (no ids, nothing else) and `more`: work was left for a later message (budget or cap). */
export type RecurringRun = Record<InstanceResult, number> & { more: boolean };

/**
 * The `recurring_check` job for one space on the WIB date `today`: every due series (by id), each caught up run
 * by run until it is no longer due on `today` or an attempt is refused; at most MAX_INSTANCES_PER_RUN attempts,
 * INSTANCES_PER_BATCH per `db.batch`, and never more D1 statements than `budget` has left (shared by the
 * invocation's other `recurring_check` messages). A space at MAX_TRANSACTIONS_PER_SPACE costs one select (and,
 * once, one batch flagging its series `limit`); series flagged `refs`/`member` are never read.
 */
export async function runDueSeries(
	db: Db,
	spaceId: string,
	today: string,
	now: number,
	budget: D1Budget = recurringBudget()
): Promise<RecurringRun> {
	const run: RecurringRun = {
		created: 0,
		advanced: 0,
		changed: 0,
		limit: 0,
		refs: 0,
		member: 0,
		more: false
	};
	// The page read, then at least one batch of one attempt (and the cap flag fits in that too).
	if (budget.left < 1 + batchCost(1)) return { ...run, more: true };
	budget.left -= 1;
	const page = await dueSeries(db, spaceId, today);
	if (page.length === 0) return run;
	if ((page[0]?.n ?? 0) >= MAX_TRANSACTIONS_PER_SPACE) {
		run.limit = page.length;
		if (page.some((s) => s.attention === null)) {
			budget.left -= 2;
			await db.batch([
				bumpSpaceSeq(db, spaceId),
				db
					.update(recurringTransactions)
					.set({
						attention: 'limit',
						updatedAt: sql`max(${now}, ${recurringTransactions.updatedAt} + 1)`,
						seq: currentSpaceSeq(spaceId)
					})
					.where(
						sql`id in (select r.id from recurring_transactions r where r.space_id = ${spaceId}
							and ${due(today)} and r.attention is null)
						and (select count(*) from transactions t where t.space_id = ${spaceId}
							and t.deleted_at is null) >= ${MAX_TRANSACTIONS_PER_SPACE}`
					)
			]);
		}
		return run;
	}
	const queue: DueAttempt[] = [];
	// One more than the cap is planned only to know whether work is left for a follow-up message.
	for (const s of page) {
		queue.push(...dueRuns(s, today, now, MAX_INSTANCES_PER_RUN + 1 - queue.length));
		if (queue.length > MAX_INSTANCES_PER_RUN) {
			queue.length = MAX_INSTANCES_PER_RUN;
			run.more = true;
			break;
		}
	}
	const stopped = new Set<string>();
	let at = 0;
	while (at < queue.length) {
		const fits = Math.min(INSTANCES_PER_BATCH, Math.floor((budget.left - 3) / 3));
		if (fits < 1) {
			run.more = true;
			break;
		}
		const chunk: DueAttempt[] = [];
		while (at < queue.length && chunk.length < fits) {
			const a = queue[at++] as DueAttempt;
			if (!stopped.has(a.s.id)) chunk.push(a);
		}
		const results = await attemptInstances(db, spaceId, chunk, now, budget);
		results.forEach((result, i) => {
			if (result === null) return;
			run[result]++;
			if (result !== 'created' && result !== 'advanced') stopped.add((chunk[i] as DueAttempt).s.id);
		});
		// At the cap every further insert is refused: the next message flags the rest at once.
		if (run.limit > 0) break;
	}
	return run;
}
