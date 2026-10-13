import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { COLLECTIBLE_CURRENCY, collectibleGainMinor } from '#lib/shared/collectibles';
import type { Db } from '../db';
import { collectibles, spaces } from '../db/schema';
import { keepKey, releasePhotoKeys, type PhotoChange, type StoredPhoto } from '../photos/store';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { newId } from '../util';
import type { CollectibleInput } from './validation';

/** Most live collectibles one space holds (PRD Owner decision 4, matching belongings); also the list's row cap. */
export const MAX_COLLECTIBLES_PER_SPACE = 300;

export interface Collectible {
	id: string;
	name: string;
	purchasePriceMinor: number;
	currency: string;
	purchasedOn: string;
	/** The current value: the user's own figure (no automated price source is wired, FN-28 decision). */
	valueMinor: number;
	/** `valueMinor − purchasePriceMinor`, exact; negative is a loss. */
	gainMinor: number;
	hasPhoto: boolean;
	note: string | null;
	/** Fictional local-review row (`Data demo`): badged, never counted in a total. */
	isDemo: boolean;
	createdAt: number;
	updatedAt: number;
}

/**
 * `missing`: no such live collectible in this space (same answer for another space's id). `stale`: changed
 * meanwhile. `demo`: a `Data demo` row, which is read-only (never edited into, or deleted like, a real item).
 */
export type CollectibleWriteResult = 'ok' | 'stale' | 'missing' | 'demo';

const live = (spaceId: string) =>
	and(eq(collectibles.spaceId, spaceId), isNull(collectibles.deletedAt));

const columns = {
	id: collectibles.id,
	name: collectibles.name,
	purchasePriceMinor: collectibles.purchasePriceMinor,
	currency: collectibles.currency,
	purchasedOn: collectibles.purchasedOn,
	manualValueMinor: collectibles.manualValueMinor,
	photoKey: collectibles.photoKey,
	note: collectibles.note,
	isDemo: collectibles.isDemo,
	createdAt: collectibles.createdAt,
	updatedAt: collectibles.updatedAt
};

type Row = {
	[K in keyof typeof columns]: (typeof columns)[K]['_']['data'] | null;
};

/** A live row (the CHECK guarantees its content columns are set). */
function toCollectible(row: Row): Collectible {
	const purchasePriceMinor = row.purchasePriceMinor as number;
	const valueMinor = row.manualValueMinor as number;
	return {
		id: row.id as string,
		name: row.name as string,
		purchasePriceMinor,
		currency: row.currency as string,
		purchasedOn: row.purchasedOn as string,
		valueMinor,
		gainMinor: collectibleGainMinor({ valueMinor, purchasePriceMinor }),
		hasPhoto: row.photoKey !== null,
		note: row.note,
		isDemo: row.isDemo === true,
		createdAt: row.createdAt as number,
		updatedAt: row.updatedAt as number
	};
}

/** The space's live collectibles, newest first; bounded by MAX_COLLECTIBLES_PER_SPACE (the creation cap). */
export async function listCollectibles(db: Db, spaceId: string): Promise<Collectible[]> {
	const rows = await db
		.select(columns)
		.from(collectibles)
		.where(live(spaceId))
		.orderBy(desc(collectibles.createdAt), desc(collectibles.id))
		.limit(MAX_COLLECTIBLES_PER_SPACE);
	return rows.map(toCollectible);
}

/**
 * The value and gain totals per currency of the real (non-demo) items; a null figure is past the safe integer
 * range ("too large", never rounded).
 */
export type CollectiblesTotal = {
	currency: string;
	valueMinor: number | null;
	gainMinor: number | null;
}[];

const safe = (n: bigint) =>
	n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;

/** Σ value and Σ gain of the listed items, grouped by currency, exact (BigInt); `Data demo` rows left out. */
export function collectiblesTotalsOf(items: readonly Collectible[]): CollectiblesTotal {
	const sums = new Map<string, { value: bigint; gain: bigint }>();
	for (const item of items) {
		if (item.isDemo) continue;
		const sum = sums.get(item.currency) ?? { value: 0n, gain: 0n };
		sums.set(item.currency, {
			value: sum.value + BigInt(item.valueMinor),
			gain: sum.gain + BigInt(item.gainMinor)
		});
	}
	return [...sums].map(([currency, { value, gain }]) => ({
		currency,
		valueMinor: safe(value),
		gainMinor: safe(gain)
	}));
}

/** The space's collectibles total (the same rows the /koleksi list shows). */
export async function collectiblesTotal(db: Db, spaceId: string): Promise<CollectiblesTotal> {
	return collectiblesTotalsOf(await listCollectibles(db, spaceId));
}

/**
 * The photo of a live collectible, only when `userId` is still a live member of its space (checked in the same
 * statement as the read). Null otherwise: one answer for every reason.
 */
export async function getCollectiblePhoto(
	db: Db,
	scope: SpaceScope,
	id: string
): Promise<StoredPhoto | null> {
	const row = await db
		.select({ key: collectibles.photoKey, type: collectibles.photoType })
		.from(collectibles)
		.where(
			and(
				eq(collectibles.id, id),
				live(scope.spaceId),
				isNotNull(collectibles.photoKey),
				isLiveMember(scope.spaceId, scope.userId)
			)
		)
		.get();
	return row?.key && row.type ? { key: row.key, type: row.type } : null;
}

/** The space a collectible id belongs to ('' when unknown): only ever passed on to requireSpaceAccess. */
export async function collectibleSpaceId(db: Db, id: string): Promise<string> {
	const row = await db
		.select({ spaceId: collectibles.spaceId })
		.from(collectibles)
		.where(eq(collectibles.id, id.slice(0, 64)))
		.get();
	return row?.spaceId ?? '';
}

const nextUpdatedAt = (expected: number, now: number) => Math.max(now, expected + 1);

export type CreateCollectibleResult =
	{ ok: true; id: string } | { ok: false; reason: 'limit' | 'gone' };

/**
 * Creates a collectible (IDR, never `Data demo`), with its already-written photo when given. One guarded
 * insert: refused past MAX_COLLECTIBLES_PER_SPACE live items or when the writer is no longer a member, so
 * concurrent creates cannot pass the cap. The photo's reserved deletion is dropped in the same batch only when
 * the row now holds it.
 */
export async function createCollectible(
	db: Db,
	scope: SpaceScope,
	input: CollectibleInput,
	photo: StoredPhoto | null,
	now: number
): Promise<CreateCollectibleResult> {
	const { spaceId, userId } = scope;
	const id = newId();
	const insert = db
		.insert(collectibles)
		.select((qb) =>
			qb
				.select({
					id: sql`${id}`.as('id'),
					spaceId: spaces.id,
					name: sql`${input.name}`.as('name'),
					purchasePriceMinor: sql`${input.purchasePriceMinor}`.as('purchase_price_minor'),
					currency: sql`${COLLECTIBLE_CURRENCY}`.as('currency'),
					purchasedOn: sql`${input.purchasedOn}`.as('purchased_on'),
					manualValueMinor: sql`${input.manualValueMinor}`.as('manual_value_minor'),
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
						sql`(select count(*) from collectibles c where c.space_id = ${spaceId}
							and c.deleted_at is null) < ${MAX_COLLECTIBLES_PER_SPACE}`
					)
				)
		)
		.returning({ id: collectibles.id });
	const [, inserted] = photo
		? await db.batch([
				bumpSpaceSeq(db, spaceId),
				insert,
				keepKey(db, photo.key, holds(id, photo.key))
			])
		: await db.batch([bumpSpaceSeq(db, spaceId), insert]);
	if (inserted.length === 1) return { ok: true, id };
	const [count] = await db.all<{ n: number }>(
		sql`select count(*) as n from collectibles where space_id = ${spaceId} and deleted_at is null`
	);
	return { ok: false, reason: (count?.n ?? 0) >= MAX_COLLECTIBLES_PER_SPACE ? 'limit' : 'gone' };
}

/** SQL: the collectible `id` now holds `key` (evaluated after the row write in the same batch). */
const holds = (id: string, key: string) =>
	sql`exists (select 1 from collectibles c where c.id = ${id} and c.photo_key = ${key})`;

/**
 * After a guarded write changed nothing: `demo` for a live `Data demo` row of this space, `stale` for another
 * live collectible of this space, else `missing`.
 */
async function whyNot(db: Db, spaceId: string, id: string): Promise<CollectibleWriteResult> {
	const row = await db
		.select({ isDemo: collectibles.isDemo })
		.from(collectibles)
		.where(and(eq(collectibles.id, id), live(spaceId)))
		.get();
	return row ? (row.isDemo ? 'demo' : 'stale') : 'missing';
}

/**
 * The guarded tail of every write: this live, real (not `Data demo`) collectible of this space, `updated_at`
 * still `expectedUpdatedAt` (the value the form was loaded with, so a second tab's stale submission is
 * refused), the writer still a member.
 */
const writable = (scope: SpaceScope, id: string, expectedUpdatedAt: number) =>
	and(
		eq(collectibles.id, id),
		live(scope.spaceId),
		eq(collectibles.isDemo, false),
		eq(collectibles.updatedAt, expectedUpdatedAt),
		isLiveMember(scope.spaceId, scope.userId)
	);

export interface WriteOutcome {
	result: CollectibleWriteResult;
	/** Photo keys this write stopped using: delete them now (photos/store.ts cleanUpFiles). */
	released: string[];
}

/** Saves the edit form of a live collectible and applies `photo`; `stale` when it changed since the form loaded. */
export async function updateCollectible(
	db: Db,
	scope: SpaceScope,
	id: string,
	input: CollectibleInput,
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
		.update(collectibles)
		.set({
			name: input.name,
			purchasePriceMinor: input.purchasePriceMinor,
			purchasedOn: input.purchasedOn,
			manualValueMinor: input.manualValueMinor,
			note: input.note,
			...photoColumns,
			updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
			seq: currentSpaceSeq(scope.spaceId)
		})
		.where(guard)
		.returning({ id: collectibles.id });
	let released: { key: string }[] = [];
	let updated: { id: string }[];
	if (photo.kind === 'keep') {
		[, updated] = await db.batch([bumpSpaceSeq(db, scope.spaceId), update]);
	} else if (photo.kind === 'remove') {
		[, released, updated] = await db.batch([
			bumpSpaceSeq(db, scope.spaceId),
			releasePhotoKeys(db, collectibles, guard, now),
			update
		]);
	} else {
		[, released, updated] = await db.batch([
			bumpSpaceSeq(db, scope.spaceId),
			releasePhotoKeys(db, collectibles, guard, now),
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
 * Deletes a live collectible: a content-free tombstone (name, amounts, date, note and the photo key all
 * cleared, CHECK-enforced) in the same batch that moves its photo key to the deletion outbox. From then on
 * nothing serves that photo, whatever happens to the R2 delete.
 */
export async function archiveCollectible(
	db: Db,
	scope: SpaceScope,
	id: string,
	expectedUpdatedAt: number,
	now: number
): Promise<WriteOutcome> {
	const guard = writable(scope, id, expectedUpdatedAt);
	const [, released, archived] = await db.batch([
		bumpSpaceSeq(db, scope.spaceId),
		releasePhotoKeys(db, collectibles, guard, now),
		db
			.update(collectibles)
			.set({
				name: null,
				purchasePriceMinor: null,
				purchasedOn: null,
				manualValueMinor: null,
				photoKey: null,
				photoType: null,
				note: null,
				createdAt: null,
				deletedAt: now,
				updatedAt: nextUpdatedAt(expectedUpdatedAt, now),
				seq: currentSpaceSeq(scope.spaceId)
			})
			.where(guard)
			.returning({ id: collectibles.id })
	]);
	return {
		result: archived.length === 1 ? 'ok' : await whyNot(db, scope.spaceId, id),
		released: released.map((r) => r.key)
	};
}
