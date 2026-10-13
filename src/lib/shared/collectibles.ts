/** Longest collectible name (FN-28), in code points after cleaning. */
export const COLLECTIBLE_NAME_MAX_LENGTH = 80;
/** Longest note on a collectible, in code points after cleaning. */
export const COLLECTIBLE_NOTE_MAX_LENGTH = 300;
/** Collectibles hold IDR this pass (no per-item currency picker, like belongings). */
export const COLLECTIBLE_CURRENCY = 'IDR';

/**
 * The gain of a collectible: its current value less what it cost, an exact integer in minor units (both inputs
 * are safe integers of at most 15 digits, so the difference is too). Negative is a loss.
 */
export function collectibleGainMinor(item: {
	valueMinor: number;
	purchasePriceMinor: number;
}): number {
	if (!Number.isSafeInteger(item.valueMinor) || !Number.isSafeInteger(item.purchasePriceMinor))
		throw new RangeError('amounts must be safe integers');
	return item.valueMinor - item.purchasePriceMinor;
}

/**
 * The gain as a percentage of the purchase price in tenths of a percent (`125` = 12,5 %), rounded toward zero,
 * exact (BigInt); null when the item cost nothing (a gift: no percentage). Display only, never stored: the
 * rupiah figure is the primary one (design system: rupiah, not percent).
 */
export function gainPermille(gainMinor: number, purchasePriceMinor: number): number | null {
	if (purchasePriceMinor <= 0) return null;
	return Number((BigInt(gainMinor) * 1000n) / BigInt(purchasePriceMinor));
}

/** `125` → `+12,5%`, `-30` → `−3%`, `0` → `0%` (U+2212 for a loss, Indonesian decimal comma). */
export function formatPermille(permille: number): string {
	const sign = permille > 0 ? '+' : permille < 0 ? '−' : '';
	const abs = Math.abs(permille);
	const whole = Math.trunc(abs / 10)
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
	const tenth = abs % 10;
	return `${sign}${whole}${tenth === 0 ? '' : `,${tenth}`}%`;
}

/** The add/edit form's fields as typed (a refused no-JS form echoes them back; never stored as such). */
export interface CollectibleFormValues {
	name: string;
	/** Whole units, grouped as typed (`1.250.000`). */
	purchasePrice: string;
	purchasedOn: string;
	/** Whole units: the user's own current value. */
	currentValue: string;
	note: string;
}
