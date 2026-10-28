import { sql } from 'drizzle-orm';
import {
	GMAIL_RETENTION_MS,
	GMAIL_REVIEW_PAGE_SIZE,
	GMAIL_UNDO_WINDOW_MS,
	type GmailScanKind
} from '#lib/shared/gmail/ledger';
import type { GmailReviewRow, GmailReviewState } from '#lib/shared/gmail/review';
import type { Db } from '../db';
import { drafts, gmailScans, transactions } from '../db/schema';
import { listCategoriesWithPresets } from '../categories/repo';
import { discardDraftsWhere, saveDrafts, setDraftsCategory, setDraftsWallet } from '../drafts/repo';
import { listWallets } from '../wallets/repo';
import { bumpSpaceSeqsWhere, currentSpaceSeq } from '../sync/seq';
import { bumpedUpdatedAt } from '../sync/updated-at';
import { TOMBSTONE_CONTENT } from '../transactions/repo';
import { liveMemberOf } from './repo';

/**
 * FN-19b "Transaksi dari Gmail" (PRD § C): the session user's Gmail captures and the undo of one scan. Everything
 * is resolved from the SESSION user: a scan, mail row, draft or transaction is reached only through the user's own
 * connection (`user_id` repeated in every statement) and only in spaces the user is still a live member of, so
 * another user's scan id reads exactly like a missing one. Mail text is never stored; rows show stored figures.
 */

/** A page position: the last row's `received_at` and id (newest first). */
export interface ReviewCursor {
	receivedAt: number;
	id: string;
}

export function parseReviewCursor(raw: string | null): ReviewCursor | null {
	const m = raw ? /^(\d{1,16})_([0-9a-f]{32})$/.exec(raw) : null;
	if (!m) return null;
	const receivedAt = Number(m[1]);
	return Number.isSafeInteger(receivedAt) ? { receivedAt, id: m[2] as string } : null;
}

export const reviewCursorOf = (c: ReviewCursor) => `${c.receivedAt}_${c.id}`;

export interface ReviewPage {
	connection: { id: string; googleAddress: string | null } | null;
	rows: GmailReviewRow[];
	nextCursor: string | null;
}

interface RawRow {
	id: string;
	gmailId: string;
	receivedAt: number;
	senderDomain: string | null;
	subject: string | null;
	scanId: string | null;
	scanKind: GmailScanKind | null;
	scanDays: number | null;
	scanCreatedAt: number | null;
	scanUndoneAt: number | null;
	draftLive: number | null;
	flag: string | null;
	dTitle: string | null;
	dAmount: number | null;
	dCurrency: string | null;
	dType: string | null;
	txLive: number | null;
	tTitle: string | null;
	tAmount: number | null;
	tCurrency: string | null;
	tType: string | null;
}

const direction = (type: string | null) => (type === 'expense' || type === 'income' ? type : null);

function reviewRow(r: RawRow): GmailReviewRow {
	let state: GmailReviewState;
	let content = {
		title: null as string | null,
		amount: null as number | null,
		currency: null as string | null,
		type: null as string | null
	};
	if (r.txLive === 1) {
		state = 'saved';
		content = { title: r.tTitle, amount: r.tAmount, currency: r.tCurrency, type: r.tType };
	} else if (r.draftLive === 1) {
		state = r.flag === 'duplicate' ? 'duplicate' : 'draft';
		content = { title: r.dTitle, amount: r.dAmount, currency: r.dCurrency, type: r.dType };
	} else state = 'cancelled';
	return {
		id: r.id,
		gmailId: r.gmailId,
		receivedAt: r.receivedAt,
		state,
		title: content.title,
		amountMinor: content.amount,
		currency: content.currency,
		direction: direction(content.type),
		senderDomain: r.senderDomain,
		subject: r.subject,
		scan:
			r.scanId && r.scanKind && r.scanCreatedAt !== null
				? {
						id: r.scanId,
						kind: r.scanKind,
						days: r.scanDays,
						createdAt: r.scanCreatedAt,
						undoneAt: r.scanUndoneAt,
						undoable: r.scanUndoneAt === null
					}
				: null
	};
}

/**
 * One page (GMAIL_REVIEW_PAGE_SIZE) of the user's captures, newest first by (`received_at`, id), within the
 * 90-day ledger retention: every ledger row that inserted a draft, with what that draft became (pending, a saved
 * transaction, or cancelled). Null connection: none.
 */
export async function listGmailCaptures(
	db: Db,
	userId: string,
	cursor: ReviewCursor | null,
	now: number
): Promise<ReviewPage> {
	const connection = await db.get<{ id: string; googleAddress: string | null }>(
		sql`select id, google_address as googleAddress from gmail_connections where user_id = ${userId} limit 1`
	);
	if (!connection) return { connection: null, rows: [], nextCursor: null };
	const after = cursor
		? sql`and (gm.received_at < ${cursor.receivedAt} or (gm.received_at = ${cursor.receivedAt} and gm.id < ${cursor.id}))`
		: sql``;
	const raw =
		await db.all<RawRow>(sql`select gm.id, gm.gmail_id as gmailId, gm.received_at as receivedAt,
			gm.sender_domain as senderDomain, gm.subject, s.id as scanId, s.kind as scanKind, s.days as scanDays,
			s.created_at as scanCreatedAt, s.undone_at as scanUndoneAt,
			case when d.id is not null and d.deleted_at is null then 1 else 0 end as draftLive, d.flag,
			d.title as dTitle, d.amount_minor as dAmount, d.currency as dCurrency, d.type as dType,
			case when t.id is not null and t.deleted_at is null then 1 else 0 end as txLive,
			t.title as tTitle, t.amount_minor as tAmount, t.currency as tCurrency, t.type as tType
		from gmail_mail gm
		left join gmail_scans s on s.id = gm.scan_id and s.user_id = gm.user_id
		left join drafts d on d.id = gm.draft_id and d.space_id = gm.space_id
		left join transactions t on t.id = d.saved_transaction_id and t.space_id = gm.space_id
		where gm.connection_id = ${connection.id} and gm.user_id = ${userId} and gm.status = 'draft_created'
			and gm.draft_id is not null and gm.received_at > ${now - GMAIL_RETENTION_MS}
			and ${liveMemberOf(sql`gm.space_id`, sql`${userId}`)} ${after}
		order by gm.received_at desc, gm.id desc
		limit ${GMAIL_REVIEW_PAGE_SIZE + 1}`);
	const more = raw.length > GMAIL_REVIEW_PAGE_SIZE;
	const page = raw.slice(0, GMAIL_REVIEW_PAGE_SIZE);
	const last = page.at(-1);
	return {
		connection,
		rows: page.map(reviewRow),
		nextCursor: more && last ? reviewCursorOf({ receivedAt: last.receivedAt, id: last.id }) : null
	};
}

export type UndoScanResult =
	| { kind: 'ok'; drafts: number; transactions: number; skipped: number }
	| { kind: 'already' }
	| { kind: 'missing' };

/**
 * "Urungkan pemindaian", one `db.batch` guarded by the scan id, its owner (the session user) and its connection's
 * owner: (a) the scan is marked `undone_at`, only while not undone yet (a second call changes nothing:
 * `already`); then, only when that statement changed it in this very batch, (b) every still-pending draft the
 * scan's reads inserted becomes a content-free tombstone (dedupe key kept: the same mail is never recreated), and
 * (c) every live transaction saved from those drafts within GMAIL_UNDO_WINDOW_MS of the scan's end is tombstoned
 * too, EXCEPT one the user edited after it was created (`updated_at` > `created_at`), one with a kept photo, a
 * transfer, or one in a live "Cocokkan transfer" link: those stay and are counted as skipped. Spaces the user
 * left are not touched. Counts are exact (read inside the same batch).
 */
export async function undoGmailScan(
	db: Db,
	userId: string,
	scanId: string,
	now: number
): Promise<UndoScanResult> {
	const owned = sql`exists (select 1 from gmail_scans s join gmail_connections c on c.id = s.connection_id
		where s.id = ${scanId} and s.user_id = ${userId} and c.user_id = ${userId})`;
	/** True only after the claim below changed the scan in this very batch. */
	const undoneNow = sql`exists (select 1 from gmail_scans s where s.id = ${scanId} and s.user_id = ${userId}
		and s.undone_at = ${now})`;
	const mails = sql`select gm.draft_id from gmail_mail gm where gm.scan_id = ${scanId} and gm.user_id = ${userId}
		and gm.draft_id is not null and ${liveMemberOf(sql`gm.space_id`, sql`${userId}`)}`;
	const pendingDrafts = sql`drafts.id in (${mails}) and drafts.deleted_at is null`;
	const scanTx = sql`select d.saved_transaction_id from gmail_mail gm
		join drafts d on d.id = gm.draft_id and d.space_id = gm.space_id
		where gm.scan_id = ${scanId} and gm.user_id = ${userId} and d.saved_transaction_id is not null
			and ${liveMemberOf(sql`gm.space_id`, sql`${userId}`)}`;
	const withinWindow = sql`exists (select 1 from gmail_scans s where s.id = ${scanId}
		and s.updated_at >= ${now - GMAIL_UNDO_WINDOW_MS})`;
	const undoable = sql`transactions.id in (${scanTx}) and transactions.deleted_at is null
		and transactions.updated_at = transactions.created_at and transactions.photo_key is null
		and transactions.type <> 'transfer'
		and not exists (select 1 from transfer_links l where l.undone_at is null
			and (l.debit_transaction_id = transactions.id or l.credit_transaction_id = transactions.id))
		and ${withinWindow} and ${undoneNow}`;
	const steps = [
		db
			.update(gmailScans)
			.set({ undoneAt: now })
			.where(
				sql`${gmailScans.id} = ${scanId} and ${gmailScans.userId} = ${userId}
					and ${gmailScans.undoneAt} is null and ${owned}`
			)
			.returning({ id: gmailScans.id }),
		db
			.select({ n: sql<number>`count(*)` })
			.from(drafts)
			.where(sql`${pendingDrafts} and ${undoneNow}`),
		...discardDraftsWhere(
			db,
			sql`select drafts.id from drafts where ${pendingDrafts} and ${undoneNow}`,
			now
		),
		bumpSpaceSeqsWhere(db, transactions, undoable),
		db
			.update(transactions)
			.set({
				deletedAt: now,
				...TOMBSTONE_CONTENT,
				updatedAt: bumpedUpdatedAt(transactions.updatedAt, now),
				seq: currentSpaceSeq(sql`transactions.space_id`)
			})
			.where(undoable)
			.returning({ id: transactions.id }),
		db
			.select({ n: sql<number>`count(*)` })
			.from(transactions)
			.where(sql`transactions.id in (${scanTx}) and transactions.deleted_at is null`)
	] as const;
	const results = (await db.batch(steps as unknown as [(typeof steps)[number]])) as unknown[];
	const claimed = results[0] as { id: string }[];
	if (claimed.length === 1) {
		const draftCount = (results[1] as { n: number }[])[0]?.n ?? 0;
		const txs = results[5] as { id: string }[];
		const skipped = (results[6] as { n: number }[])[0]?.n ?? 0;
		return { kind: 'ok', drafts: draftCount, transactions: txs.length, skipped };
	}
	const exists = await db.get<{ undoneAt: number | null }>(sql`select s.undone_at as undoneAt
		from gmail_scans s join gmail_connections c on c.id = s.connection_id
		where s.id = ${scanId} and s.user_id = ${userId} and c.user_id = ${userId}`);
	return exists ? { kind: 'already' } : { kind: 'missing' };
}

export type SaveScanResult =
	| { kind: 'ok'; saved: number; incomplete: number }
	| { kind: 'missing' | 'stale' | 'limit' | 'duplicate' | 'none' | 'wallet' | 'category' };

/** What "Simpan semua yang lengkap" may fill in first: a wallet and an expense category of the space, each optional. */
export interface ScanSaveChoices {
	walletId: string | null;
	categoryId: string | null;
}

/** The live IDR wallets and visible expense categories of the user's Gmail target space (empty when not a member). */
export async function reviewChoices(
	db: Db,
	userId: string
): Promise<{
	wallets: { id: string; name: string }[];
	categories: { id: string; name: string; isPreset: boolean }[];
}> {
	const conn = await db.get<{
		spaceId: string;
	}>(sql`select c.space_id as spaceId from gmail_connections c
		where c.user_id = ${userId} and ${liveMemberOf(sql`c.space_id`, sql`${userId}`)}`);
	if (!conn) return { wallets: [], categories: [] };
	const [wallets, categories] = await Promise.all([
		listWallets(db, conn.spaceId),
		listCategoriesWithPresets(db, conn.spaceId)
	]);
	return {
		wallets: wallets.filter((w) => w.currency === 'IDR').map((w) => ({ id: w.id, name: w.name })),
		categories: categories
			.filter((c) => c.kind === 'expense' && !c.isHidden)
			.map((c) => ({ id: c.id, name: c.name, isPreset: c.isPreset }))
	};
}

interface PendingRef {
	id: string;
	updatedAt: number;
	type: string;
	walletId: string | null;
	categoryId: string | null;
}

/**
 * "Simpan semua yang lengkap" of a look-back scan (QA F1). Through the existing write paths only: the chosen
 * wallet goes on every still-pending draft of the scan WITHOUT one (`setDraftsWallet`, IDR only), the chosen
 * expense category on every pending expense draft without one (`setDraftsCategory`), then every complete draft
 * goes through FN-05's one save path (`saveDrafts`); drafts still missing a wallet or a category (an income draft
 * without one, say) are left for Kotak masuk and counted. Each step is guarded on the versions just read, so a
 * change in another tab answers `stale`. At most GMAIL_REVIEW_PAGE_SIZE × 4 drafts per call.
 */
export async function saveScanDrafts(
	db: Db,
	userId: string,
	scanId: string,
	choices: ScanSaveChoices,
	now: number
): Promise<SaveScanResult> {
	const scan = await db.get<{ spaceId: string }>(sql`select c.space_id as spaceId from gmail_scans s
		join gmail_connections c on c.id = s.connection_id
		where s.id = ${scanId} and s.user_id = ${userId} and c.user_id = ${userId} and s.kind = 'lookback'
			and s.undone_at is null and ${liveMemberOf(sql`c.space_id`, sql`${userId}`)}`);
	if (!scan) return { kind: 'missing' };
	const scope = { spaceId: scan.spaceId, userId };
	const pendingRefs = () =>
		db.all<PendingRef>(sql`select d.id, d.updated_at as updatedAt, d.type, d.wallet_id as walletId,
				d.category_id as categoryId
			from gmail_mail gm join drafts d on d.id = gm.draft_id and d.space_id = gm.space_id
			where gm.scan_id = ${scanId} and gm.user_id = ${userId} and gm.space_id = ${scan.spaceId}
				and d.deleted_at is null
			order by d.id limit ${GMAIL_REVIEW_PAGE_SIZE * 4}`);
	const ref = (r: PendingRef) => ({ id: r.id, updatedAt: r.updatedAt });
	let refs = await pendingRefs();
	if (refs.length === 0) return { kind: 'none' };
	if (choices.walletId) {
		const without = refs.filter((r) => r.walletId === null);
		if (without.length > 0) {
			const set = await setDraftsWallet(db, scope, without.map(ref), choices.walletId, now);
			if (!set.ok) return { kind: set.reason === 'wallet' ? 'wallet' : 'stale' };
			refs = await pendingRefs();
		}
	}
	if (choices.categoryId) {
		const without = refs.filter((r) => r.categoryId === null && r.type === 'expense');
		if (without.length > 0) {
			const set = await setDraftsCategory(db, scope, without.map(ref), choices.categoryId, now);
			if (!set.ok)
				return { kind: set.reason === 'stale' || set.reason === 'none' ? 'stale' : 'category' };
			refs = await pendingRefs();
		}
	}
	if (refs.length === 0) return { kind: 'none' };
	const result = await saveDrafts(db, scope, refs.map(ref), now);
	if (result.ok) return { kind: 'ok', saved: result.saved, incomplete: result.incomplete };
	return { kind: result.reason };
}
