import { and, asc, desc, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { WalletCurrency, WalletType } from '#lib/shared/wallets';
import type { Db } from '../db';
import { spaces, wallets } from '../db/schema';
import { isLiveMember } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { newId } from '../util';
import type { WalletInput } from './validation';

/** Most wallets one space holds, archived ones included (they stay listable); also the list's row cap. */
export const MAX_WALLETS_PER_SPACE = 50;

/**
 * Who writes where. Every function here runs only after `requireSpaceAccess` admitted `userId` to `spaceId`;
 * each write repeats that membership check in its own statement, so a removal in between changes nothing.
 */
export interface WalletScope {
	spaceId: string;
	userId: string;
}

export interface WalletSummary {
	id: string;
	name: string;
	type: WalletType;
	currency: WalletCurrency;
	openingBalanceMinor: number;
	isFavourite: boolean;
	lastFour: string | null;
	createdAt: number;
	updatedAt: number;
	archived: boolean;
}

/** `missing`: no such wallet in this space (same answer for another space's id). `stale`: changed meanwhile. */
export type WalletWriteResult = 'ok' | 'stale' | 'missing';

const columns = {
	id: wallets.id,
	name: wallets.name,
	type: wallets.type,
	currency: wallets.currency,
	openingBalanceMinor: wallets.openingBalanceMinor,
	isFavourite: wallets.isFavourite,
	lastFour: wallets.lastFour,
	createdAt: wallets.createdAt,
	updatedAt: wallets.updatedAt,
	deletedAt: wallets.deletedAt
};

function summary(row: {
	id: string;
	name: string;
	type: WalletType;
	currency: string;
	openingBalanceMinor: number;
	isFavourite: boolean;
	lastFour: string | null;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
}): WalletSummary {
	const { deletedAt, currency, ...rest } = row;
	// Every stored code passed the allow-list (validation.ts).
	return { ...rest, currency: currency as WalletCurrency, archived: deletedAt !== null };
}

/**
 * The space's wallets: live ones (favourite first, then oldest first), then, with `includeArchived`, archived
 * ones in the same order. Bounded by MAX_WALLETS_PER_SPACE, which is also the per-space creation cap.
 */
export async function listWallets(
	db: Db,
	spaceId: string,
	opts: { includeArchived?: boolean } = {}
): Promise<WalletSummary[]> {
	const rows = await db
		.select(columns)
		.from(wallets)
		.where(
			opts.includeArchived
				? eq(wallets.spaceId, spaceId)
				: and(eq(wallets.spaceId, spaceId), isNull(wallets.deletedAt))
		)
		.orderBy(
			sql`${wallets.deletedAt} is not null`,
			desc(wallets.isFavourite),
			asc(wallets.createdAt),
			asc(wallets.id)
		)
		.limit(MAX_WALLETS_PER_SPACE);
	return rows.map(summary);
}

/** One wallet of this space (live only unless `includeArchived`); null for an unknown or other-space id. */
export async function getWallet(
	db: Db,
	spaceId: string,
	walletId: string,
	opts: { includeArchived?: boolean } = {}
): Promise<WalletSummary | null> {
	const row = await db
		.select(columns)
		.from(wallets)
		.where(
			and(
				eq(wallets.id, walletId),
				eq(wallets.spaceId, spaceId),
				opts.includeArchived ? undefined : isNull(wallets.deletedAt)
			)
		)
		.get();
	return row ? summary(row) : null;
}

/** `updated_at` of a write that expected `expected`: always later, even within the same millisecond. */
const nextUpdatedAt = (expected: number, now: number) => Math.max(now, expected + 1);
const bumpedUpdatedAt = (now: number) => sql`max(${now}, ${wallets.updatedAt} + 1)`;

/**
 * Batch item: `walletId` becomes the space's one favourite and the previous favourite is cleared, in one
 * statement (so concurrent swaps always leave exactly one). Runs only while `guard` holds and `walletId` is a
 * live wallet of the space. Place after `bumpSpaceSeq`.
 */
function favouriteSwap(db: Db, scope: WalletScope, walletId: string, now: number, guard?: SQL) {
	const { spaceId, userId } = scope;
	return db
		.update(wallets)
		.set({
			isFavourite: sql`case when ${wallets.id} = ${walletId} then 1 else 0 end`,
			updatedAt: bumpedUpdatedAt(now),
			seq: currentSpaceSeq(spaceId)
		})
		.where(
			and(
				eq(wallets.spaceId, spaceId),
				isNull(wallets.deletedAt),
				or(
					and(eq(wallets.id, walletId), eq(wallets.isFavourite, false)),
					and(sql`${wallets.id} <> ${walletId}`, eq(wallets.isFavourite, true))
				),
				sql`exists (select 1 from wallets w where w.id = ${walletId}
					and w.space_id = ${spaceId} and w.deleted_at is null)`,
				isLiveMember(spaceId, userId),
				guard
			)
		);
}

/**
 * Batch item: when the space has live wallets but no favourite (the favourite was archived, or an archived
 * wallet came back to an empty list), its oldest live wallet becomes the favourite.
 */
function favouriteRepair(db: Db, spaceId: string, now: number) {
	return db
		.update(wallets)
		.set({ isFavourite: true, updatedAt: bumpedUpdatedAt(now), seq: currentSpaceSeq(spaceId) })
		.where(
			and(
				sql`${wallets.id} = (select w.id from wallets w where w.space_id = ${spaceId}
					and w.deleted_at is null order by w.created_at, w.id limit 1)`,
				sql`not exists (select 1 from wallets w where w.space_id = ${spaceId}
					and w.deleted_at is null and w.is_favourite = 1)`
			)
		);
}

/** Why a create wrote nothing: the space's cap, or the membership went meanwhile (answered as not found). */
export type CreateWalletResult = { ok: true; id: string } | { ok: false; reason: 'limit' | 'gone' };

/**
 * Creates a wallet. The space's first live wallet is its favourite regardless of `isFavourite`; a later one
 * takes the favourite over only when `isFavourite`. Refused past MAX_WALLETS_PER_SPACE (one guarded insert, so
 * concurrent creates cannot pass the cap).
 */
export async function createWallet(
	db: Db,
	scope: WalletScope,
	input: WalletInput,
	now: number
): Promise<CreateWalletResult> {
	const { spaceId, userId } = scope;
	const id = newId();
	const created = sql`exists (select 1 from wallets w where w.id = ${id})`;
	const [, inserted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.insert(wallets)
			.select((qb) =>
				qb
					.select({
						id: sql`${id}`.as('id'),
						spaceId: spaces.id,
						name: sql`${input.name}`.as('name'),
						type: sql`${input.type}`.as('type'),
						currency: sql`${input.currency}`.as('currency'),
						openingBalanceMinor: sql`${input.openingBalanceMinor}`.as('opening_balance_minor'),
						isFavourite: sql`not exists (select 1 from wallets w where w.space_id = ${spaceId}
							and w.deleted_at is null and w.is_favourite = 1)`.as('is_favourite'),
						lastFour: sql`${input.lastFour}`.as('last_four'),
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
							sql`(select count(*) from wallets w where w.space_id = ${spaceId}) < ${MAX_WALLETS_PER_SPACE}`
						)
					)
			)
			.returning({ id: wallets.id }),
		...(input.isFavourite ? [favouriteSwap(db, scope, id, now, created)] : [])
	]);
	if (inserted.length === 1) return { ok: true, id };
	const [count] = await db.all<{ n: number }>(
		sql`select count(*) as n from wallets where space_id = ${spaceId}`
	);
	return { ok: false, reason: (count?.n ?? 0) >= MAX_WALLETS_PER_SPACE ? 'limit' : 'gone' };
}

/** After a guarded write changed nothing: `stale` when the wallet is still in this space, else `missing`. */
async function whyNot(db: Db, spaceId: string, walletId: string): Promise<WalletWriteResult> {
	return (await getWallet(db, spaceId, walletId, { includeArchived: true })) ? 'stale' : 'missing';
}

/**
 * Saves the edit form of a live wallet, only when its `updated_at` is still `expectedUpdatedAt` (the value the
 * form was loaded with): a second tab's stale submission gets `stale`, never an overwrite. With
 * `isFavourite` it also becomes the favourite in the same batch; unticking it on the favourite changes nothing
 * (there is always exactly one favourite: choose another wallet instead).
 */
export async function updateWallet(
	db: Db,
	scope: WalletScope,
	walletId: string,
	input: WalletInput,
	expectedUpdatedAt: number,
	now: number
): Promise<WalletWriteResult> {
	const { spaceId, userId } = scope;
	const written = sql`exists (select 1 from wallets w where w.id = ${walletId}
		and w.seq = ${currentSpaceSeq(spaceId)})`;
	const [, updated] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(wallets)
			.set({
				name: input.name,
				type: input.type,
				currency: input.currency,
				openingBalanceMinor: input.openingBalanceMinor,
				lastFour: input.lastFour,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(wallets.id, walletId),
					eq(wallets.spaceId, spaceId),
					isNull(wallets.deletedAt),
					eq(wallets.updatedAt, expectedUpdatedAt),
					isLiveMember(spaceId, userId),
					// A wallet's transactions are in its currency (FN-05): the code changes only while it has none.
					or(
						eq(wallets.currency, input.currency),
						sql`not exists (select 1 from transactions t where t.space_id = ${spaceId}
							and (t.wallet_id = ${walletId} or t.transfer_to_wallet_id = ${walletId})
							and t.deleted_at is null)`
					)
				)
			)
			.returning({ id: wallets.id }),
		...(input.isFavourite ? [favouriteSwap(db, scope, walletId, now, written)] : [])
	]);
	return updated.length === 1 ? 'ok' : whyNot(db, spaceId, walletId);
}

/**
 * Archives (tombstones) a live wallet when `updated_at` is still `expectedUpdatedAt`. Its favourite flag is
 * cleared and passes to the oldest live wallet, if any, in the same batch.
 */
export async function archiveWallet(
	db: Db,
	scope: WalletScope,
	walletId: string,
	expectedUpdatedAt: number,
	now: number
): Promise<WalletWriteResult> {
	const { spaceId, userId } = scope;
	const [, archived] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(wallets)
			.set({
				deletedAt: now,
				isFavourite: false,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(wallets.id, walletId),
					eq(wallets.spaceId, spaceId),
					isNull(wallets.deletedAt),
					eq(wallets.updatedAt, expectedUpdatedAt),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: wallets.id }),
		favouriteRepair(db, spaceId, now)
	]);
	return archived.length === 1 ? 'ok' : whyNot(db, spaceId, walletId);
}

/** Brings an archived wallet back (when `updated_at` is still `expectedUpdatedAt`); favourite only if none. */
export async function restoreWallet(
	db: Db,
	scope: WalletScope,
	walletId: string,
	expectedUpdatedAt: number,
	now: number
): Promise<WalletWriteResult> {
	const { spaceId, userId } = scope;
	const [, restored] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(wallets)
			.set({
				deletedAt: null,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(wallets.id, walletId),
					eq(wallets.spaceId, spaceId),
					isNotNull(wallets.deletedAt),
					eq(wallets.updatedAt, expectedUpdatedAt),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: wallets.id }),
		favouriteRepair(db, spaceId, now)
	]);
	return restored.length === 1 ? 'ok' : whyNot(db, spaceId, walletId);
}

/**
 * Makes a live wallet the space's favourite (idempotent). `missing` when it is not a live wallet of this
 * space. Concurrent calls always leave exactly one favourite.
 */
export async function setFavourite(
	db: Db,
	scope: WalletScope,
	walletId: string,
	now: number
): Promise<'ok' | 'missing'> {
	const { spaceId } = scope;
	const [, , favourite] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		favouriteSwap(db, scope, walletId, now),
		db
			.select({ id: wallets.id })
			.from(wallets)
			.where(
				and(
					eq(wallets.id, walletId),
					eq(wallets.spaceId, spaceId),
					isNull(wallets.deletedAt),
					eq(wallets.isFavourite, true)
				)
			)
	]);
	return favourite.length === 1 ? 'ok' : 'missing';
}

/** A wallet an import may write into: its id and currency (the import only writes IDR rows). */
export interface WalletRef {
	id: string;
	currency: string;
}

/**
 * Batch items for an import (FN-18): the new `lainnya` IDR wallets (zero opening balance) `wallets` names, each
 * only while no live wallet of the space has that name (compared as SQLite `lower()`), the membership holds and
 * the space stays within MAX_WALLETS_PER_SPACE with all of them (else none is written; the transactions that
 * point at them then fail their own guard and the import's assertion). Place after `bumpSpaceSeq`, before the
 * transactions, in the import's one `db.batch`, so nothing is created when nothing is imported.
 */
export function insertImportedWallets(
	db: Db,
	scope: WalletScope,
	newWallets: readonly { id: string; name: string }[],
	now: number
) {
	const { spaceId, userId } = scope;
	const json = JSON.stringify(newWallets);
	const missing = sql`not exists (select 1 from wallets w where w.space_id = ${spaceId}
		and w.deleted_at is null and lower(w.name) = lower(json_extract(j.value, '$.name')))`;
	return [
		db.insert(wallets).select(
			sql`select json_extract(j.value, '$.id'), ${spaceId}, json_extract(j.value, '$.name'), 'lainnya',
				'IDR', 0, 0, null, ${now}, ${now}, null, ${currentSpaceSeq(spaceId)}
			from json_each(${json}) j
			where ${missing} and ${isLiveMember(spaceId, userId)}
				and (select count(*) from wallets w where w.space_id = ${spaceId})
					+ (select count(*) from json_each(${json}) j where ${missing}) <= ${MAX_WALLETS_PER_SPACE}`
		),
		favouriteRepair(db, spaceId, now)
	] as const;
}
