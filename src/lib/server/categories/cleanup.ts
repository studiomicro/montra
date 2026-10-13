import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { maskAccountNumbers } from '#lib/shared/text';
import {
	FALLBACK_EXPENSE_CATEGORY,
	isFallbackCategory,
	type CategoryKind
} from '#lib/shared/transactions';
import type { MerchantReason } from '#lib/shared/merchants/resolve';
import type { Db } from '../db';
import { categoryCleanupBatches, categoryCleanupItems, transactions } from '../db/schema';
import { resolveMerchants, RESOLVE_BATCH_MAX } from '../merchants/resolve';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { ensurePresetCategories, listCategories } from './repo';

/**
 * FN-48 "Rapikan kategori": captured and imported rows still sitting in a fallback category ("Lainnya",
 * "Pemasukan Lain") get the category FN-20's deterministic resolver (now with the bank-narrative layer) names
 * for their title, after the user reviews the list. Only `category_id`, `updated_at` and `seq` change, plus the
 * `category_source` marker set to `auto` (so a row from before migration 0037 stays eligible after an undo); the
 * whole batch can be undone in one step. Never AI (`allowAi: false`), never a row a person categorised.
 */

/** Most rows one review lists (newest first); the card's count still shows them all. */
export const CLEANUP_PREVIEW_MAX = 500;
/** Rows per write statement: keeps each statement's one JSON parameter small (as the import's INSERT_CHUNK). */
const WRITE_CHUNK = 250;

/**
 * A row "Rapikan kategori" may change (owner decisions 5 and 6, AC-25/26): live, expense or income, captured
 * (never `manual`), in a fallback category of this space (`isFallbackCategory` in SQL), and its category never
 * chosen by a person: `category_source = 'auto'`, or, on a row written before migration 0037 (null), never
 * edited since it was created. Demo rows are included (badged) like every other list.
 */
const eligible = (spaceId: string) => sql`t.space_id = ${spaceId} and t.deleted_at is null
	and t.type in ('expense', 'income') and t.source <> 'manual'
	and (t.category_source = 'auto' or (t.category_source is null and t.updated_at = t.created_at))
	and exists (select 1 from categories c where c.id = t.category_id and c.space_id = ${spaceId}
		and c.tile_key = 'lain'
		and (c.is_preset = 1 or lower(trim(c.name)) = ${FALLBACK_EXPENSE_CATEGORY.toLowerCase()}))`;

interface Candidate {
	id: string;
	type: CategoryKind;
	title: string | null;
	amountMinor: number;
	currency: string;
	occurredOn: string;
	categoryId: string;
	isDemo: number;
	updatedAt: number;
}

/** One row the review proposes to change. */
export interface CleanupProposal {
	id: string;
	type: CategoryKind;
	/** The stored title with any long digit run masked (display only). */
	title: string;
	amountMinor: number;
	currency: string;
	occurredOn: string;
	isDemo: boolean;
	fromCategoryId: string;
	toCategoryId: string;
	reason: MerchantReason;
}

/** How many rows of the space are eligible (counted in SQL, never by loading them). */
export async function countCleanupCandidates(db: Db, spaceId: string): Promise<number> {
	const [row] = await db.all<{ n: number }>(
		sql`select count(*) as n from transactions t where ${eligible(spaceId)}`
	);
	return row?.n ?? 0;
}

const candidateColumns = sql`t.id, t.type, t.title, t.amount_minor as amountMinor, t.currency,
	t.occurred_on as occurredOn, t.category_id as categoryId, t.is_demo as isDemo, t.updated_at as updatedAt`;

/**
 * The resolver's pick for each candidate with a title, kept only when it is a real (non-fallback) category other
 * than the current one. Distinct (kind, title) pairs only, RESOLVE_BATCH_MAX per call; deterministic layers only.
 */
async function propose(
	db: Db,
	scope: SpaceScope,
	rows: readonly Candidate[],
	now: number
): Promise<CleanupProposal[]> {
	const textKey = (r: { type: string; title: string }) => `${r.type}\u0000${r.title}`;
	const distinct = new Map<string, { rawText: string; type: CategoryKind }>();
	for (const r of rows)
		if (r.title && !distinct.has(textKey({ type: r.type, title: r.title })))
			distinct.set(textKey({ type: r.type, title: r.title }), { rawText: r.title, type: r.type });
	if (distinct.size === 0) return [];
	const categories = await listCategories(db, scope.spaceId);
	const fallbacks = new Set(categories.filter(isFallbackCategory).map((c) => c.id));
	const keys = [...distinct.keys()];
	const items = [...distinct.values()];
	const picks = new Map<string, { categoryId: string; reason: MerchantReason }>();
	for (let i = 0; i < items.length; i += RESOLVE_BATCH_MAX) {
		const { items: resolved } = await resolveMerchants(
			db,
			scope,
			items.slice(i, i + RESOLVE_BATCH_MAX),
			{ userId: scope.userId, allowAi: false, now }
		);
		resolved.forEach((r, j) => {
			const key = keys[i + j];
			if (key && r.categoryId && !fallbacks.has(r.categoryId))
				picks.set(key, { categoryId: r.categoryId, reason: r.reason });
		});
	}
	return rows.flatMap((r) => {
		const pick = r.title ? picks.get(textKey({ type: r.type, title: r.title })) : undefined;
		if (!pick || !r.title || pick.categoryId === r.categoryId) return [];
		return [
			{
				id: r.id,
				type: r.type,
				title: maskAccountNumbers(r.title),
				amountMinor: r.amountMinor,
				currency: r.currency,
				occurredOn: r.occurredOn,
				isDemo: r.isDemo === 1,
				fromCategoryId: r.categoryId,
				toCategoryId: pick.categoryId,
				reason: pick.reason
			}
		];
	});
}

export interface CleanupPreview {
	/** Every eligible row of the space (the first CLEANUP_PREVIEW_MAX are reviewed). */
	total: number;
	/** How many eligible rows this review read (at most CLEANUP_PREVIEW_MAX). */
	scanned: number;
	proposals: CleanupProposal[];
}

/**
 * The review list: the newest CLEANUP_PREVIEW_MAX eligible rows (by WIB date, then time, then id) and, among
 * them, every row for which the resolver names a better category. The space's presets are topped up first, so a
 * space created before FN-48 has the bank-statement categories to land in.
 */
export async function previewCleanup(
	db: Db,
	scope: SpaceScope,
	now: number
): Promise<CleanupPreview> {
	const { spaceId } = scope;
	await ensurePresetCategories(db, spaceId, now);
	const [rows, total] = await Promise.all([
		db.all<Candidate>(
			sql`select ${candidateColumns} from transactions t where ${eligible(spaceId)}
			order by t.occurred_on desc, t.occurred_at desc, t.id desc
			limit ${CLEANUP_PREVIEW_MAX}`
		),
		countCleanupCandidates(db, spaceId)
	]);
	return { total, scanned: rows.length, proposals: await propose(db, scope, rows, now) };
}

export type ApplyCleanupResult =
	| { status: 'ok'; applied: number; changed: number; updatedAt: number }
	| { status: 'already' }
	| { status: 'none' }
	| { status: 'stale' };

const batchInSpace = async (db: Db, spaceId: string, batchId: string) =>
	db
		.select({ id: categoryCleanupBatches.id })
		.from(categoryCleanupBatches)
		.where(and(eq(categoryCleanupBatches.id, batchId), eq(categoryCleanupBatches.spaceId, spaceId)))
		.get();

/**
 * "Terapkan": re-checks every selected id on the server (eligible now, and the resolver's pick recomputed; the
 * client sends ids only, never a category) and writes, in one `db.batch`: the batch header (only while the
 * user is a live member and no batch with `batchId` exists, so a resent form changes nothing: `already`), one
 * item per row still exactly as reviewed (same category and `updated_at`, else counted in `changed`), and each
 * of those rows' `category_id`, `updated_at` and `seq`. Ids and plans travel as JSON (`json_each`) in chunks of
 * WRITE_CHUNK. `none`: nothing selected is eligible; `stale`: every selected row changed meanwhile.
 */
export async function applyCleanup(
	db: Db,
	scope: SpaceScope,
	batchId: string,
	ids: readonly string[],
	now: number
): Promise<ApplyCleanupResult> {
	const { spaceId, userId } = scope;
	if (await batchInSpace(db, spaceId, batchId)) return { status: 'already' };
	const wanted = [...new Set(ids)].slice(0, CLEANUP_PREVIEW_MAX);
	if (wanted.length === 0) return { status: 'none' };
	const rows = await db.all<Candidate>(
		sql`select ${candidateColumns} from transactions t where ${eligible(spaceId)}
		and t.id in (select value from json_each(${JSON.stringify(wanted)}))
		limit ${wanted.length}`
	);
	const proposals = await propose(db, scope, rows, now);
	if (proposals.length === 0) return { status: 'none' };
	const updatedAtOf = new Map(rows.map((r) => [r.id, r.updatedAt]));
	const plan = proposals.map((p) => ({
		id: p.id,
		prev: p.fromCategoryId,
		next: p.toCategoryId,
		updatedAt: updatedAtOf.get(p.id)
	}));
	const chunks: (typeof plan)[] = [];
	for (let i = 0; i < plan.length; i += WRITE_CHUNK) chunks.push(plan.slice(i, i + WRITE_CHUNK));

	const f = (name: string) => sql`json_extract(j.value, ${'$.' + name})`;
	/** A planned row is still exactly as reviewed, and its new category is a visible one of its kind. */
	const stillAsReviewed = sql`t.id = ${f('id')} and ${eligible(spaceId)}
		and t.category_id = ${f('prev')} and t.updated_at = ${f('updatedAt')}
		and exists (select 1 from categories c where c.id = ${f('next')} and c.space_id = ${spaceId}
			and c.kind = t.type and c.deleted_at is null and c.is_hidden = 0)`;
	const headerWrittenNow = sql`exists (select 1 from category_cleanup_batches b where b.id = ${batchId}
		and b.space_id = ${spaceId} and b.seq = ${currentSpaceSeq(spaceId)} and b.undone_at is null)`;

	const [, , ...rest] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db.insert(categoryCleanupBatches).select(
			sql`select ${batchId}, ${spaceId}, 0, ${userId}, ${now}, ${now}, null, null, ${currentSpaceSeq(spaceId)}
			where ${isLiveMember(spaceId, userId)}
				and not exists (select 1 from category_cleanup_batches b where b.id = ${batchId})
				and exists (select 1 from json_each(${JSON.stringify(plan)}) j, transactions t
					where ${stillAsReviewed})`
		),
		...chunks.flatMap((chunk) => {
			const json = JSON.stringify(chunk);
			return [
				db.insert(categoryCleanupItems).select(
					sql`select ${batchId}, ${spaceId}, t.id, ${f('prev')}, ${f('next')}, max(${now}, t.updated_at + 1)
					from json_each(${json}) j, transactions t
					where ${stillAsReviewed} and ${headerWrittenNow}`
				),
				db
					.update(transactions)
					.set({
						categoryId: sql`(select i.new_category_id from category_cleanup_items i
							where i.batch_id = ${batchId} and i.transaction_id = ${transactions.id})`,
						// The marker stays `auto` (a row from before 0037 gets it now): its category is still a
						// machine proposal, so a later clean-up may revisit it after an undo.
						categorySource: 'auto',
						updatedAt: sql`max(${now}, ${transactions.updatedAt} + 1)`,
						seq: currentSpaceSeq(spaceId)
					})
					.where(
						sql`${transactions.spaceId} = ${spaceId} and ${transactions.deletedAt} is null
						and ${transactions.id} in (select json_extract(j.value, '$.id') from json_each(${json}) j)
						and ${transactions.id} in (select i.transaction_id from category_cleanup_items i
							where i.batch_id = ${batchId} and i.previous_category_id = ${transactions.categoryId})
						and ${headerWrittenNow}`
					)
			];
		}),
		db
			.update(categoryCleanupBatches)
			.set({
				rowCount: sql`(select count(*) from category_cleanup_items i where i.batch_id = ${batchId})`
			})
			.where(
				and(
					eq(categoryCleanupBatches.id, batchId),
					eq(categoryCleanupBatches.spaceId, spaceId),
					sql`${categoryCleanupBatches.seq} = ${currentSpaceSeq(spaceId)}`
				)
			),
		db
			.select({ rowCount: categoryCleanupBatches.rowCount })
			.from(categoryCleanupBatches)
			.where(
				and(
					eq(categoryCleanupBatches.id, batchId),
					eq(categoryCleanupBatches.spaceId, spaceId),
					sql`${categoryCleanupBatches.seq} = ${currentSpaceSeq(spaceId)}`
				)
			)
	]);
	const written = rest.at(-1) as { rowCount: number }[];
	const applied = written[0]?.rowCount ?? 0;
	if (applied > 0)
		return { status: 'ok', applied, changed: proposals.length - applied, updatedAt: now };
	return (await batchInSpace(db, spaceId, batchId)) ? { status: 'already' } : { status: 'stale' };
}

/** The space's latest clean-up that can still be undone, or null. */
export async function latestCleanup(
	db: Db,
	spaceId: string
): Promise<{ id: string; rowCount: number; createdAt: number; updatedAt: number } | null> {
	const row = await db
		.select({
			id: categoryCleanupBatches.id,
			rowCount: categoryCleanupBatches.rowCount,
			createdAt: categoryCleanupBatches.createdAt,
			updatedAt: categoryCleanupBatches.updatedAt
		})
		.from(categoryCleanupBatches)
		.where(
			and(
				eq(categoryCleanupBatches.spaceId, spaceId),
				isNull(categoryCleanupBatches.undoneAt),
				isNull(categoryCleanupBatches.deletedAt)
			)
		)
		.orderBy(desc(categoryCleanupBatches.createdAt), desc(categoryCleanupBatches.id))
		.limit(1)
		.get();
	return row ?? null;
}

export type UndoCleanupResult =
	| { status: 'ok'; reverted: number; kept: number }
	| { status: 'already' }
	| { status: 'stale' }
	| { status: 'missing' };

/**
 * "Urungkan": marks the batch undone and gives every row of it its previous category back, in one `db.batch`,
 * only while the batch is not yet undone, its `updated_at` is still `expectedUpdatedAt` and the user is a live
 * member (the rows are touched only when that first statement changed the batch in this very batch, its `seq`).
 * A row is restored only while it still holds exactly what the clean-up wrote (same category and `updated_at`):
 * a row edited since is left alone and counted in `kept`. Only `category_id`, `updated_at` and `seq` change.
 * `already`: undone before (a resend changes nothing). `missing`: no such batch in this space.
 */
export async function undoCleanup(
	db: Db,
	scope: SpaceScope,
	batchId: string,
	expectedUpdatedAt: number,
	now: number
): Promise<UndoCleanupResult> {
	const { spaceId, userId } = scope;
	const [, undone, reverted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(categoryCleanupBatches)
			.set({
				undoneAt: now,
				updatedAt: Math.max(now, expectedUpdatedAt + 1),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(categoryCleanupBatches.id, batchId),
					eq(categoryCleanupBatches.spaceId, spaceId),
					isNull(categoryCleanupBatches.undoneAt),
					isNull(categoryCleanupBatches.deletedAt),
					eq(categoryCleanupBatches.updatedAt, expectedUpdatedAt),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ rowCount: categoryCleanupBatches.rowCount }),
		db
			.update(transactions)
			.set({
				categoryId: sql`(select i.previous_category_id from category_cleanup_items i
					where i.batch_id = ${batchId} and i.transaction_id = ${transactions.id})`,
				categorySource: 'auto',
				updatedAt: sql`max(${now}, ${transactions.updatedAt} + 1)`,
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				sql`${transactions.spaceId} = ${spaceId} and ${transactions.deletedAt} is null
				and ${transactions.id} in (select i.transaction_id from category_cleanup_items i
					where i.batch_id = ${batchId} and i.space_id = ${spaceId}
						and i.new_category_id = ${transactions.categoryId}
						and i.applied_updated_at = ${transactions.updatedAt}
						and exists (select 1 from categories c where c.id = i.previous_category_id
							and c.space_id = ${spaceId} and c.kind = ${transactions.type} and c.deleted_at is null))
				and exists (select 1 from category_cleanup_batches b where b.id = ${batchId}
					and b.space_id = ${spaceId} and b.undone_at is not null
					and b.seq = ${currentSpaceSeq(spaceId)})`
			)
			.returning({ id: transactions.id })
	]);
	const [header] = undone;
	if (header) {
		const n = reverted.length;
		return { status: 'ok', reverted: n, kept: header.rowCount - n };
	}
	const row = await db
		.select({ undoneAt: categoryCleanupBatches.undoneAt })
		.from(categoryCleanupBatches)
		.where(
			and(
				eq(categoryCleanupBatches.id, batchId),
				eq(categoryCleanupBatches.spaceId, spaceId),
				isNull(categoryCleanupBatches.deletedAt)
			)
		)
		.get();
	if (!row) return { status: 'missing' };
	return row.undoneAt !== null ? { status: 'already' } : { status: 'stale' };
}
