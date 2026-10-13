import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db';
import { safeMinor } from './aggregate';

/**
 * A live row's signed effect on its own wallet (`wallet_id`, table alias `t`): + income, − expense, − a transfer
 * out, and a balance adjustment (FN-37) by its direction. The one place an adjustment counts: it moves the
 * wallet's balance, never spending, income, a budget or a report (aggregate.ts sums expense and income only).
 */
const OWN_WALLET_DELTA = sql`case t.type when 'income' then t.amount_minor
	when 'adjustment' then (case t.adjustment_direction when 'increase' then t.amount_minor else -t.amount_minor end)
	else -t.amount_minor end`;

/**
 * Each wallet's signed transaction sum in its own currency's minor units, for `walletBalanceMinor(wallet,
 * sums.get(wallet.id) ?? 0)` (FN-04's contract): + income, − expense, − a transfer out, + a transfer in, ± a
 * balance adjustment. One grouped SQL query over the space's live rows; only rows in the wallet's own currency
 * count (a wallet's rows always are: transactions copy the wallet's currency and a wallet with transactions
 * keeps its currency). `Data demo` rows never count. Wallets without transactions are absent; a sum past the
 * safe integer range is `null` (shown as too large, never a failed page). With `upTo` (a WIB date, FN-23's
 * year-end balances) only rows with `occurred_on <= upTo` count; without it every live row counts, as before.
 */
export async function walletTransactionsSums(
	db: Db,
	spaceId: string,
	upTo?: string
): Promise<Map<string, number | null>> {
	const until = upTo === undefined ? sql`` : sql` and t.occurred_on <= ${upTo}`;
	const rows = await db.all<{ wallet_id: string; total: string }>(sql`select m.wallet_id,
			cast(sum(m.delta) as text) as total
		from (
			select t.wallet_id as wallet_id, t.currency as currency, ${OWN_WALLET_DELTA} as delta
			from transactions t
			where t.space_id = ${spaceId} and t.deleted_at is null and t.is_demo = 0${until}
			union all
			select t.transfer_to_wallet_id, t.currency, t.amount_minor
			from transactions t
			where t.space_id = ${spaceId} and t.deleted_at is null and t.is_demo = 0 and t.type = 'transfer'${until}
		) m
		join wallets w on w.id = m.wallet_id and w.space_id = ${spaceId} and w.currency = m.currency
		group by m.wallet_id`);
	const sums = new Map<string, number | null>();
	for (const r of rows) sums.set(r.wallet_id, safeMinor(BigInt(r.total)));
	return sums;
}

/**
 * SQL, inside a query over `wallets w`: the signed sum of the wallet's live, real rows in its own currency (the
 * same effect as `walletTransactionsSums`), only rows matching `filter` (`and …` over `t`), 0 when none.
 */
const walletDeltaSum = (filter: SQL) => sql`coalesce((select sum(case when t.wallet_id = w.id
			then ${OWN_WALLET_DELTA} else t.amount_minor end)
		from transactions t
		where t.space_id = w.space_id and t.deleted_at is null and t.is_demo = 0
			and t.currency = w.currency
			and (t.wallet_id = w.id or (t.type = 'transfer' and t.transfer_to_wallet_id = w.id))${filter}), 0)`;

/**
 * SQL scalar: one live wallet's balance now (opening balance plus the same signed sum as
 * `walletTransactionsSums`), null when the wallet is not live in `spaceId`. Used both to read the balance an
 * adjustment starts from and, inside the adjustment's insert, to check it is still that balance (FN-37).
 */
export function walletBalanceSql(spaceId: string, walletId: string): SQL {
	return sql`(select w.opening_balance_minor + ${walletDeltaSum(sql``)}
		from wallets w
		where w.id = ${walletId} and w.space_id = ${spaceId} and w.deleted_at is null)`;
}

/**
 * SQL scalar (FN-48 Part B): what a live wallet's rows add up to over a WIB date window, null when the wallet is
 * not live in `spaceId`. With `from` NULL: the wallet's balance before `before` (opening balance plus every row
 * dated earlier). With `from` set: only the rows dated `from` ≤ date < `before` (no opening balance), leaving out
 * the rows of the import batch `excludeBatch` (when not NULL). Either way a merged own transfer whose credit row
 * came from `excludeBatch` or `ownBatch` is left out (FN-48 Part C QA low). Each argument is an SQL expression (a bound value
 * or a column of the caller's query), so one shape serves a JSON-driven listing and a guarded insert alike.
 */
export function walletWindowSql(
	spaceId: string,
	window: { walletId: SQL; from: SQL; before: SQL; excludeBatch: SQL; ownBatch: SQL }
): SQL {
	const { walletId, from, before, excludeBatch, ownBatch } = window;
	// A merged own transfer (FN-48 Part C) keeps the debit's date; its credit side was a row of the statement
	// `ownBatch` or `excludeBatch`, so it already sits inside a printed balance and is not counted again here.
	const filter = sql` and t.occurred_on < ${before} and (${from} is null or t.occurred_on >= ${from})
		and (${excludeBatch} is null or t.import_batch_id is null or t.import_batch_id <> ${excludeBatch})
		and not exists (select 1 from transfer_links l join transactions c on c.id = l.credit_transaction_id
			where l.debit_transaction_id = t.id and l.space_id = ${spaceId} and l.undone_at is null
			and c.space_id = ${spaceId} and c.import_batch_id in (${excludeBatch}, ${ownBatch}))`;
	return sql`(select (case when ${from} is null then w.opening_balance_minor else 0 end) + ${walletDeltaSum(filter)}
		from wallets w
		where w.id = ${walletId} and w.space_id = ${spaceId} and w.deleted_at is null)`;
}

/** One live wallet's exact balance now (BigInt, never rounded); null when it is not live in `spaceId`. */
export async function readWalletBalance(
	db: Db,
	spaceId: string,
	walletId: string
): Promise<bigint | null> {
	const row = await db.get<{ balance: string | null }>(
		sql`select cast(${walletBalanceSql(spaceId, walletId)} as text) as balance`
	);
	return row?.balance == null ? null : BigInt(row.balance);
}
