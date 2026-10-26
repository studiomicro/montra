import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { NetWorthKind, PriceSource } from '#lib/shared/net-worth';
import type { Db } from '../db';
import { netWorthItems, spaces } from '../db/schema';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { newId } from '../util';
import type { NetWorthInput } from './validation';
import { nextUpdatedAt } from '../sync/updated-at';

/** Most live items one space holds (owner decision 4); also the list's row cap. Deleted items do not count. */
export const MAX_ITEMS_PER_SPACE = 200;

export interface NetWorthItem {
	id: string;
	kind: NetWorthKind;
	name: string;
	currency: string;
	priceSource: PriceSource;
	priceSymbol: string | null;
	quantityScaled: string | null;
	quantityScale: number | null;
	manualValueMinor: number | null;
	acquiredOn: string | null;
	note: string | null;
	/** Fictional local-review row (`Data demo`): badged, read-only, never counted in a total. */
	isDemo: boolean;
	createdAt: number;
	updatedAt: number;
}

/**
 * `missing`: no such live item in this space (same answer for another space's id). `stale`: changed meanwhile.
 * `demo`: a `Data demo` row, which is read-only (never edited into, or deleted like, a real item).
 */
export type NetWorthWriteResult = 'ok' | 'stale' | 'missing' | 'demo';
export type CreateNetWorthResult =
	{ ok: true; id: string } | { ok: false; reason: 'limit' | 'gone' };

const columns = {
	id: netWorthItems.id,
	kind: netWorthItems.kind,
	name: netWorthItems.name,
	currency: netWorthItems.currency,
	priceSource: netWorthItems.priceSource,
	priceSymbol: netWorthItems.priceSymbol,
	quantityScaled: netWorthItems.quantityScaled,
	quantityScale: netWorthItems.quantityScale,
	manualValueMinor: netWorthItems.manualValueMinor,
	acquiredOn: netWorthItems.acquiredOn,
	note: netWorthItems.note,
	isDemo: netWorthItems.isDemo,
	createdAt: netWorthItems.createdAt,
	updatedAt: netWorthItems.updatedAt
};

/**
 * The space's live items, oldest first, at most MAX_ITEMS_PER_SPACE (the creation cap). Live rows always carry
 * their content (the CHECK), so the non-null assertions below hold.
 */
export async function listNetWorthItems(db: Db, spaceId: string): Promise<NetWorthItem[]> {
	const rows = await db
		.select(columns)
		.from(netWorthItems)
		.where(and(eq(netWorthItems.spaceId, spaceId), isNull(netWorthItems.deletedAt)))
		.orderBy(asc(netWorthItems.createdAt), asc(netWorthItems.id))
		.limit(MAX_ITEMS_PER_SPACE);
	return rows.map((r) => ({
		...r,
		kind: r.kind as NetWorthKind,
		name: r.name as string,
		currency: r.currency as string,
		priceSource: r.priceSource as PriceSource,
		createdAt: r.createdAt as number
	}));
}

/** Creates an item. Refused past MAX_ITEMS_PER_SPACE live items in one guarded insert (concurrency-safe). */
export async function createNetWorthItem(
	db: Db,
	scope: SpaceScope,
	input: NetWorthInput,
	now: number
): Promise<CreateNetWorthResult> {
	const { spaceId, userId } = scope;
	const id = newId();
	const [, inserted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.insert(netWorthItems)
			.select((qb) =>
				qb
					.select({
						id: sql`${id}`.as('id'),
						spaceId: spaces.id,
						kind: sql`${input.kind}`.as('kind'),
						name: sql`${input.name}`.as('name'),
						currency: sql`${input.currency}`.as('currency'),
						priceSource: sql`${input.priceSource}`.as('price_source'),
						priceSymbol: sql`${input.priceSymbol}`.as('price_symbol'),
						quantityScaled: sql`${input.quantityScaled}`.as('quantity_scaled'),
						quantityScale: sql`${input.quantityScale}`.as('quantity_scale'),
						manualValueMinor: sql`${input.manualValueMinor}`.as('manual_value_minor'),
						acquiredOn: sql`${input.acquiredOn}`.as('acquired_on'),
						note: sql`${input.note}`.as('note'),
						// A form row is always real; `Data demo` rows come only from a local seed.
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
							sql`(select count(*) from net_worth_items i where i.space_id = ${spaceId}
								and i.deleted_at is null) < ${MAX_ITEMS_PER_SPACE}`
						)
					)
			)
			.returning({ id: netWorthItems.id })
	]);
	if (inserted.length === 1) return { ok: true, id };
	const [count] = await db.all<{ n: number }>(
		sql`select count(*) as n from net_worth_items where space_id = ${spaceId} and deleted_at is null`
	);
	return { ok: false, reason: (count?.n ?? 0) >= MAX_ITEMS_PER_SPACE ? 'limit' : 'gone' };
}

/**
 * After a guarded write changed nothing: `demo` for a live `Data demo` item of this space, `stale` for another
 * live item of this space, else `missing`.
 */
async function whyNot(db: Db, spaceId: string, itemId: string): Promise<NetWorthWriteResult> {
	const row = await db
		.select({ isDemo: netWorthItems.isDemo })
		.from(netWorthItems)
		.where(
			and(
				eq(netWorthItems.id, itemId),
				eq(netWorthItems.spaceId, spaceId),
				isNull(netWorthItems.deletedAt)
			)
		)
		.get();
	return row ? (row.isDemo ? 'demo' : 'stale') : 'missing';
}

/** This live, real (not `Data demo`) item of this space, `updated_at` still as loaded, the writer still a member. */
const writable = (scope: SpaceScope, itemId: string, expectedUpdatedAt: number) =>
	and(
		eq(netWorthItems.id, itemId),
		eq(netWorthItems.spaceId, scope.spaceId),
		eq(netWorthItems.isDemo, false),
		eq(netWorthItems.updatedAt, expectedUpdatedAt),
		isNull(netWorthItems.deletedAt),
		isLiveMember(scope.spaceId, scope.userId)
	);

/** Saves the edit form of a live item; `stale` when it changed since the form loaded. */
export async function updateNetWorthItem(
	db: Db,
	scope: SpaceScope,
	itemId: string,
	input: NetWorthInput,
	expectedUpdatedAt: number,
	now: number
): Promise<NetWorthWriteResult> {
	const [, updated] = await db.batch([
		bumpSpaceSeq(db, scope.spaceId),
		db
			.update(netWorthItems)
			.set({
				kind: input.kind,
				name: input.name,
				currency: input.currency,
				priceSource: input.priceSource,
				priceSymbol: input.priceSymbol,
				quantityScaled: input.quantityScaled,
				quantityScale: input.quantityScale,
				manualValueMinor: input.manualValueMinor,
				acquiredOn: input.acquiredOn,
				note: input.note,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(scope.spaceId)
			})
			.where(writable(scope, itemId, expectedUpdatedAt))
			.returning({ id: netWorthItems.id })
	]);
	return updated.length === 1 ? 'ok' : whyNot(db, scope.spaceId, itemId);
}

/** Deletes a live item: a content-free tombstone (only ids, times and seq stay), so there is no restore. */
export async function deleteNetWorthItem(
	db: Db,
	scope: SpaceScope,
	itemId: string,
	expectedUpdatedAt: number,
	now: number
): Promise<NetWorthWriteResult> {
	const [, deleted] = await db.batch([
		bumpSpaceSeq(db, scope.spaceId),
		db
			.update(netWorthItems)
			.set({
				kind: null,
				name: null,
				currency: null,
				priceSource: null,
				priceSymbol: null,
				quantityScaled: null,
				quantityScale: null,
				manualValueMinor: null,
				acquiredOn: null,
				note: null,
				createdAt: null,
				deletedAt: now,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(scope.spaceId)
			})
			.where(writable(scope, itemId, expectedUpdatedAt))
			.returning({ id: netWorthItems.id })
	]);
	return deleted.length === 1 ? 'ok' : whyNot(db, scope.spaceId, itemId);
}

/**
 * What the jobs Worker must price this tick, across every live space: whether any Indodax or gold item exists
 * (the whole ticker is cached either way, so no user's coin codes can crowd out another's, red team M2), and the
 * non-IDR currencies held by live items or live wallets of live spaces (each needs a daily rate). Bounded
 * queries; no item content leaves them.
 */
export async function pricingDemand(
	db: Db
): Promise<{ crypto: boolean; gold: boolean; currencies: string[] }> {
	const exists = (source: 'indodax' | 'gold_api') =>
		db.all<{ n: number }>(sql`select count(*) as n from (select 1 from net_worth_items i
			join spaces s on s.id = i.space_id and s.deleted_at is null
			where i.deleted_at is null and i.price_source = ${source} limit 1)`);
	const [crypto, gold, currencies] = await Promise.all([
		exists('indodax'),
		exists('gold_api'),
		db.all<{ currency: string }>(sql`select currency from (
				select distinct i.currency as currency from net_worth_items i
				join spaces s on s.id = i.space_id and s.deleted_at is null
				where i.deleted_at is null and i.currency <> 'IDR'
				union
				select distinct w.currency from wallets w
				join spaces s on s.id = w.space_id and s.deleted_at is null
				where w.deleted_at is null and w.currency <> 'IDR'
			) order by currency limit 50`)
	]);
	return {
		crypto: (crypto[0]?.n ?? 0) > 0,
		gold: (gold[0]?.n ?? 0) > 0,
		currencies: currencies.map((r) => r.currency)
	};
}
