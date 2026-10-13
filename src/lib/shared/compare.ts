/**
 * What the "compared with the last period" line under a total may say. Pure, so both Beranda and Laporan agree.
 *
 * `diffMinor` is this period minus the compared one, so the compared total is `current − diff`. When it is zero
 * the period has no data (the first month of use): "Rp347 rb lebih boros" would be misleading, the line says
 * there is nothing to compare with instead.
 */
export type CompareState = 'pill' | 'no-previous' | 'none';

export function compareState(currentMinor: number | null, diffMinor: number | null): CompareState {
	if (diffMinor === null) return 'none';
	// Too large to show: the compared total is unknown, the pill keeps its old behaviour.
	if (currentMinor === null) return 'pill';
	const previousMinor = currentMinor - diffMinor;
	if (previousMinor === 0) return currentMinor === 0 ? 'none' : 'no-previous';
	return 'pill';
}
