import { msg } from './i18n.ts';

/**
 * Net worth (FN-25): what a space owns and owes beyond its wallets. Every figure here is integer or exact
 * rational arithmetic (BigInt); prices and rates arrive as decimal text and are never turned into floats.
 */

/** Item kinds. Same list as the `net_worth_items_content_check` constraint. */
export const NET_WORTH_KINDS = [
	'cash',
	'investment_stock',
	'investment_crypto',
	'investment_gold',
	'property',
	'vehicle',
	'debt',
	'other_asset'
] as const;
export type NetWorthKind = (typeof NET_WORTH_KINDS)[number];

export const NET_WORTH_KIND_LABELS: Readonly<Record<NetWorthKind, string>> = {
	cash: msg('Kas'),
	investment_stock: msg('Saham'),
	investment_crypto: msg('Kripto'),
	investment_gold: msg('Emas'),
	property: msg('Properti'),
	vehicle: msg('Kendaraan'),
	debt: msg('Utang'),
	other_asset: msg('Aset lain')
};

/** Where an item's value comes from. `manual`: the user's own figure; the others are cached prices (jobs Worker). */
export const PRICE_SOURCES = ['manual', 'indodax', 'gold_api'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/** The one automated source each kind may use (IDX stocks: none, owner decision 3). */
export const PRICED_SOURCE_OF_KIND: Readonly<Partial<Record<NetWorthKind, PriceSource>>> = {
	investment_crypto: 'indodax',
	investment_gold: 'gold_api'
};

/**
 * Decimal places a quantity keeps, per kind that has one: crypto ×10^8 (Indodax's own satoshi-level
 * precision), gold grams ×10^3. Kinds absent here carry no quantity.
 */
export const QUANTITY_SCALE: Readonly<Partial<Record<NetWorthKind, number>>> = {
	investment_crypto: 8,
	investment_gold: 3
};

/** A debt subtracts from the total; every other kind adds. */
export const isLiabilityKind = (kind: NetWorthKind) => kind === 'debt';

/** Allocation classes shown on /kekayaan (FEATURES.md FN-25 class names, plus wallets and debts). */
export const NET_WORTH_CLASSES = [
	'wallets',
	'cash',
	'investment',
	'crypto',
	'gold',
	'property',
	'debt'
] as const;
export type NetWorthClass = (typeof NET_WORTH_CLASSES)[number];

export const NET_WORTH_CLASS_LABELS: Readonly<Record<NetWorthClass, string>> = {
	wallets: msg('Dompet'),
	cash: msg('Kas'),
	investment: msg('Investasi'),
	crypto: msg('Kripto'),
	gold: msg('Emas'),
	property: msg('Properti & aset'),
	debt: msg('Utang')
};

export const CLASS_OF_KIND: Readonly<Record<NetWorthKind, NetWorthClass>> = {
	cash: 'cash',
	investment_stock: 'investment',
	investment_crypto: 'crypto',
	investment_gold: 'gold',
	property: 'property',
	vehicle: 'property',
	other_asset: 'property',
	debt: 'debt'
};

/** Grams in one troy ounce: a physical definition (exactly 31.1034768 g), not a market figure. */
export const TROY_OUNCE_GRAMS = '31.1034768';

export const NET_WORTH_NAME_MAX_LENGTH = 60;
export const NET_WORTH_NOTE_MAX_LENGTH = 200;

/** A non-negative decimal as `n / 10^exp` (exact). */
export interface Decimal {
	n: bigint;
	exp: number;
}

/** Plain decimal text (`1493387000`, `0.073354`): digits, an optional dot and up to `maxDecimals` digits. */
const DECIMAL_TEXT = /^(\d{1,24})(?:\.(\d{1,24}))?$/;

/** Decimal text → exact decimal; null for signs, exponents, separators or more than `maxDecimals` places. */
export function parseDecimal(text: string, maxDecimals: number): Decimal | null {
	const m = DECIMAL_TEXT.exec(text);
	if (!m) return null;
	const frac = m[2] ?? '';
	if (frac.length > maxDecimals) return null;
	return { n: BigInt((m[1] as string) + frac), exp: frac.length };
}

/** `a / b` rounded half away from zero (b > 0): the single rounding step of every computation here. */
export function divRound(a: bigint, b: bigint): bigint {
	if (b <= 0n) throw new RangeError('divisor must be positive');
	const q = (2n * (a < 0n ? -a : a) + b) / (2n * b);
	return a < 0n ? -q : q;
}

const pow10 = (e: number) => 10n ** BigInt(e);

/** An exact price: IDR minor units (sen) per one whole unit (coin, gram) = num / den. */
export interface UnitPrice {
	num: bigint;
	den: bigint;
}

/** Indodax quotes IDR per coin: × 100 sen. */
export function idrUnitPrice(idrPerUnit: Decimal): UnitPrice {
	return { num: idrPerUnit.n * 100n, den: pow10(idrPerUnit.exp) };
}

/** IDR sen per gram from USD per troy ounce and the USD→IDR rate: (USD/oz ÷ 31.1034768) × rate × 100. */
export function goldGramUnitPrice(usdPerOunce: Decimal, usdIdr: Decimal): UnitPrice {
	const ounce = parseDecimal(TROY_OUNCE_GRAMS, 7) as Decimal;
	return {
		num: usdPerOunce.n * usdIdr.n * 100n * pow10(ounce.exp),
		den: pow10(usdPerOunce.exp + usdIdr.exp) * ounce.n
	};
}

/** The fields of an item the value depends on. `quantityScaled` is the integer text stored in D1. */
export interface ValuedItem {
	kind: NetWorthKind;
	priceSource: PriceSource;
	quantityScaled: string | null;
	quantityScale: number | null;
	manualValueMinor: number | null;
}

/** How a value was reached: the user's figure, a cached price, or the user's figure because no price exists. */
export type ValueBasis = 'manual' | 'price' | 'fallback';

/**
 * What an item is worth, as a positive magnitude in minor units of its currency (a debt's sign is applied by
 * the caller, `isLiabilityKind`): a manual item is exactly its `manual_value_minor` (no price consulted); a
 * priced item is quantity × `price`, rounded once; without a price it falls back to its manual value. Null
 * when there is nothing to show ("Belum ada harga").
 */
export function netWorthValueMinor(
	item: ValuedItem,
	price: UnitPrice | null
): { valueMinor: bigint; basis: ValueBasis } | null {
	if (item.priceSource === 'manual')
		return item.manualValueMinor === null
			? null
			: { valueMinor: BigInt(item.manualValueMinor), basis: 'manual' };
	if (price && item.quantityScaled !== null && item.quantityScale !== null)
		return {
			valueMinor: divRound(
				BigInt(item.quantityScaled) * price.num,
				pow10(item.quantityScale) * price.den
			),
			basis: 'price'
		};
	return item.manualValueMinor === null
		? null
		: { valueMinor: BigInt(item.manualValueMinor), basis: 'fallback' };
}

/**
 * `amountMinor` (minor units of a currency with exponent `fromExp`) in IDR sen at `rate` IDR per one unit,
 * rounded once. Callers convert a whole per-currency sum, never item by item.
 */
export function convertToIdrMinor(amountMinor: bigint, fromExp: number, rate: Decimal): bigint {
	return divRound(amountMinor * rate.n * 100n, pow10(fromExp + rate.exp));
}

/**
 * A scaled quantity as decimal text with a comma (`1500000` at scale 8 → `0,015`): thousands-grouped for
 * display, ungrouped (`grouped = false`) for a form field, which `parseQuantity` reads back exactly.
 */
export function formatQuantity(quantityScaled: string, scale: number, grouped = true): string {
	const digits = quantityScaled.padStart(scale + 1, '0');
	const whole = digits.slice(0, digits.length - scale);
	const frac = digits.slice(digits.length - scale).replace(/0+$/, '');
	const wholeText = grouped ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.') : whole;
	return frac ? `${wholeText},${frac}` : wholeText;
}

/** The add/edit form's fields as typed (a refused no-JS form echoes them back; never stored as such). */
export interface NetWorthFormValues {
	kind: string;
	name: string;
	currency: string;
	priceSource: string;
	symbol: string;
	/** Decimal text, comma or dot as the decimal separator (`0,015`). */
	quantity: string;
	/** Whole units, grouped as typed (`1.250.000`). */
	manualValue: string;
	acquiredOn: string;
	note: string;
}
