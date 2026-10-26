import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { isLocked, type FormMode, type PatunganMode } from '#lib/shared/patungan';
import type { Db } from '../db';
import { batchAssert, isBatchAssertFailure } from '../db/assert';
import { patunganParticipants, patunganSplits, transactions } from '../db/schema';
import { isLiveMember, MAX_SPACE_MEMBERS, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { safeMinor } from '../transactions/aggregate';
import { insertTransactions, MANUAL, MAX_TRANSACTIONS_PER_SPACE } from '../transactions/repo';
import type { TransactionInput } from '../transactions/validation';
import { isUniqueViolation } from '../util';

/**
 * FN-49 Patungan: every read and write of splits. Each function takes a space the caller admitted through
 * `requireSpaceAccess` (`currentSpaceScope`) and repeats the membership inside its own statements
 * (`isLiveMember`); every change is payer-only (`created_by_user_id`), checked in the same statement. A write that
 * touches a split and a transaction does so in one `db.batch` that ends with a `batchAssert` of the invariant
 * (shares add up to the total; a linked transaction counts exactly the payer's share), so it is all or nothing.
 *
 * The link lives on `transactions` (`patungan_split_id`, `patungan_effective_amount_minor`). Two kinds of linked
 * row, told apart by the numbers alone: a **bill** (an existing expense of the whole total: effective < amount,
 * since every other person's share is at least 1) and the payer's **own share** row this module created
 * (effective = amount). A bill's `amount_minor` is never changed here; an own-share row follows the payer's share.
 */

/** Most live splits one space holds (keeps the list and every scan bounded). */
const MAX_SPLITS_PER_SPACE = 1000;
/** Most splits /patungan lists (newest first). */
const SPLIT_LIST_LIMIT = 100;
/** Most transactions the "Dari transaksi" picker offers (newest first). */
const BILL_PICKER_LIMIT = 30;

export interface ParticipantInput {
	kind: 'member' | 'guest';
	/** Set exactly for a member (the payer's own row included). */
	memberUserId: string | null;
	/** A guest's typed name (cleaned); for a member the server stores the account name instead. */
	displayName: string;
	shareAmountMinor: number;
}

/** A split's content as the create and edit forms produce it. `participants[0]` is always the payer. */
export interface SplitFields {
	title: string;
	occurredOn: string;
	note: string | null;
	mode: FormMode;
	totalAmountMinor: number;
	participants: ParticipantInput[];
}

/** How the payer's own spending is recorded: an existing bill row linked, or a new row of their share. */
export type BillChoice =
	| { kind: 'link'; transactionId: string }
	| { kind: 'own'; transactionId: string; walletId: string; categoryId: string };

interface SplitParticipant {
	id: string;
	position: number;
	kind: 'member' | 'guest';
	memberUserId: string | null;
	displayName: string;
	isPayer: boolean;
	shareAmountMinor: number;
	paidAmountMinor: number;
	paidAt: number | null;
}

interface LinkedTransaction {
	id: string;
	title: string | null;
	amountMinor: number;
	effectiveAmountMinor: number;
	currency: string;
	occurredOn: string;
	walletName: string;
	/** The payer's own-share row this split created (effective = amount), not an existing bill. */
	ownShare: boolean;
}

export interface SplitDetail {
	id: string;
	title: string;
	totalAmountMinor: number;
	currency: string;
	occurredOn: string;
	mode: PatunganMode;
	note: string | null;
	payerName: string;
	createdByUserId: string | null;
	/**
	 * The payer is still a live member of the space. When not (removed, left, account deleted), the space's
	 * Pemilik may unlink or delete the split (owner decision, red team L2).
	 */
	payerIsMember: boolean;
	isDemo: boolean;
	updatedAt: number;
	participants: SplitParticipant[];
	linked: LinkedTransaction | null;
	locked: boolean;
}

export interface SplitListRow {
	id: string;
	title: string;
	totalAmountMinor: number;
	currency: string;
	occurredOn: string;
	isDemo: boolean;
	payerName: string;
	/** The viewer created (paid) this split. */
	viewerIsPayer: boolean;
	/** What the viewer, as a member participant, still owes (null when they are not on it as a non-payer). */
	viewerOwesMinor: number | null;
	/** Every non-payer share is paid. */
	settled: boolean;
	linked: boolean;
}

/** What the viewer is still owed on the splits they paid, per currency (demo splits never count). */
export interface OwedTotal {
	currency: string;
	/** Exact sum; null when past Number.MAX_SAFE_INTEGER. */
	owedMinor: number | null;
}

/** A transaction the "Dari transaksi" picker offers: a live, real, unlinked expense of the space. */
export interface BillCandidate {
	id: string;
	title: string | null;
	amountMinor: number;
	currency: string;
	occurredOn: string;
	walletName: string;
}

/** The live members of the space (account name and id), for the people picker. */
export async function spaceMemberNames(
	db: Db,
	spaceId: string
): Promise<{ userId: string; name: string }[]> {
	return db.all<{ userId: string; name: string }>(sql`select m.user_id as userId, u.name as name
		from space_members m join users u on u.id = m.user_id
		where m.space_id = ${spaceId} and m.deleted_at is null
		order by case m.role when 'owner' then 0 else 1 end, m.created_at, m.id
		limit ${MAX_SPACE_MEMBERS}`);
}

/** The space's splits, newest first (at most SPLIT_LIST_LIMIT), with the viewer's part in each. */
export async function listSplits(db: Db, scope: SpaceScope): Promise<SplitListRow[]> {
	const { spaceId, userId } = scope;
	const rows = await db.all<{
		id: string;
		title: string;
		total: number;
		currency: string;
		occurredOn: string;
		isDemo: number;
		payerName: string;
		viewerIsPayer: number;
		owes: number | null;
		open: number;
		linked: number;
	}>(sql`select s.id, s.title, s.total_amount_minor as total, s.currency, s.occurred_on as occurredOn,
			s.is_demo as isDemo, s.payer_name as payerName,
			coalesce(s.created_by_user_id = ${userId}, 0) as viewerIsPayer,
			(select p.share_amount_minor - p.paid_amount_minor from patungan_participants p
				where p.split_id = s.id and p.space_id = s.space_id and p.deleted_at is null
				and p.is_payer = 0 and p.member_user_id = ${userId}) as owes,
			(select count(*) from patungan_participants p where p.split_id = s.id and p.space_id = s.space_id
				and p.deleted_at is null and p.is_payer = 0 and p.paid_at is null) as open,
			exists (select 1 from transactions t where t.patungan_split_id = s.id and t.space_id = s.space_id
				and t.deleted_at is null) as linked
		from patungan_splits s
		where s.space_id = ${spaceId} and s.deleted_at is null
		order by s.occurred_on desc, s.created_at desc, s.id desc
		limit ${SPLIT_LIST_LIMIT}`);
	return rows.map((r) => ({
		id: r.id,
		title: r.title,
		totalAmountMinor: r.total,
		currency: r.currency,
		occurredOn: r.occurredOn,
		isDemo: r.isDemo === 1,
		payerName: r.payerName,
		viewerIsPayer: r.viewerIsPayer === 1,
		viewerOwesMinor: r.owes,
		settled: r.open === 0,
		linked: r.linked === 1
	}));
}

/**
 * "Belum dilunasi": what the others still owe the viewer on the splits the viewer paid, per currency, summed in
 * SQL over every live split of the space (not only the listed page). `Data demo` splits never count.
 */
export async function owedToViewer(db: Db, scope: SpaceScope): Promise<OwedTotal[]> {
	const rows = await db.all<{ currency: string; total: string }>(sql`select s.currency as currency,
			cast(sum(p.share_amount_minor - p.paid_amount_minor) as text) as total
		from patungan_participants p
		join patungan_splits s on s.id = p.split_id and s.space_id = p.space_id
		where s.space_id = ${scope.spaceId} and s.deleted_at is null and s.is_demo = 0
			and s.created_by_user_id = ${scope.userId}
			and p.deleted_at is null and p.is_payer = 0 and p.paid_at is null
		group by s.currency
		order by case s.currency when 'IDR' then 0 else 1 end, s.currency`);
	return rows.map((r) => ({ currency: r.currency, owedMinor: safeMinor(BigInt(r.total)) }));
}

/** One live split of the space with its people and its linked transaction; null for any other id. */
export async function getSplit(
	db: Db,
	spaceId: string,
	splitId: string
): Promise<SplitDetail | null> {
	const split = await db
		.select()
		.from(patunganSplits)
		.where(
			and(
				eq(patunganSplits.id, splitId),
				eq(patunganSplits.spaceId, spaceId),
				isNull(patunganSplits.deletedAt)
			)
		)
		.get();
	if (
		!split ||
		split.title === null ||
		split.totalAmountMinor === null ||
		split.currency === null ||
		split.occurredOn === null ||
		split.payerName === null
	)
		return null;
	const [people, linkedRows, payerMember] = await Promise.all([
		db.all<{
			id: string;
			position: number;
			kind: 'member' | 'guest';
			memberUserId: string | null;
			displayName: string;
			isPayer: number;
			share: number;
			paid: number;
			paidAt: number | null;
		}>(sql`select p.id, p.position, p.kind, p.member_user_id as memberUserId,
				p.display_name as displayName, p.is_payer as isPayer, p.share_amount_minor as share,
				p.paid_amount_minor as paid, p.paid_at as paidAt
			from patungan_participants p
			where p.split_id = ${splitId} and p.space_id = ${spaceId} and p.deleted_at is null
			order by p.position, p.id`),
		db.all<{
			id: string;
			title: string | null;
			amount: number;
			effective: number;
			currency: string;
			occurredOn: string;
			walletName: string | null;
		}>(sql`select t.id, t.title, t.amount_minor as amount, t.patungan_effective_amount_minor as effective,
				t.currency, t.occurred_on as occurredOn, w.name as walletName
			from transactions t
			left join wallets w on w.id = t.wallet_id and w.space_id = t.space_id
			where t.patungan_split_id = ${splitId} and t.space_id = ${spaceId} and t.deleted_at is null
			limit 1`),
		split.createdByUserId
			? db.get<{ one: number }>(sql`select 1 as one from space_members m
				where m.space_id = ${spaceId} and m.user_id = ${split.createdByUserId} and m.deleted_at is null`)
			: undefined
	]);
	const participants: SplitParticipant[] = people.map((p) => ({
		id: p.id,
		position: p.position,
		kind: p.kind,
		memberUserId: p.memberUserId,
		displayName: p.displayName,
		isPayer: p.isPayer === 1,
		shareAmountMinor: p.share,
		paidAmountMinor: p.paid,
		paidAt: p.paidAt
	}));
	const t = linkedRows[0];
	return {
		id: split.id,
		title: split.title,
		totalAmountMinor: split.totalAmountMinor,
		currency: split.currency,
		occurredOn: split.occurredOn,
		mode: split.mode,
		note: split.note,
		payerName: split.payerName,
		createdByUserId: split.createdByUserId,
		payerIsMember: Boolean(payerMember),
		isDemo: split.isDemo,
		updatedAt: split.updatedAt,
		participants,
		linked: t
			? {
					id: t.id,
					title: t.title,
					amountMinor: t.amount,
					effectiveAmountMinor: t.effective,
					currency: t.currency,
					occurredOn: t.occurredOn,
					walletName: t.walletName ?? '',
					ownShare: t.effective === t.amount
				}
			: null,
		locked: isLocked(participants)
	};
}

/** SQL (alias `t`): a transaction that may become a split's bill — a live, real expense not linked yet. */
const linkable = (spaceId: string) => sql`t.space_id = ${spaceId} and t.deleted_at is null
	and t.type = 'expense' and t.is_demo = 0 and t.patungan_split_id is null`;

/**
 * Transactions the "Dari transaksi" picker offers, newest first (at most BILL_PICKER_LIMIT); with `exact`, only
 * those of exactly that amount and currency (linking an existing split never recomputes its total).
 */
export async function billCandidates(
	db: Db,
	spaceId: string,
	exact?: { amountMinor: number; currency: string }
): Promise<BillCandidate[]> {
	const amount = exact
		? sql` and t.amount_minor = ${exact.amountMinor} and t.currency = ${exact.currency}`
		: sql``;
	return db.all<BillCandidate>(sql`select t.id, t.title, t.amount_minor as amountMinor, t.currency,
			t.occurred_on as occurredOn, coalesce(w.name, '') as walletName
		from transactions t
		left join wallets w on w.id = t.wallet_id and w.space_id = t.space_id
		where ${linkable(spaceId)}${amount}
		order by t.occurred_on desc, t.occurred_at desc, t.id desc
		limit ${BILL_PICKER_LIMIT}`);
}

/** One transaction the picker may offer (for `?dariTransaksi=`); null when it cannot be a bill. */
export async function billCandidate(
	db: Db,
	spaceId: string,
	transactionId: string
): Promise<BillCandidate | null> {
	const row = await db.get<BillCandidate>(sql`select t.id, t.title, t.amount_minor as amountMinor,
			t.currency, t.occurred_on as occurredOn, coalesce(w.name, '') as walletName
		from transactions t
		left join wallets w on w.id = t.wallet_id and w.space_id = t.space_id
		where t.id = ${transactionId} and ${linkable(spaceId)}`);
	return row ?? null;
}

/** `updated_at` of a write that expected `expected`: always later, even within the same millisecond. */
const nextUpdatedAt = (expected: number, now: number) => Math.max(now, expected + 1);

/** SQL: the split `splitId` was written by this very batch (its `seq` is the one this batch took, at `updatedAt`). */
const writtenNow = (spaceId: string, splitId: string, updatedAt: number) =>
	sql`exists (select 1 from patungan_splits s where s.id = ${splitId} and s.space_id = ${spaceId}
		and s.updated_at = ${updatedAt} and s.seq = ${currentSpaceSeq(spaceId)})`;

/**
 * SQL: `splitId` is a live, real split of the space that `userId` paid (the payer-only rule). A `Data demo`
 * split is never written by anyone (red team L1): it can never be linked to a real row or move a real total.
 */
const payerOf = (spaceId: string, splitId: string, userId: string) =>
	sql`exists (select 1 from patungan_splits s where s.id = ${splitId} and s.space_id = ${spaceId}
		and s.deleted_at is null and s.is_demo = 0 and s.created_by_user_id = ${userId})`;

/**
 * SQL: `userId` is the space's Pemilik and `splitId` is a live, real split whose payer is no longer a live
 * member of the space (removed, left, account deleted: `created_by_user_id` null). Owner decision for red team
 * L2: the Pemilik may then unlink or delete it, so its bill counts in full again; nothing else.
 */
const orphanOwnerOf = (spaceId: string, splitId: string, userId: string) =>
	sql`exists (select 1 from patungan_splits s where s.id = ${splitId} and s.space_id = ${spaceId}
		and s.deleted_at is null and s.is_demo = 0
		and not exists (select 1 from space_members pm where pm.space_id = s.space_id
			and pm.user_id = s.created_by_user_id and pm.deleted_at is null))
	and exists (select 1 from space_members o where o.space_id = ${spaceId} and o.user_id = ${userId}
		and o.role = 'owner' and o.deleted_at is null)`;

/** SQL: `userId` may unlink or delete `splitId`: its payer, or the Pemilik once the payer has gone. */
const managerOf = (spaceId: string, splitId: string, userId: string) =>
	sql`(${payerOf(spaceId, splitId, userId)} or ${orphanOwnerOf(spaceId, splitId, userId)})`;

/** Whether `userId` is the live Pemilik of the space (for telling why a write was refused). */
async function isSpaceOwner(db: Db, spaceId: string, userId: string): Promise<boolean> {
	const row = await db.get<{ one: number }>(sql`select 1 as one from space_members m
		where m.space_id = ${spaceId} and m.user_id = ${userId} and m.role = 'owner' and m.deleted_at is null`);
	return Boolean(row);
}

/** SQL: someone other than the payer has paid part of `splitId` (it is locked). */
const lockedSql = (splitId: string) =>
	sql`exists (select 1 from patungan_participants p where p.split_id = ${splitId}
		and p.deleted_at is null and p.is_payer = 0 and p.paid_amount_minor > 0)`;

/**
 * Batch item: the participants of `fields` for `splitId`, only while `guard` holds; a member row only while that
 * account is a live member of the space (its name is snapshotted from the account), so a member removed meanwhile
 * leaves the count short and the closing assert fails the whole batch.
 */
function insertParticipants(
	db: Db,
	scope: SpaceScope,
	splitId: string,
	fields: SplitFields,
	now: number,
	guard: SQL
) {
	const { spaceId } = scope;
	const json = JSON.stringify(
		fields.participants.map((p, i) => ({
			id: crypto.randomUUID(),
			position: i,
			kind: p.kind,
			member: p.kind === 'member' ? p.memberUserId : null,
			name: p.displayName,
			payer: i === 0 ? 1 : 0,
			share: p.shareAmountMinor
		}))
	);
	const f = (name: string) => sql`json_extract(j.value, ${'$.' + name})`;
	const memberName = sql`(select substr(u.name, 1, 80) from users u join space_members m on m.user_id = u.id
		where u.id = ${f('member')} and m.space_id = ${spaceId} and m.deleted_at is null)`;
	return db.insert(patunganParticipants).select(
		sql`select ${f('id')}, ${splitId}, ${spaceId}, ${f('position')}, ${f('kind')}, ${f('member')},
				case when ${f('kind')} = 'member' then ${memberName} else ${f('name')} end,
				${f('payer')}, ${f('share')}, null,
				case when ${f('payer')} = 1 then ${f('share')} else 0 end,
				case when ${f('payer')} = 1 then ${now} else null end,
				${now}, ${now}, null, ${currentSpaceSeq(spaceId)}
			from json_each(${json}) j
			where ${guard} and (${f('kind')} = 'guest' or ${memberName} is not null)`
	);
}

/** SQL: the live participants of `splitId` are exactly `fields`' count and add up to its total. */
const sharesHold = (splitId: string, fields: SplitFields) =>
	sql`(select count(*) = ${fields.participants.length}
			and sum(p.share_amount_minor) = ${fields.totalAmountMinor}
			and sum(p.is_payer) = 1
		from patungan_participants p where p.split_id = ${splitId} and p.deleted_at is null)`;

/**
 * SQL: a live transaction linked to `splitId` counts exactly `share` and is either the own-share row (amount =
 * share) or a bill of exactly `total` (or none is linked, when `required` is false).
 */
const linkHolds = (
	spaceId: string,
	splitId: string,
	share: number,
	total: number,
	required: boolean
) => {
	const ok = sql`exists (select 1 from transactions t where t.patungan_split_id = ${splitId}
		and t.space_id = ${spaceId} and t.deleted_at is null and t.patungan_effective_amount_minor = ${share}
		and (t.amount_minor = ${share} or t.amount_minor = ${total}))`;
	return required
		? ok
		: sql`(${ok} or not exists (select 1 from transactions t where t.patungan_split_id = ${splitId}
			and t.deleted_at is null))`;
};

/** The own-share row for `fields`: an expense of the payer's share, in the split's currency. */
function ownShareInput(
	fields: SplitFields,
	currency: string,
	bill: { walletId: string; categoryId: string }
): TransactionInput {
	return {
		type: 'expense',
		amountMinor: payerShare(fields),
		currency,
		walletId: bill.walletId,
		transferToWalletId: null,
		categoryId: bill.categoryId,
		title: fields.title,
		note: null,
		occurredOn: fields.occurredOn,
		occurredTime: null
	};
}

const payerShare = (fields: SplitFields) => fields.participants[0]?.shareAmountMinor ?? 0;

/** Batch item: links the transaction `transactionId` (written by this batch when `fresh`) to `splitId`. */
function setLink(db: Db, spaceId: string, splitId: string, share: number, now: number, where: SQL) {
	return db
		.update(transactions)
		.set({
			patunganSplitId: splitId,
			patunganEffectiveAmountMinor: share,
			updatedAt: sql`max(${now}, ${transactions.updatedAt} + 1)`,
			seq: currentSpaceSeq(spaceId)
		})
		.where(and(eq(transactions.spaceId, spaceId), isNull(transactions.deletedAt), where));
}

export type CreateSplitResult =
	{ ok: true } | { ok: false; reason: 'already' | 'bill' | 'limit' | 'split_limit' | 'gone' };

/**
 * Creates a split, its participants and its bookkeeping in one batch: `bill.kind = 'link'` links an existing
 * expense of exactly the total and currency (only while it is a live, real, unlinked expense of the space);
 * `own` writes one new expense of the payer's own share (FN-05's insert path, source `manual`) and links it.
 * `splitId` is the form's id, so a resend writes nothing twice (`already`).
 */
export async function createSplit(
	db: Db,
	scope: SpaceScope,
	splitId: string,
	fields: SplitFields,
	currency: string,
	bill: BillChoice,
	now: number
): Promise<CreateSplitResult> {
	const { spaceId, userId } = scope;
	const share = payerShare(fields);
	const created = writtenNow(spaceId, splitId, now);
	const insertSplit = db.insert(patunganSplits).select(
		sql`select ${splitId}, ${spaceId}, ${userId}, (select substr(u.name, 1, 80) from users u where u.id = ${userId}),
				${fields.title}, ${fields.totalAmountMinor}, ${currency}, ${fields.occurredOn}, ${fields.mode},
				${fields.note}, null, 0, ${now}, ${now}, null, ${currentSpaceSeq(spaceId)}
			where ${isLiveMember(spaceId, userId)}
				and not exists (select 1 from patungan_splits x where x.id = ${splitId})
				and (select count(*) from patungan_splits x where x.space_id = ${spaceId}
					and x.deleted_at is null) < ${MAX_SPLITS_PER_SPACE}`
	);
	const people = insertParticipants(db, scope, splitId, fields, now, created);
	const assert = batchAssert(
		db,
		sql`${created} and ${sharesHold(splitId, fields)} and ${linkHolds(spaceId, splitId, share, fields.totalAmountMinor, true)}`
	);
	try {
		if (bill.kind === 'link') {
			await db.batch([
				bumpSpaceSeq(db, spaceId),
				insertSplit,
				people,
				setLink(
					db,
					spaceId,
					splitId,
					share,
					now,
					sql`${transactions.id} = ${bill.transactionId} and ${transactions.type} = 'expense'
						and ${transactions.isDemo} = 0 and ${transactions.patunganSplitId} is null
						and ${transactions.amountMinor} = ${fields.totalAmountMinor}
						and ${transactions.currency} = ${currency} and ${created}`
				),
				assert
			]);
		} else {
			await db.batch([
				bumpSpaceSeq(db, spaceId),
				insertSplit,
				people,
				insertTransactions(
					db,
					scope,
					[
						{ id: bill.transactionId, input: ownShareInput(fields, currency, bill), origin: MANUAL }
					],
					now,
					() => created
				),
				setLink(
					db,
					spaceId,
					splitId,
					share,
					now,
					sql`${transactions.id} = ${bill.transactionId} and ${transactions.createdAt} = ${now} and ${created}`
				),
				assert
			]);
		}
		return { ok: true };
	} catch (e) {
		if (!isBatchAssertFailure(e) && !isUniqueViolation(e)) throw e;
	}
	// Nothing was written. Why: a resend, a cap, the bill row, or a wallet/category/member gone meanwhile.
	const existing = await db.get<{ spaceId: string }>(
		sql`select space_id as spaceId from patungan_splits where id = ${splitId}`
	);
	if (existing) return existing.spaceId === spaceId ? { ok: false, reason: 'already' } : gone();
	const [splits] = await db.all<{ n: number }>(
		sql`select count(*) as n from patungan_splits where space_id = ${spaceId} and deleted_at is null`
	);
	if ((splits?.n ?? 0) >= MAX_SPLITS_PER_SPACE) return { ok: false, reason: 'split_limit' };
	if (bill.kind === 'link') return { ok: false, reason: 'bill' };
	const [live] = await db.all<{ n: number }>(
		sql`select count(*) as n from transactions where space_id = ${spaceId} and deleted_at is null`
	);
	if ((live?.n ?? 0) >= MAX_TRANSACTIONS_PER_SPACE) return { ok: false, reason: 'limit' };
	return gone();
}

const gone = () => ({ ok: false as const, reason: 'gone' as const });

/** Why a payer-only write on a split wrote nothing. */
export type SplitWriteRefusal = 'missing' | 'forbidden' | 'stale' | 'locked' | 'bill' | 'gone';

/** Re-reads the split to tell the caller why a guarded write changed nothing. */
async function whyNot(
	db: Db,
	scope: SpaceScope,
	splitId: string,
	expectedUpdatedAt: number | null,
	/** The write also admits the Pemilik of a split whose payer has gone (unlink, delete). */
	orphanOwner = false
): Promise<SplitWriteRefusal> {
	const split = await getSplit(db, scope.spaceId, splitId);
	// A Data demo split answers like a missing one to every write (red team L1).
	if (!split || split.isDemo) return 'missing';
	if (
		split.createdByUserId !== scope.userId &&
		!(orphanOwner && !split.payerIsMember && (await isSpaceOwner(db, scope.spaceId, scope.userId)))
	)
		return 'forbidden';
	if (expectedUpdatedAt !== null && split.updatedAt !== expectedUpdatedAt) return 'stale';
	return 'gone';
}

/**
 * Saves the full edit form (mode, people, shares, total, title, date, note) while the split is unlocked and its
 * `updated_at` is still `expectedUpdatedAt`: the old participant rows become tombstones and the new ones are
 * written, and a linked transaction follows the payer's new share in the same batch (a bill keeps its amount and
 * must still equal the total; an own-share row takes the new share as its amount). Payer-only.
 */
export async function updateSplit(
	db: Db,
	scope: SpaceScope,
	splitId: string,
	fields: SplitFields,
	expectedUpdatedAt: number,
	now: number
): Promise<'ok' | SplitWriteRefusal> {
	const { spaceId, userId } = scope;
	const updatedAt = nextUpdatedAt(expectedUpdatedAt, now);
	const touched = writtenNow(spaceId, splitId, updatedAt);
	const share = payerShare(fields);
	try {
		const [, updated] = await db.batch([
			bumpSpaceSeq(db, spaceId),
			db
				.update(patunganSplits)
				.set({
					title: fields.title,
					occurredOn: fields.occurredOn,
					note: fields.note,
					mode: fields.mode,
					totalAmountMinor: fields.totalAmountMinor,
					updatedAt,
					seq: currentSpaceSeq(spaceId)
				})
				.where(
					and(
						eq(patunganSplits.id, splitId),
						eq(patunganSplits.spaceId, spaceId),
						isNull(patunganSplits.deletedAt),
						eq(patunganSplits.updatedAt, expectedUpdatedAt),
						eq(patunganSplits.createdByUserId, userId),
						eq(patunganSplits.isDemo, false),
						isLiveMember(spaceId, userId),
						sql`not ${lockedSql(splitId)}`
					)
				)
				.returning({ id: patunganSplits.id }),
			db
				.update(patunganParticipants)
				.set({ ...PARTICIPANT_TOMBSTONE, deletedAt: now, updatedAt, seq: currentSpaceSeq(spaceId) })
				.where(
					and(
						eq(patunganParticipants.splitId, splitId),
						eq(patunganParticipants.spaceId, spaceId),
						isNull(patunganParticipants.deletedAt),
						touched
					)
				),
			insertParticipants(db, scope, splitId, fields, now, touched),
			db
				.update(transactions)
				.set({
					// An own-share row (effective = amount) is the share; a bill keeps its stored amount.
					amountMinor: sql`case when ${transactions.patunganEffectiveAmountMinor} = ${transactions.amountMinor}
						then ${share} else ${transactions.amountMinor} end`,
					patunganEffectiveAmountMinor: share,
					updatedAt: sql`max(${now}, ${transactions.updatedAt} + 1)`,
					seq: currentSpaceSeq(spaceId)
				})
				.where(
					and(
						eq(transactions.patunganSplitId, splitId),
						eq(transactions.spaceId, spaceId),
						isNull(transactions.deletedAt),
						sql`(${transactions.patunganEffectiveAmountMinor} = ${transactions.amountMinor}
							or ${transactions.amountMinor} = ${fields.totalAmountMinor})`,
						touched
					)
				),
			batchAssert(
				db,
				sql`not ${touched} or (${sharesHold(splitId, fields)} and ${linkHolds(spaceId, splitId, share, fields.totalAmountMinor, false)})`
			)
		]);
		if (updated.length === 1) return 'ok';
	} catch (e) {
		if (!isBatchAssertFailure(e) && !isUniqueViolation(e)) throw e;
		const split = await getSplit(db, spaceId, splitId);
		// The split's own guard held, so the bill (its total) or a member changed meanwhile.
		return split?.linked &&
			!split.linked.ownShare &&
			split.linked.amountMinor !== fields.totalAmountMinor
			? 'bill'
			: 'gone';
	}
	const why = await whyNot(db, scope, splitId, expectedUpdatedAt);
	if (why !== 'gone') return why;
	const split = await getSplit(db, spaceId, splitId);
	return split?.locked ? 'locked' : 'gone';
}

/** The title, date and note: editable by the payer even once the split is locked. */
export async function updateSplitDetails(
	db: Db,
	scope: SpaceScope,
	splitId: string,
	details: Pick<SplitFields, 'title' | 'occurredOn' | 'note'>,
	expectedUpdatedAt: number,
	now: number
): Promise<'ok' | SplitWriteRefusal> {
	const { spaceId, userId } = scope;
	const [, updated] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(patunganSplits)
			.set({
				title: details.title,
				occurredOn: details.occurredOn,
				note: details.note,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(patunganSplits.id, splitId),
					eq(patunganSplits.spaceId, spaceId),
					isNull(patunganSplits.deletedAt),
					eq(patunganSplits.updatedAt, expectedUpdatedAt),
					eq(patunganSplits.createdByUserId, userId),
					eq(patunganSplits.isDemo, false),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: patunganSplits.id })
	]);
	return updated.length === 1 ? 'ok' : whyNot(db, scope, splitId, expectedUpdatedAt);
}

/** What a participant tombstone clears (content-free, like every other tombstone). */
const PARTICIPANT_TOMBSTONE = {
	displayName: null,
	memberUserId: null,
	shareAmountMinor: null,
	breakdownNote: null,
	paidAmountMinor: null,
	paidAt: null
} as const;

/**
 * "Tandai lunas" (`paid`) or "Batalkan lunas" (`unpaid`) for one non-payer participant. Payer-only. Idempotent:
 * settling a settled row (or un-settling an open one) changes nothing and is `ok`. Never touches a transaction
 * or any total.
 */
export async function setParticipantPaid(
	db: Db,
	scope: SpaceScope,
	splitId: string,
	participantId: string,
	paid: boolean,
	now: number
): Promise<'ok' | 'missing' | 'forbidden'> {
	const { spaceId, userId } = scope;
	const [, changed] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(patunganParticipants)
			.set({
				paidAmountMinor: paid ? sql`${patunganParticipants.shareAmountMinor}` : 0,
				paidAt: paid ? now : null,
				updatedAt: sql`max(${now}, ${patunganParticipants.updatedAt} + 1)`,
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(patunganParticipants.id, participantId),
					eq(patunganParticipants.splitId, splitId),
					eq(patunganParticipants.spaceId, spaceId),
					isNull(patunganParticipants.deletedAt),
					eq(patunganParticipants.isPayer, false),
					paid
						? sql`${patunganParticipants.paidAt} is null`
						: sql`${patunganParticipants.paidAmountMinor} > 0`,
					payerOf(spaceId, splitId, userId),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: patunganParticipants.id })
	]);
	if (changed.length === 1) return 'ok';
	const split = await getSplit(db, spaceId, splitId);
	if (!split || split.isDemo) return 'missing';
	if (split.createdByUserId !== userId) return 'forbidden';
	const person = split.participants.find((p) => p.id === participantId && !p.isPayer);
	return person ? 'ok' : 'missing';
}

/**
 * "Lepas tautan": the linked transaction becomes an ordinary row again (counted in full from the next read); its
 * amount, date and everything else stay. The payer, or the Pemilik once the payer has left the space; `ok` when
 * nothing was linked (already unlinked).
 */
export async function unlinkSplit(
	db: Db,
	scope: SpaceScope,
	splitId: string,
	now: number
): Promise<'ok' | 'missing' | 'forbidden'> {
	const { spaceId, userId } = scope;
	await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(transactions)
			.set({
				patunganSplitId: null,
				patunganEffectiveAmountMinor: null,
				updatedAt: sql`max(${now}, ${transactions.updatedAt} + 1)`,
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(transactions.patunganSplitId, splitId),
					eq(transactions.spaceId, spaceId),
					isNull(transactions.deletedAt),
					managerOf(spaceId, splitId, userId),
					isLiveMember(spaceId, userId)
				)
			)
	]);
	const why = await whyNot(db, scope, splitId, null, true);
	return why === 'missing' || why === 'forbidden' ? why : 'ok';
}

/**
 * "Tautkan transaksi lain": links an existing expense to a split that has none. The transaction must be a live,
 * real, unlinked expense of the space of exactly the split's total and currency; it then counts the payer's share.
 */
export async function linkSplit(
	db: Db,
	scope: SpaceScope,
	splitId: string,
	transactionId: string,
	now: number
): Promise<'ok' | 'missing' | 'forbidden' | 'already' | 'bill'> {
	const { spaceId, userId } = scope;
	const share = sql`(select p.share_amount_minor from patungan_participants p where p.split_id = ${splitId}
		and p.deleted_at is null and p.is_payer = 1)`;
	const [, linked] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(transactions)
			.set({
				patunganSplitId: splitId,
				patunganEffectiveAmountMinor: share,
				updatedAt: sql`max(${now}, ${transactions.updatedAt} + 1)`,
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(transactions.id, transactionId),
					eq(transactions.spaceId, spaceId),
					isNull(transactions.deletedAt),
					eq(transactions.type, 'expense'),
					eq(transactions.isDemo, false),
					isNull(transactions.patunganSplitId),
					payerOf(spaceId, splitId, userId),
					isLiveMember(spaceId, userId),
					sql`not exists (select 1 from transactions x where x.patungan_split_id = ${splitId}
						and x.deleted_at is null)`,
					sql`exists (select 1 from patungan_splits s where s.id = ${splitId}
						and s.total_amount_minor = ${transactions.amountMinor}
						and s.currency = ${transactions.currency})`,
					sql`${share} < ${transactions.amountMinor}`
				)
			)
			.returning({ id: transactions.id })
	]);
	if (linked.length === 1) return 'ok';
	const split = await getSplit(db, spaceId, splitId);
	if (!split || split.isDemo) return 'missing';
	if (split.createdByUserId !== userId) return 'forbidden';
	return split.linked ? 'already' : 'bill';
}

/**
 * "Buat transaksi untuk bagianmu": writes one expense of the payer's current share (FN-05's insert path) from
 * `walletId` in `categoryId` and links it, for a split that has no linked transaction. The share is re-checked
 * inside the insert, so an edit in between writes nothing.
 */
export async function createOwnShare(
	db: Db,
	scope: SpaceScope,
	split: SplitDetail,
	bill: { transactionId: string; walletId: string; categoryId: string },
	now: number
): Promise<'ok' | 'missing' | 'forbidden' | 'already' | 'limit' | 'gone'> {
	const { spaceId, userId } = scope;
	const payer = split.participants.find((p) => p.isPayer);
	if (!payer) return 'missing';
	const guard = sql`${payerOf(spaceId, split.id, userId)}
		and exists (select 1 from patungan_participants p where p.split_id = ${split.id}
			and p.deleted_at is null and p.is_payer = 1 and p.share_amount_minor = ${payer.shareAmountMinor})
		and not exists (select 1 from transactions x where x.patungan_split_id = ${split.id}
			and x.deleted_at is null)`;
	const input: TransactionInput = {
		type: 'expense',
		amountMinor: payer.shareAmountMinor,
		currency: split.currency,
		walletId: bill.walletId,
		transferToWalletId: null,
		categoryId: bill.categoryId,
		title: split.title,
		note: null,
		occurredOn: split.occurredOn,
		occurredTime: null
	};
	try {
		await db.batch([
			bumpSpaceSeq(db, spaceId),
			insertTransactions(
				db,
				scope,
				[{ id: bill.transactionId, input, origin: MANUAL }],
				now,
				() => guard
			),
			setLink(
				db,
				spaceId,
				split.id,
				payer.shareAmountMinor,
				now,
				sql`${transactions.id} = ${bill.transactionId} and ${transactions.createdAt} = ${now}
					and ${transactions.seq} = ${currentSpaceSeq(spaceId)}`
			),
			batchAssert(
				db,
				linkHolds(spaceId, split.id, payer.shareAmountMinor, split.totalAmountMinor, true)
			)
		]);
		return 'ok';
	} catch (e) {
		if (!isBatchAssertFailure(e) && !isUniqueViolation(e)) throw e;
	}
	const current = await getSplit(db, spaceId, split.id);
	if (!current || current.isDemo) return 'missing';
	if (current.createdByUserId !== userId) return 'forbidden';
	if (current.linked) return 'already';
	const [live] = await db.all<{ n: number }>(
		sql`select count(*) as n from transactions where space_id = ${spaceId} and deleted_at is null`
	);
	return (live?.n ?? 0) >= MAX_TRANSACTIONS_PER_SPACE ? 'limit' : 'gone';
}

/**
 * "Hapus": in one batch the split and every participant become content-free tombstones and a linked transaction
 * is unlinked (counted in full again from the next read; never deleted). Payer-only, stale-checked.
 */
export async function deleteSplit(
	db: Db,
	scope: SpaceScope,
	splitId: string,
	expectedUpdatedAt: number,
	now: number
): Promise<'ok' | SplitWriteRefusal> {
	const { spaceId, userId } = scope;
	const updatedAt = nextUpdatedAt(expectedUpdatedAt, now);
	const touched = writtenNow(spaceId, splitId, updatedAt);
	const [, deleted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(patunganSplits)
			.set({
				payerName: null,
				title: null,
				totalAmountMinor: null,
				currency: null,
				occurredOn: null,
				note: null,
				paymentDetails: null,
				deletedAt: now,
				updatedAt,
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(patunganSplits.id, splitId),
					eq(patunganSplits.spaceId, spaceId),
					isNull(patunganSplits.deletedAt),
					eq(patunganSplits.updatedAt, expectedUpdatedAt),
					managerOf(spaceId, splitId, userId),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: patunganSplits.id }),
		db
			.update(patunganParticipants)
			.set({ ...PARTICIPANT_TOMBSTONE, deletedAt: now, updatedAt, seq: currentSpaceSeq(spaceId) })
			.where(
				and(
					eq(patunganParticipants.splitId, splitId),
					eq(patunganParticipants.spaceId, spaceId),
					isNull(patunganParticipants.deletedAt),
					touched
				)
			),
		db
			.update(transactions)
			.set({
				patunganSplitId: null,
				patunganEffectiveAmountMinor: null,
				updatedAt: sql`max(${now}, ${transactions.updatedAt} + 1)`,
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(transactions.patunganSplitId, splitId),
					eq(transactions.spaceId, spaceId),
					isNull(transactions.deletedAt),
					touched
				)
			)
	]);
	return deleted.length === 1 ? 'ok' : whyNot(db, scope, splitId, expectedUpdatedAt, true);
}
