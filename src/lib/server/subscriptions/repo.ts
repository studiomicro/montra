import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import {
	effectiveNextCharge,
	followingCharge,
	nextChargeOn,
	type BillingCycle,
	type BillingSchedule
} from '#lib/shared/subscriptions';
import type { SubscriptionCategory } from '#lib/shared/subscriptions-catalogue';
import type { Db } from '../db';
import { spaceNotifications, spaces, subscriptions, transactions } from '../db/schema';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { insertTransactions, MAX_TRANSACTIONS_PER_SPACE } from '../transactions/repo';
import type { TransactionInput } from '../transactions/validation';
import { newId } from '../util';
import type { SubscriptionInput } from './validation';

/** Most live subscriptions one space holds (owner decision 5); also the list's row cap. */
export const MAX_SUBSCRIPTIONS_PER_SPACE = 100;
/** How many recent expenses "hubungkan transaksi" offers. */
const PAYABLE_EXPENSES_LIMIT = 30;

// Every function here runs only after `requireSpaceAccess` admitted `scope.userId` to `scope.spaceId`; each
// write repeats that membership (`isLiveMember`) inside its own statement, so a removal in between changes
// nothing. Ids from a form are only ever looked up inside the space: another space's id reads as missing.

export interface SubscriptionSummary {
	id: string;
	catalogueId: string | null;
	name: string;
	category: SubscriptionCategory;
	amountMinor: number;
	currency: string;
	schedule: BillingSchedule;
	walletId: string | null;
	/** The wallet's name while it is still there (archived included); null without one. */
	walletName: string | null;
	/** The live transaction of the latest payment; null when none was linked or it was deleted since. */
	linked: { id: string; occurredOn: string } | null;
	/** The next charge (WIB), never stale: see `effectiveNextCharge`. */
	nextChargeOn: string;
	reminderDaysBefore: number;
	/** Fictional local-review row ("Data demo"): badged, left out of the monthly total, reminders and payment. */
	isDemo: boolean;
	createdAt: number;
	updatedAt: number;
}

/** `missing`: no such live subscription in this space (same answer for another space's id). */
export type SubscriptionWriteResult = 'ok' | 'stale' | 'missing';

interface Row {
	id: string;
	catalogueId: string | null;
	name: string | null;
	category: string | null;
	amountMinor: number | null;
	currency: string | null;
	billingCycle: BillingCycle | null;
	billingDay: number | null;
	billingMonth: number | null;
	walletId: string | null;
	walletName: string | null;
	linkedId: string | null;
	linkedOn: string | null;
	nextChargeOn: string | null;
	reminderDaysBefore: number | null;
	isDemo: number;
	createdAt: number;
	updatedAt: number;
}

/** A live row (the CHECK guarantees its content) with its next charge as of `today`. */
function summary(row: Row, today: string): SubscriptionSummary | null {
	const {
		name,
		category,
		amountMinor,
		currency,
		billingCycle,
		billingDay,
		nextChargeOn: stored
	} = row;
	if (
		name === null ||
		category === null ||
		amountMinor === null ||
		currency === null ||
		billingCycle === null ||
		billingDay === null ||
		stored === null ||
		row.reminderDaysBefore === null
	)
		return null;
	const schedule: BillingSchedule = {
		cycle: billingCycle,
		day: billingDay,
		month: row.billingMonth
	};
	return {
		id: row.id,
		catalogueId: row.catalogueId,
		name,
		category: category as SubscriptionCategory,
		amountMinor,
		currency,
		schedule,
		walletId: row.walletId,
		walletName: row.walletId ? row.walletName : null,
		linked: row.linkedId && row.linkedOn ? { id: row.linkedId, occurredOn: row.linkedOn } : null,
		nextChargeOn: effectiveNextCharge(schedule, stored, today),
		reminderDaysBefore: row.reminderDaysBefore,
		isDemo: Boolean(row.isDemo),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

/** The rows of `where` with their wallet name and live linked transaction (one query, bounded). */
async function select(db: Db, spaceId: string, extra: SQL | null) {
	return db.all<Row>(sql`select s.id as id, s.catalogue_id as catalogueId, s.name as name,
			s.category as category, s.amount_minor as amountMinor, s.currency as currency,
			s.billing_cycle as billingCycle, s.billing_day as billingDay, s.billing_month as billingMonth,
			s.wallet_id as walletId, w.name as walletName, t.id as linkedId, t.occurred_on as linkedOn,
			s.next_charge_on as nextChargeOn, s.reminder_days_before as reminderDaysBefore,
			s.is_demo as isDemo, s.created_at as createdAt, s.updated_at as updatedAt
		from subscriptions s
		left join wallets w on w.id = s.wallet_id and w.space_id = s.space_id
		left join transactions t on t.id = s.linked_transaction_id and t.space_id = s.space_id
			and t.deleted_at is null
		where s.space_id = ${spaceId} and s.deleted_at is null ${extra ? sql`and ${extra}` : sql``}
		order by s.created_at, s.id
		limit ${MAX_SUBSCRIPTIONS_PER_SPACE}`);
}

/** The space's live subscriptions, soonest next charge first (then name). Bounded by the per-space cap. */
export async function listSubscriptions(
	db: Db,
	spaceId: string,
	today: string
): Promise<SubscriptionSummary[]> {
	const rows = await select(db, spaceId, null);
	return rows
		.map((r) => summary(r, today))
		.filter((s): s is SubscriptionSummary => s !== null)
		.sort((a, b) =>
			a.nextChargeOn === b.nextChargeOn
				? a.name.localeCompare(b.name, 'id') || (a.id < b.id ? -1 : 1)
				: a.nextChargeOn < b.nextChargeOn
					? -1
					: 1
		);
}

/** One live subscription of this space; null for an unknown, deleted or other-space id. */
export async function getSubscription(
	db: Db,
	spaceId: string,
	id: string,
	today: string
): Promise<SubscriptionSummary | null> {
	const [row] = await select(db, spaceId, sql`s.id = ${id}`);
	return row ? summary(row, today) : null;
}

/**
 * SQL condition: `walletId` is null, or a live wallet of the space in `currency`. `keep` (an edit) also allows
 * the wallet the row already names, archived or not, so archiving a wallet never blocks editing a bill.
 */
function walletHolds(
	spaceId: string,
	walletId: string | null,
	currency: string,
	keep: string | null
) {
	if (walletId === null) return sql`1`;
	return sql`exists (select 1 from wallets w where w.id = ${walletId} and w.space_id = ${spaceId}
		and w.currency = ${currency} and (w.deleted_at is null or w.id = ${keep ?? ''}))`;
}

/** `updated_at` of a write that expected `expected`: always later, even within the same millisecond. */
const nextUpdatedAt = (expected: number, now: number) => Math.max(now, expected + 1);

const liveCount = (spaceId: string) =>
	sql`(select count(*) from subscriptions x where x.space_id = ${spaceId} and x.deleted_at is null)`;

export type CreateSubscriptionResult =
	{ ok: true; id: string } | { ok: false; reason: 'limit' | 'wallet' | 'gone' };

/**
 * Creates a subscription with its first charge on or after `today` (WIB). One guarded insert: refused past
 * MAX_SUBSCRIPTIONS_PER_SPACE live rows (so concurrent creates cannot pass the cap), when the wallet is not a
 * live wallet of the space in the bill's currency, or when the membership went meanwhile.
 */
export async function createSubscription(
	db: Db,
	scope: SpaceScope,
	input: SubscriptionInput,
	today: string,
	now: number
): Promise<CreateSubscriptionResult> {
	const { spaceId, userId } = scope;
	const id = newId();
	const { schedule } = input;
	const [, inserted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.insert(subscriptions)
			.select((qb) =>
				qb
					.select({
						id: sql`${id}`.as('id'),
						spaceId: spaces.id,
						catalogueId: sql`${input.catalogueId}`.as('catalogue_id'),
						name: sql`${input.name}`.as('name'),
						category: sql`${input.category}`.as('category'),
						amountMinor: sql`${input.amountMinor}`.as('amount_minor'),
						currency: sql`${input.currency}`.as('currency'),
						billingCycle: sql`${schedule.cycle}`.as('billing_cycle'),
						billingDay: sql`${schedule.day}`.as('billing_day'),
						billingMonth: sql`${schedule.month}`.as('billing_month'),
						walletId: sql`${input.walletId}`.as('wallet_id'),
						linkedTransactionId: sql`null`.as('linked_transaction_id'),
						nextChargeOn: sql`${nextChargeOn(schedule, today)}`.as('next_charge_on'),
						reminderDaysBefore: sql`${input.reminderDaysBefore}`.as('reminder_days_before'),
						// A form row is always real; only scripts/demo-seed.ts writes `Data demo` rows.
						isDemo: sql`0`.as('is_demo'),
						createdAt: sql`${now}`.as('created_at'),
						updatedAt: sql`${now}`.as('updated_at'),
						deletedAt: sql`null`.as('deleted_at'),
						seq: sql`${currentSpaceSeq(spaceId)}`.as('seq')
					})
					.from(spaces)
					.where(
						and(
							eq(spaces.id, spaceId),
							isLiveMember(spaceId, userId),
							sql`${liveCount(spaceId)} < ${MAX_SUBSCRIPTIONS_PER_SPACE}`,
							walletHolds(spaceId, input.walletId, input.currency, null)
						)
					)
			)
			.returning({ id: subscriptions.id })
	]);
	if (inserted.length === 1) return { ok: true, id };
	const [count] = await db.all<{ n: number }>(sql`select ${liveCount(spaceId)} as n`);
	if ((count?.n ?? 0) >= MAX_SUBSCRIPTIONS_PER_SPACE) return { ok: false, reason: 'limit' };
	const [wallet] = await db.all<{ ok: number }>(
		sql`select ${walletHolds(spaceId, input.walletId, input.currency, null)} as ok`
	);
	return { ok: false, reason: wallet?.ok ? 'gone' : 'wallet' };
}

/** After a guarded write changed nothing: `stale` when the subscription is still live here, else `missing`. */
async function whyNot(db: Db, spaceId: string, id: string): Promise<SubscriptionWriteResult> {
	const row = await db
		.select({ id: subscriptions.id })
		.from(subscriptions)
		.where(
			and(
				eq(subscriptions.id, id),
				eq(subscriptions.spaceId, spaceId),
				isNull(subscriptions.deletedAt)
			)
		)
		.get();
	return row ? 'stale' : 'missing';
}

/**
 * The guarded tail of every write: this live subscription of this space, `updated_at` still
 * `expectedUpdatedAt` (the value the form was loaded with, so a second tab's stale submission is refused),
 * the writer still a member.
 */
const writable = (scope: SpaceScope, id: string, expectedUpdatedAt: number) =>
	and(
		eq(subscriptions.id, id),
		eq(subscriptions.spaceId, scope.spaceId),
		eq(subscriptions.updatedAt, expectedUpdatedAt),
		isNull(subscriptions.deletedAt),
		isLiveMember(scope.spaceId, scope.userId)
	);

/**
 * Saves the edit form. A changed schedule restarts from `today` (next charge on or after it); an unchanged one
 * keeps the stored next charge, so editing the price never undoes "sudah dibayar". The catalogue id is kept.
 * `current` is the row as the action read it (its wallet stays allowed even if archived since).
 */
export async function updateSubscription(
	db: Db,
	scope: SpaceScope,
	id: string,
	input: SubscriptionInput,
	current: Pick<SubscriptionSummary, 'walletId'>,
	expectedUpdatedAt: number,
	today: string,
	now: number
): Promise<SubscriptionWriteResult | 'wallet'> {
	const { schedule } = input;
	const restart = nextChargeOn(schedule, today);
	const [, updated] = await db.batch([
		bumpSpaceSeq(db, scope.spaceId),
		db
			.update(subscriptions)
			.set({
				name: input.name,
				category: input.category,
				amountMinor: input.amountMinor,
				currency: input.currency,
				billingCycle: schedule.cycle,
				billingDay: schedule.day,
				billingMonth: schedule.month,
				walletId: input.walletId,
				nextChargeOn: sql`case when ${subscriptions.billingCycle} = ${schedule.cycle}
					and ${subscriptions.billingDay} = ${schedule.day}
					and coalesce(${subscriptions.billingMonth}, 0) = ${schedule.month ?? 0}
					then ${subscriptions.nextChargeOn} else ${restart} end`,
				reminderDaysBefore: input.reminderDaysBefore,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(scope.spaceId)
			})
			.where(
				and(
					writable(scope, id, expectedUpdatedAt),
					walletHolds(scope.spaceId, input.walletId, input.currency, current.walletId)
				)
			)
			.returning({ id: subscriptions.id })
	]);
	if (updated.length === 1) return 'ok';
	const why = await whyNot(db, scope.spaceId, id);
	if (why === 'missing') return why;
	const [wallet] = await db.all<{ ok: number }>(
		sql`select ${walletHolds(scope.spaceId, input.walletId, input.currency, current.walletId)} as ok`
	);
	return wallet?.ok ? 'stale' : 'wallet';
}

/** Deletes a subscription: a content-free tombstone (only id, space, timestamps and seq remain). */
export async function deleteSubscription(
	db: Db,
	scope: SpaceScope,
	id: string,
	expectedUpdatedAt: number,
	now: number
): Promise<SubscriptionWriteResult> {
	const prefix = `bill:${id}:`;
	const [, deleted] = await db.batch([
		bumpSpaceSeq(db, scope.spaceId),
		db
			.update(subscriptions)
			.set({
				catalogueId: null,
				name: null,
				category: null,
				amountMinor: null,
				currency: null,
				billingCycle: null,
				billingDay: null,
				billingMonth: null,
				walletId: null,
				linkedTransactionId: null,
				nextChargeOn: null,
				reminderDaysBefore: null,
				deletedAt: now,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(scope.spaceId)
			})
			.where(writable(scope, id, expectedUpdatedAt))
			.returning({ id: subscriptions.id }),
		// Red team L2: every member's bill reminders of this subscription become content-free tombstones in the
		// same batch (name and amount gone at once, not after the 90-day sweep). They keep their key, so a
		// replayed tick never recreates them. Only once the subscription itself is a tombstone.
		db
			.update(spaceNotifications)
			.set({ params: null, readAt: null, deletedAt: now, updatedAt: now })
			.where(
				sql`${spaceNotifications.spaceId} = ${scope.spaceId}
					and ${spaceNotifications.kind} = 'bill_reminder' and ${spaceNotifications.deletedAt} is null
					and substr(${spaceNotifications.dataKey}, 1, ${prefix.length}) = ${prefix}
					and exists (select 1 from subscriptions s where s.id = ${id} and s.space_id = ${scope.spaceId}
						and s.deleted_at is not null)`
			)
	]);
	return deleted.length === 1 ? 'ok' : whyNot(db, scope.spaceId, id);
}

/** SQL condition: `transactionId` is a live, real (not demo) expense of the space in `currency`. */
const payableExpense = (spaceId: string, transactionId: string, currency: string) =>
	sql`exists (select 1 from transactions t where t.id = ${transactionId} and t.space_id = ${spaceId}
		and t.deleted_at is null and t.type = 'expense' and t.currency = ${currency} and t.is_demo = 0)`;

/** The charge after the one now due (what a payment advances `next_charge_on` to). */
const advanced = (current: SubscriptionSummary) =>
	followingCharge(current.schedule, current.nextChargeOn);

/**
 * "Tandai sudah dibayar" with an existing transaction: links it and advances the next charge one cycle past
 * the one now due. `current` is the row as the action read it with the same `today`; the write is guarded by
 * its `updated_at`, so the advance is computed from exactly that row. `transaction`: the id is not a live real
 * expense of this space in the bill's currency (another space's id reads the same).
 */
export async function markPaidWithExisting(
	db: Db,
	scope: SpaceScope,
	current: SubscriptionSummary,
	expectedUpdatedAt: number,
	transactionId: string,
	now: number
): Promise<SubscriptionWriteResult | 'transaction'> {
	const [, updated] = await db.batch([
		bumpSpaceSeq(db, scope.spaceId),
		db
			.update(subscriptions)
			.set({
				linkedTransactionId: transactionId,
				nextChargeOn: advanced(current),
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(scope.spaceId)
			})
			.where(
				and(
					writable(scope, current.id, expectedUpdatedAt),
					payableExpense(scope.spaceId, transactionId, current.currency)
				)
			)
			.returning({ id: subscriptions.id })
	]);
	if (updated.length === 1) return 'ok';
	const why = await whyNot(db, scope.spaceId, current.id);
	if (why === 'missing') return why;
	const [tx] = await db.all<{ ok: number }>(
		sql`select ${payableExpense(scope.spaceId, transactionId, current.currency)} as ok`
	);
	return tx?.ok ? 'stale' : 'transaction';
}

/**
 * "Tandai sudah dibayar" → "Catat transaksi baru": in one batch, writes the expense through FN-05's own
 * write path (`insertTransactions`: membership, wallet/category and the space's transaction cap re-checked in
 * the statement; source `manual`), only while the subscription is still as the form saw it, then links it and
 * advances the next charge. Either both rows change or neither does. `input` was checked by FN-05's
 * validation (`capturedTransactionInput`) in the action.
 */
export async function markPaidWithNew(
	db: Db,
	scope: SpaceScope,
	current: SubscriptionSummary,
	expectedUpdatedAt: number,
	input: TransactionInput,
	now: number
): Promise<
	| { ok: true; transactionId: string }
	| { ok: false; reason: 'stale' | 'missing' | 'limit' | 'gone' }
> {
	const { spaceId } = scope;
	const transactionId = newId();
	const stillAsLoaded = sql`exists (select 1 from subscriptions s where s.id = ${current.id}
		and s.space_id = ${spaceId} and s.updated_at = ${expectedUpdatedAt} and s.deleted_at is null)`;
	const [, inserted, updated] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		insertTransactions(
			db,
			scope,
			[{ id: transactionId, input, origin: { source: 'manual', dedupeKey: null, isDemo: false } }],
			now,
			() => stillAsLoaded
		),
		db
			.update(subscriptions)
			.set({
				linkedTransactionId: transactionId,
				nextChargeOn: advanced(current),
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					writable(scope, current.id, expectedUpdatedAt),
					sql`exists (select 1 from transactions t where t.id = ${transactionId}
						and t.space_id = ${spaceId} and t.deleted_at is null)`
				)
			)
			.returning({ id: subscriptions.id })
	]);
	if (inserted.length === 1 && updated.length === 1) return { ok: true, transactionId };
	const why = await whyNot(db, spaceId, current.id);
	if (why === 'missing') return { ok: false, reason: 'missing' };
	const [s] = await db.all<{ ok: number }>(sql`select ${stillAsLoaded} as ok`);
	if (!s?.ok) return { ok: false, reason: 'stale' };
	const [count] = await db.all<{ n: number }>(
		sql`select count(*) as n from transactions where space_id = ${spaceId} and deleted_at is null`
	);
	return {
		ok: false,
		reason: (count?.n ?? 0) >= MAX_TRANSACTIONS_PER_SPACE ? 'limit' : 'gone'
	};
}

export interface PayableExpense {
	id: string;
	title: string | null;
	amountMinor: number;
	currency: string;
	occurredOn: string;
}

/** The space's most recent live real expenses (what "hubungkan transaksi" offers), newest first. */
export async function listPayableExpenses(db: Db, spaceId: string): Promise<PayableExpense[]> {
	const rows = await db
		.select({
			id: transactions.id,
			title: transactions.title,
			amountMinor: transactions.amountMinor,
			currency: transactions.currency,
			occurredOn: transactions.occurredOn
		})
		.from(transactions)
		.where(
			and(
				eq(transactions.spaceId, spaceId),
				isNull(transactions.deletedAt),
				eq(transactions.type, 'expense'),
				eq(transactions.isDemo, false)
			)
		)
		.orderBy(desc(transactions.occurredOn), desc(transactions.occurredAt), desc(transactions.id))
		.limit(PAYABLE_EXPENSES_LIMIT);
	return rows.flatMap((r) =>
		r.amountMinor !== null && r.currency && r.occurredOn
			? [{ ...r, amountMinor: r.amountMinor, currency: r.currency, occurredOn: r.occurredOn }]
			: []
	);
}
