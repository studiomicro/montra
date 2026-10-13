import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { BELONGING_CURRENCY, belongingValue } from '#lib/shared/belongings';
import type { Db } from '../db';
import { belongings, spaces } from '../db/schema';
import { keepKey, releasePhotoKeys, type PhotoChange, type StoredPhoto } from '../photos/store';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { newId } from '../util';
import type { BelongingInput } from './validation';

/** Most live belongings one space holds (Owner decision 5); also the list's row cap. */
export const MAX_BELONGINGS_PER_SPACE = 300;

export interface Belonging {
	id: string;
	name: string;
	purchasePriceMinor: number;
	currency: string;
	purchasedOn: string;
	/** The user's own figure; null = the estimate is shown. */
	currentValueMinor: number | null;
	hasPhoto: boolean;
	note: string | null;
	/** Fictional local-review row (`Data demo`): badged, read-only, never counted in a total. */
	isDemo: boolean;
	createdAt: number;
	updatedAt: number;
}

/**
 * `missing`: no such live belonging in this space (same answer for another space's id). `stale`: changed
 * meanwhile. `demo`: a `Data demo` row, which is read-only (never edited into, or deleted like, a real item).
 */
export type BelongingWriteResult = 'ok' | 'stale' | 'missing' | 'demo';

const live = (spaceId: string) =>
	and(eq(belongings.spaceId, spaceId), isNull(belongings.deletedAt));

const columns = {
	id: belongings.id,
	name: belongings.name,
	purchasePriceMinor: belongings.purchasePriceMinor,
	currency: belongings.currency,
	purchasedOn: belongings.purchasedOn,
	currentValueMinor: belongings.currentValueMinor,
	photoKey: belongings.photoKey,
	note: belongings.note,
	isDemo: belongings.isDemo,
	createdAt: belongings.createdAt,
	updatedAt: belongings.updatedAt
};

type Row = {
	[K in keyof typeof columns]: (typeof columns)[K]['_']['data'] | null;
};

/** A live row (the CHECK guarantees its content columns are set). */
function toBelonging(row: Row): Belonging {
	return {
		id: row.id as string,
		name: row.name as string,
		purchasePriceMinor: row.purchasePriceMinor as number,
		currency: row.currency as string,
		purchasedOn: row.purchasedOn as string,
		currentValueMinor: row.currentValueMinor,
		hasPhoto: row.photoKey !== null,
		note: row.note,
		isDemo: row.isDemo === true,
		createdAt: row.createdAt as number,
		updatedAt: row.updatedAt as number
	};
}

/** The space's live belongings, newest first; bounded by MAX_BELONGINGS_PER_SPACE (the creation cap). */
export async function listBelongings(db: Db, spaceId: string): Promise<Belonging[]> {
	const rows = await db
		.select(columns)
		.from(belongings)
		.where(live(spaceId))
		.orderBy(desc(belongings.createdAt), desc(belongings.id))
		.limit(MAX_BELONGINGS_PER_SPACE);
	return rows.map(toBelonging);
}

/** One live belonging of this space; null for an unknown, deleted or other-space id. */
export async function getBelonging(db: Db, spaceId: string, id: string): Promise<Belonging | null> {
	const row = await db
		.select(columns)
		.from(belongings)
		.where(and(eq(belongings.id, id), live(spaceId)))
		.get();
	return row ? toBelonging(row) : null;
}

/** The value total per currency; null when a sum is past the safe integer range ("too large", never rounded). */
export type BelongingsTotal = { currency: string; totalMinor: number | null; estimated: boolean }[];

/**
 * Σ of each item's value (`current_value_minor ?? estimatedValueMinor(...)` as of `today`, WIB), grouped by
 * currency, exact (BigInt). `estimated` is true when any item in the sum counts with its estimate. `Data demo`
 * rows are left out.
 */
export function totalsOf(items: readonly Belonging[], today: string): BelongingsTotal {
	const sums = new Map<string, { total: bigint; estimated: boolean }>();
	for (const item of items) {
		if (item.isDemo) continue;
		const { valueMinor, estimated } = belongingValue(item, today);
		const sum = sums.get(item.currency) ?? { total: 0n, estimated: false };
		sums.set(item.currency, {
			total: sum.total + BigInt(valueMinor),
			estimated: sum.estimated || estimated
		});
	}
	return [...sums].map(([currency, { total, estimated }]) => ({
		currency,
		totalMinor: total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null,
		estimated
	}));
}

/** The space's belongings total as of `today` (the same rows the /barang list shows). */
export async function belongingsTotal(
	db: Db,
	spaceId: string,
	today: string
): Promise<BelongingsTotal> {
	return totalsOf(await listBelongings(db, spaceId), today);
}

/**
 * The photo of a live belonging, only when `userId` is still a live member of its space (checked in the same
 * statement as the read). Null otherwise: one answer for every reason.
 */
export async function getBelongingPhoto(
	db: Db,
	scope: SpaceScope,
	id: string
): Promise<StoredPhoto | null> {
	const row = await db
		.select({ key: belongings.photoKey, type: belongings.photoType })
		.from(belongings)
		.where(
			and(
				eq(belongings.id, id),
				live(scope.spaceId),
				isNotNull(belongings.photoKey),
				isLiveMember(scope.spaceId, scope.userId)
			)
		)
		.get();
	return row?.key && row.type ? { key: row.key, type: row.type } : null;
}

/** The space a belonging id belongs to ('' when unknown): only ever passed on to requireSpaceAccess. */
export async function belongingSpaceId(db: Db, id: string): Promise<string> {
	const row = await db
		.select({ spaceId: belongings.spaceId })
		.from(belongings)
		.where(eq(belongings.id, id.slice(0, 64)))
		.get();
	return row?.spaceId ?? '';
}

const nextUpdatedAt = (expected: number, now: number) => Math.max(now, expected + 1);

export type CreateBelongingResult =
	{ ok: true; id: string } | { ok: false; reason: 'limit' | 'gone' };

/**
 * Creates a belonging (IDR), with its already-written photo when given. One guarded insert: refused past
 * MAX_BELONGINGS_PER_SPACE live items or when the writer is no longer a member, so concurrent creates cannot
 * pass the cap. The photo's reserved deletion is dropped in the same batch only when the row now holds it.
 */
export async function createBelonging(
	db: Db,
	scope: SpaceScope,
	input: BelongingInput,
	photo: StoredPhoto | null,
	now: number
): Promise<CreateBelongingResult> {
	const { spaceId, userId } = scope;
	const id = newId();
	const insert = db
		.insert(belongings)
		.select((qb) =>
			qb
				.select({
					id: sql`${id}`.as('id'),
					spaceId: spaces.id,
					name: sql`${input.name}`.as('name'),
					purchasePriceMinor: sql`${input.purchasePriceMinor}`.as('purchase_price_minor'),
					currency: sql`${BELONGING_CURRENCY}`.as('currency'),
					purchasedOn: sql`${input.purchasedOn}`.as('purchased_on'),
					currentValueMinor: sql`${input.currentValueMinor}`.as('current_value_minor'),
					photoKey: sql`${photo?.key ?? null}`.as('photo_key'),
					photoType: sql`${photo?.type ?? null}`.as('photo_type'),
					note: sql`${input.note}`.as('note'),
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
						sql`(select count(*) from belongings b where b.space_id = ${spaceId}
							and b.deleted_at is null) < ${MAX_BELONGINGS_PER_SPACE}`
					)
				)
		)
		.returning({ id: belongings.id });
	const [, inserted] = photo
		? await db.batch([
				bumpSpaceSeq(db, spaceId),
				insert,
				keepKey(db, photo.key, holds(id, photo.key))
			])
		: await db.batch([bumpSpaceSeq(db, spaceId), insert]);
	if (inserted.length === 1) return { ok: true, id };
	const [count] = await db.all<{ n: number }>(
		sql`select count(*) as n from belongings where space_id = ${spaceId} and deleted_at is null`
	);
	return { ok: false, reason: (count?.n ?? 0) >= MAX_BELONGINGS_PER_SPACE ? 'limit' : 'gone' };
}

/** SQL: the belonging `id` now holds `key` (evaluated after the row write in the same batch). */
const holds = (id: string, key: string) =>
	sql`exists (select 1 from belongings b where b.id = ${id} and b.photo_key = ${key})`;

/**
 * After a guarded write changed nothing: `demo` for a live `Data demo` row of this space, `stale` for another
 * live belonging of this space, else `missing`.
 */
async function whyNot(db: Db, spaceId: string, id: string): Promise<BelongingWriteResult> {
	const row = await db
		.select({ isDemo: belongings.isDemo })
		.from(belongings)
		.where(and(eq(belongings.id, id), live(spaceId)))
		.get();
	return row ? (row.isDemo ? 'demo' : 'stale') : 'missing';
}

/**
 * The guarded tail of every write: this live, real (not `Data demo`) belonging of this space, `updated_at` still
 * `expectedUpdatedAt` (the value the form was loaded with, so a second tab's stale submission is refused), the
 * writer still a member.
 */
const writable = (scope: SpaceScope, id: string, expectedUpdatedAt: number) =>
	and(
		eq(belongings.id, id),
		live(scope.spaceId),
		eq(belongings.isDemo, false),
		eq(belongings.updatedAt, expectedUpdatedAt),
		isLiveMember(scope.spaceId, scope.userId)
	);

export interface WriteOutcome {
	result: BelongingWriteResult;
	/** Photo keys this write stopped using: delete them now (photos/store.ts cleanUpFiles). */
	released: string[];
}

/** Saves the edit form of a live belonging and applies `photo`; `stale` when it changed since the form loaded. */
export async function updateBelonging(
	db: Db,
	scope: SpaceScope,
	id: string,
	input: BelongingInput,
	photo: PhotoChange,
	expectedUpdatedAt: number,
	now: number
): Promise<WriteOutcome> {
	const guard = writable(scope, id, expectedUpdatedAt);
	const photoColumns =
		photo.kind === 'keep'
			? {}
			: photo.kind === 'remove'
				? { photoKey: null, photoType: null }
				: { photoKey: photo.key, photoType: photo.type };
	const update = db
		.update(belongings)
		.set({
			name: input.name,
			purchasePriceMinor: input.purchasePriceMinor,
			purchasedOn: input.purchasedOn,
			currentValueMinor: input.currentValueMinor,
			note: input.note,
			...photoColumns,
			updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
			seq: currentSpaceSeq(scope.spaceId)
		})
		.where(guard)
		.returning({ id: belongings.id });
	let released: { key: string }[] = [];
	let updated: { id: string }[];
	if (photo.kind === 'keep') {
		[, updated] = await db.batch([bumpSpaceSeq(db, scope.spaceId), update]);
	} else if (photo.kind === 'remove') {
		[, released, updated] = await db.batch([
			bumpSpaceSeq(db, scope.spaceId),
			releasePhotoKeys(db, belongings, guard, now),
			update
		]);
	} else {
		[, released, updated] = await db.batch([
			bumpSpaceSeq(db, scope.spaceId),
			releasePhotoKeys(db, belongings, guard, now),
			update,
			keepKey(db, photo.key, holds(id, photo.key))
		]);
	}
	return {
		result: updated.length === 1 ? 'ok' : await whyNot(db, scope.spaceId, id),
		released: released.map((r) => r.key)
	};
}

/**
 * Deletes a live belonging: a content-free tombstone (name, amounts, date, note and the photo key all cleared,
 * CHECK-enforced) in the same batch that moves its photo key to the deletion outbox. From then on nothing
 * serves that photo, whatever happens to the R2 delete.
 */
export async function archiveBelonging(
	db: Db,
	scope: SpaceScope,
	id: string,
	expectedUpdatedAt: number,
	now: number
): Promise<WriteOutcome> {
	const guard = writable(scope, id, expectedUpdatedAt);
	const [, released, archived] = await db.batch([
		bumpSpaceSeq(db, scope.spaceId),
		releasePhotoKeys(db, belongings, guard, now),
		db
			.update(belongings)
			.set({
				name: null,
				purchasePriceMinor: null,
				purchasedOn: null,
				currentValueMinor: null,
				photoKey: null,
				photoType: null,
				note: null,
				createdAt: null,
				deletedAt: now,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(scope.spaceId)
			})
			.where(guard)
			.returning({ id: belongings.id })
	]);
	return {
		result: archived.length === 1 ? 'ok' : await whyNot(db, scope.spaceId, id),
		released: released.map((r) => r.key)
	};
}
