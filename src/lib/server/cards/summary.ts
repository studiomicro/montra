import { sql } from 'drizzle-orm';
import {
	availableCredit,
	billRemaining,
	dueChip,
	owedMinor,
	reconciliationGap,
	type DueChip
} from '#lib/shared/cards';
import type { Db } from '../db';
import { safeMinor } from '../transactions/aggregate';
import { latestCardStatements, type StoredCardStatement } from './statements';

/**
 * The card summary (FN-55a A2): computed for each live `kartu_kredit` wallet from stored rows plus the last stored
 * card statement's printed figures, in the wallet's own currency — never typed, never estimated. Callers pass the
 * cards they already listed for a space admitted through `requireSpaceAccess` (with their balances, FN-04's
 * contract); this module adds two bounded queries for all of them (ids bound once as JSON). `Data demo` rows never
 * count. A figure past the safe integer range is null ("terlalu besar"), never rounded.
 */

/** A live card wallet as the summary needs it. */
export interface CardWallet {
	id: string;
	currency: string;
	/** Opening balance plus its rows (null: too large to show). */
	balanceMinor: number | null;
	creditLimitMinor: number | null;
	dueDay: number | null;
}

export interface CardSummary {
	walletId: string;
	/** What is owed now (0 with a credit balance); null when the balance is too large. */
	owedMinor: number | null;
	/** A positive balance ("Saldo kredit"); 0 otherwise. */
	creditMinor: number | null;
	limitMinor: number | null;
	/** Limit − owed (never negative: `over`); null without a limit or a readable balance. */
	available: { kind: 'available'; minor: number | null } | { kind: 'over' } | null;
	/** The newest stored statement and what happened since it (absent: no statement stored). */
	bill: {
		statement: StoredCardStatement;
		/** Transfers into the card and `transfer`-tile income rows dated after the statement date. */
		paidMinor: number | null;
		/** max(0, printed new balance owed − paid); 0 is "Lunas". */
		remainingMinor: number | null;
		/** Expense rows minus other income rows (refunds) dated after the statement date. */
		unbilledMinor: number | null;
		/** Balance − (new balance + paid − unbilled): 0 when the wallet agrees with the bill. */
		gapMinor: number | null;
	} | null;
	due: DueChip | null;
	/** `transfer`-tile income rows in the card no "Cocokkan transfer" merged yet (owner decision 9). */
	unmatchedPayments: number;
}

/** One card's sums since its statement date, as exact decimal text (read as BigInt). */
interface SumRow {
	w: string;
	paid: string;
	spent: string;
	refunds: string;
}

/**
 * Paid, spent and refunded since each card's statement date (rows dated strictly after it: a row dated on the
 * statement date is already inside the printed balance). One query for every card with a statement.
 */
async function sinceStatement(
	db: Db,
	spaceId: string,
	items: readonly { w: string; s: string; c: string }[]
): Promise<Map<string, SumRow>> {
	const out = new Map<string, SumRow>();
	if (items.length === 0) return out;
	const f = (name: string) => sql.raw(`json_extract(j.value, '$.${name}')`);
	const base = sql`t.space_id = ${spaceId} and t.deleted_at is null and t.is_demo = 0
		and t.currency = ${f('c')} and t.occurred_on > ${f('s')}`;
	const transferTile = sql`exists (select 1 from categories k where k.id = t.category_id
		and k.space_id = ${spaceId} and k.tile_key = 'transfer')`;
	const rows = await db.all<SumRow>(sql`select ${f('w')} as w,
			cast(coalesce((select sum(t.amount_minor) from transactions t where ${base} and t.type = 'transfer'
				and t.transfer_to_wallet_id = ${f('w')}), 0)
				+ coalesce((select sum(t.amount_minor) from transactions t where ${base} and t.type = 'income'
				and t.wallet_id = ${f('w')} and ${transferTile}), 0) as text) as paid,
			cast(coalesce((select sum(t.amount_minor) from transactions t where ${base} and t.type = 'expense'
				and t.wallet_id = ${f('w')}), 0) as text) as spent,
			cast(coalesce((select sum(t.amount_minor) from transactions t where ${base} and t.type = 'income'
				and t.wallet_id = ${f('w')} and not ${transferTile}), 0) as text) as refunds
		from json_each(${JSON.stringify(items)}) j`);
	for (const r of rows) out.set(r.w, r);
	return out;
}

/** Each card's count of `transfer`-tile income rows (bill payments not merged into a transfer yet). */
async function unmatchedPayments(
	db: Db,
	spaceId: string,
	walletIds: readonly string[]
): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	if (walletIds.length === 0) return out;
	const rows = await db.all<{ w: string; n: number }>(sql`select t.wallet_id as w, count(*) as n
		from transactions t
		where t.space_id = ${spaceId} and t.deleted_at is null and t.is_demo = 0 and t.type = 'income'
			and t.wallet_id in (select value from json_each(${JSON.stringify(walletIds)}))
			and exists (select 1 from categories k where k.id = t.category_id and k.space_id = ${spaceId}
				and k.tile_key = 'transfer')
		group by t.wallet_id`);
	for (const r of rows) out.set(r.w, r.n);
	return out;
}

/** The A2 summary of each card in `cards`, in their order. `today` is the WIB date of now. */
export async function cardSummaries(
	db: Db,
	spaceId: string,
	cards: readonly CardWallet[],
	today: string
): Promise<CardSummary[]> {
	const ids = cards.map((c) => c.id);
	const [latest, unmatched] = await Promise.all([
		latestCardStatements(db, spaceId, ids),
		unmatchedPayments(db, spaceId, ids)
	]);
	const since = await sinceStatement(
		db,
		spaceId,
		cards.flatMap((c) => {
			const s = latest.get(c.id);
			return s ? [{ w: c.id, s: s.statementDate, c: c.currency }] : [];
		})
	);
	return cards.map((c): CardSummary => {
		const balance = c.balanceMinor;
		const statement = latest.get(c.id) ?? null;
		const sums = since.get(c.id);
		let bill: CardSummary['bill'] = null;
		if (statement && sums) {
			const paid = BigInt(sums.paid);
			const unbilled = BigInt(sums.spent) - BigInt(sums.refunds);
			const remaining = billRemaining(statement.newBalanceMinor, paid);
			bill = {
				statement,
				paidMinor: safeMinor(paid),
				remainingMinor: safeMinor(remaining),
				unbilledMinor: safeMinor(unbilled),
				gapMinor:
					balance === null
						? null
						: safeMinor(reconciliationGap(balance, statement.newBalanceMinor, paid, unbilled))
			};
		}
		const available = balance === null ? null : availableCredit(c.creditLimitMinor, balance);
		const outstanding = bill !== null && bill.remainingMinor !== 0;
		return {
			walletId: c.id,
			owedMinor: balance === null ? null : safeMinor(owedMinor(balance)),
			creditMinor: balance === null ? null : Math.max(balance, 0),
			limitMinor: c.creditLimitMinor,
			available:
				available === null
					? null
					: available.kind === 'over'
						? { kind: 'over' }
						: { kind: 'available', minor: safeMinor(available.minor) },
			bill,
			due: dueChip(today, statement?.dueDate ?? null, outstanding, c.dueDay),
			unmatchedPayments: unmatched.get(c.id) ?? 0
		};
	});
}
