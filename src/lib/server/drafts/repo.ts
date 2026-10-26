import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { wibDateString, wibTodayString } from '#lib/shared/dates';
import { selectionKind, type DraftFlag, type DraftSource } from '#lib/shared/drafts';
import type { CategoryKind, CategorySource } from '#lib/shared/transactions';
import { ensurePresetCategories, getCategory, listCategories } from '../categories/repo';
import type { Db } from '../db';
import { batchAssert, isBatchAssertFailure } from '../db/assert';
import { drafts } from '../db/schema';
import { learnFromCorrections } from '../merchants/learn';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, bumpSpaceSeqsWhere, currentSpaceSeq } from '../sync/seq';
import {
	insertTransactions,
	transactionCapReached,
	type NewTransaction
} from '../transactions/repo';
import { capturedTransactionInput } from '../transactions/validation';
import { isUniqueViolation, newId } from '../util';
import { getWallet, listWallets } from '../wallets/repo';
import type { DraftRef } from './validation';
import { bumpedUpdatedAt } from '../sync/updated-at';

/** Most pending drafts one page lists (the header still counts all of them). */
const DRAFT_LIST_MAX = 100;
/**
 * Most pending drafts one space holds (tombstones do not count). Every drafts insert repeats it in its own
 * statement, counting the rows it adds, so a flood of captures is refused whole at the cap, never grown past it.
 */
export const MAX_DRAFTS_PER_SPACE = 1000;

/** SQL condition: the space stays within MAX_DRAFTS_PER_SPACE pending drafts with `adding` more. */
export const draftsUnderCap = (spaceId: string, adding: number) =>
	sql`(select count(*) from drafts d where d.space_id = ${spaceId} and d.deleted_at is null) + ${adding}
		<= ${MAX_DRAFTS_PER_SPACE}`;

/** One pending (live) draft as the inbox and the review screen show it. */
export interface PendingDraft {
	id: string;
	type: CategoryKind;
	amountMinor: number;
	currency: string;
	title: string | null;
	note: string | null;
	categoryId: string | null;
	walletId: string | null;
	occurredOn: string;
	occurredAt: number;
	source: DraftSource;
	flag: DraftFlag | null;
	isDemo: boolean;
	updatedAt: number;
}

/** A pending draft with its dedupe key (server-side only: the save copies it onto the transaction). */
interface DraftRow extends PendingDraft {
	dedupeKey: string | null;
	/** FN-48: `user` once a member set its category with "Atur kategori" (copied onto the transaction). */
	categorySource: CategorySource | null;
}

const columns = {
	id: drafts.id,
	type: drafts.type,
	amountMinor: drafts.amountMinor,
	currency: drafts.currency,
	title: drafts.title,
	note: drafts.note,
	categoryId: drafts.categoryId,
	walletId: drafts.walletId,
	occurredOn: drafts.occurredOn,
	occurredAt: drafts.occurredAt,
	source: drafts.source,
	dedupeKey: drafts.dedupeKey,
	flag: drafts.flag,
	isDemo: drafts.isDemo,
	updatedAt: drafts.updatedAt,
	categorySource: drafts.categorySource
};

type Content = 'amountMinor' | 'currency' | 'occurredOn' | 'occurredAt';
type Selected = Omit<DraftRow, Content> & { [K in Content]: DraftRow[K] | null };

/** A live row always has its content (`drafts_content_check`); only tombstones carry nulls. */
function live(row: Selected): DraftRow | null {
	const { amountMinor, currency, occurredOn, occurredAt } = row;
	if (amountMinor === null || !currency || !occurredOn || occurredAt === null) return null;
	return { ...row, amountMinor, currency, occurredOn, occurredAt };
}

/** What the pages get: everything but the dedupe key. */
function view(row: DraftRow): PendingDraft {
	return {
		id: row.id,
		type: row.type,
		amountMinor: row.amountMinor,
		currency: row.currency,
		title: row.title,
		note: row.note,
		categoryId: row.categoryId,
		walletId: row.walletId,
		occurredOn: row.occurredOn,
		occurredAt: row.occurredAt,
		source: row.source,
		flag: row.flag,
		isDemo: row.isDemo,
		updatedAt: row.updatedAt
	};
}

const pending = (spaceId: string) => and(eq(drafts.spaceId, spaceId), isNull(drafts.deletedAt));

/** The space's pending drafts, newest WIB day first, at most DRAFT_LIST_MAX. */
export async function listPendingDrafts(db: Db, spaceId: string): Promise<PendingDraft[]> {
	const rows = await db
		.select(columns)
		.from(drafts)
		.where(pending(spaceId))
		.orderBy(desc(drafts.occurredOn), desc(drafts.occurredAt), desc(drafts.id))
		.limit(DRAFT_LIST_MAX);
	return rows.flatMap((r) => {
		const row = live(r);
		return row ? [view(row)] : [];
	});
}

/** How many drafts of the space are pending (counted in SQL, never by loading them). */
export async function countPendingDrafts(db: Db, spaceId: string): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)` })
		.from(drafts)
		.where(pending(spaceId));
	return row?.n ?? 0;
}

/**
 * The pending drafts of the space among `ids` (bound once as JSON). An id that is unknown, already saved or
 * discarded, or of another space finds nothing: every action treats all of them the same.
 */
export async function getDrafts(
	db: Db,
	spaceId: string,
	ids: readonly string[]
): Promise<DraftRow[]> {
	if (ids.length === 0) return [];
	const rows = await db
		.select(columns)
		.from(drafts)
		.where(
			and(pending(spaceId), sql`drafts.id in (select value from json_each(${JSON.stringify(ids)}))`)
		)
		.limit(ids.length);
	return rows.flatMap((r) => live(r) ?? []);
}

/** The columns a draft keeps none of once discarded or saved (content-free tombstone, like transactions). */
const tombstone = (spaceId: string | SQL, now: number) => ({
	deletedAt: now,
	amountMinor: null,
	currency: null,
	title: null,
	note: null,
	categoryId: null,
	walletId: null,
	occurredOn: null,
	occurredAt: null,
	flag: null,
	updatedAt: bumpedUpdatedAt(drafts.updatedAt, now),
	seq: currentSpaceSeq(spaceId)
});

/**
 * `db.batch` items that discard every PENDING draft whose id `draftIds` (a subquery) selects, in whichever spaces
 * they are: each affected space's sync counter is bumped once, then the drafts become content-free tombstones
 * stamped with their own space's new seq. The dedupe key stays, so the same capture is never recreated. Used when
 * a capture source is removed (FN-19 Gmail disconnect); no id list is bound.
 */
export function discardDraftsWhere(db: Db, draftIds: SQL, now: number) {
	const target = sql`drafts.id in (${draftIds}) and drafts.deleted_at is null`;
	return [
		bumpSpaceSeqsWhere(db, drafts, target),
		db
			.update(drafts)
			.set(tombstone(sql`drafts.space_id`, now))
			.where(target)
	] as const;
}

/** SQL condition on a `drafts` row: it is one of `refs` (JSON `[{id, updatedAt}]`) at exactly that `updated_at`. */
const matchesRefs = (refs: string) => sql`drafts.id in (select json_extract(r.value, '$.id')
	from json_each(${refs}) r where json_extract(r.value, '$.updatedAt') = drafts.updated_at)`;

/** SQL value: how many of `refs` this batch wrote (stamped with the seq the batch's `bumpSpaceSeq` took). */
const writtenNow = (spaceId: string, refs: string) => sql`(select count(*) from drafts w
	where w.space_id = ${spaceId} and w.seq = ${currentSpaceSeq(spaceId)}
	and w.id in (select json_extract(r.value, '$.id') from json_each(${refs}) r))`;

export type DraftWriteResult = 'ok' | 'stale' | 'missing';

/**
 * Discards ("Abaikan") one draft while its `updated_at` is still the one the page showed: a content-free
 * tombstone, permanent (owner decision E). Its dedupe key stays, so the same capture is never recreated.
 */
export async function discardDraft(
	db: Db,
	scope: SpaceScope,
	ref: DraftRef,
	now: number
): Promise<DraftWriteResult> {
	const { spaceId, userId } = scope;
	const [, done] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(drafts)
			.set(tombstone(spaceId, now))
			.where(
				and(
					eq(drafts.id, ref.id),
					pending(spaceId),
					eq(drafts.updatedAt, ref.updatedAt),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: drafts.id })
	]);
	if (done.length === 1) return 'ok';
	return (await getDrafts(db, spaceId, [ref.id])).length > 0 ? 'stale' : 'missing';
}

/**
 * Applies the merchant name the user tapped ("Pakai nama …", FN-20 red team L2) to one pending draft while its
 * `updated_at` is still the one the page showed. The caller passes the name the server resolved itself, never one
 * from the form.
 */
export async function renameDraft(
	db: Db,
	scope: SpaceScope,
	ref: DraftRef,
	title: string,
	now: number
): Promise<DraftWriteResult> {
	const { spaceId, userId } = scope;
	const [, done] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(drafts)
			.set({
				title,
				updatedAt: bumpedUpdatedAt(drafts.updatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(drafts.id, ref.id),
					pending(spaceId),
					eq(drafts.updatedAt, ref.updatedAt),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: drafts.id })
	]);
	if (done.length === 1) return 'ok';
	return (await getDrafts(db, spaceId, [ref.id])).length > 0 ? 'stale' : 'missing';
}

type Loaded = { ok: true; rows: DraftRow[] } | { ok: false; reason: 'none' | 'stale' };

/**
 * The selection's drafts as stored now. Ids not pending in this space are left out (`none` when that is all
 * of them); a draft whose `updated_at` moved since the page loaded makes the whole request `stale`.
 */
async function loadSelection(db: Db, spaceId: string, refs: readonly DraftRef[]): Promise<Loaded> {
	const rows = await getDrafts(
		db,
		spaceId,
		refs.map((r) => r.id)
	);
	if (rows.length === 0) return { ok: false, reason: 'none' };
	const expected = new Map(refs.map((r) => [r.id, r.updatedAt]));
	if (rows.some((r) => expected.get(r.id) !== r.updatedAt)) return { ok: false, reason: 'stale' };
	return { ok: true, rows };
}

/** JSON `[{id, updatedAt}]` of `rows`, for `matchesRefs` / `writtenNow`. */
const refsJson = (rows: readonly { id: string; updatedAt: number }[], extra = {}) =>
	JSON.stringify(rows.map((r) => ({ id: r.id, updatedAt: r.updatedAt, ...extra })));

/**
 * Runs `items` (after the seq bump) as one `db.batch` that also asserts `expected` drafts of `refs` were
 * written: all or nothing. `stale` when a draft changed meanwhile (the batch rolled back).
 */
async function allOrNothing(
	db: Db,
	spaceId: string,
	refs: string,
	expected: number,
	items: readonly BatchItem<'sqlite'>[]
): Promise<'ok' | 'stale'> {
	try {
		await db.batch([
			bumpSpaceSeq(db, spaceId),
			...items,
			batchAssert(db, sql`${writtenNow(spaceId, refs)} = ${expected}`)
		]);
		return 'ok';
	} catch (e) {
		if (isBatchAssertFailure(e)) return 'stale';
		throw e;
	}
}

export type BulkCategoryResult =
	| { ok: true; updated: number }
	| { ok: false; reason: 'none' | 'stale' | 'mixed' | 'kind' | 'category' };

/**
 * "Atur kategori": one visible category of the space for every selected draft, all in one guarded batch. The
 * selection must be all expense or all income (owner decision A: a mixed one is refused whole) and the category
 * of that kind; a category of another space reads as not found.
 */
export async function setDraftsCategory(
	db: Db,
	scope: SpaceScope,
	refs: readonly DraftRef[],
	categoryId: string,
	now: number
): Promise<BulkCategoryResult> {
	const { spaceId, userId } = scope;
	const category = await getCategory(db, spaceId, categoryId);
	if (!category || category.isHidden) return { ok: false, reason: 'category' };
	const loaded = await loadSelection(db, spaceId, refs);
	if (!loaded.ok) return loaded;
	const kind = selectionKind(loaded.rows.map((r) => r.type));
	if (kind === 'mixed') return { ok: false, reason: 'mixed' };
	if (kind !== category.kind) return { ok: false, reason: 'kind' };
	const json = refsJson(loaded.rows);
	const result = await allOrNothing(db, spaceId, json, loaded.rows.length, [
		db
			.update(drafts)
			.set({
				categoryId,
				categorySource: 'user',
				updatedAt: bumpedUpdatedAt(drafts.updatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					pending(spaceId),
					matchesRefs(json),
					eq(drafts.type, category.kind),
					isLiveMember(spaceId, userId),
					sql`exists (select 1 from categories c where c.id = ${categoryId}
						and c.space_id = ${spaceId} and c.kind = ${category.kind}
						and c.deleted_at is null and c.is_hidden = 0)`
				)
			)
	]);
	if (result !== 'ok') return { ok: false, reason: result };
	// FN-20 learning (owner decision 4): only after the change was written, and only for drafts whose category
	// really changed. A failure to learn never undoes or hides the confirmed change.
	const corrections = loaded.rows
		.filter((r) => r.title && r.categoryId !== categoryId)
		.map((r) => ({ descriptor: r.title ?? '', kind: category.kind, categoryId }));
	await learnFromCorrections(db, scope, corrections, now).catch((e: unknown) =>
		console.error('drafts: learning failed', e instanceof Error ? e.message : 'unknown')
	);
	return { ok: true, updated: loaded.rows.length };
}

/**
 * FN-20 "Isi kategori otomatis": writes the resolver's categories onto pending drafts that still have none, each
 * only while it is unchanged since it was read (`updated_at`), still without a category, and the category is a
 * visible category of this space of the draft's kind. One guarded statement; returns how many were filled. No
 * rule is learned: an unchanged suggestion teaches nothing (owner decision 5).
 */
export async function fillDraftCategories(
	db: Db,
	scope: SpaceScope,
	fills: readonly { id: string; updatedAt: number; categoryId: string }[],
	now: number
): Promise<number> {
	if (fills.length === 0) return 0;
	const { spaceId, userId } = scope;
	const json = JSON.stringify(fills.slice(0, DRAFT_LIST_MAX));
	const pick = (
		field: string
	) => sql`(select json_extract(f.value, ${`$.${field}`}) from json_each(${json}) f
		where json_extract(f.value, '$.id') = drafts.id)`;
	const [, filled] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(drafts)
			.set({
				categoryId: pick('categoryId'),
				updatedAt: bumpedUpdatedAt(drafts.updatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					pending(spaceId),
					isNull(drafts.categoryId),
					isLiveMember(spaceId, userId),
					sql`drafts.updated_at = ${pick('updatedAt')}`,
					sql`exists (select 1 from categories c where c.id = ${pick('categoryId')}
						and c.space_id = ${spaceId} and c.kind = drafts.type
						and c.deleted_at is null and c.is_hidden = 0)`
				)
			)
			.returning({ id: drafts.id })
	]);
	return filled.length;
}

export type BulkWalletResult =
	| { ok: true; updated: number; skipped: number }
	| { ok: false; reason: 'none' | 'stale' | 'wallet' };

/**
 * "Atur dompet": one live wallet of the space for every selected draft, whatever its type, in one guarded
 * batch. Drafts in another currency than the wallet's are skipped (counted), never converted; a wallet of
 * another space reads as not found.
 */
export async function setDraftsWallet(
	db: Db,
	scope: SpaceScope,
	refs: readonly DraftRef[],
	walletId: string,
	now: number
): Promise<BulkWalletResult> {
	const { spaceId, userId } = scope;
	const wallet = await getWallet(db, spaceId, walletId);
	if (!wallet) return { ok: false, reason: 'wallet' };
	const loaded = await loadSelection(db, spaceId, refs);
	if (!loaded.ok) return loaded;
	const matching = loaded.rows.filter((r) => r.currency === wallet.currency);
	const skipped = loaded.rows.length - matching.length;
	if (matching.length === 0) return { ok: true, updated: 0, skipped };
	const json = refsJson(matching);
	const result = await allOrNothing(db, spaceId, json, matching.length, [
		db
			.update(drafts)
			.set({
				walletId,
				updatedAt: bumpedUpdatedAt(drafts.updatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					pending(spaceId),
					matchesRefs(json),
					isLiveMember(spaceId, userId),
					sql`drafts.currency = (select w.currency from wallets w where w.id = ${walletId}
						and w.space_id = ${spaceId} and w.deleted_at is null)`
				)
			)
	]);
	return result === 'ok'
		? { ok: true, updated: matching.length, skipped }
		: { ok: false, reason: result };
}

export type SaveDraftsResult =
	| { ok: true; saved: number; incomplete: number }
	| { ok: false; reason: 'none' | 'stale' | 'duplicate' | 'limit' };

/**
 * "Simpan N transaksi". Each selected draft with a usable wallet and category is checked by FN-05's validator
 * (`capturedTransactionInput`) and written through FN-05's one insert path (`insertTransactions`) with the
 * draft's source, dedupe key and captured instant; the draft becomes a tombstone pointing at its transaction.
 * All of it is one `db.batch` asserting every draft was saved: if any draft changed or went meanwhile, the
 * space hit its transaction cap, or a dedupe key was already recorded, nothing is saved. Drafts still missing a
 * wallet or category (or whose wallet/category went) are left as they are and counted (owner decision B).
 */
export async function saveDrafts(
	db: Db,
	scope: SpaceScope,
	refs: readonly DraftRef[],
	now: number
): Promise<SaveDraftsResult> {
	const { spaceId } = scope;
	const loaded = await loadSelection(db, spaceId, refs);
	if (!loaded.ok) return loaded;
	const [wallets, categories] = await Promise.all([
		listWallets(db, spaceId),
		listCategories(db, spaceId)
	]);
	const rows: NewTransaction[] = [];
	for (const draft of loaded.rows) {
		const wallet = wallets.find((w) => w.id === draft.walletId);
		const category = categories.find((c) => c.id === draft.categoryId);
		const checked = capturedTransactionInput(draft, {
			wallet: wallet ? { id: wallet.id, currency: wallet.currency } : null,
			toWallet: null,
			category: category ? { id: category.id, kind: category.kind } : null
		});
		if (!checked.ok) continue;
		rows.push({
			id: newId(),
			input: checked.value,
			origin: {
				source: draft.source,
				dedupeKey: draft.dedupeKey,
				occurredAt: draft.occurredAt,
				isDemo: draft.isDemo,
				// FN-48: a category a member set with "Atur kategori" is theirs; the capture's own guess is `auto`.
				categorySource: draft.categorySource === 'user' ? 'user' : 'auto'
			},
			guard: { draftId: draft.id, draftUpdatedAt: draft.updatedAt }
		});
	}
	const incomplete = loaded.rows.length - rows.length;
	if (rows.length === 0) return { ok: true, saved: 0, incomplete };
	const json = JSON.stringify(
		rows.map((r) => ({ id: r.guard?.draftId, updatedAt: r.guard?.draftUpdatedAt, tx: r.id }))
	);
	const draftStillPending: (key: (name: string) => SQL) => SQL = (key) =>
		sql`exists (select 1 from drafts d where d.id = ${key('draftId')} and d.space_id = ${spaceId}
			and d.deleted_at is null and d.updated_at = ${key('draftUpdatedAt')})`;
	const txOf = sql`(select json_extract(p.value, '$.tx') from json_each(${json}) p
		where json_extract(p.value, '$.id') = drafts.id)`;
	try {
		const result = await allOrNothing(db, spaceId, json, rows.length, [
			insertTransactions(db, scope, rows, now, draftStillPending),
			db
				.update(drafts)
				.set({ ...tombstone(spaceId, now), savedTransactionId: txOf })
				.where(
					and(
						pending(spaceId),
						matchesRefs(json),
						sql`exists (select 1 from transactions t where t.id = ${txOf})`
					)
				)
		]);
		if (result === 'ok') return { ok: true, saved: rows.length, incomplete };
	} catch (e) {
		if (isUniqueViolation(e)) return { ok: false, reason: 'duplicate' };
		throw e;
	}
	const full = await transactionCapReached(db, spaceId, rows.length);
	return { ok: false, reason: full ? 'limit' : 'stale' };
}

/**
 * Dev-only (`devRoutesEnabled`): adds four fictional drafts to the space on every call, all `is_demo`: an
 * expense ready to save (the space's first wallet and its "Kopi" preset), an expense and an income that need a
 * wallet and category, and a duplicate-flagged expense. Dates are WIB (today, yesterday) from shared/dates.
 * Each gets a fresh dedupe key so the never-recreated rule can be tried by hand. Returns how many were added.
 */
export async function seedDemoDrafts(db: Db, scope: SpaceScope, now: number): Promise<number> {
	const { spaceId, userId } = scope;
	await ensurePresetCategories(db, spaceId, now);
	const [wallets, categories] = await Promise.all([
		listWallets(db, spaceId),
		listCategories(db, spaceId)
	]);
	const wallet = wallets.find((w) => w.currency === 'IDR') ?? null;
	const kopi =
		categories.find((c) => c.tileKey === 'kopi' && c.kind === 'expense') ??
		categories.find((c) => c.kind === 'expense') ??
		null;
	const yesterday = now - 24 * 60 * 60 * 1000;
	const row = (r: {
		type: CategoryKind;
		amountMinor: number;
		title: string;
		source: DraftSource;
		at: number;
		walletId?: string | null;
		categoryId?: string | null;
		flag?: DraftFlag;
	}) => ({
		id: newId(),
		type: r.type,
		amountMinor: r.amountMinor,
		title: r.title,
		categoryId: r.categoryId ?? null,
		walletId: r.walletId ?? null,
		occurredOn: r.at === now ? wibTodayString(now) : wibDateString(r.at),
		occurredAt: r.at,
		source: r.source,
		dedupeKey: `demo:${newId()}`,
		flag: r.flag ?? null
	});
	const rows = [
		row({
			type: 'expense',
			amountMinor: 2_800_000,
			title: 'Kedai Kopi Senja',
			source: 'gmail',
			at: now,
			walletId: wallet?.id,
			categoryId: kopi?.id
		}),
		row({
			type: 'expense',
			amountMinor: 15_450_000,
			title: 'Toko Serba Ada',
			source: 'receipt',
			at: yesterday
		}),
		row({
			type: 'income',
			amountMinor: 250_000_000,
			title: 'Honor proyek desain',
			source: 'statement',
			at: yesterday
		}),
		row({
			type: 'expense',
			amountMinor: 2_800_000,
			title: 'Kedai Kopi Senja',
			source: 'gmail',
			at: now,
			walletId: wallet?.id,
			flag: 'duplicate'
		})
	];
	const [, inserted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.insert(drafts)
			.select(
				sql`select json_extract(j.value, '$.id'), ${spaceId}, json_extract(j.value, '$.type'),
					json_extract(j.value, '$.amountMinor'), 'IDR', json_extract(j.value, '$.title'), null,
					json_extract(j.value, '$.categoryId'), json_extract(j.value, '$.walletId'),
					json_extract(j.value, '$.occurredOn'), json_extract(j.value, '$.occurredAt'),
					json_extract(j.value, '$.source'), json_extract(j.value, '$.dedupeKey'),
					json_extract(j.value, '$.flag'), 1, null, ${now}, ${now}, null, ${currentSpaceSeq(spaceId)}, null
				from json_each(${JSON.stringify(rows)}) j
				where ${isLiveMember(spaceId, userId)} and ${draftsUnderCap(spaceId, rows.length)}`
			)
			.returning({ id: drafts.id })
	]);
	return inserted.length;
}

/**
 * Dev-only: tombstones every demo draft still pending in the space. Returns how many. A demo draft already saved
 * is a transaction now: it stays, badged "Data demo" and excluded from every total (`is_demo` carried over),
 * and is deleted like any transaction from Riwayat.
 */
export async function clearDemoDrafts(db: Db, scope: SpaceScope, now: number): Promise<number> {
	const { spaceId, userId } = scope;
	const [, cleared] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(drafts)
			.set(tombstone(spaceId, now))
			.where(and(pending(spaceId), eq(drafts.isDemo, true), isLiveMember(spaceId, userId)))
			.returning({ id: drafts.id })
	]);
	return cleared.length;
}
