import { and, eq, isNull, sql } from 'drizzle-orm';
import { addDays, wibTodayString } from '#lib/shared/dates';
import { cleanDescriptor } from '#lib/shared/merchants/clean';
import { layerKey, type LayerHit } from '#lib/shared/merchants/resolve';
import { cleanText } from '#lib/shared/text';
import type { CategoryKind, TileKey } from '#lib/shared/transactions';
import type { Db } from '../db';
import { merchantCache, merchantRules } from '../db/schema';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';

/**
 * FN-20 storage: the space's merchant rules, its history of saved transactions read as rules, and the AI cache.
 * Every function takes a space id or `SpaceScope` already admitted by `requireSpaceAccess`
 * (`currentSpaceScope`), never a space id from a form; writes repeat the live membership in their own statement.
 * Lists of keys travel as one JSON parameter (`json_each`), never one bound parameter per key.
 */

/** Most rules the settings page lists (a space learns one per corrected merchant). */
export const MERCHANT_RULES_LIST_MAX = 500;
/** Longest search term kept on the settings page. */
export const MERCHANT_SEARCH_MAX_LENGTH = 60;
/** History: saved transactions of the last 12 months, at most this many rows per space (PRD AC-19). */
export const HISTORY_ROWS_MAX = 5000;
const HISTORY_DAYS = 365;
/** AI answers are kept 90 days (owner decision 6). */
export const MERCHANT_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Expired cache rows deleted per write (opportunistic, bounded). */
const CACHE_SWEEP_MAX = 100;

export interface MerchantRuleView {
	id: string;
	merchantName: string;
	kind: CategoryKind;
	/** The rule's category while it is a visible category of the space, else null ("Kategori tidak tersedia"). */
	category: { id: string; name: string; tileKey: TileKey; isPreset: boolean } | null;
	hits: number;
	updatedAt: number;
}

/** A `kind:key` list as the JSON parameter the lookups bind. */
const keysJson = (keys: Iterable<string>) => JSON.stringify([...new Set(keys)]);

/** The space's live rules for `layerKeys` (`kind:key`), by layer key. */
export async function rulesForKeys(
	db: Db,
	spaceId: string,
	layerKeys: readonly string[]
): Promise<Map<string, LayerHit>> {
	const out = new Map<string, LayerHit>();
	if (layerKeys.length === 0) return out;
	const rows = await db.all<{ kind: CategoryKind; matchKey: string; categoryId: string | null }>(
		sql`select kind, match_key as matchKey, category_id as categoryId from merchant_rules
		where space_id = ${spaceId} and deleted_at is null
			and (kind || ':' || match_key) in (select value from json_each(${keysJson(layerKeys)}))
		limit ${layerKeys.length}`
	);
	for (const r of rows) out.set(layerKey(r.kind, r.matchKey), { categoryId: r.categoryId });
	return out;
}

/** Unexpired AI answers of the space for `layerKeys`, by layer key (a null category: the model named none). */
export async function cacheForKeys(
	db: Db,
	spaceId: string,
	layerKeys: readonly string[],
	now: number
): Promise<Map<string, LayerHit & { merchantName: string | null }>> {
	const out = new Map<string, LayerHit & { merchantName: string | null }>();
	if (layerKeys.length === 0) return out;
	const rows = await db.all<{
		kind: CategoryKind;
		matchKey: string;
		categoryId: string | null;
		merchantName: string | null;
	}>(
		sql`select kind, match_key as matchKey, category_id as categoryId, merchant_name as merchantName
		from merchant_cache
		where space_id = ${spaceId} and expires_at > ${now}
			and (kind || ':' || match_key) in (select value from json_each(${keysJson(layerKeys)}))
		limit ${layerKeys.length}`
	);
	for (const r of rows)
		out.set(layerKey(r.kind, r.matchKey), {
			categoryId: r.categoryId,
			merchantName: r.merchantName
		});
	return out;
}

/**
 * The space's history for `layerKeys`: per key, the category its saved, non-demo expense or income transactions
 * of the last 12 months used most (ties: the most recent), read from at most HISTORY_ROWS_MAX rows. Transfers,
 * adjustments, tombstones and rows without a category or title are ignored; only this space's rows are read.
 */
export async function historyForKeys(
	db: Db,
	spaceId: string,
	layerKeys: readonly string[],
	now: number
): Promise<Map<string, LayerHit>> {
	const out = new Map<string, LayerHit>();
	if (layerKeys.length === 0) return out;
	const wanted = new Set(layerKeys);
	const since = addDays(wibTodayString(now), -HISTORY_DAYS);
	const rows = await db.all<{ type: CategoryKind; title: string; categoryId: string }>(
		sql`select type, title, category_id as categoryId from transactions
		where space_id = ${spaceId} and deleted_at is null and is_demo = 0
			and type in ('expense', 'income') and category_id is not null and title is not null
			and occurred_on >= ${since}
		order by occurred_on desc, occurred_at desc
		limit ${HISTORY_ROWS_MAX}`
	);
	// Per key: category → [count, rank of its most recent row] (rows come newest first).
	const tally = new Map<string, Map<string, [number, number]>>();
	rows.forEach((r, rank) => {
		const lk = layerKey(r.type, cleanDescriptor(r.title).key);
		if (!wanted.has(lk)) return;
		const perKey = tally.get(lk) ?? new Map<string, [number, number]>();
		const seen = perKey.get(r.categoryId);
		perKey.set(r.categoryId, seen ? [seen[0] + 1, seen[1]] : [1, rank]);
		tally.set(lk, perKey);
	});
	for (const [lk, perKey] of tally) {
		let best: [string, number, number] | null = null;
		for (const [categoryId, [count, rank]] of perKey)
			if (!best || count > best[1] || (count === best[1] && rank < best[2]))
				best = [categoryId, count, rank];
		if (best) out.set(lk, { categoryId: best[0] });
	}
	return out;
}

/**
 * Caches AI answers for the space (90 days): one `INSERT … ON CONFLICT DO UPDATE` from a JSON parameter, a
 * category kept only while it is a category of this space of the row's kind, then a bounded sweep of expired
 * rows of the space. Replays are harmless. The caller must still be a live member of a live space at the moment
 * of the write (`isLiveMember`, FN-20 red team L3): the AI call before it can take 30 s, long enough for a
 * removal.
 */
export async function writeCache(
	db: Db,
	scope: SpaceScope,
	entries: readonly {
		key: string;
		kind: CategoryKind;
		merchantName: string | null;
		categoryId: string | null;
	}[],
	now: number
): Promise<void> {
	if (entries.length === 0) return;
	const { spaceId, userId } = scope;
	const json = JSON.stringify(
		entries.map((e) => ({
			key: e.key,
			kind: e.kind,
			name: e.merchantName ? cleanText(e.merchantName, 80) || null : null,
			category: e.categoryId
		}))
	);
	const expires = now + MERCHANT_CACHE_TTL_MS;
	const pick = (field: string) => sql`json_extract(j.value, ${`$.${field}`})`;
	await db.batch([
		db
			.insert(merchantCache)
			.select(
				sql`select ${spaceId}, ${pick('key')}, ${pick('kind')}, ${pick('name')},
					(select c.id from categories c where c.id = ${pick('category')}
						and c.space_id = ${spaceId} and c.kind = ${pick('kind')}),
					'ai', ${now}, ${expires}
				from json_each(${json}) j
				where ${isLiveMember(spaceId, userId)}`
			)
			.onConflictDoUpdate({
				target: [merchantCache.spaceId, merchantCache.matchKey, merchantCache.kind],
				set: {
					merchantName: sql`excluded.merchant_name`,
					categoryId: sql`excluded.category_id`,
					createdAt: sql`excluded.created_at`,
					expiresAt: sql`excluded.expires_at`
				}
			}),
		db.delete(merchantCache).where(
			sql`rowid in (select rowid from merchant_cache where space_id = ${spaceId}
					and expires_at <= ${now} limit ${CACHE_SWEEP_MAX})`
		)
	]);
}

/**
 * The space's live rules for the settings page, newest change first, at most MERCHANT_RULES_LIST_MAX; `search`
 * (already cleaned) narrows by merchant name with `instr` (never LIKE: D1 refuses long patterns).
 */
export async function listRules(db: Db, spaceId: string, search = ''): Promise<MerchantRuleView[]> {
	const term = search.toLowerCase();
	const rows = await db.all<{
		id: string;
		merchantName: string;
		kind: CategoryKind;
		categoryId: string | null;
		categoryName: string | null;
		tileKey: TileKey | null;
		isPreset: number | null;
		hits: number;
		updatedAt: number;
	}>(
		sql`select r.id, r.merchant_name as merchantName, r.kind, c.id as categoryId, c.name as categoryName,
			c.tile_key as tileKey, c.is_preset as isPreset, r.hits, r.updated_at as updatedAt
		from merchant_rules r
		left join categories c on c.id = r.category_id and c.space_id = r.space_id
			and c.deleted_at is null and c.is_hidden = 0 and c.kind = r.kind
		where r.space_id = ${spaceId} and r.deleted_at is null
			and (${term} = '' or instr(lower(r.merchant_name), ${term}) > 0 or instr(r.match_key, ${term}) > 0)
		order by r.updated_at desc, r.id
		limit ${MERCHANT_RULES_LIST_MAX}`
	);
	return rows.map((r) => ({
		id: r.id,
		merchantName: r.merchantName,
		kind: r.kind,
		category:
			r.categoryId && r.categoryName && r.tileKey
				? {
						id: r.categoryId,
						name: r.categoryName,
						tileKey: r.tileKey,
						isPreset: r.isPreset === 1
					}
				: null,
		hits: r.hits,
		updatedAt: r.updatedAt
	}));
}

/** How many live rules the space has (counted in SQL). */
export async function countRules(db: Db, spaceId: string): Promise<number> {
	const [row] = await db.all<{ n: number }>(
		sql`select count(*) as n from merchant_rules where space_id = ${spaceId} and deleted_at is null`
	);
	return row?.n ?? 0;
}

/** The columns a deleted rule keeps none of (content-free tombstone). */
const tombstone = (spaceId: string, now: number) => ({
	deletedAt: now,
	merchantName: null,
	categoryId: null,
	updatedAt: sql`max(${now}, ${merchantRules.updatedAt} + 1)`,
	seq: currentSpaceSeq(spaceId)
});

/**
 * Deletes one rule while its `updated_at` is still the one the page showed. `missing`: no live rule with this id
 * in this space (another space's id reads the same); `stale`: it changed meanwhile.
 */
export async function deleteRule(
	db: Db,
	scope: SpaceScope,
	id: string,
	expectedUpdatedAt: number,
	now: number
): Promise<'ok' | 'stale' | 'missing'> {
	const { spaceId, userId } = scope;
	const [, done] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(merchantRules)
			.set(tombstone(spaceId, now))
			.where(
				and(
					eq(merchantRules.id, id),
					eq(merchantRules.spaceId, spaceId),
					isNull(merchantRules.deletedAt),
					eq(merchantRules.updatedAt, expectedUpdatedAt),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: merchantRules.id })
	]);
	if (done.length === 1) return 'ok';
	const still = await db
		.select({ id: merchantRules.id })
		.from(merchantRules)
		.where(
			and(
				eq(merchantRules.id, id),
				eq(merchantRules.spaceId, spaceId),
				isNull(merchantRules.deletedAt)
			)
		)
		.get();
	return still ? 'stale' : 'missing';
}

/** "Hapus semua aturan": every live rule of the space becomes a tombstone. Returns how many. */
export async function deleteAllRules(db: Db, scope: SpaceScope, now: number): Promise<number> {
	const { spaceId, userId } = scope;
	const [, done] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(merchantRules)
			.set(tombstone(spaceId, now))
			.where(
				and(
					eq(merchantRules.spaceId, spaceId),
					isNull(merchantRules.deletedAt),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: merchantRules.id })
	]);
	return done.length;
}
