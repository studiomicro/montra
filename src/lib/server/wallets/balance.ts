/**
 * A wallet's balance in its own currency's minor units: the opening balance plus the signed sum of the wallet's
 * live transactions (FN-05 passes that sum, computed in SQL for the same currency; until then every caller
 * passes 0). The shape of this function is the contract FN-05 builds against: do not change it.
 */
export function walletBalanceMinor(
	wallet: { openingBalanceMinor: number },
	transactionsSumMinor = 0
): number {
	const balance = wallet.openingBalanceMinor + transactionsSumMinor;
	if (!Number.isSafeInteger(balance)) throw new RangeError('wallet balance out of range');
	return balance;
}

/**
 * The balance to show for `walletTransactionsSums`' entry `sum`, or null ("too large") when it is outside the
 * safe integer range: never a failed page.
 */
export function shownBalance(
	wallet: { openingBalanceMinor: number },
	sum: number | null | undefined
): number | null {
	if (sum === null) return null;
	try {
		return walletBalanceMinor(wallet, sum ?? 0);
	} catch (e) {
		if (e instanceof RangeError) return null;
		throw e;
	}
}

/** One currency's total of wallet balances; null when a balance or the sum is too large to show. */
export interface BalanceTotal {
	currency: string;
	totalMinor: number | null;
}

/**
 * The balances of `wallets` summed per currency, never across currencies (Dompet's "Total saldo"): `first`
 * (the hero's currency) leads, the others follow by code. Exact BigInt sums; a null balance makes its currency's
 * total null (too large to show), never a rounded figure.
 */
export function balanceTotals(
	wallets: readonly { currency: string; balanceMinor: number | null }[],
	first: string
): BalanceTotal[] {
	const sums = new Map<string, bigint | null>();
	for (const w of wallets) {
		const prev = sums.has(w.currency) ? (sums.get(w.currency) ?? null) : 0n;
		sums.set(
			w.currency,
			prev === null || w.balanceMinor === null ? null : prev + BigInt(w.balanceMinor)
		);
	}
	const max = BigInt(Number.MAX_SAFE_INTEGER);
	return [...sums]
		.map(([currency, sum]) => ({
			currency,
			totalMinor: sum === null || sum > max || sum < -max ? null : Number(sum)
		}))
		.sort((a, b) =>
			a.currency === first ? -1 : b.currency === first ? 1 : a.currency < b.currency ? -1 : 1
		);
}
