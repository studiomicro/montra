import { and, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { wibInstantUtcMs } from '#lib/shared/dates';
import type {
	AdjustmentDirection,
	CategorySource,
	TransactionSource,
	TransactionType
} from '#lib/shared/transactions';
import type { Db } from '../db';
import { transactions } from '../db/schema';
import { cleanUpFiles, keepKey, releasePhotoKeys, type StoredPhoto } from '../photos/store';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { newId } from '../util';
import type { TransactionInput } from './validation';

/** One live transaction as the edit page needs it. */
export interface TransactionDetail {
	id: string;
	type: TransactionType;
	amountMinor: number;
	currency: string;
	walletId: string;
	transferToWalletId: string | null;
	categoryId: string | null;
	/** Set exactly on a balance adjustment (FN-37). */
	adjustmentDirection: AdjustmentDirection | null;
	title: string | null;
	note: string | null;
	occurredOn: string;
	occurredAt: number;
	source: TransactionSource;
	/** Fictional local-review row ("Data demo"): never copied into a real row. */
	isDemo: boolean;
	/** The recurring series that created the row (FN-36); null otherwise. */
	recurringSeriesId: string | null;
	/** A receipt photo is kept with the row (FN-15), served by /riwayat/<id>/foto. */
	hasPhoto: boolean;
	/** FN-49: the split this row is linked to and the payer's share it counts; null when not linked. */
	patungan: { splitId: string; effectiveAmountMinor: number } | null;
	updatedAt: number;
}

/** `missing`: no such live transaction in this space (same answer for another space's id). `stale`: changed meanwhile. */
export type TransactionWriteResult = 'ok' | 'stale' | 'missing';

const detailColumns = {
	id: transactions.id,
	type: transactions.type,
	amountMinor: transactions.amountMinor,
	currency: transactions.currency,
	walletId: transactions.walletId,
	transferToWalletId: transactions.transferToWalletId,
	categoryId: transactions.categoryId,
	adjustmentDirection: transactions.adjustmentDirection,
	title: transactions.title,
	note: transactions.note,
	occurredOn: transactions.occurredOn,
	occurredAt: transactions.occurredAt,
	source: transactions.source,
	isDemo: transactions.isDemo,
	recurringSeriesId: transactions.recurringSeriesId,
	photoKey: transactions.photoKey,
	patunganSplitId: transactions.patunganSplitId,
	patunganEffectiveAmountMinor: transactions.patunganEffectiveAmountMinor,
	updatedAt: transactions.updatedAt
};

/** One live transaction of this space; null for an unknown, deleted or other-space id. */
export async function getTransaction(
	db: Db,
	spaceId: string,
	transactionId: string
): Promise<TransactionDetail | null> {
	const row = await db
		.select(detailColumns)
		.from(transactions)
		.where(
			and(
				eq(transactions.id, transactionId),
				eq(transactions.spaceId, spaceId),
				isNull(transactions.deletedAt)
			)
		)
		.get();
	if (!row) return null;
	// A live row always has its content (`transactions_content_check`); only tombstones carry nulls.
	const {
		amountMinor,
		currency,
		walletId,
		occurredOn,
		occurredAt,
		photoKey,
		patunganSplitId,
		patunganEffectiveAmountMinor,
		...rest
	} = row;
	if (amountMinor === null || !currency || !walletId || !occurredOn || occurredAt === null)
		return null;
	return {
		...rest,
		amountMinor,
		currency,
		walletId,
		occurredOn,
		occurredAt,
		hasPhoto: photoKey !== null,
		patungan:
			patunganSplitId !== null && patunganEffectiveAmountMinor !== null
				? { splitId: patunganSplitId, effectiveAmountMinor: patunganEffectiveAmountMinor }
				: null
	};
}

/**
 * The kept receipt photo of a live transaction (FN-15), only while `scope.userId` is still a live member of its
 * space (checked in the same statement as the read). Null otherwise: one answer for every reason.
 */
export async function getTransactionPhoto(
	db: Db,
	scope: SpaceScope,
	transactionId: string
): Promise<StoredPhoto | null> {
	const row = await db
		.select({ key: transactions.photoKey, type: transactions.photoType })
		.from(transactions)
		.where(
			and(
				eq(transactions.id, transactionId),
				eq(transactions.spaceId, scope.spaceId),
				isNull(transactions.deletedAt),
				isNotNull(transactions.photoKey),
				isLiveMember(scope.spaceId, scope.userId)
			)
		)
		.get();
	return row?.key && row.type ? { key: row.key, type: row.type } : null;
}

/** The space a transaction id belongs to ('' when unknown): only ever passed on to requireSpaceAccess. */
export async function transactionSpaceId(db: Db, transactionId: string): Promise<string> {
	const row = await db
		.select({ spaceId: transactions.spaceId })
		.from(transactions)
		.where(eq(transactions.id, transactionId.slice(0, 64)))
		.get();
	return row?.spaceId ?? '';
}

/** True when the space has at least one live transaction (tells "nothing yet" from "nothing matches"). */
export async function hasTransactions(db: Db, spaceId: string): Promise<boolean> {
	const row = await db
		.select({ id: transactions.id })
		.from(transactions)
		.where(and(eq(transactions.spaceId, spaceId), isNull(transactions.deletedAt)))
		.limit(1)
		.get();
	return Boolean(row);
}

/** True when a live transaction of the space is paid from, into or transferred to `walletId`. */
export async function walletHasTransactions(
	db: Db,
	spaceId: string,
	walletId: string
): Promise<boolean> {
	const row = await db
		.select({ id: transactions.id })
		.from(transactions)
		.where(
			and(
				eq(transactions.spaceId, spaceId),
				isNull(transactions.deletedAt),
				or(eq(transactions.walletId, walletId), eq(transactions.transferToWalletId, walletId))
			)
		)
		.limit(1)
		.get();
	return Boolean(row);
}

/** Most live transactions one space holds (with MAX_AMOUNT_MINOR, every SQL sum stays a 64-bit integer). */
export const MAX_TRANSACTIONS_PER_SPACE = 100_000;

/** The values `refsHold` checks: bound parameters, or SQL expressions (a row of a multi-row insert). */
type RefValues = Record<
	'type' | 'currency' | 'walletId' | 'transferToWalletId' | 'categoryId',
	string | null | SQL
>;

/**
 * SQL condition: every id a transaction names still belongs to the space as the action checked it — the wallet
 * (and the destination) live, in the space, with the transaction's currency; the category visible, in the
 * space, of the type's kind (a balance adjustment, like a transfer, has none: FN-37). Repeated inside each write, so a concurrent archive, hide or move between the
 * check and the write writes nothing. On an edit (`current` set) the archived wallet or hidden category the row
 * already uses stays allowed for that row (FN-06 criterion 6).
 */
function refsHold(
	spaceId: string,
	v: RefValues,
	current = false,
	/** FN-17 spreadsheet rows only: a row marked so may name no category ("Tanpa kategori"). */
	noCategory: SQL = sql`0`
): SQL {
	const keptWallet = current
		? sql` or w.id = ${transactions.walletId} or w.id = ${transactions.transferToWalletId}`
		: sql``;
	const keptCategory = current ? sql` or c.id = ${transactions.categoryId}` : sql``;
	const wallet = (id: string | null | SQL) => sql`exists (select 1 from wallets w where w.id = ${id}
		and w.space_id = ${spaceId} and w.currency = ${v.currency}
		and (w.deleted_at is null${keptWallet}))`;
	return sql`${wallet(v.walletId)} and (case when ${v.type} = 'transfer'
		then ${wallet(v.transferToWalletId)}
		when ${v.type} = 'adjustment' then 1
		when ${noCategory} = 1 and ${v.categoryId} is null then 1
		else exists (select 1 from categories c where c.id = ${v.categoryId}
			and c.space_id = ${spaceId} and c.kind = ${v.type} and c.deleted_at is null
			and (c.is_hidden = 0${keptCategory})) end)`;
}

/**
 * Where a new transaction came from. A form row is `manual` without a dedupe key; a capture (FN-11 drafts, and
 * through them FN-14 onward) keeps its source and dedupe key, and the instant it read (`occurredAt`, stored
 * verbatim instead of the time-or-save-instant rule). `isDemo` carries a fictional draft's "Data demo" mark onto
 * the transaction it becomes (badged, excluded from every total); it is only ever read from a stored draft row,
 * never from a form, so a form row is always real.
 */
export interface TransactionOrigin {
	source: TransactionSource;
	dedupeKey: string | null;
	occurredAt?: number;
	isDemo?: boolean;
	/**
	 * FN-48: who chose the category. `auto` only where nobody saw it before it was saved (an import, a draft saved
	 * with the capture's own guess); unset means `user` (a person picked or reviewed it), the safe side for
	 * "Rapikan kategori", which never touches a `user` row.
	 */
	categorySource?: CategorySource;
}
export const MANUAL: TransactionOrigin = { source: 'manual', dedupeKey: null, isDemo: false };

/** The CSV template's extra columns (FN-18), stored as given (already cleaned); null when empty. */
export interface TransactionExtras {
	paymentMethod: string | null;
	recurrence: string | null;
	tag: string | null;
	reference: string | null;
}

/**
 * One row for `insertTransactions`. `guard` holds values the caller's guard condition reads back per row.
 * `importBatchId` and `extras` are set only by an import (FN-18), `recurringSeriesId` only by the recurring
 * cron (FN-36).
 */
export interface NewTransaction {
	id: string;
	input: TransactionInput;
	origin: TransactionOrigin;
	guard?: Record<string, string | number>;
	importBatchId?: string;
	extras?: TransactionExtras;
	recurringSeriesId?: string;
	/** FN-17: the row may be written without a category (`capturedTransactionInput` with `allowNoCategory`). */
	allowNoCategory?: boolean;
}

/**
 * The one write path into `transactions`: a batch item inserting `rows` (bound once as JSON, no 100-parameter
 * limit) into the space, each row only while the membership and its wallet/category hold (`refsHold`) and the
 * caller's `guard` holds for it, and only while the space stays within MAX_TRANSACTIONS_PER_SPACE with every
 * row added. `guard(key)` reads the row's `guard[key]`. Place after `bumpSpaceSeq` in the same `db.batch`.
 * `occurred_at` is `origin.occurredAt`, else the given WIB time on `occurredOn`, else `now` (owner decision F).
 */
export function insertTransactions(
	db: Db,
	scope: SpaceScope,
	rows: readonly NewTransaction[],
	now: number,
	guard?: (key: (name: string) => SQL) => SQL
) {
	const { spaceId, userId } = scope;
	const json = JSON.stringify(
		rows.map(
			({
				id,
				input,
				origin,
				guard: g,
				importBatchId,
				extras,
				recurringSeriesId,
				allowNoCategory
			}) => ({
				id,
				type: input.type,
				amountMinor: input.amountMinor,
				currency: input.currency,
				categoryId: input.categoryId,
				walletId: input.walletId,
				transferToWalletId: input.transferToWalletId,
				title: input.title,
				note: input.note,
				occurredOn: input.occurredOn,
				occurredAt:
					origin.occurredAt ??
					(input.occurredTime ? wibInstantUtcMs(input.occurredOn, input.occurredTime) : now),
				source: origin.source,
				dedupeKey: origin.dedupeKey,
				isDemo: origin.isDemo ? 1 : 0,
				importBatchId: importBatchId ?? null,
				paymentMethod: extras?.paymentMethod ?? null,
				recurrence: extras?.recurrence ?? null,
				tag: extras?.tag ?? null,
				reference: extras?.reference ?? null,
				adjustmentDirection: input.adjustmentDirection ?? null,
				recurringSeriesId: recurringSeriesId ?? null,
				noCategory: allowNoCategory ? 1 : 0,
				categorySource: origin.categorySource ?? 'user',
				guard: g ?? {}
			})
		)
	);
	const f = (name: string) => sql`json_extract(j.value, ${'$.' + name})`;
	const underCap = sql`(select count(*) from transactions t where t.space_id = ${spaceId}
		and t.deleted_at is null) + ${rows.length} <= ${MAX_TRANSACTIONS_PER_SPACE}`;
	const refs = refsHold(
		spaceId,
		{
			type: f('type'),
			currency: f('currency'),
			walletId: f('walletId'),
			transferToWalletId: f('transferToWalletId'),
			categoryId: f('categoryId')
		},
		false,
		f('noCategory')
	);
	return db
		.insert(transactions)
		.select(
			sql`select ${f('id')}, ${spaceId}, ${f('type')}, ${f('amountMinor')}, ${f('currency')},
				${f('categoryId')}, ${f('walletId')}, ${f('transferToWalletId')}, ${f('title')}, ${f('note')},
				${f('occurredOn')}, ${f('occurredAt')}, ${f('source')}, ${f('dedupeKey')}, ${f('isDemo')}, ${now}, ${now},
				null, ${currentSpaceSeq(spaceId)}, ${f('importBatchId')}, ${f('paymentMethod')},
				${f('recurrence')}, ${f('tag')}, ${f('reference')}, ${f('adjustmentDirection')},
				${f('recurringSeriesId')}, null, null, ${f('categorySource')}, null, null
			from json_each(${json}) j
			where ${isLiveMember(spaceId, userId)} and ${refs} and ${underCap}
				and ${guard ? guard((name) => f('guard.' + name)) : sql`1`}`
		)
		.returning({ id: transactions.id });
}

/**
 * The batch items that give the row `id` this batch just inserted its uploaded, reserved photo (FN-15): only when
 * that row was written by this very batch — this batch's space seq and created at `now`, so an id that already
 * existed (a resent or forged `clientId`, red team L1) gets nothing — still live and without a photo. The
 * reservation is dropped only when the row now holds the key (photos/store.ts); otherwise the caller releases it.
 */
export function attachPhoto(db: Db, spaceId: string, id: string, photo: StoredPhoto, now: number) {
	return [
		db
			.update(transactions)
			.set({ photoKey: photo.key, photoType: photo.type })
			.where(
				and(
					eq(transactions.id, id),
					eq(transactions.spaceId, spaceId),
					sql`${transactions.seq} = ${currentSpaceSeq(spaceId)}`,
					eq(transactions.createdAt, now),
					isNull(transactions.deletedAt),
					isNull(transactions.photoKey)
				)
			),
		keepKey(
			db,
			photo.key,
			sql`exists (select 1 from transactions t where t.id = ${id} and t.photo_key = ${photo.key})`
		)
	] as const;
}

/** Whether the live row `id` of the space holds the photo `key` (after a write that may have attached it). */
export async function holdsPhoto(
	db: Db,
	spaceId: string,
	id: string,
	key: string
): Promise<boolean> {
	const row = await db
		.select({ id: transactions.id })
		.from(transactions)
		.where(
			and(
				eq(transactions.id, id),
				eq(transactions.spaceId, spaceId),
				eq(transactions.photoKey, key),
				isNull(transactions.deletedAt)
			)
		)
		.get();
	return Boolean(row);
}

/**
 * Writes one transaction: a form row (`manual`, no dedupe key) unless `origin` names a capture. `occurred_on`
 * stays the WIB date given either way. Refused with `limit` at MAX_TRANSACTIONS_PER_SPACE live rows (one
 * guarded insert), and with `gone` when the membership, wallet or category went meanwhile, or the caller's
 * `guard` condition (checked inside the same insert) no longer holds. `photo`: an uploaded receipt photo the row
 * keeps (FN-15 "Lampirkan fotonya saja"), attached in the same batch.
 */
export async function createTransaction(
	db: Db,
	scope: SpaceScope,
	input: TransactionInput,
	now: number,
	origin: TransactionOrigin = MANUAL,
	guard?: SQL,
	/** FN-02: the offline queue's client id (see `createTransactionOnce`); a fresh id otherwise. */
	id: string = newId(),
	photo: StoredPhoto | null = null
): Promise<{ ok: true; id: string } | { ok: false; reason: 'limit' | 'gone' }> {
	const { spaceId } = scope;
	const insert = insertTransactions(
		db,
		scope,
		[{ id, input, origin }],
		now,
		guard ? () => guard : undefined
	);
	const [, inserted] = photo
		? await db.batch([
				bumpSpaceSeq(db, spaceId),
				insert,
				...attachPhoto(db, spaceId, id, photo, now)
			])
		: await db.batch([bumpSpaceSeq(db, spaceId), insert]);
	if (inserted.length === 1) return { ok: true, id };
	const [count] = await db.all<{ n: number }>(
		sql`select count(*) as n from transactions where space_id = ${spaceId} and deleted_at is null`
	);
	return { ok: false, reason: (count?.n ?? 0) >= MAX_TRANSACTIONS_PER_SPACE ? 'limit' : 'gone' };
}

/**
 * What a tombstone clears: every content column (an FN-49 Patungan link included, so deleting a split's bill
 * unlinks it with no Patungan-aware code), so only id, space, type, source, dedupe key, import batch,
 * timestamps and seq remain (the dedupe key stays so a deleted capture is never recreated from the same
 * source). Shared by a single delete and an import's undo (FN-18).
 */
export const TOMBSTONE_CONTENT = {
	amountMinor: null,
	currency: null,
	walletId: null,
	transferToWalletId: null,
	categoryId: null,
	occurredOn: null,
	occurredAt: null,
	title: null,
	note: null,
	paymentMethod: null,
	recurrence: null,
	tag: null,
	reference: null,
	adjustmentDirection: null,
	photoKey: null,
	photoType: null,
	// FN-49: a deleted row is no split's bill any more (it already counts in no total).
	patunganSplitId: null,
	patunganEffectiveAmountMinor: null
} as const;

/** `updated_at` of a write that expected `expected`: always later, even within the same millisecond. */
const nextUpdatedAt = (expected: number, now: number) => Math.max(now, expected + 1);

/** `id` is a deleted row (a tombstone) of this space: a resent delete has nothing left to do (FN-02). */
export async function isTombstoneInSpace(db: Db, spaceId: string, id: string): Promise<boolean> {
	const [row] = await db
		.select({ id: transactions.id })
		.from(transactions)
		.where(
			and(
				eq(transactions.id, id),
				eq(transactions.spaceId, spaceId),
				isNotNull(transactions.deletedAt)
			)
		)
		.limit(1);
	return row !== undefined;
}

async function whyNot(db: Db, spaceId: string, id: string): Promise<TransactionWriteResult> {
	return (await getTransaction(db, spaceId, id)) ? 'stale' : 'missing';
}

/**
 * FN-49 (owner decision 7): SQL condition that an edit keeps a linked bill's amount, currency and type. While a
 * row is a split's bill (`patungan_split_id` set) only those three are locked — title, note, date, category,
 * wallet and the rest stay editable; to change the amount the payer unlinks first. Inside the update itself, so
 * a link made between the form's check and the write still holds.
 */
function linkedBillKept(input: TransactionInput): SQL {
	return sql`(${transactions.patunganSplitId} is null or (${transactions.amountMinor} = ${input.amountMinor}
		and ${transactions.currency} = ${input.currency} and ${input.type} = 'expense'))`;
}

/** `linked`: the row is a split's bill and the edit would change its amount, currency or type (nothing written). */
export type TransactionUpdateResult = TransactionWriteResult | 'linked';

/**
 * Saves the edit form, only while the row's `updated_at` is still `expectedUpdatedAt` (a second tab's stale
 * form gets `stale`, never an overwrite). Without a time the stored `occurred_at` is kept. `source` and
 * `dedupe_key` are write-once and never touched here. A split's bill (FN-49) keeps its amount, currency and type
 * (`linked` otherwise).
 */
export async function updateTransaction(
	db: Db,
	scope: SpaceScope,
	transactionId: string,
	input: TransactionInput,
	expectedUpdatedAt: number,
	now: number
): Promise<TransactionUpdateResult> {
	const { spaceId, userId } = scope;
	const [, updated] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(transactions)
			.set({
				type: input.type,
				amountMinor: input.amountMinor,
				currency: input.currency,
				walletId: input.walletId,
				transferToWalletId: input.transferToWalletId,
				categoryId: input.categoryId,
				// FN-48: a person saved this form, so the category is theirs ("Rapikan kategori" leaves it alone).
				categorySource: 'user',
				adjustmentDirection: input.adjustmentDirection ?? null,
				title: input.title,
				note: input.note,
				occurredOn: input.occurredOn,
				...(input.occurredTime
					? { occurredAt: wibInstantUtcMs(input.occurredOn, input.occurredTime) }
					: {}),
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(transactions.id, transactionId),
					eq(transactions.spaceId, spaceId),
					isNull(transactions.deletedAt),
					eq(transactions.updatedAt, expectedUpdatedAt),
					isLiveMember(spaceId, userId),
					refsHold(spaceId, input, true),
					linkedBillKept(input)
				)
			)
			.returning({ id: transactions.id })
	]);
	if (updated.length === 1) return 'ok';
	const current = await getTransaction(db, spaceId, transactionId);
	if (!current) return 'missing';
	const changesBill =
		current.amountMinor !== input.amountMinor ||
		current.currency !== input.currency ||
		input.type !== 'expense';
	return current.updatedAt === expectedUpdatedAt && current.patungan && changesBill
		? 'linked'
		: 'stale';
}

/**
 * Deletes (tombstones) a transaction while its `updated_at` is still `expectedUpdatedAt`: `deleted_at` set and
 * every content column cleared in the same statement, `seq` advanced. It leaves every list and total at once. A
 * kept receipt photo (FN-15) goes to the file-deletion outbox in the same batch, so nothing serves it from then
 * on; with `files` its object is deleted right after (photos/store.ts cleanUpFiles), else the cron sweep does.
 */
export async function deleteTransaction(
	db: Db,
	scope: SpaceScope,
	transactionId: string,
	expectedUpdatedAt: number,
	now: number,
	files?: Parameters<typeof cleanUpFiles>[0]
): Promise<TransactionWriteResult> {
	const { spaceId, userId } = scope;
	const guard = and(
		eq(transactions.id, transactionId),
		eq(transactions.spaceId, spaceId),
		isNull(transactions.deletedAt),
		eq(transactions.updatedAt, expectedUpdatedAt),
		isLiveMember(spaceId, userId)
	);
	const [, released, deleted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		releasePhotoKeys(db, transactions, guard, now),
		db
			.update(transactions)
			.set({
				deletedAt: now,
				...TOMBSTONE_CONTENT,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(guard)
			.returning({ id: transactions.id })
	]);
	if (files && released.length > 0)
		await cleanUpFiles(
			files,
			db,
			released.map((r) => r.key),
			now
		);
	return deleted.length === 1 ? 'ok' : whyNot(db, spaceId, transactionId);
}
