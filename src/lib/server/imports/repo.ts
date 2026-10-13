import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { CsvFormat, IMPORT_SOURCES } from '#lib/shared/csv';
import type { Db } from '../db';
import { importBatches, transactions } from '../db/schema';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { recordAuditEvent } from '../spaces/audit';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { TOMBSTONE_CONTENT } from '../transactions/repo';
import { batchHasLiveTransferLink, settleTransferLinksOfBatch } from '../transfers/match';
import { getWallet } from '../wallets/repo';

/** Most batches the history lists (newest first). */
export const IMPORT_LIST_MAX = 50;

/** One import as Riwayat impor shows it. */
export interface ImportBatchSummary {
	id: string;
	source: ImportBatchSource;
	format: CsvFormat | null;
	filename: string | null;
	rowCount: number;
	importedCount: number;
	skippedCount: number;
	alreadyImportedCount: number;
	createdAt: number;
	updatedAt: number;
	undoneAt: number | null;
}

/** Where a batch came from (`import_batches.source`). */
export type ImportBatchSource = (typeof IMPORT_SOURCES)[number];

/** The counts and labels a new batch row records (never the file or its rows). */
export interface NewImportBatch {
	id: string;
	/** `csv` (FN-18), `statement` (FN-16a) or `spreadsheet` (FN-17). */
	source: 'csv' | 'statement' | 'spreadsheet';
	/** The CSV template; null for a statement or a spreadsheet. */
	format: CsvFormat | null;
	filename: string | null;
	rowCount: number;
	importedCount: number;
	skippedCount: number;
	alreadyImportedCount: number;
	/** FN-48 Part B: a statement's wallet, row dates and printed balances (null for every other import). */
	statement?: StatementFigures | null;
}

/**
 * What a statement batch records for the continuity check (FN-48 Part B): the wallet its rows went to, the WIB
 * dates of the statement's first and last row, and the opening and closing balances it printed (IDR minor units,
 * null when it printed none or a figure cannot be trusted for these rows).
 */
export interface StatementFigures {
	walletId: string;
	periodFrom: string;
	periodTo: string;
	openingBalanceMinor: number | null;
	closingBalanceMinor: number | null;
}

/**
 * Batch item: the `import_batches` row of a CSV or statement import, only while `userId` is a live member of the space. Place
 * after `bumpSpaceSeq` and before the transactions that point at it, in the same `db.batch`.
 */
export function createImportBatch(db: Db, scope: SpaceScope, input: NewImportBatch, now: number) {
	const { spaceId, userId } = scope;
	const st = input.statement ?? null;
	return db.insert(importBatches).select(
		sql`select ${input.id}, ${spaceId}, ${input.source}, ${input.format}, ${input.filename}, ${input.rowCount},
			${input.importedCount}, ${input.skippedCount}, ${input.alreadyImportedCount}, ${userId}, ${now}, ${now},
			null, null, ${currentSpaceSeq(spaceId)}, ${st?.walletId ?? null}, ${st?.periodFrom ?? null},
			${st?.periodTo ?? null}, ${st?.openingBalanceMinor ?? null}, ${st?.closingBalanceMinor ?? null}
		where ${isLiveMember(spaceId, userId)}`
	);
}

/** The space's imports, newest first, at most IMPORT_LIST_MAX. */
export async function listImportBatches(db: Db, spaceId: string): Promise<ImportBatchSummary[]> {
	return db
		.select({
			id: importBatches.id,
			source: importBatches.source,
			format: importBatches.format,
			filename: importBatches.filename,
			rowCount: importBatches.rowCount,
			importedCount: importBatches.importedCount,
			skippedCount: importBatches.skippedCount,
			alreadyImportedCount: importBatches.alreadyImportedCount,
			createdAt: importBatches.createdAt,
			updatedAt: importBatches.updatedAt,
			undoneAt: importBatches.undoneAt
		})
		.from(importBatches)
		.where(and(eq(importBatches.spaceId, spaceId), isNull(importBatches.deletedAt)))
		.orderBy(desc(importBatches.createdAt), desc(importBatches.id))
		.limit(IMPORT_LIST_MAX);
}

/**
 * `ok`: undone now. `ok_transfer_kept`: undone now, but a "Cocokkan transfer" merge of one of its rows was edited
 * since, so that transfer stays as the user left it (the user is told). `already`: undone before (a double click or
 * replay: nothing happens, not an error). `stale`: changed since the page loaded. `missing`: no such batch in this
 * space (same for another space's id).
 */
export type UndoResult = 'ok' | 'ok_transfer_kept' | 'already' | 'stale' | 'missing';

/**
 * "Urungkan": marks the batch undone and tombstones every live transaction it wrote (content-free, like a single
 * delete; the dedupe key stays, so the same file never re-creates them), in one `db.batch`. Only while the batch
 * is not yet undone, its `updated_at` is still `expectedUpdatedAt` and the user is a live member; the
 * transactions are touched only when that first statement changed the batch in this very batch (its `seq`).
 * A confirmed "Cocokkan transfer" merge (FN-48 Part C) with a row of the batch is settled first, in the same
 * batch: the other import's row is restored from its snapshot and the link is marked undone
 * (`settleTransferLinksOfBatch`), so undoing one statement never loses a row of the other for good.
 */
export async function undoImportBatch(
	db: Db,
	scope: SpaceScope,
	batchId: string,
	expectedUpdatedAt: number,
	now: number
): Promise<UndoResult> {
	const { spaceId, userId } = scope;
	/** True only after the batch row below changed in this very `db.batch`. */
	const undoneNow = sql`exists (select 1 from import_batches b where b.id = ${batchId}
		and b.space_id = ${spaceId} and b.undone_at is not null
		and b.seq = ${currentSpaceSeq(spaceId)})`;
	const [, undone, , , editedTransferKept] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(importBatches)
			.set({
				undoneAt: now,
				updatedAt: Math.max(now, expectedUpdatedAt + 1),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(importBatches.id, batchId),
					eq(importBatches.spaceId, spaceId),
					isNull(importBatches.undoneAt),
					isNull(importBatches.deletedAt),
					eq(importBatches.updatedAt, expectedUpdatedAt),
					isLiveMember(spaceId, userId)
				)
			)
			.returning({ id: importBatches.id }),
		...settleTransferLinksOfBatch(db, spaceId, batchId, now, undoneNow),
		db
			.update(transactions)
			.set({
				deletedAt: now,
				...TOMBSTONE_CONTENT,
				updatedAt: sql`max(${now}, ${transactions.updatedAt} + 1)`,
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(transactions.spaceId, spaceId),
					eq(transactions.importBatchId, batchId),
					isNull(transactions.deletedAt),
					undoneNow
				)
			)
	]);
	if (undone.length === 1) return editedTransferKept.length > 0 ? 'ok_transfer_kept' : 'ok';
	const row = await db
		.select({ undoneAt: importBatches.undoneAt })
		.from(importBatches)
		.where(
			and(
				eq(importBatches.id, batchId),
				eq(importBatches.spaceId, spaceId),
				isNull(importBatches.deletedAt)
			)
		)
		.get();
	if (!row) return 'missing';
	return row.undoneAt !== null ? 'already' : 'stale';
}

/**
 * FN-16j: the one wallet every live row of a batch sits in (on either side of a transfer), per batch, and its
 * live row count. `sourceWalletId` is null when the rows share no wallet or more than one (both sides of every
 * row being the same two wallets): such a batch cannot be moved as one. Bounded by the batch ids (at most
 * IMPORT_LIST_MAX from the page, one from the move) and the rows those batches wrote; ids bound once as JSON.
 * `linked`: a row of the batch is in a live "Cocokkan transfer" link (FN-48 Part C), so the batch cannot move: the
 * merged transfer's target and the link's snapshot name the wallets as they were, and the undo restores there.
 */
async function batchWalletSides(db: Db, spaceId: string, batchIds: string[]) {
	const rows = await db.all<{
		batch_id: string;
		live_count: number;
		matches: number;
		source_wallet_id: string | null;
		linked: number;
	}>(sql`with live as (
			select t.id, t.import_batch_id as b, t.wallet_id as w, t.transfer_to_wallet_id as tw
			from transactions t
			where t.space_id = ${spaceId} and t.deleted_at is null
				and t.import_batch_id in (select value from json_each(${JSON.stringify(batchIds)}))
		),
		sides as (
			select b, id, w as wallet from live
			union select b, id, tw as wallet from live where tw is not null
		),
		totals as (select b, count(*) as n from live group by b),
		cand as (select b, wallet, count(*) as c from sides group by b, wallet)
		select totals.b as batch_id, totals.n as live_count,
			(select count(*) from cand where cand.b = totals.b and cand.c = totals.n) as matches,
			(select min(cand.wallet) from cand where cand.b = totals.b and cand.c = totals.n) as source_wallet_id,
			${batchHasLiveTransferLink(spaceId, sql`totals.b`)} as linked
		from totals`);
	const sides = new Map<
		string,
		{ liveCount: number; sourceWalletId: string | null; linked: boolean }
	>();
	for (const r of rows)
		sides.set(r.batch_id, {
			liveCount: r.live_count,
			sourceWalletId: r.matches === 1 ? r.source_wallet_id : null,
			linked: r.linked === 1
		});
	return sides;
}

/**
 * Why a batch cannot be moved at all: its rows share no one wallet, it has no live row left, or a row of it is in
 * a confirmed transfer match (undo that match first).
 */
export type MoveBlocked = 'mixed_wallets' | 'nothing_to_move' | 'transfer_linked';

/** What the move control of one live batch needs: the wallet it would move from, or why it cannot move. */
export interface ImportBatchMoveState {
	fromWalletId: string | null;
	moveBlocked: MoveBlocked | null;
}

/** The move state of each of `batchIds` (FN-16j), for the Riwayat impor list. */
export async function importBatchMoveStates(
	db: Db,
	spaceId: string,
	batchIds: string[]
): Promise<Map<string, ImportBatchMoveState>> {
	const sides = await batchWalletSides(db, spaceId, batchIds);
	const states = new Map<string, ImportBatchMoveState>();
	for (const id of batchIds) {
		const s = sides.get(id);
		states.set(id, {
			fromWalletId: s?.sourceWalletId ?? null,
			moveBlocked: !s
				? 'nothing_to_move'
				: s.linked
					? 'transfer_linked'
					: s.sourceWalletId === null
						? 'mixed_wallets'
						: null
		});
	}
	return states;
}

/**
 * `ok`: `moved` rows now sit in the target wallet (`walletName`); `skipped` transfer rows were left because the
 * move would make both their sides the same wallet. Refusals write nothing: `missing` (no such batch in this
 * space, or not a live member: one answer), `already` (undone), `stale` (changed since the page loaded or while
 * moving), `wallet_not_found` (missing, archived or another space's: one answer), `same_wallet`,
 * `currency_mismatch`, `source_archived` (the rows' wallet is archived: restore it first), `mixed_wallets`, `nothing_to_move`, `transfer_linked` (a row is in a live FN-48C merge).
 */
export type MoveResult =
	| { ok: true; moved: number; skipped: number; walletName: string }
	| {
			ok: false;
			reason:
				| 'missing'
				| 'already'
				| 'stale'
				| 'wallet_not_found'
				| 'same_wallet'
				| 'currency_mismatch'
				| 'source_archived'
				| MoveBlocked;
	  };

/**
 * "Pindahkan ke dompet lain" (FN-16j): every live transaction of the batch moves from the one wallet they all sit
 * in to `targetWalletId` (a transfer only on that side; a transfer whose other side is the target is skipped), and
 * a statement batch's continuity wallet follows, in one `db.batch`. The batch row is changed first, guarded by
 * the page's version, membership, every live row still on the source wallet, no live transfer link on its rows and a
 * live same-currency target;
 * the rows and the audit event follow only when that statement changed the batch in this very batch (its `seq`),
 * so a refusal writes nothing. Amounts, currencies and dates are never touched.
 */
export async function moveImportBatch(
	db: Db,
	scope: SpaceScope,
	batchId: string,
	targetWalletId: string,
	expectedUpdatedAt: number,
	now: number
): Promise<MoveResult> {
	const { spaceId, userId } = scope;
	const refuse = (reason: Extract<MoveResult, { ok: false }>['reason']) =>
		({ ok: false, reason }) as const;
	const batch = await db
		.select({ undoneAt: importBatches.undoneAt, updatedAt: importBatches.updatedAt })
		.from(importBatches)
		.where(
			and(
				eq(importBatches.id, batchId),
				eq(importBatches.spaceId, spaceId),
				isNull(importBatches.deletedAt),
				isLiveMember(spaceId, userId)
			)
		)
		.get();
	if (!batch) return refuse('missing');
	if (batch.undoneAt !== null) return refuse('already');
	if (batch.updatedAt !== expectedUpdatedAt) return refuse('stale');
	const side = (await batchWalletSides(db, spaceId, [batchId])).get(batchId);
	if (!side) return refuse('nothing_to_move');
	if (side.linked) return refuse('transfer_linked');
	const source = side.sourceWalletId;
	if (source === null) return refuse('mixed_wallets');
	const [target, from] = await Promise.all([
		getWallet(db, spaceId, targetWalletId),
		getWallet(db, spaceId, source)
	]);
	if (!target) return refuse('wallet_not_found');
	if (target.id === source) return refuse('same_wallet');
	// FN-16j red team L2: rows of an archived wallet stay with it (restore the wallet first), never reappear elsewhere.
	if (!from) return refuse('source_archived');
	if (from.currency !== target.currency) return refuse('currency_mismatch');

	const live = and(
		eq(transactions.spaceId, spaceId),
		eq(transactions.importBatchId, batchId),
		isNull(transactions.deletedAt)
	);
	/** True only after the batch row below changed in this very `db.batch`. */
	const moved = sql`exists (select 1 from import_batches b where b.id = ${batchId}
		and b.space_id = ${spaceId} and b.seq = ${currentSpaceSeq(spaceId)})`;
	const stamp = {
		updatedAt: sql`max(${now}, ${transactions.updatedAt} + 1)`,
		seq: currentSpaceSeq(spaceId)
	};
	const isTransfer = eq(transactions.type, 'transfer');
	const [, changed, skipped, plain, fromSide, toSide] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(importBatches)
			.set({
				walletId: sql`case when ${importBatches.walletId} is null then null else ${target.id} end`,
				updatedAt: Math.max(now, expectedUpdatedAt + 1),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(importBatches.id, batchId),
					eq(importBatches.spaceId, spaceId),
					isNull(importBatches.undoneAt),
					isNull(importBatches.deletedAt),
					eq(importBatches.updatedAt, expectedUpdatedAt),
					isLiveMember(spaceId, userId),
					sql`exists (select 1 from transactions t where t.space_id = ${spaceId}
						and t.import_batch_id = ${batchId} and t.deleted_at is null)`,
					sql`not exists (select 1 from transactions t where t.space_id = ${spaceId}
						and t.import_batch_id = ${batchId} and t.deleted_at is null
						and t.wallet_id <> ${source} and coalesce(t.transfer_to_wallet_id, '') <> ${source})`,
					sql`not ${batchHasLiveTransferLink(spaceId, batchId)}`,
					sql`exists (select 1 from wallets w where w.id = ${target.id} and w.space_id = ${spaceId}
						and w.deleted_at is null and w.currency = (select f.currency from wallets f
							where f.id = ${source} and f.space_id = ${spaceId} and f.deleted_at is null))`
				)
			)
			.returning({ id: importBatches.id }),
		// Transfers left alone: moving their source side would make both sides the target wallet.
		db
			.select({ n: sql<number>`count(*)` })
			.from(transactions)
			.where(
				and(
					live,
					isTransfer,
					or(
						and(eq(transactions.walletId, source), eq(transactions.transferToWalletId, target.id)),
						and(eq(transactions.transferToWalletId, source), eq(transactions.walletId, target.id))
					)
				)
			),
		db
			.update(transactions)
			.set({ walletId: target.id, ...stamp })
			.where(and(live, ne(transactions.type, 'transfer'), eq(transactions.walletId, source), moved))
			.returning({ id: transactions.id }),
		db
			.update(transactions)
			.set({ walletId: target.id, ...stamp })
			.where(
				and(
					live,
					isTransfer,
					eq(transactions.walletId, source),
					ne(transactions.transferToWalletId, target.id),
					moved
				)
			)
			.returning({ id: transactions.id }),
		db
			.update(transactions)
			.set({ transferToWalletId: target.id, ...stamp })
			.where(
				and(
					live,
					isTransfer,
					eq(transactions.transferToWalletId, source),
					ne(transactions.walletId, target.id),
					moved
				)
			)
			.returning({ id: transactions.id }),
		recordAuditEvent(db, { spaceId, actorUserId: userId, action: 'import_batch_moved' }, now, moved)
	]);
	if (changed.length !== 1) {
		// A member removed while the move ran gets `missing`, as before it (FN-16j red team L1).
		const row = await db
			.select({ undoneAt: importBatches.undoneAt })
			.from(importBatches)
			.where(
				and(
					eq(importBatches.id, batchId),
					eq(importBatches.spaceId, spaceId),
					isNull(importBatches.deletedAt),
					isLiveMember(spaceId, userId)
				)
			)
			.get();
		if (!row) return refuse('missing');
		return refuse(row.undoneAt !== null ? 'already' : 'stale');
	}
	return {
		ok: true,
		moved: plain.length + fromSide.length + toSide.length,
		skipped: skipped[0]?.n ?? 0,
		walletName: target.name
	};
}
