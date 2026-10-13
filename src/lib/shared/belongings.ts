import { currencyExponent } from './money-format.ts';

/** Longest belonging name (FN-27), in code points after cleaning. */
export const BELONGING_NAME_MAX_LENGTH = 80;
/** Longest note on a belonging, in code points after cleaning. */
export const BELONGING_NOTE_MAX_LENGTH = 300;
/** Belongings hold IDR this pass (no per-item currency picker, like goals). */
export const BELONGING_CURRENCY = 'IDR';

/**
 * The depreciation curve (Owner decision 1): straight-line from the purchase price down to 20 % of it over
 * DEPRECIATION_DAYS days (5 × 365 + 1 leap day), then flat at that floor. Always shown as an estimate.
 */
export const DEPRECIATION_DAYS = 1826;
const FLOOR_PERCENT = 20n;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of a `YYYY-MM-DD` date (years 0001–9999); RangeError when it is not a calendar date. */
function dayNumber(date: string): number {
	const m = DATE.exec(date);
	if (!m) throw new RangeError('not a YYYY-MM-DD date');
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const at = new Date(0);
	at.setUTCFullYear(y, mo - 1, d);
	if (y < 1 || at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d)
		throw new RangeError('not a calendar date');
	return Math.floor(at.getTime() / 86_400_000);
}

/**
 * The estimated current value of an item bought for `purchasePriceMinor` on `purchasedOn` (WIB date), as of
 * `today` (WIB date): the purchase price less a straight-line share of 80 % of it, by whole days of age, capped
 * at DEPRECIATION_DAYS. Exact integer arithmetic (BigInt) in whole currency units, the loss rounded down so
 * the estimate never falls below the 20 % floor; a purchase date after `today` (a typing mistake) counts as
 * age 0. Never negative, never above the purchase price. RangeError for a negative or unsafe price or a
 * non-date.
 */
export function estimatedValueMinor(
	purchasePriceMinor: number,
	purchasedOn: string,
	today: string,
	currency: string = BELONGING_CURRENCY
): number {
	if (!Number.isSafeInteger(purchasePriceMinor) || purchasePriceMinor < 0)
		throw new RangeError('purchase price must be a non-negative safe integer');
	const age = Math.min(Math.max(dayNumber(today) - dayNumber(purchasedOn), 0), DEPRECIATION_DAYS);
	const base = 10n ** BigInt(currencyExponent(currency));
	const price = BigInt(purchasePriceMinor);
	// Whole units only: a stored price is whole units (forms.ts wholeAmountMinor), so nothing is lost here.
	const units = price / base;
	const lost = (units * (100n - FLOOR_PERCENT) * BigInt(age)) / (100n * BigInt(DEPRECIATION_DAYS));
	return Number(price - lost * base);
}

/**
 * The value a belonging counts with: the user's own figure when set, else the estimate as of `today`.
 * `estimated` tells the page to label it "Estimasi".
 */
export function belongingValue(
	item: { purchasePriceMinor: number; purchasedOn: string; currentValueMinor: number | null },
	today: string
): { valueMinor: number; estimated: boolean } {
	if (item.currentValueMinor !== null)
		return { valueMinor: item.currentValueMinor, estimated: false };
	return {
		valueMinor: estimatedValueMinor(item.purchasePriceMinor, item.purchasedOn, today),
		estimated: true
	};
}

/** The add/edit form's fields as typed (a refused no-JS form echoes them back; never stored as such). */
export interface BelongingFormValues {
	name: string;
	/** Whole units, grouped as typed (`1.250.000`). */
	purchasePrice: string;
	purchasedOn: string;
	/** Whole units; blank means "use the estimate". */
	currentValue: string;
	note: string;
}
