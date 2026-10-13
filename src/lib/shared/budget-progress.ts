/**
 * How much of the month's budget is used, as a whole percent for Beranda's thin progress bar (display only;
 * the figures beside it come from the server's safe-to-spend). Rounded down, so the bar never overstates use.
 */
export function budgetUsedPercent(
	budgetMinor: number,
	safe: { kind: 'left'; remainingMinor: number } | { kind: 'spent' } | { kind: 'over' }
): number {
	if (safe.kind !== 'left' || budgetMinor <= 0) return 100;
	const used = BigInt(budgetMinor) - BigInt(safe.remainingMinor);
	if (used <= 0n) return 0;
	return Number((used * 100n) / BigInt(budgetMinor));
}
