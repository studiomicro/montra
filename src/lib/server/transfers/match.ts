import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { maskAccountNumbers } from '#lib/shared/text';
import type { Db } from '../db';
import { transactions, transferLinks, type TRANSFER_LINK_SOURCES } from '../db/schema';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { TOMBSTONE_CONTENT } from '../transactions/repo';
import { errorLabel, newId } from '../util';
import { bumpedUpdatedAt } from '../sync/updated-at';

/**
 * FN-48 Part C "Cocokkan transfer": an imported statement records a transfer between two of the user's own wallets
 * as two unrelated rows (an expense in the source wallet, an income in the destination), so it is counted as both
 * money out and money in. This module finds such pairs deterministically — live, non-demo rows already in the
 * `transfer` tile category of their kind ("Transfer keluar" / "Transfer masuk"), same `amount_minor` and
 * `currency`, two different wallets of the same space, `occurred_on` (WIB date) within ±1 day — and, after the
 * user confirms one pair, merges them into one FN-05 transfer row: the debit row becomes the transfer, the credit
 * row is tombstoned (its dedupe key stays, so a re-import never recreates it) and both rows' previous content is
 * kept in `transfer_links` for the one-step undo, which restores the very same rows (same ids, same `created_at`).
 * Never a match on amount alone, nothing learned from a confirmed, skipped or auto-merged pair. FN-48d: right after
 * a statement import commits, `autoMatchTransferPairs` merges only the own-transfer pairs that have exactly one
 * possible reading; every other pair still waits for the user's confirm.
 * FN-55a adds a second kind of pair, a card payment (`CARD_PAIR`): merged the same way into one transfer from the
 * bank wallet to the card, with the same confirm, undo, stale and cross-space rules.
 */

/** Who merged a pair: the user's confirm, or the statement import's auto-match pass (FN-48d). */
export type TransferLinkSource = (typeof TRANSFER_LINK_SOURCES)[number];

/** Most pairs one review lists (newest `occurred_on` first); the card's count still shows them all. */
export const MATCH_PREVIEW_MAX = 200;
/** Most confirmed merges the review page offers to undo (newest first). */
export const LINKS_LIST_MAX = 50;

/**
 * One side of a candidate pair (table alias `d` for the debit, `c` for the credit): a live, real expense or income
 * row of the space whose category is the `transfer` tile of its own kind, in a live wallet. A debit row that is a
 * Patungan split's bill cannot become a transfer (its link requires an expense); a credit row with a kept receipt
 * photo is not tombstoned (the photo could not be restored exactly), so neither is offered.
 */
function eligible(alias: 'd' | 'c', spaceId: string): SQL {
	const t = sql.raw(alias);
	const kind = alias === 'd' ? 'expense' : 'income';
	const own = alias === 'd' ? sql`${t}.patungan_split_id is null` : sql`${t}.photo_key is null`;
	return sql`${t}.space_id = ${spaceId} and ${t}.deleted_at is null and ${t}.is_demo = 0
		and ${t}.type = ${kind} and ${own}
		and exists (select 1 from categories k where k.id = ${t}.category_id and k.space_id = ${spaceId}
			and k.tile_key = 'transfer' and k.kind = ${t}.type)
		and exists (select 1 from wallets w where w.id = ${t}.wallet_id and w.space_id = ${spaceId}
			and w.deleted_at is null)`;
}

/** Debit `d` and credit `c` form a pair: exact amount and currency, two wallets, WIB dates within a day. */
const PAIRED = sql`c.amount_minor = d.amount_minor and c.currency = d.currency and c.wallet_id <> d.wallet_id
	and c.occurred_on between date(d.occurred_on, '-1 day') and date(d.occurred_on, '+1 day')`;

/**
 * FN-55a A5, a card payment: debit `d` is a live, real expense row of a non-card wallet in the `kartu-kredit` or
 * `transfer` tile (a bank's "KARTU KREDIT/PL …" debit), credit `c` a live, real income row of a `kartu_kredit`
 * wallet in the `transfer` tile (the statement's payment line). The same exclusions as `eligible` (a Patungan bill,
 * a kept photo).
 */
function cardSide(alias: 'd' | 'c', spaceId: string): SQL {
	const t = sql.raw(alias);
	const debit = alias === 'd';
	const tiles = debit ? sql`('kartu-kredit', 'transfer')` : sql`('transfer')`;
	return sql`${t}.space_id = ${spaceId} and ${t}.deleted_at is null and ${t}.is_demo = 0
		and ${t}.type = ${debit ? 'expense' : 'income'}
		and ${debit ? sql`${t}.patungan_split_id is null` : sql`${t}.photo_key is null`}
		and exists (select 1 from categories k where k.id = ${t}.category_id and k.space_id = ${spaceId}
			and k.tile_key in ${tiles} and k.kind = ${t}.type)
		and exists (select 1 from wallets w where w.id = ${t}.wallet_id and w.space_id = ${spaceId}
			and w.deleted_at is null and w.type ${debit ? sql`<>` : sql`=`} 'kartu_kredit')`;
}

/**
 * A card payment's dates (owner decision 5): the card's credit from 1 day before to 3 days after the bank's debit
 * (card payments post later, across weekends). Every other pair keeps PAIRED's ±1 day.
 */
const CARD_PAIRED = sql`c.amount_minor = d.amount_minor and c.currency = d.currency and c.wallet_id <> d.wallet_id
	and c.occurred_on between date(d.occurred_on, '-1 day') and date(d.occurred_on, '+3 day')`;

/** The two kinds of candidate pair: own wallets' transfer tiles (FN-48 Part C), and a card payment (FN-55a). */
const OWN_PAIR = (spaceId: string) =>
	sql`(${PAIRED} and ${eligible('d', spaceId)} and ${eligible('c', spaceId)})`;
const CARD_PAIR = (spaceId: string) =>
	sql`(${CARD_PAIRED} and ${cardSide('d', spaceId)} and ${cardSide('c', spaceId)})`;

/** `from … where …` over every candidate pair of the space (append `and …` for one pair). */
const pairsOf = (spaceId: string) => sql`from transactions d join transactions c
		on c.space_id = d.space_id and c.amount_minor = d.amount_minor and c.currency = d.currency
	where d.space_id = ${spaceId} and (${OWN_PAIR(spaceId)} or ${CARD_PAIR(spaceId)})`;

/** How many pairs the space has (counted in SQL, never by loading them); the /impor card's count. */
export async function countTransferMatches(db: Db, spaceId: string): Promise<number> {
	const row = await db.get<{ n: number }>(sql`select count(*) as n ${pairsOf(spaceId)}`);
	return row?.n ?? 0;
}

interface PairRow {
	kind: 'own' | 'card';
	debitId: string;
	debitTitle: string | null;
	debitOn: string;
	debitWalletId: string;
	debitUpdatedAt: number;
	creditId: string;
	creditTitle: string | null;
	creditOn: string;
	creditWalletId: string;
	creditUpdatedAt: number;
	amountMinor: number;
	currency: string;
}

/** One row of a proposed pair, as the review shows it (title masked, display only). */
interface TransferSide {
	id: string;
	title: string;
	occurredOn: string;
	walletId: string;
	/** The row's version the form sends back, so a row edited meanwhile is never merged (409). */
	updatedAt: number;
}

export interface TransferPair {
	/** `card`: a bank debit paying a card's bill (FN-55a); `own`: a transfer between two own accounts. */
	kind: 'own' | 'card';
	debit: TransferSide;
	credit: TransferSide;
	amountMinor: number;
	currency: string;
}

/**
 * Pairs that share a row (one debit with two same-amount credits in the window, or the reverse) are one group:
 * the review lists every candidate of it and the user picks one or skips the whole group; nothing is picked for
 * them. A group of one pair is unambiguous.
 */
export interface TransferMatchGroup<P extends PairOfIds = TransferPair> {
	/** The group's first pair's ids (a stable key for the list). */
	key: string;
	amountMinor: number;
	currency: string;
	ambiguous: boolean;
	pairs: P[];
}

/** What grouping reads of a pair: its two row ids, amount and currency. */
interface PairOfIds {
	debit: { id: string };
	credit: { id: string };
	amountMinor: number;
	currency: string;
}

/** Connected components of the pair graph (rows as nodes), in the order the pairs were listed. */
export function groupTransferPairs<P extends PairOfIds>(
	pairs: readonly P[]
): TransferMatchGroup<P>[] {
	const parent = new Map<string, string>();
	const root = (id: string): string => {
		let r = id;
		while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
		return r;
	};
	const unite = (a: string, b: string) => {
		const ra = root(a);
		const rb = root(b);
		if (!parent.has(ra)) parent.set(ra, ra);
		if (!parent.has(rb)) parent.set(rb, rb);
		if (ra !== rb) parent.set(rb, ra);
	};
	for (const p of pairs) unite(p.debit.id, p.credit.id);
	const groups = new Map<string, TransferMatchGroup<P>>();
	for (const p of pairs) {
		const r = root(p.debit.id);
		const g = groups.get(r);
		if (g) {
			g.pairs.push(p);
			g.ambiguous = true;
		} else
			groups.set(r, {
				key: `${p.debit.id}:${p.credit.id}`,
				amountMinor: p.amountMinor,
				currency: p.currency,
				ambiguous: false,
				pairs: [p]
			});
	}
	return [...groups.values()];
}

export interface TransferMatchPreview {
	/** Every candidate pair of the space (the first MATCH_PREVIEW_MAX are reviewed). */
	total: number;
	/** How many pairs this review read (at most MATCH_PREVIEW_MAX). */
	shown: number;
	groups: TransferMatchGroup[];
}

/**
 * The review list: the newest MATCH_PREVIEW_MAX candidate pairs of the space (by the later of the two WIB dates,
 * then ids), grouped so an ambiguous set is shown whole. Amounts are compared as `amount_minor` integers with the
 * currency, dates as `occurred_on` only.
 */
export async function proposeTransferMatches(
	db: Db,
	spaceId: string
): Promise<TransferMatchPreview> {
	const [rows, total] = await Promise.all([
		db.all<PairRow>(
			sql`select case when ${CARD_PAIR(spaceId)} then 'card' else 'own' end as kind,
				d.id as debitId, d.title as debitTitle, d.occurred_on as debitOn,
				d.wallet_id as debitWalletId, d.updated_at as debitUpdatedAt,
				c.id as creditId, c.title as creditTitle, c.occurred_on as creditOn,
				c.wallet_id as creditWalletId, c.updated_at as creditUpdatedAt,
				d.amount_minor as amountMinor, d.currency
			${pairsOf(spaceId)}
			order by max(d.occurred_on, c.occurred_on) desc, d.occurred_on desc, d.id, c.id
			limit ${MATCH_PREVIEW_MAX}`
		),
		countTransferMatches(db, spaceId)
	]);
	const pairs = rows.map((r): TransferPair => ({
		kind: r.kind,
		debit: {
			id: r.debitId,
			title: maskAccountNumbers(r.debitTitle ?? ''),
			occurredOn: r.debitOn,
			walletId: r.debitWalletId,
			updatedAt: r.debitUpdatedAt
		},
		credit: {
			id: r.creditId,
			title: maskAccountNumbers(r.creditTitle ?? ''),
			occurredOn: r.creditOn,
			walletId: r.creditWalletId,
			updatedAt: r.creditUpdatedAt
		},
		amountMinor: r.amountMinor,
		currency: r.currency
	}));
	return { total, shown: pairs.length, groups: groupTransferPairs(pairs) };
}

/** The pair the form confirms: both ids and both versions as reviewed. */
export interface TransferPairChoice {
	debitId: string;
	creditId: string;
	debitUpdatedAt: number;
	creditUpdatedAt: number;
}

/**
 * `ok`: merged now. `already`: this very pair is in a live link (a resent form changes nothing). `stale`: the
 * pair is still a candidate but one row changed since the review (409, never an overwrite). `missing`: no such
 * candidate pair in this space (another space's ids get the same answer).
 */
export type ApplyMatchResult =
	{ status: 'ok'; linkId: string } | { status: 'already' | 'stale' | 'missing' };

const linkWrittenNow = (spaceId: string, linkId: string) =>
	sql`exists (select 1 from transfer_links l where l.id = ${linkId} and l.space_id = ${spaceId}
		and l.undone_at is null and l.seq = ${currentSpaceSeq(spaceId)})`;

/**
 * "Cocokkan" (one pair, explicit confirm): one `db.batch` that writes the link — only while the two rows are still
 * a candidate pair exactly as reviewed (same `updated_at`), in no live link, and the user is a live member — with
 * both rows' previous content as JSON, then, only when that link was written in this very batch (its `seq`):
 * the debit row becomes the transfer (`type`, `transfer_to_wallet_id` = the credit row's wallet, no category) and
 * the credit row is tombstoned like a single delete (TOMBSTONE_CONTENT; dedupe key, import batch and `created_at`
 * kept). No amount changes anywhere. `source` `auto` (FN-48d's pass) is stored on the link and adds
 * `stillUnambiguous` to the same guard, so a pair that became ambiguous or was declined since the pass read it is
 * never merged.
 */
export async function applyTransferMatch(
	db: Db,
	scope: SpaceScope,
	pair: TransferPairChoice,
	now: number,
	source: TransferLinkSource = 'manual'
): Promise<ApplyMatchResult> {
	const { spaceId, userId } = scope;
	const linkId = newId();
	const written = linkWrittenNow(spaceId, linkId);
	const unambiguousNow = source === 'auto' ? stillUnambiguous(spaceId, pair) : sql`1`;
	const [, , , , found] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db.insert(transferLinks).select(
			sql`select ${linkId}, ${spaceId}, d.id, c.id,
				json_object('type', d.type, 'categoryId', d.category_id, 'categorySource', d.category_source,
					'transferToWalletId', d.transfer_to_wallet_id, 'updatedAt', d.updated_at),
				json_object('amountMinor', c.amount_minor, 'currency', c.currency, 'walletId', c.wallet_id,
					'transferToWalletId', c.transfer_to_wallet_id, 'categoryId', c.category_id,
					'categorySource', c.category_source, 'occurredOn', c.occurred_on, 'occurredAt', c.occurred_at,
					'title', c.title, 'note', c.note, 'paymentMethod', c.payment_method, 'recurrence', c.recurrence,
					'tag', c.tag, 'reference', c.reference, 'adjustmentDirection', c.adjustment_direction,
					'photoKey', c.photo_key, 'photoType', c.photo_type, 'patunganSplitId', c.patungan_split_id,
					'patunganEffectiveAmountMinor', c.patungan_effective_amount_minor, 'updatedAt', c.updated_at),
				${now}, ${now}, null, ${currentSpaceSeq(spaceId)}, ${source}
			${pairsOf(spaceId)}
				and d.id = ${pair.debitId} and c.id = ${pair.creditId}
				and d.updated_at = ${pair.debitUpdatedAt} and c.updated_at = ${pair.creditUpdatedAt}
				and ${isLiveMember(spaceId, userId)}
				and not exists (select 1 from transfer_links l where l.undone_at is null
					and (l.debit_transaction_id in (d.id, c.id) or l.credit_transaction_id in (d.id, c.id)))
				and ${unambiguousNow}`
		),
		db
			.update(transactions)
			.set({
				type: 'transfer',
				transferToWalletId: sql`(select json_extract(l.credit_snapshot, '$.walletId')
					from transfer_links l where l.id = ${linkId})`,
				categoryId: null,
				categorySource: null,
				updatedAt: bumpedUpdatedAt(transactions.updatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(transactions.id, pair.debitId),
					eq(transactions.spaceId, spaceId),
					isNull(transactions.deletedAt),
					written
				)
			),
		db
			.update(transactions)
			.set({
				deletedAt: now,
				...TOMBSTONE_CONTENT,
				updatedAt: bumpedUpdatedAt(transactions.updatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(transactions.id, pair.creditId),
					eq(transactions.spaceId, spaceId),
					isNull(transactions.deletedAt),
					written
				)
			),
		db
			.select({ id: transferLinks.id })
			.from(transferLinks)
			.where(and(eq(transferLinks.id, linkId), eq(transferLinks.spaceId, spaceId), written))
	]);
	if (found.length === 1) return { status: 'ok', linkId };
	const live = await db
		.select({ id: transferLinks.id })
		.from(transferLinks)
		.where(
			and(
				eq(transferLinks.spaceId, spaceId),
				eq(transferLinks.debitTransactionId, pair.debitId),
				eq(transferLinks.creditTransactionId, pair.creditId),
				isNull(transferLinks.undoneAt)
			)
		)
		.get();
	if (live) return { status: 'already' };
	const candidate = await db.get<{ n: number }>(
		sql`select 1 as n ${pairsOf(spaceId)} and d.id = ${pair.debitId} and c.id = ${pair.creditId}`
	);
	return { status: candidate ? 'stale' : 'missing' };
}

/**
 * FN-48d, in the guarded insert of an `auto` merge (the pair as `d` and `c`): the pair is an own transfer and not a
 * card payment (FN-55a pairs stay manual), no auto-merge — live or undone — ever named either row (an undone one
 * is the user's "not this pair"), and neither row is in any other candidate pair (own or card) right now, so its
 * group still has exactly one pair. The inner `pairsOf` declares its own `d` and `c`; the ids come as values.
 */
function stillUnambiguous(spaceId: string, pair: TransferPairChoice): SQL {
	return sql`not ${CARD_PAIR(spaceId)}
		and not exists (select 1 from transfer_links h where h.space_id = ${spaceId} and h.source = 'auto'
			and (h.debit_transaction_id in (d.id, c.id) or h.credit_transaction_id in (d.id, c.id)))
		and not exists (select 1 ${pairsAround(spaceId, 'd', pair.debitId)} and c.id <> ${pair.creditId})
		and not exists (select 1 ${pairsAround(spaceId, 'c', pair.creditId)} and d.id <> ${pair.debitId})`;
}

/**
 * `from … where …` over every candidate pair (own or card) that row `id` is side `known` of: that row by its id,
 * the other side looked up by space, amount and currency among live rows (`transactions_space_amount_idx`, named
 * so the plan never walks the space's rows by date instead).
 */
function pairsAround(spaceId: string, known: 'd' | 'c', id: string): SQL {
	const k = sql.raw(known);
	const o = sql.raw(known === 'd' ? 'c' : 'd');
	return sql`from transactions ${k} cross join transactions ${o} indexed by transactions_space_amount_idx
			on ${o}.space_id = ${k}.space_id and ${o}.amount_minor = ${k}.amount_minor
			and ${o}.currency = ${k}.currency and ${o}.deleted_at is null
		where ${k}.id = ${id} and ${k}.space_id = ${spaceId} and (${OWN_PAIR(spaceId)} or ${CARD_PAIR(spaceId)})`;
}

/** Most pairs one statement import merges by itself (owner decision 3); the rest wait on the review page. */
export const AUTO_MATCH_MAX = 20;
/**
 * Most candidate pairs the auto-match pass reads. Pairs only ever join rows of one amount and currency, so the read
 * is ordered by those: past the cap, the last amount read may be incomplete and is dropped whole (its ambiguity
 * cannot be judged), every earlier amount is complete.
 */
export const AUTO_MATCH_SCAN_MAX = 1000;

/** One candidate pair as the auto-match pass reads it. */
export interface AutoMatchCandidate {
	kind: 'own' | 'card';
	debit: { id: string; occurredOn: string; updatedAt: number };
	credit: { id: string; occurredOn: string; updatedAt: number };
	amountMinor: number;
	currency: string;
	/** One of the two rows was written by the import that just committed. */
	touched: boolean;
	/** An auto-merge (live or undone) already named one of the two rows. */
	autoBefore: boolean;
}

/**
 * The pairs the pass merges, from candidates read in (amount, currency) order with at most `scanMax + 1` rows:
 * the incomplete last amount dropped, then only groups of exactly one pair that is an own transfer, touched by the
 * import and never auto-merged before; newest first (later WIB date of the two, then the debit's, then ids), at
 * most `max`.
 */
export function chooseAutoMatches(
	candidates: readonly AutoMatchCandidate[],
	scanMax: number,
	max: number
): AutoMatchCandidate[] {
	const extra = candidates.length > scanMax ? candidates[scanMax] : undefined;
	const complete = extra
		? candidates
				.slice(0, scanMax)
				.filter((p) => p.amountMinor !== extra.amountMinor || p.currency !== extra.currency)
		: candidates;
	const later = (p: AutoMatchCandidate) =>
		p.debit.occurredOn > p.credit.occurredOn ? p.debit.occurredOn : p.credit.occurredOn;
	const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
	return groupTransferPairs(complete)
		.filter((g) => !g.ambiguous)
		.map((g) => g.pairs[0]!)
		.filter((p) => p.kind === 'own' && p.touched && !p.autoBefore)
		.sort(
			(a, b) =>
				cmp(later(b), later(a)) ||
				cmp(b.debit.occurredOn, a.debit.occurredOn) ||
				cmp(a.debit.id, b.debit.id) ||
				cmp(a.credit.id, b.credit.id)
		)
		.slice(0, max);
}

/**
 * FN-48d "auto-match": right after a statement import's own batch has committed (never inside it), merges the
 * import's unambiguous own-transfer pairs by themselves through `applyTransferMatch` (`source` `auto`): the same
 * guarded merge, link and one-step undo as the user's confirm. The read is bounded by the batch's own amounts — the
 * live, real, transfer-tile rows `batchId` wrote (`transactions_import_batch_idx`) — looked up among the space's
 * live rows (`transactions_space_amount_idx`), so every competing row is seen, whatever import it came from, and
 * the list of amounts is never bound as parameters. `chooseAutoMatches` picks the pairs; a pair that turned stale
 * or ambiguous before its merge is simply left for the review page. Returns how many were merged.
 */
export async function autoMatchTransferPairs(
	db: Db,
	scope: SpaceScope,
	batchId: string,
	now: number
): Promise<{ autoMatchedCount: number }> {
	const { spaceId } = scope;
	/*
	 * Plan steering (SQLite): the batch's amounts come first (`cross join` keeps them outermost; the unary `+` keeps
	 * the batch read on `transactions_import_batch_idx`), then each side is looked up by space, amount and currency
	 * among live rows (`transactions_space_amount_idx`, named for `c` so the plan never walks the space by date).
	 */
	const batchAmounts = sql`(select distinct t.amount_minor, t.currency from transactions t
		where t.space_id = ${spaceId} and t.import_batch_id = ${batchId} and +t.deleted_at is null and t.is_demo = 0
		and t.type in ('expense', 'income')
		and exists (select 1 from categories k where k.id = t.category_id and k.space_id = ${spaceId}
			and k.tile_key = 'transfer' and k.kind = t.type))`;
	const rows = await db.all<{
		kind: 'own' | 'card';
		debitId: string;
		debitOn: string;
		debitUpdatedAt: number;
		creditId: string;
		creditOn: string;
		creditUpdatedAt: number;
		amountMinor: number;
		currency: string;
		touched: number;
		autoBefore: number;
	}>(
		sql`select case when ${CARD_PAIR(spaceId)} then 'card' else 'own' end as kind,
			d.id as debitId, d.occurred_on as debitOn, d.updated_at as debitUpdatedAt,
			c.id as creditId, c.occurred_on as creditOn, c.updated_at as creditUpdatedAt,
			d.amount_minor as amountMinor, d.currency,
			(d.import_batch_id is ${batchId} or c.import_batch_id is ${batchId}) as touched,
			exists (select 1 from transfer_links h where h.space_id = ${spaceId} and h.source = 'auto'
				and (h.debit_transaction_id in (d.id, c.id) or h.credit_transaction_id in (d.id, c.id))) as autoBefore
		from ${batchAmounts} x cross join transactions d
			join transactions c indexed by transactions_space_amount_idx on c.space_id = d.space_id and c.amount_minor = d.amount_minor and c.currency = d.currency
			and c.deleted_at is null
		where d.space_id = ${spaceId} and d.amount_minor = x.amount_minor and d.currency = x.currency
			and d.deleted_at is null and (${OWN_PAIR(spaceId)} or ${CARD_PAIR(spaceId)})
		order by d.amount_minor, d.currency, d.id, c.id
		limit ${AUTO_MATCH_SCAN_MAX + 1}`
	);
	const chosen = chooseAutoMatches(
		rows.map((r) => ({
			kind: r.kind,
			debit: { id: r.debitId, occurredOn: r.debitOn, updatedAt: r.debitUpdatedAt },
			credit: { id: r.creditId, occurredOn: r.creditOn, updatedAt: r.creditUpdatedAt },
			amountMinor: r.amountMinor,
			currency: r.currency,
			touched: r.touched === 1,
			autoBefore: r.autoBefore === 1
		})),
		AUTO_MATCH_SCAN_MAX,
		AUTO_MATCH_MAX
	);
	let autoMatchedCount = 0;
	// One small merge after another (each its own db.batch); a pair that fails its guard stays for the user. A merge
	// that throws ends the pass, but the count still names every merge already written (red team L1): the success
	// line never under-reports what the Otomatis badge lists.
	for (const p of chosen) {
		let result: Awaited<ReturnType<typeof applyTransferMatch>>;
		try {
			result = await applyTransferMatch(
				db,
				scope,
				{
					debitId: p.debit.id,
					creditId: p.credit.id,
					debitUpdatedAt: p.debit.updatedAt,
					creditUpdatedAt: p.credit.updatedAt
				},
				now,
				'auto'
			);
		} catch (e) {
			console.error('impor: transfer auto-match stopped', errorLabel(e));
			break;
		}
		if (result.status === 'ok') autoMatchedCount++;
	}
	return { autoMatchedCount };
}

/**
 * `ok`: undone now. `already`: undone before (a resend changes nothing). `stale`: one of the two rows no longer
 * holds exactly what the merge wrote (edited or deleted since), or belongs to an import the user has undone
 * meanwhile, so nothing is restored. `missing`: no such link in this space.
 */
export type UndoMatchResult = 'ok' | 'already' | 'stale' | 'missing';

/*
 * Guards shared by the one-pair undo and the import undo (`settleTransferLinksOfBatch`); each expects the link as
 * `l` and the row as `d` (debit) or `c` (credit) in the enclosing `from`.
 */
/** The debit row `d` still holds exactly what the merge of link `l` wrote: a live transfer to the credit's wallet. */
const debitHolds = (spaceId: string) => sql`d.space_id = ${spaceId} and d.deleted_at is null
	and d.type = 'transfer' and d.transfer_to_wallet_id = json_extract(l.credit_snapshot, '$.walletId')
	and d.updated_at = max(l.created_at, json_extract(l.debit_snapshot, '$.updatedAt') + 1)`;
/** The credit row `c` is still the tombstone the merge of link `l` wrote. */
const creditHolds = (spaceId: string) => sql`c.space_id = ${spaceId} and c.deleted_at = l.created_at
	and c.updated_at = max(l.created_at, json_extract(l.credit_snapshot, '$.updatedAt') + 1)`;
/** The wallet the credit row of link `l` would come back to is live. */
const creditWalletLive = (spaceId: string) => sql`exists (select 1 from wallets w
	where w.id = json_extract(l.credit_snapshot, '$.walletId') and w.space_id = ${spaceId} and w.deleted_at is null)`;
/**
 * Row `alias` was not written by an import the user has undone: an undone import's rows stay tombstones, whatever
 * a transfer link remembers of them (an undo that revived one would contradict the user's "Urungkan impor").
 */
const rowImportLive = (alias: 'd' | 'c') => sql`not exists (select 1 from import_batches b
	where b.id = ${sql.raw(alias)}.import_batch_id and b.undone_at is not null)`;

/** `set` columns that put the debit row's previous `type`, category, marker and transfer target back from `snapshot`. */
function debitRestore(snapshot: SQL, spaceId: string, now: number) {
	const f = (field: string) => sql`json_extract(${snapshot}, ${'$.' + field})`;
	return {
		type: f('type'),
		categoryId: f('categoryId'),
		categorySource: f('categorySource'),
		transferToWalletId: f('transferToWalletId'),
		updatedAt: bumpedUpdatedAt(transactions.updatedAt, now),
		seq: currentSpaceSeq(spaceId)
	};
}

/** `set` columns that put every content column of the credit row back from `snapshot` (a JSON expression). */
function creditRestore(snapshot: SQL, spaceId: string, now: number) {
	const f = (field: string) => sql`json_extract(${snapshot}, ${'$.' + field})`;
	return {
		deletedAt: null,
		amountMinor: f('amountMinor'),
		currency: f('currency'),
		walletId: f('walletId'),
		transferToWalletId: f('transferToWalletId'),
		categoryId: f('categoryId'),
		categorySource: f('categorySource'),
		occurredOn: f('occurredOn'),
		occurredAt: f('occurredAt'),
		title: f('title'),
		note: f('note'),
		paymentMethod: f('paymentMethod'),
		recurrence: f('recurrence'),
		tag: f('tag'),
		reference: f('reference'),
		adjustmentDirection: f('adjustmentDirection'),
		photoKey: f('photoKey'),
		photoType: f('photoType'),
		patunganSplitId: f('patunganSplitId'),
		patunganEffectiveAmountMinor: f('patunganEffectiveAmountMinor'),
		updatedAt: bumpedUpdatedAt(transactions.updatedAt, now),
		seq: currentSpaceSeq(spaceId)
	};
}

/**
 * "Urungkan" (one pair): one `db.batch` that marks the link undone — only while it is live, the user is a live
 * member, both rows still hold exactly what the merge wrote (the debit a transfer to the credit's wallet, the
 * credit a tombstone, each at the `updated_at` the merge gave it) in a live wallet, and neither row comes from an
 * import undone since — then, only when the link was undone in this very batch, restores the debit row's previous
 * `type`, category, marker and transfer target and the credit row's every content column from the snapshots: a
 * guarded UPDATE, the same rows (same id and `created_at`), never a new row.
 */
export async function undoTransferMatch(
	db: Db,
	scope: SpaceScope,
	linkId: string,
	now: number
): Promise<UndoMatchResult> {
	const { spaceId, userId } = scope;
	const l = transferLinks;
	const undoneNow = sql`exists (select 1 from transfer_links l where l.id = ${linkId} and l.space_id = ${spaceId}
		and l.undone_at is not null and l.seq = ${currentSpaceSeq(spaceId)})`;
	/** The link's snapshot (`which`), for the restoring statements. */
	const snapshotOf = (which: 'debit_snapshot' | 'credit_snapshot') =>
		sql`(select l.${sql.raw(which)} from transfer_links l where l.id = ${linkId})`;
	const rowOf = (which: 'debit_transaction_id' | 'credit_transaction_id') =>
		sql`(select l.${sql.raw(which)} from transfer_links l where l.id = ${linkId})`;
	const [, undone] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(l)
			.set({
				undoneAt: now,
				updatedAt: bumpedUpdatedAt(l.updatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(l.id, linkId),
					eq(l.spaceId, spaceId),
					isNull(l.undoneAt),
					isLiveMember(spaceId, userId),
					sql`exists (select 1 from transfer_links l join transactions d on d.id = l.debit_transaction_id
						where l.id = ${linkId} and ${debitHolds(spaceId)} and ${rowImportLive('d')})`,
					sql`exists (select 1 from transfer_links l join transactions c on c.id = l.credit_transaction_id
						where l.id = ${linkId} and ${creditHolds(spaceId)} and ${creditWalletLive(spaceId)}
						and ${rowImportLive('c')})`
				)
			)
			.returning({ id: l.id }),
		db
			.update(transactions)
			.set(debitRestore(snapshotOf('debit_snapshot'), spaceId, now))
			.where(
				and(
					eq(transactions.id, rowOf('debit_transaction_id')),
					eq(transactions.spaceId, spaceId),
					undoneNow
				)
			),
		db
			.update(transactions)
			.set(creditRestore(snapshotOf('credit_snapshot'), spaceId, now))
			.where(
				and(
					eq(transactions.id, rowOf('credit_transaction_id')),
					eq(transactions.spaceId, spaceId),
					undoneNow
				)
			)
	]);
	if (undone.length === 1) return 'ok';
	const row = await db
		.select({ undoneAt: l.undoneAt })
		.from(l)
		.where(and(eq(l.id, linkId), eq(l.spaceId, spaceId)))
		.get();
	if (!row) return 'missing';
	return row.undoneAt !== null ? 'already' : 'stale';
}

/** A live transfer link has a row (debit or credit, live or tombstone) that import `batchId` wrote. */
export const batchHasLiveTransferLink = (spaceId: string, batchId: string | SQL) =>
	sql`exists (select 1 from transfer_links l join transactions t
		on t.id in (l.debit_transaction_id, l.credit_transaction_id)
		where l.space_id = ${spaceId} and l.undone_at is null and t.space_id = ${spaceId}
		and t.import_batch_id = ${batchId})`;

/**
 * "Urungkan impor" meets a confirmed merge: statements for `undoImportBatch`'s `db.batch`, placed after the batch
 * row changed and guarded by `batchUndoneNow` (true only then). Each live link with a row of the batch gets its
 * *other* row — the one the batch did not write — restored from its snapshot while that row still holds what the
 * merge wrote and its own import is live: the credit row comes back when the debit's import is undone while the
 * merged transfer is still live (nothing of the other statement is lost; into its wallet even when that wallet was
 * archived since, as an archived wallet keeps its rows; a merged transfer the user deleted keeps the credit deleted,
 * red team L3), the debit row becomes its expense again when the credit's import is undone. Then a probe
 * reports whether a debit edited since the merge stays a transfer into the undone credit's wallet (the user is
 * told; the row stays as the user left it), and every such link is marked undone (settled: it leaves the review's
 * "Urungkan" list). The batch's own rows are then tombstoned by the import undo as usual. Every statement starts
 * from the batch's rows (`transactions_import_batch_idx`) and the live-link indexes, never the whole space.
 * Returns `[creditRestore, debitRestore, editedTransferKept, settle]`; the third yields one row when such an
 * edited transfer stayed.
 */
export function settleTransferLinksOfBatch(
	db: Db,
	spaceId: string,
	batchId: string,
	now: number,
	batchUndoneNow: SQL
) {
	const l = transferLinks;
	const t = transactions;
	/*
	 * Plan steering (SQLite): a unary `+` keeps the space pin but stops it from picking the space-wide index, and
	 * `cross join` keeps the link outermost, so each statement walks the batch's rows and the live-link indexes.
	 */
	const inSpace = (column: SQLiteColumn) => sql`+${column} = ${spaceId}`;
	const batchRows = sql`(select bt.id from transactions bt where bt.space_id = ${spaceId}
		and bt.import_batch_id = ${batchId})`;
	const creditSnap = sql`(select l.credit_snapshot from transfer_links l
		where l.credit_transaction_id = ${t.id} and l.space_id = ${spaceId} and l.undone_at is null)`;
	const debitSnap = sql`(select l.debit_snapshot from transfer_links l
		where l.debit_transaction_id = ${t.id} and l.space_id = ${spaceId} and l.undone_at is null)`;
	return [
		db
			.update(t)
			.set(creditRestore(creditSnap, spaceId, now))
			.where(
				and(
					inSpace(t.spaceId),
					sql`${t.id} in (select l.credit_transaction_id from transfer_links l
						cross join transactions c on c.id = l.credit_transaction_id
						where +l.space_id = ${spaceId} and l.undone_at is null and l.debit_transaction_id in ${batchRows}
						and ${creditHolds(spaceId)} and ${rowImportLive('c')}
						and exists (select 1 from transactions d where d.id = l.debit_transaction_id
							and d.space_id = ${spaceId} and d.deleted_at is null))`,
					batchUndoneNow
				)
			),
		db
			.update(t)
			.set(debitRestore(debitSnap, spaceId, now))
			.where(
				and(
					inSpace(t.spaceId),
					sql`${t.id} in (select l.debit_transaction_id from transfer_links l
						cross join transactions d on d.id = l.debit_transaction_id
						where +l.space_id = ${spaceId} and l.undone_at is null and l.credit_transaction_id in ${batchRows}
						and ${debitHolds(spaceId)} and ${rowImportLive('d')})`,
					batchUndoneNow
				)
			),
		db
			.select({ id: l.id })
			.from(l)
			.where(
				and(
					inSpace(l.spaceId),
					isNull(l.undoneAt),
					sql`${l.creditTransactionId} in ${batchRows}`,
					sql`exists (select 1 from transactions d where d.id = ${l.debitTransactionId}
						and d.space_id = ${spaceId} and d.deleted_at is null and d.type = 'transfer'
						and d.transfer_to_wallet_id = json_extract(${l.creditSnapshot}, '$.walletId')
						and d.import_batch_id is not ${batchId})`,
					batchUndoneNow
				)
			)
			.limit(1),
		db
			.update(l)
			.set({
				undoneAt: now,
				updatedAt: bumpedUpdatedAt(l.updatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					inSpace(l.spaceId),
					isNull(l.undoneAt),
					sql`${l.id} in (select x.id from transfer_links x where x.undone_at is null
						and x.debit_transaction_id in ${batchRows}
						union all select x.id from transfer_links x where x.undone_at is null
						and x.credit_transaction_id in ${batchRows})`,
					batchUndoneNow
				)
			)
	] as const;
}

/** One confirmed merge the review page offers to undo. */
export interface TransferLinkSummary {
	id: string;
	createdAt: number;
	/** The transfer row's title as it is now (masked), or null when that row was deleted since. */
	title: string | null;
	amountMinor: number;
	currency: string;
	occurredOn: string;
	fromWalletId: string | null;
	toWalletId: string;
	/** FN-48d: `auto` when the statement import's auto-match pass merged it ("Otomatis"). */
	source: TransferLinkSource;
}

/** Where a page of the links list starts: below this link (its `createdAt` and `id`), older ones only. */
export interface TransferLinkCursor {
	createdAt: number;
	id: string;
}

/**
 * The space's live links, newest first, with the merged transfer row's current title, wallet and date: one page
 * of at most LINKS_LIST_MAX, older than `before` when given (QA low: every live link stays reachable to undo).
 * `next` is the cursor of the following page, or null when this page is the last.
 */
export async function listTransferLinks(
	db: Db,
	spaceId: string,
	before: TransferLinkCursor | null = null
): Promise<{ links: TransferLinkSummary[]; next: TransferLinkCursor | null }> {
	const older = before
		? sql`and (l.created_at < ${before.createdAt} or (l.created_at = ${before.createdAt} and l.id < ${before.id}))`
		: sql``;
	const rows = await db.all<TransferLinkSummary>(
		sql`select l.id, l.created_at as createdAt, d.title,
			json_extract(l.credit_snapshot, '$.amountMinor') as amountMinor,
			json_extract(l.credit_snapshot, '$.currency') as currency,
			coalesce(d.occurred_on, json_extract(l.credit_snapshot, '$.occurredOn')) as occurredOn,
			d.wallet_id as fromWalletId,
			json_extract(l.credit_snapshot, '$.walletId') as toWalletId,
			l.source as source
		from transfer_links l
		left join transactions d on d.id = l.debit_transaction_id and d.space_id = l.space_id
			and d.deleted_at is null
		where l.space_id = ${spaceId} and l.undone_at is null ${older}
		order by l.created_at desc, l.id desc
		limit ${LINKS_LIST_MAX + 1}`
	);
	const page = rows.slice(0, LINKS_LIST_MAX);
	const last = page.at(-1);
	return {
		links: page.map((r) => ({
			...r,
			title: r.title === null ? null : maskAccountNumbers(r.title)
		})),
		next: rows.length > LINKS_LIST_MAX && last ? { createdAt: last.createdAt, id: last.id } : null
	};
}
