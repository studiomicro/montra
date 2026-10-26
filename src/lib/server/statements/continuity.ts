import { sql, type SQL } from 'drizzle-orm';
import { addDays } from '#lib/shared/dates';
import type { CardStatementFigures, StatementParse } from '#lib/shared/statements/types';
import type { Db } from '../db';
import type { SpaceScope } from '../spaces/access';
import { safeMinor } from '../transactions/aggregate';
import { createTransaction, MANUAL } from '../transactions/repo';
import { adjustmentFor, type TransactionInput } from '../transactions/validation';
import { walletWindowSql } from '../transactions/wallet-sum';

/**
 * Statement continuity per wallet (FN-48 Part B). Each statement batch records the wallet its rows went to, the
 * WIB dates of the statement's first and last row and the balances it printed. A statement's printed Saldo Awal
 * must equal the nearest earlier statement's printed Saldo Akhir of the same wallet (plus any row of that wallet
 * dated between the two, such as the adjustment this module offers); with no earlier statement, it must equal the
 * wallet's own balance before the statement's first day. A mismatch is a gap, shown with both figures; the user
 * may close it with one FN-37 balance-adjustment row dated the day before the statement. Only stored rows and
 * printed figures are used: no claim is made when a figure is missing, and periods that overlap are never
 * compared. Batches are ordered by date, never by import order; continuity never crosses wallets.
 */

/** Most statement batches one check reads (newest periods first); older ones are then never guessed about. */
const CONTINUITY_BATCH_MAX = 1000;
/** Most breaks the /impor page lists. */
const CONTINUITY_LIST_MAX = 20;
/** Time of day an adjustment closing a gap is recorded at: the end of the day before the statement. */
const ADJUSTMENT_TIME = '23:59';

/** A statement's own span and printed balances, before or after it is stored. */
export interface StatementSpan {
	periodFrom: string;
	periodTo: string;
	openingBalanceMinor: number | null;
	closingBalanceMinor: number | null;
}

/** A stored statement batch of one wallet, as the check reads it. */
export interface StoredStatement extends StatementSpan {
	id: string;
	walletId: string;
	createdAt: number;
}

/**
 * FN-55b: a card statement's span, never its min/max transaction date (a purchase dated in the previous cycle may
 * post in this one): the printed period; else, with only the statement date printed, the day after the previous
 * stored card statement's date to the statement date; else the earliest printed posting date to the statement date
 * (the statement date alone when none is printed). Balances in the wallet's convention, as printed.
 */
export function cardStatementSpan(
	card: CardStatementFigures,
	previousStatementDate: string | null
): StatementSpan {
	const to = card.periodTo ?? card.statementDate;
	const from =
		card.periodFrom ??
		(previousStatementDate !== null && previousStatementDate < to
			? addDays(previousStatementDate, 1)
			: (card.firstPostingDate ?? to));
	return {
		periodFrom: from <= to ? from : to,
		periodTo: to,
		openingBalanceMinor: card.previousBalanceMinor,
		closingBalanceMinor: card.newBalanceMinor
	};
}

/**
 * The span a statement records (null when it has no readable row): the WIB dates of its first and last readable
 * row — every readable row, written or not, since the printed Saldo Awal is the balance before the statement's
 * first row even when that row was left out as a duplicate — and its printed balances. The closing balance is
 * dropped when rows were cut (`truncated`): it then belongs to rows this import never read.
 */
export function statementSpan(parse: StatementParse, truncated: boolean): StatementSpan | null {
	let from: string | null = null;
	let to: string | null = null;
	for (const r of parse.rows) {
		if (!r.ok) continue;
		const d = r.value.date;
		if (from === null || d < from) from = d;
		if (to === null || d > to) to = d;
	}
	if (from === null || to === null) return null;
	return {
		periodFrom: from,
		periodTo: to,
		openingBalanceMinor: parse.openingBalanceMinor,
		closingBalanceMinor: truncated ? null : parse.closingBalanceMinor
	};
}

/** What the check compares a statement with. */
export type ContinuityPlan =
	/** No claim: the statement or its predecessor printed no balance, or older batches were not read. */
	| { kind: 'none' }
	/** Another statement of the wallet covers some of the same days: never compared. */
	| { kind: 'overlap' }
	/** No earlier statement: the wallet's own balance before the first day. */
	| { kind: 'wallet' }
	/** The nearest earlier statement by date (its printed closing balance). */
	| { kind: 'statement'; previous: StoredStatement & { closingBalanceMinor: number } };

/** The same statement imported again (same days, same printed balances): never compared with itself. */
const sameStatement = (a: StatementSpan, b: StatementSpan) =>
	a.periodFrom === b.periodFrom &&
	a.periodTo === b.periodTo &&
	a.openingBalanceMinor === b.openingBalanceMinor &&
	a.closingBalanceMinor === b.closingBalanceMinor;

/** Newest first by end date, then start date, import time and id (the guarded insert orders the same way). */
const byRecency = (a: StoredStatement, b: StoredStatement) =>
	a.periodTo !== b.periodTo
		? a.periodTo < b.periodTo
			? 1
			: -1
		: a.periodFrom !== b.periodFrom
			? a.periodFrom < b.periodFrom
				? 1
				: -1
			: a.createdAt !== b.createdAt
				? b.createdAt - a.createdAt
				: a.id < b.id
					? 1
					: -1;

/**
 * What `candidate` (stored, with its id, or not yet stored) is compared with among `stored`, the same wallet's
 * live statement batches. `complete`: false when older batches were cut by CONTINUITY_BATCH_MAX (then a statement
 * with no earlier one in the list makes no claim, rather than being compared with the wallet's balance).
 */
export function planContinuity(
	candidate: StatementSpan & { id: string | null },
	stored: readonly StoredStatement[],
	complete = true,
	card = false
): ContinuityPlan {
	if (candidate.openingBalanceMinor === null) return { kind: 'none' };
	const others = stored.filter((b) => b.id !== candidate.id && !sameStatement(b, candidate));
	if (others.some((b) => b.periodFrom <= candidate.periodTo && b.periodTo >= candidate.periodFrom))
		return { kind: 'overlap' };
	const previous = others.filter((b) => b.periodTo < candidate.periodFrom).sort(byRecency)[0];
	// FN-55b: a card statement connects statement to statement only; the first one makes no claim (its wallet
	// balance is shown for information).
	if (!previous) return complete && !card ? { kind: 'wallet' } : { kind: 'none' };
	const closing = previous.closingBalanceMinor;
	if (closing === null) return { kind: 'none' };
	return { kind: 'statement', previous: { ...previous, closingBalanceMinor: closing } };
}

/** A statement's continuity, as /impor shows it. */
export type Continuity =
	| { status: 'none' }
	| { status: 'overlap' }
	| { status: 'pass'; against: 'wallet' | 'statement' }
	| {
			status: 'gap';
			against: 'wallet' | 'statement';
			/** The statement's first day: the gap lies before it. */
			periodFrom: string;
			/** The earlier statement's last day (`statement`), else null. */
			previousPeriodTo: string | null;
			/** The printed Saldo Awal. */
			openingMinor: number;
			/** What the wallet or the earlier statement says the balance was. */
			expectedMinor: number;
			/** `openingMinor − expectedMinor`: what an adjustment would add (negative: take away). */
			gapMinor: number;
			/** The adjustment's date: the day before `periodFrom`. */
			adjustOn: string;
	  };

/** The window a plan sums over, as one JSON item of `windowTotals`. */
interface WindowItem {
	i: number;
	w: string;
	lo: string | null;
	hi: string;
	ex: string | null;
	/** The checked statement's own batch (null for a preview). */
	own: string | null;
}

function windowOf(
	i: number,
	walletId: string,
	span: StatementSpan & { id: string | null },
	plan: ContinuityPlan
): WindowItem | null {
	if (plan.kind === 'wallet')
		return { i, w: walletId, lo: null, hi: span.periodFrom, ex: null, own: span.id };
	if (plan.kind === 'statement')
		return {
			i,
			w: walletId,
			lo: plan.previous.periodTo,
			hi: span.periodFrom,
			ex: plan.previous.id,
			own: span.id
		};
	return null;
}

/** Each window's total (exact, as BigInt; null for a wallet no longer live), in one bounded query. */
async function windowTotals(
	db: Db,
	spaceId: string,
	items: readonly WindowItem[]
): Promise<Map<number, bigint | null>> {
	const totals = new Map<number, bigint | null>();
	if (items.length === 0) return totals;
	const field = (name: string) => sql`json_extract(j.value, ${`$.${name}`})`;
	const rows = await db.all<{ i: number; total: string | null }>(sql`select ${field('i')} as i,
			cast(${walletWindowSql(spaceId, {
				walletId: field('w'),
				from: field('lo'),
				before: field('hi'),
				excludeBatch: field('ex'),
				ownBatch: field('own')
			})} as text) as total
		from json_each(${JSON.stringify(items)}) j`);
	for (const r of rows) totals.set(Number(r.i), r.total === null ? null : BigInt(r.total));
	return totals;
}

/** The result of a plan given its window's total. */
function resultOf(span: StatementSpan, plan: ContinuityPlan, total: bigint | null): Continuity {
	if (plan.kind === 'none' || span.openingBalanceMinor === null) return { status: 'none' };
	if (plan.kind === 'overlap') return { status: 'overlap' };
	if (total === null) return { status: 'none' };
	const expected = safeMinor(
		plan.kind === 'statement' ? BigInt(plan.previous.closingBalanceMinor) + total : total
	);
	if (expected === null) return { status: 'none' };
	const gap = safeMinor(BigInt(span.openingBalanceMinor) - BigInt(expected));
	if (gap === null) return { status: 'none' };
	if (gap === 0) return { status: 'pass', against: plan.kind };
	return {
		status: 'gap',
		against: plan.kind,
		periodFrom: span.periodFrom,
		previousPeriodTo: plan.kind === 'statement' ? plan.previous.periodTo : null,
		openingMinor: span.openingBalanceMinor,
		expectedMinor: expected,
		gapMinor: gap,
		adjustOn: addDays(span.periodFrom, -1)
	};
}

interface StoredRow {
	id: string;
	wallet_id: string;
	wallet_name: string;
	wallet_type: string;
	period_from: string;
	period_to: string;
	opening_balance_minor: number | null;
	closing_balance_minor: number | null;
	created_at: number;
}

/** Whether `walletId` is a live `kartu_kredit` wallet of the space (its statements connect statement to statement). */
async function isCardWallet(db: Db, spaceId: string, walletId: string): Promise<boolean> {
	const row = await db.get<{ n: number }>(sql`select count(*) as n from wallets
		where id = ${walletId} and space_id = ${spaceId} and deleted_at is null and type = 'kartu_kredit'`);
	return (row?.n ?? 0) > 0;
}

/**
 * The space's live statement batches with a recorded span whose wallet is a live IDR wallet of the space
 * (optionally one wallet), newest periods first, at most CONTINUITY_BATCH_MAX (`complete`: none were cut).
 */
async function storedStatements(db: Db, spaceId: string, walletId: string | null) {
	const rows =
		await db.all<StoredRow>(sql`select b.id, b.wallet_id, w.name as wallet_name, w.type as wallet_type, b.period_from,
			b.period_to, b.opening_balance_minor, b.closing_balance_minor, b.created_at
		from import_batches b
		join wallets w on w.id = b.wallet_id and w.space_id = ${spaceId} and w.deleted_at is null
			and w.currency = 'IDR'
		where b.space_id = ${spaceId} and b.source = 'statement' and b.undone_at is null
			and b.deleted_at is null and b.period_from is not null and b.period_to is not null
			${walletId === null ? sql`` : sql`and b.wallet_id = ${walletId}`}
		order by b.period_from desc, b.period_to desc, b.created_at desc, b.id desc
		limit ${CONTINUITY_BATCH_MAX + 1}`);
	const complete = rows.length <= CONTINUITY_BATCH_MAX;
	const batches = rows.slice(0, CONTINUITY_BATCH_MAX).map((r) => ({
		id: r.id,
		walletId: r.wallet_id,
		walletName: r.wallet_name,
		card: r.wallet_type === 'kartu_kredit',
		periodFrom: r.period_from,
		periodTo: r.period_to,
		openingBalanceMinor: r.opening_balance_minor,
		closingBalanceMinor: r.closing_balance_minor,
		createdAt: r.created_at
	}));
	return { batches, complete };
}

/**
 * The continuity of a statement about to be imported (preview) or just imported (`candidate.id` set) into
 * `walletId`. No claim without a live IDR wallet of the space.
 */
export async function checkStatement(
	db: Db,
	spaceId: string,
	walletId: string,
	candidate: StatementSpan & { id: string | null }
): Promise<Continuity> {
	// A wallet that is not a live IDR wallet of the space has no batches here and no window total: no claim.
	const { batches, complete } = await storedStatements(db, spaceId, walletId);
	const plan = planContinuity(
		candidate,
		batches,
		complete,
		await isCardWallet(db, spaceId, walletId)
	);
	const item = windowOf(0, walletId, candidate, plan);
	const totals = await windowTotals(db, spaceId, item ? [item] : []);
	return resultOf(candidate, plan, totals.get(0) ?? null);
}

/** One break /impor lists: a stored statement whose continuity is a gap or an overlap. */
export type ContinuityBreak = {
	batchId: string;
	walletId: string;
	walletName: string;
	periodFrom: string;
	periodTo: string;
} & (Extract<Continuity, { status: 'gap' }> | { status: 'overlap' });

/**
 * Every break among the space's live statement batches, per wallet and by date (most recent period first, at
 * most CONTINUITY_LIST_MAX): one bounded read of the batches and one query for all the windows.
 */
export async function continuityBreaks(db: Db, spaceId: string): Promise<ContinuityBreak[]> {
	const { batches, complete } = await storedStatements(db, spaceId, null);
	const byWallet = new Map<string, StoredStatement[]>();
	for (const b of batches) byWallet.set(b.walletId, [...(byWallet.get(b.walletId) ?? []), b]);
	const plans = batches.map((b) =>
		planContinuity(b, byWallet.get(b.walletId) ?? [], complete, b.card)
	);
	const items = batches.flatMap((b, i) => windowOf(i, b.walletId, b, plans[i]!) ?? []);
	const totals = await windowTotals(db, spaceId, items);
	const breaks: ContinuityBreak[] = [];
	batches.forEach((b, i) => {
		const result = resultOf(b, plans[i]!, totals.get(i) ?? null);
		if (result.status !== 'gap' && result.status !== 'overlap') return;
		breaks.push({
			...result,
			batchId: b.id,
			walletId: b.walletId,
			walletName: b.walletName,
			periodFrom: b.periodFrom,
			periodTo: b.periodTo
		});
	});
	return breaks.slice(0, CONTINUITY_LIST_MAX);
}

/**
 * `ok`: the adjustment was written (`id`). `already`: there is no gap any more (closed meanwhile, by another tab or
 * another member: nothing written, not an error). `stale`: the gap is not the one the page showed. `missing`: no
 * live statement batch of this space with that id. `limit`/`too_large`: refused, nothing written.
 */
export type CloseGapResult =
	| { ok: true; id: string }
	| { ok: false; reason: 'already' | 'stale' | 'missing' | 'limit' | 'too_large' };

/** The batch's stored span and wallet, only when it is a live statement batch of the space with a span. */
async function storedBatch(db: Db, spaceId: string, batchId: string) {
	return db.get<{
		wallet_id: string;
		period_from: string;
		period_to: string;
		opening_balance_minor: number | null;
		closing_balance_minor: number | null;
	}>(sql`select wallet_id, period_from, period_to, opening_balance_minor, closing_balance_minor
		from import_batches
		where id = ${batchId} and space_id = ${spaceId} and source = 'statement' and undone_at is null
			and deleted_at is null and wallet_id is not null and period_from is not null and period_to is not null`);
}

const int = (n: number) => sql`cast(${n.toString()} as integer)`;

/**
 * "Catat penyesuaian" (FN-48 Part B, owner decision 13): closes the gap of the statement batch `batchId` with one
 * FN-37 balance-adjustment row on its wallet, dated the day before the statement, for exactly the gap — written
 * through FN-05's one insert path (`createTransaction`, like FN-37's own form), never an edit of the wallet's
 * opening balance. The gap is checked again on the server (never taken from the page except to detect a stale
 * page: `expectedGapMinor`), and the insert only goes through while, inside the same statement, the batch is
 * still live, its earlier statement is still the same one and the gap is still exactly that amount — so two
 * confirmations (two tabs, two members) write one row; the second finds no gap. Deleting the row (FN-05's delete)
 * undoes it and the gap shows again.
 */
export async function closeContinuityGap(
	db: Db,
	scope: SpaceScope,
	batchId: string,
	expectedGapMinor: number,
	now: number
): Promise<CloseGapResult> {
	const { spaceId } = scope;
	const batch = await storedBatch(db, spaceId, batchId);
	if (!batch) return { ok: false, reason: 'missing' };
	const span: StatementSpan & { id: string } = {
		id: batchId,
		periodFrom: batch.period_from,
		periodTo: batch.period_to,
		openingBalanceMinor: batch.opening_balance_minor,
		closingBalanceMinor: batch.closing_balance_minor
	};
	const walletId = batch.wallet_id;
	const { batches, complete } = await storedStatements(db, spaceId, walletId);
	const plan = planContinuity(span, batches, complete, await isCardWallet(db, spaceId, walletId));
	const item = windowOf(0, walletId, span, plan);
	const totals = await windowTotals(db, spaceId, item ? [item] : []);
	const result = resultOf(span, plan, totals.get(0) ?? null);
	if (result.status !== 'gap' || !item || plan.kind === 'none' || plan.kind === 'overlap')
		return { ok: false, reason: 'already' };
	if (result.gapMinor !== expectedGapMinor) return { ok: false, reason: 'stale' };
	const diff = adjustmentFor(result.openingMinor, BigInt(result.expectedMinor));
	if (!diff.ok) return { ok: false, reason: 'too_large' };

	const previousId = plan.kind === 'statement' ? plan.previous.id : '';
	const window = walletWindowSql(spaceId, {
		walletId: sql`${walletId}`,
		from: sql`${item.lo}`,
		before: sql`${item.hi}`,
		excludeBatch: sql`${item.ex}`,
		ownBatch: sql`${item.own}`
	});
	const expected: SQL =
		plan.kind === 'statement'
			? sql`(${int(plan.previous.closingBalanceMinor)} + ${window})`
			: window;
	const guard = sql`exists (select 1 from import_batches c where c.id = ${batchId} and c.space_id = ${spaceId}
			and c.source = 'statement' and c.undone_at is null and c.deleted_at is null
			and c.wallet_id = ${walletId} and c.period_from = ${span.periodFrom}
			and c.opening_balance_minor = ${int(result.openingMinor)})
		and coalesce((select b.id from import_batches b where b.space_id = ${spaceId} and b.wallet_id = ${walletId}
			and b.source = 'statement' and b.undone_at is null and b.deleted_at is null
			and b.period_from is not null and b.period_to < ${span.periodFrom} and b.id <> ${batchId}
			order by b.period_to desc, b.period_from desc, b.created_at desc, b.id desc limit 1), '') = ${previousId}
		and ${int(result.openingMinor)} - ${expected} = ${int(result.gapMinor)}`;
	const input: TransactionInput = {
		type: 'adjustment',
		amountMinor: diff.amountMinor,
		currency: 'IDR',
		walletId,
		transferToWalletId: null,
		categoryId: null,
		adjustmentDirection: diff.direction,
		title: null,
		note: null,
		occurredOn: result.adjustOn,
		occurredTime: ADJUSTMENT_TIME
	};
	const created = await createTransaction(db, scope, input, now, MANUAL, guard);
	if (created.ok) return { ok: true, id: created.id };
	if (created.reason === 'limit') return { ok: false, reason: 'limit' };
	// Nothing written: the gap closed or moved meanwhile, or the batch, wallet or membership went.
	const again = await storedBatch(db, spaceId, batchId);
	if (!again) return { ok: false, reason: 'missing' };
	const after = await checkStatement(db, spaceId, walletId, span);
	return { ok: false, reason: after.status === 'gap' ? 'stale' : 'already' };
}
