import { error } from '@sveltejs/kit';
import { and, asc, eq, isNotNull, lte, sql, type SQL } from 'drizzle-orm';
import type { JobMessage } from '#lib/shared/jobs';
import type { PhotoType } from '#lib/shared/photos';
import type { Db } from '../db';
import { belongings, collectibles, fileDeletions, transactions } from '../db/schema';
import { errorLabel, sha256Hex } from '../util';
import type { SanitizedImage } from './image';

/**
 * Photos the user keeps, in the `FILES` R2 bucket (FN-27 belongings, FN-28 collectibles, FN-15 receipt photos
 * kept with a transaction). The bucket
 * has no public access: a photo is read only through a route that checked space membership first
 * (`photoResponse`). Object keys are `spaces/<space_id>/<kind>/<random uuid>`: never a user-supplied name,
 * never guessable, namespaced by space so a purge can find them.
 *
 * Every key this app writes or stops using passes through `file_deletions`, so a failed or interrupted R2 call
 * never leaves an object nobody will delete:
 * 1. `reservePhotoKey` records the new key as due for deletion UPLOAD_GRACE_MS from now, then the object is
 *    written (`putPhoto`).
 * 2. The D1 batch that stores the key on its row also deletes that record (`keepKey`); a batch that changes
 *    nothing leaves it, and `deleteFiles` removes the object.
 * 3. A batch that stops referencing a key (tombstone, replace, remove, space purge) inserts it as due now, and
 *    the caller removes it right after (`cleanUpFiles`); a failure there is retried through the jobs queue and
 *    the hourly cron (`sweepFileDeletions`).
 */
export type PhotoKind = 'belongings' | 'collectibles' | 'receipts';
/** The tables whose rows hold a photo key (one per PhotoKind). */
export type PhotoTable = typeof belongings | typeof collectibles | typeof transactions;

/** A photo to store with a row write: its reserved key and sniffed type. */
export interface StoredPhoto {
	key: string;
	type: PhotoType;
}
/** What an edit does to a row's photo. */
export type PhotoChange =
	{ kind: 'keep' } | { kind: 'remove' } | ({ kind: 'replace' } & StoredPhoto);

/** How long a reserved upload key waits before the sweep may delete its object (an upload takes seconds). */
export const UPLOAD_GRACE_MS = 15 * 60 * 1000;
/** Most keys one delete call or sweep handles (R2 deletes up to 1000 keys per call). */
export const FILE_DELETE_BATCH = 100;

export const newPhotoKey = (spaceId: string, kind: PhotoKind): string =>
	`spaces/${spaceId}/${kind}/${crypto.randomUUID()}`;

/**
 * An Agen report file's key (FN-23): `spaces/<space_id>/agent/<run_id>/<uuid>.<ext>`, built from ids and a fixed
 * extension only, never request text. It passes the same outbox as photos (`reservePhotoKey`, `keepKey`).
 */
export const newAgentFileKey = (spaceId: string, runId: string, ext: 'csv' | 'html'): string =>
	`spaces/${spaceId}/agent/${runId}/${crypto.randomUUID()}.${ext}`;

/**
 * How many live rows of `spaceId` hold a stored photo, per kind (FN-42 "Pemakaian"; FN-15 receipt photos kept
 * with a transaction). A row's `photo_key` is the one proof it holds an R2 object; three counts in one statement. Call only after `requireSpaceAccess`.
 */
export async function countStoredPhotos(
	db: Db,
	spaceId: string
): Promise<Record<PhotoKind, number>> {
	const [row] = await db.all<Record<PhotoKind, number>>(sql`select
		(select count(*) from belongings where space_id = ${spaceId} and deleted_at is null
			and photo_key is not null) as belongings,
		(select count(*) from collectibles where space_id = ${spaceId} and deleted_at is null
			and photo_key is not null) as collectibles,
		(select count(*) from transactions where space_id = ${spaceId} and deleted_at is null
			and photo_key is not null) as receipts`);
	return {
		belongings: row?.belongings ?? 0,
		collectibles: row?.collectibles ?? 0,
		receipts: row?.receipts ?? 0
	};
}

/** Step 1: the key is recorded before its object exists, so a crash after the R2 write still gets it deleted. */
export async function reservePhotoKey(db: Db, key: string, now: number): Promise<void> {
	await db.insert(fileDeletions).values({ key, dueAt: now + UPLOAD_GRACE_MS, attempts: 0 });
}

export async function putPhoto(
	bucket: R2Bucket,
	key: string,
	image: SanitizedImage
): Promise<void> {
	await bucket.put(key, image.bytes, { httpMetadata: { contentType: image.type } });
}

/**
 * Batch item for step 2: forget the reserved key, only once `referenced` (a condition evaluated after the row
 * update in the same batch) shows a row now holds it.
 */
export function keepKey(db: Db, key: string, referenced: SQL) {
	return db.delete(fileDeletions).where(and(eq(fileDeletions.key, key), referenced));
}

/**
 * Batch item, placed before the write that stops using the keys: the photo key of every `table` row matching
 * `where` goes to the deletion outbox, due `now`. Used for a tombstone, a removed or replaced photo (`where` is
 * the write's own guard, so a refused write releases nothing) and a space purge. Returns the keys it released.
 */
export function releasePhotoKeys(db: Db, table: PhotoTable, where: SQL | undefined, now: number) {
	return db
		.insert(fileDeletions)
		.select((qb) =>
			qb
				.select({
					key: sql`${table.photoKey}`.as('key'),
					dueAt: sql`${now}`.as('due_at'),
					attempts: sql`0`.as('attempts')
				})
				.from(table)
				.where(and(where, isNotNull(table.photoKey)))
		)
		.onConflictDoNothing()
		.returning({ key: fileDeletions.key });
}

/**
 * Deletes the objects `keys` (at most FILE_DELETE_BATCH) and then their outbox rows. The rows are first marked
 * due now with one more attempt, so if R2 fails they wait for the next sweep. Idempotent: deleting a missing
 * object succeeds. Throws when R2 fails.
 */
async function deleteFiles(
	db: Db,
	bucket: R2Bucket,
	keys: readonly string[],
	now: number
): Promise<void> {
	const batch = keys.slice(0, FILE_DELETE_BATCH);
	if (batch.length === 0) return;
	const list = JSON.stringify(batch);
	const among = sql`${fileDeletions.key} in (select value from json_each(${list}))`;
	await db
		.update(fileDeletions)
		.set({ dueAt: now, attempts: sql`${fileDeletions.attempts} + 1` })
		.where(among);
	await bucket.delete([...batch]);
	await db.delete(fileDeletions).where(among);
}

/**
 * The objects whose deletion is due (oldest first, at most `limit`), deleted. Keys a live row still holds
 * (never expected; photo rows and FN-23 report runs) are only dropped from the outbox, never deleted from R2.
 * Returns how many were handled.
 */
export async function sweepFileDeletions(
	db: Db,
	bucket: R2Bucket,
	now: number,
	limit: number = FILE_DELETE_BATCH
): Promise<number> {
	const referenced = sql`(exists (select 1 from belongings b where b.photo_key = ${fileDeletions.key})
		or exists (select 1 from collectibles c where c.photo_key = ${fileDeletions.key})
		or exists (select 1 from transactions t where t.photo_key = ${fileDeletions.key})
		or exists (select 1 from agent_runs a where a.csv_key = ${fileDeletions.key})
		or exists (select 1 from agent_runs a where a.html_key = ${fileDeletions.key}))`;
	await db.delete(fileDeletions).where(and(lte(fileDeletions.dueAt, now), referenced));
	const due = await db
		.select({ key: fileDeletions.key })
		.from(fileDeletions)
		.where(lte(fileDeletions.dueAt, now))
		.orderBy(asc(fileDeletions.dueAt), asc(fileDeletions.key))
		.limit(Math.min(limit, FILE_DELETE_BATCH));
	await deleteFiles(
		db,
		bucket,
		due.map((d) => d.key),
		now
	);
	return due.length;
}

/**
 * After a write that let go of `keys`: delete them now; when that fails (R2 or D1 down), log without the keys
 * and ask the jobs Worker to retry (`file_sweep`); the hourly cron is the last resort. Never throws: the D1 write
 * already succeeded and is what the user sees.
 */
export async function cleanUpFiles(
	env: { FILES: R2Bucket; JOBS_QUEUE: Queue },
	db: Db,
	keys: readonly string[],
	now: number
): Promise<void> {
	if (keys.length === 0) return;
	try {
		await deleteFiles(db, env.FILES, keys, now);
	} catch (e) {
		console.warn('photos: delete failed, queued for retry', errorLabel(e));
		try {
			await env.JOBS_QUEUE.send({ type: 'file_sweep' } satisfies JobMessage);
		} catch (q) {
			console.warn('photos: retry not queued, left to the cron sweep', errorLabel(q));
		}
	}
}

/**
 * After a write that let go of keys it does not list (a space purge): sweep what is due now, and ask the jobs
 * Worker to carry on when a full batch was handled or the sweep failed. Never throws.
 */
export async function sweepSoon(
	env: { FILES: R2Bucket; JOBS_QUEUE: Queue },
	db: Db,
	now: number
): Promise<void> {
	let more: boolean;
	try {
		more = (await sweepFileDeletions(db, env.FILES, now)) >= FILE_DELETE_BATCH;
	} catch (e) {
		console.warn('photos: sweep failed, queued for retry', errorLabel(e));
		more = true;
	}
	if (!more) return;
	try {
		await env.JOBS_QUEUE.send({ type: 'file_sweep' } satisfies JobMessage);
	} catch (q) {
		console.warn('photos: sweep not queued, left to the cron sweep', errorLabel(q));
	}
}

/** Content Security Policy of a served photo: nothing in it may run, load or be framed. */
const PHOTO_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";

/**
 * The response for a stored photo the caller already checked access to. Content-Type is the type sniffed and
 * stored at upload, never what R2 or the client says; `nosniff`, `inline`, `private, no-cache` (revalidated with
 * the ETag on every view, so a removed member's browser cannot reuse it without asking) and a script-free CSP.
 * A missing object answers exactly like a missing row.
 */
export async function photoResponse(
	bucket: R2Bucket,
	key: string,
	type: PhotoType,
	request: Request
): Promise<Response> {
	const etag = `"${(await sha256Hex(key)).slice(0, 32)}"`;
	const headers = new Headers({
		'content-type': type,
		'x-content-type-options': 'nosniff',
		'content-disposition': 'inline',
		'cache-control': 'private, no-cache',
		'content-security-policy': PHOTO_CSP,
		'cross-origin-resource-policy': 'same-origin',
		etag
	});
	if (request.headers.get('if-none-match') === etag)
		return new Response(null, { status: 304, headers });
	const object = await bucket.get(key);
	if (!object) error(404, 'Not found');
	headers.set('content-length', String(object.size));
	return new Response(object.body, { headers });
}
