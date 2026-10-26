import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { asciiLowerKey } from '#lib/shared/text';
import {
	FN48_TILES,
	PRESET_CATEGORIES,
	type CategoryKind,
	type TileKey
} from '#lib/shared/transactions';
import type { Db } from '../db';
import { categories, spaces } from '../db/schema';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { newId } from '../util';
import type { CategoryCreate, CategoryEdit } from './validation';
import { bumpedUpdatedAt, nextUpdatedAt } from '../sync/updated-at';

/** Most categories one space creates (the 24 presets included, hidden ones too). */
export const MAX_CATEGORIES_PER_SPACE = 100;
type Preset = (typeof PRESET_CATEGORIES)[number];
/**
 * The presets added after spaces were already seeded, per generation, topped up on the next load: FN-39's two
 * (for a space seeded with the first 15), then FN-48's seven (for a space holding the first 17). `upTo`: the
 * preset count a space has once that generation and every earlier one is complete.
 */
const FN48_PRESETS = PRESET_CATEGORIES.filter((p) => FN48_TILES.has(p.tileKey));
const FN39_PRESETS = PRESET_CATEGORIES.filter(
	(p) => p.tileKey === 'ojek-online' || p.tileKey === 'pesan-antar-makanan'
);
const LATER_PRESETS: readonly { upTo: number; presets: readonly Preset[] }[] = [
	{ upTo: PRESET_CATEGORIES.length - FN48_PRESETS.length, presets: FN39_PRESETS },
	{ upTo: PRESET_CATEGORIES.length, presets: FN48_PRESETS }
];
/**
 * Most categories one space can hold, so every category list's row cap: a space that was at the creation cap
 * before FN-39 or FN-48 still received the later presets (`ensurePresetCategories`).
 */
export const CATEGORY_LIST_MAX =
	MAX_CATEGORIES_PER_SPACE + FN39_PRESETS.length + FN48_PRESETS.length;

/** A preset's identity within a space: its tile and kind ("Transfer" has an expense and an income preset). */
const presetSlot = (p: { tileKey: string; kind: string }) => `${p.tileKey}:${p.kind}`;

export interface CategorySummary {
	id: string;
	kind: CategoryKind;
	name: string;
	tileKey: TileKey;
	isPreset: boolean;
	isHidden: boolean;
	updatedAt: number;
}

/** `missing`: no such category in this space (same answer for another space's id). `stale`: changed meanwhile. */
export type CategoryWriteResult = 'ok' | 'stale' | 'missing';

const columns = {
	id: categories.id,
	kind: categories.kind,
	name: categories.name,
	tileKey: categories.tileKey,
	isPreset: categories.isPreset,
	isHidden: categories.isHidden,
	updatedAt: categories.updatedAt
};

/**
 * Gives a space its 24 preset categories the first time any category route loads for it, and a space seeded
 * before FN-39 or FN-48 the presets added since (`LATER_PRESETS`, at the end of its list) the next time. Each
 * insert is one guarded statement in one `db.batch` (D1 runs a batch as one transaction), so concurrent loads seed
 * exactly once: the first seed only while the space has no category at all; a top-up preset only while the
 * space has fewer presets than its generation's `upTo` and none with that preset's tile and kind. A preset is
 * never recreated once the space has it, even renamed, hidden or moved to another tile (the preset count of its
 * generation is then complete). Neither is gated by MAX_CATEGORIES_PER_SPACE (the creation cap counts presets as
 * taken room). The rows travel as one JSON parameter (`json_each`), never as one bound parameter per value.
 */
export async function ensurePresetCategories(
	db: Db,
	spaceId: string,
	now: number = Date.now()
): Promise<void> {
	const [state] = await presetStateQuery(db, spaceId);
	await completePresets(db, spaceId, state, now);
}

/**
 * `ensurePresetCategories` followed by `listCategories`, in one round trip when the space already has every
 * preset (the usual case): the preset state and the list are read in one `db.batch`. Only when a preset was
 * seeded or topped up is the list read again.
 */
export async function listCategoriesWithPresets(
	db: Db,
	spaceId: string,
	opts: { includeHidden?: boolean } = {},
	now: number = Date.now()
): Promise<CategorySummary[]> {
	const [[state], list] = await db.batch([
		presetStateQuery(db, spaceId),
		listCategoriesQuery(db, spaceId, opts)
	]);
	return (await completePresets(db, spaceId, state, now))
		? listCategories(db, spaceId, opts)
		: list;
}

/** What `ensurePresetCategories` decides on: every category row of the space, live or not, and its presets. */
function presetStateQuery(db: Db, spaceId: string) {
	return db
		.select({
			total: sql<number>`count(*)`,
			presets: sql<number>`coalesce(sum(${categories.isPreset}), 0)`,
			slots: sql<string>`coalesce(json_group_array(${categories.tileKey} || ':' || ${categories.kind})
				filter (where ${categories.isPreset} = 1), '[]')`
		})
		.from(categories)
		.where(eq(categories.spaceId, spaceId));
}

/**
 * The write half of `ensurePresetCategories` for the state `presetStateQuery` read. True when it sent a write
 * (a first seed or a top-up), false when the space already had every preset its generation needs.
 */
async function completePresets(
	db: Db,
	spaceId: string,
	state: { total: number; presets: number; slots: string } | undefined,
	now: number
): Promise<boolean> {
	if (state && state.total > 0) {
		if (state.presets >= PRESET_CATEGORIES.length) return false;
		const slots = new Set(JSON.parse(state.slots) as string[]);
		const groups = LATER_PRESETS.map((g) => ({
			upTo: g.upTo,
			missing: g.presets.filter((p) => !slots.has(presetSlot(p)))
		})).filter((g) => g.missing.length > 0);
		if (groups.length === 0) return false;
		await topUpPresets(db, spaceId, groups, now);
		return true;
	}
	const rows = PRESET_CATEGORIES.map((p, i) => ({
		id: newId(),
		kind: p.kind,
		name: p.name,
		tileKey: p.tileKey,
		sortOrder: i
	}));
	await db.batch([
		bumpSpaceSeq(db, spaceId),
		db.insert(categories).select(
			sql`select json_extract(value, '$.id'), ${spaceId}, json_extract(value, '$.kind'),
				json_extract(value, '$.name'), json_extract(value, '$.tileKey'), 1, 0,
				json_extract(value, '$.sortOrder'), ${now}, ${now}, null, ${currentSpaceSeq(spaceId)}
			from json_each(${JSON.stringify(rows)})
			where not exists (select 1 from categories c where c.space_id = ${spaceId})
				and exists (select 1 from spaces s where s.id = ${spaceId} and s.deleted_at is null)`
		)
	]);
	return true;
}

/**
 * The top-up half of `ensurePresetCategories`: each group's `missing` presets after every category the space has,
 * in preset order, one guarded insert per generation (oldest first) in one batch.
 */
async function topUpPresets(
	db: Db,
	spaceId: string,
	groups: readonly { upTo: number; missing: readonly Preset[] }[],
	now: number
): Promise<void> {
	const inserts = groups.map(({ upTo, missing }) => {
		const rows = missing.map((p) => ({
			id: newId(),
			kind: p.kind,
			name: p.name,
			tileKey: p.tileKey
		}));
		return db.insert(categories).select(
			sql`select json_extract(j.value, '$.id'), ${spaceId}, json_extract(j.value, '$.kind'),
				json_extract(j.value, '$.name'), json_extract(j.value, '$.tileKey'), 1, 0,
				(select coalesce(max(c.sort_order), -1) + 1 from categories c where c.space_id = ${spaceId}) + j.key,
				${now}, ${now}, null, ${currentSpaceSeq(spaceId)}
			from json_each(${JSON.stringify(rows)}) j
			where not exists (select 1 from categories c where c.space_id = ${spaceId} and c.is_preset = 1
					and c.tile_key = json_extract(j.value, '$.tileKey')
					and c.kind = json_extract(j.value, '$.kind'))
				and (select count(*) from categories c where c.space_id = ${spaceId} and c.is_preset = 1)
					< ${upTo}
				and exists (select 1 from spaces s where s.id = ${spaceId} and s.deleted_at is null)`
		);
	});
	const [first, ...rest] = inserts;
	if (!first) return;
	await db.batch([bumpSpaceSeq(db, spaceId), first, ...rest]);
}

/**
 * The space's categories: expense first, then income, each in preset order then creation order. Hidden ones
 * only with `includeHidden`. Bounded by CATEGORY_LIST_MAX.
 */
export async function listCategories(
	db: Db,
	spaceId: string,
	opts: { includeHidden?: boolean } = {}
): Promise<CategorySummary[]> {
	return listCategoriesQuery(db, spaceId, opts);
}

/** The one statement of `listCategories`, also batched by `listCategoriesWithPresets`. */
function listCategoriesQuery(db: Db, spaceId: string, opts: { includeHidden?: boolean }) {
	return db
		.select(columns)
		.from(categories)
		.where(
			and(
				eq(categories.spaceId, spaceId),
				isNull(categories.deletedAt),
				opts.includeHidden ? undefined : eq(categories.isHidden, false)
			)
		)
		.orderBy(
			sql`${categories.kind} = 'income'`,
			asc(categories.sortOrder),
			asc(categories.createdAt),
			asc(categories.id)
		)
		.limit(CATEGORY_LIST_MAX);
}

/** One category of this space (hidden ones included); null for an unknown or other-space id. */
export async function getCategory(
	db: Db,
	spaceId: string,
	categoryId: string
): Promise<CategorySummary | null> {
	const row = await db
		.select(columns)
		.from(categories)
		.where(
			and(
				eq(categories.id, categoryId),
				eq(categories.spaceId, spaceId),
				isNull(categories.deletedAt)
			)
		)
		.get();
	return row ?? null;
}

export type CreateCategoryResult =
	{ ok: true; id: string } | { ok: false; reason: 'limit' | 'gone' };

/** Adds a custom category at the end of its kind's list; refused past MAX_CATEGORIES_PER_SPACE (one guarded insert). */
export async function createCategory(
	db: Db,
	scope: SpaceScope,
	input: CategoryCreate,
	now: number
): Promise<CreateCategoryResult> {
	const { spaceId, userId } = scope;
	const id = newId();
	const [, inserted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.insert(categories)
			.select((qb) =>
				qb
					.select({
						id: sql`${id}`.as('id'),
						spaceId: spaces.id,
						kind: sql`${input.kind}`.as('kind'),
						name: sql`${input.name}`.as('name'),
						tileKey: sql`${input.tileKey}`.as('tile_key'),
						isPreset: sql`0`.as('is_preset'),
						isHidden: sql`0`.as('is_hidden'),
						sortOrder: sql`(select coalesce(max(c.sort_order), -1) + 1 from categories c
							where c.space_id = ${spaceId})`.as('sort_order'),
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
							sql`(select count(*) from categories c where c.space_id = ${spaceId}) < ${MAX_CATEGORIES_PER_SPACE}`
						)
					)
			)
			.returning({ id: categories.id })
	]);
	if (inserted.length === 1) return { ok: true, id };
	const [count] = await db.all<{ n: number }>(
		sql`select count(*) as n from categories where space_id = ${spaceId}`
	);
	return { ok: false, reason: (count?.n ?? 0) >= MAX_CATEGORIES_PER_SPACE ? 'limit' : 'gone' };
}

/**
 * Renames a category and/or changes its tile, only while its `updated_at` is still `expectedUpdatedAt` (a
 * second tab's stale form gets `stale`). Transactions point at the row, so they show the change at once.
 */
export async function updateCategory(
	db: Db,
	scope: SpaceScope,
	categoryId: string,
	input: CategoryEdit,
	expectedUpdatedAt: number,
	now: number
): Promise<CategoryWriteResult> {
	const { spaceId, userId } = scope;
	const [, updated] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(categories)
			.set({
				name: input.name,
				tileKey: input.tileKey,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(categories.id, categoryId),
					eq(categories.spaceId, spaceId),
					isNull(categories.deletedAt),
					eq(categories.updatedAt, expectedUpdatedAt),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: categories.id })
	]);
	if (updated.length === 1) return 'ok';
	return (await getCategory(db, spaceId, categoryId)) ? 'stale' : 'missing';
}

/**
 * Hides or shows a category (idempotent: hiding a hidden one is `ok`). A hidden category leaves the pickers
 * but every transaction using it still shows it. Never deletes anything (owner decision C).
 */
export async function setCategoryHidden(
	db: Db,
	scope: SpaceScope,
	categoryId: string,
	hidden: boolean,
	now: number
): Promise<'ok' | 'missing'> {
	const { spaceId, userId } = scope;
	const [, , row] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(categories)
			.set({
				isHidden: hidden,
				updatedAt: bumpedUpdatedAt(categories.updatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(categories.id, categoryId),
					eq(categories.spaceId, spaceId),
					isNull(categories.deletedAt),
					eq(categories.isHidden, !hidden),
					isLiveMember(spaceId, userId)
				)
			),
		db
			.select({ id: categories.id })
			.from(categories)
			.where(
				and(
					eq(categories.id, categoryId),
					eq(categories.spaceId, spaceId),
					isNull(categories.deletedAt),
					eq(categories.isHidden, hidden),
					isLiveMember(spaceId, userId)
				)
			)
	]);
	return row.length === 1 ? 'ok' : 'missing';
}

/** How an import (FN-18) matches a category: the kind and the name as SQLite `lower()` folds it. */
export const categoryNameKey = (kind: CategoryKind, name: string) =>
	`${kind}:${asciiLowerKey(name)}`;

/**
 * Batch item for an import (FN-18): the new custom categories (`lain` tile, at the end of the list) `newCategories`
 * names, each only while no visible category of that kind has that name (SQLite `lower()`), the membership holds
 * and the space stays within MAX_CATEGORIES_PER_SPACE with all of them (else none is written; the transactions
 * that point at them then fail their own guard and the import's assertion). Place after `bumpSpaceSeq`, before
 * the transactions, in the import's one `db.batch`, so nothing is created when nothing is imported.
 */
export function insertImportedCategories(
	db: Db,
	scope: SpaceScope,
	newCategories: readonly { id: string; kind: CategoryKind; name: string }[],
	now: number
) {
	const { spaceId, userId } = scope;
	const json = JSON.stringify(newCategories);
	const missing = sql`not exists (select 1 from categories c where c.space_id = ${spaceId}
		and c.deleted_at is null and c.is_hidden = 0 and c.kind = json_extract(j.value, '$.kind')
		and lower(c.name) = lower(json_extract(j.value, '$.name')))`;
	return db.insert(categories).select(
		sql`select json_extract(j.value, '$.id'), ${spaceId}, json_extract(j.value, '$.kind'),
			json_extract(j.value, '$.name'), 'lain', 0, 0,
			(select coalesce(max(c.sort_order), -1) + 1 from categories c where c.space_id = ${spaceId}) + j.key,
			${now}, ${now}, null, ${currentSpaceSeq(spaceId)}
		from json_each(${json}) j
		where ${missing} and ${isLiveMember(spaceId, userId)}
			and (select count(*) from categories c where c.space_id = ${spaceId})
				+ (select count(*) from json_each(${json}) j where ${missing}) <= ${MAX_CATEGORIES_PER_SPACE}`
	);
}
