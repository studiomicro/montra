import { tileFromWords } from './merchants/dictionary.ts';
import { wibDateParts } from './dates.ts';
import type { TileKey } from './transactions.ts';
import { walletHintFromText } from './voice-parse.ts';
import type { WalletType } from './wallets.ts';

/**
 * FN-15 receipt scan ("Struk"): the figures of one read receipt and the checks the review screen and the save
 * action share, so the banner the user sees and the rule the server applies are the same code. Money is integer
 * IDR minor units throughout; a figure that was not printed or not legible is null, never guessed.
 */

/**
 * Longest side of the photo the browser sends (it re-encodes before upload): Anthropic's high-resolution vision
 * tier long edge for Claude 4.7 and later (docs.anthropic.com › Vision, re-checked 2026-10-09). Larger photos
 * would only be downscaled by the provider after costing upload time.
 */
export const RECEIPT_MAX_SIDE = 2576;
/** JPEG quality of the re-encoded photo: small enough to upload fast, sharp enough for small receipt print. */
export const RECEIPT_JPEG_QUALITY = 0.85;
/** Most item lines one receipt holds on the review screen and in a save. */
export const RECEIPT_ITEMS_MAX = 80;
/** "Baca struk" / "Baca lagi" attempts per user per throttle window (10 minutes), owner decision 8. */
export const RECEIPT_READS_PER_WINDOW = 10;
/** A read date more than this many years before today (WIB) is flagged "Periksa tanggalnya". */
export const RECEIPT_DATE_PAST_YEARS = 2;
/** Longest printed payment method kept (the FN-18 extras column). */
export const RECEIPT_PAYMENT_MAX_LENGTH = 100;

/** One printed item line: its name and line amount (null when not legible). */
export interface ReceiptItem {
	name: string;
	amountMinor: number | null;
}

/** What the server made of the model's answer, after schema validation and cleaning. */
export interface ReceiptReading {
	/** The shop name as printed ('' when not legible). */
	shop: string;
	/** WIB calendar date `YYYY-MM-DD`, or null. */
	occurredOn: string | null;
	items: ReceiptItem[];
	taxMinor: number | null;
	serviceMinor: number | null;
	discountMinor: number | null;
	totalMinor: number | null;
	/** ISO 4217 code as printed, informational only: every saved row is IDR (PRD out of scope). */
	currency: string | null;
	/** The printed payment line ('' when none), shown as text, never applied silently. */
	paymentMethod: string;
}

export type ReceiptMode = 'single' | 'split';

/** One review item as posted (echoed back on a refusal so a no-JavaScript page keeps the user's edits). */
export interface ReceiptItemValues {
	name: string;
	amount: string;
	categoryId: string;
}

/** The review form as typed, every field cut to a bounded length before any work. */
export interface ReceiptFormValues {
	mode: ReceiptMode;
	shop: string;
	occurredOn: string;
	walletId: string;
	categoryId: string;
	paymentMethod: string;
	items: ReceiptItemValues[];
	tax: string;
	service: string;
	discount: string;
	total: string;
	keepPhoto: boolean;
	acceptMismatch: boolean;
	/** Opaque proof from `read` that this photo was read (server `receipts/read-ticket.ts`); '' when none. */
	readTicket: string;
}

/** What the review screen opens with after a read. */
export interface ReceiptReview {
	values: ReceiptFormValues;
	dateCheck: ReceiptDateCheck;
	/** `item.<i>` and `total`: an amount matching a live expense on the date ±1 day ("Mungkin sudah dicatat"). */
	duplicates: string[];
	/** A row of this very photo is already saved (or was deleted after saving): a save writes nothing. */
	alreadySaved: boolean;
	/** The printed currency when it is not IDR ("Periksa totalnya": every saved row is IDR). */
	foreignCurrency: string | null;
}

/** The figures reconciliation reads (the review form's current values, or the reading). */
export interface ReceiptFigures {
	items: readonly (number | null)[];
	taxMinor: number | null;
	serviceMinor: number | null;
	discountMinor: number | null;
	totalMinor: number | null;
}

/**
 * `match`: Σ items + tax + service − discount equals the total exactly (integer minor units). `mismatch`: it
 * does not, or it cannot be checked (a missing item amount or total, or a non-IDR receipt): "Periksa totalnya".
 * `computedMinor` is null when an item amount is missing.
 */
export type ReceiptBalance =
	| { status: 'match'; computedMinor: number }
	| { status: 'mismatch'; computedMinor: number | null; totalMinor: number | null };

const big = (minor: number | null) => BigInt(minor ?? 0);

/** Exact reconciliation of a receipt (BigInt; never a float comparison). */
export function reconcileReceipt(
	f: ReceiptFigures,
	currency: string | null = 'IDR'
): ReceiptBalance {
	const known = f.items.every((a) => a !== null);
	const computed = known
		? f.items.reduce<bigint>((sum, a) => sum + big(a), 0n) +
			big(f.taxMinor) +
			big(f.serviceMinor) -
			big(f.discountMinor)
		: null;
	const computedMinor =
		computed !== null &&
		computed >= BigInt(Number.MIN_SAFE_INTEGER) &&
		computed <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(computed)
			: null;
	const idr = currency === null || currency === 'IDR';
	if (idr && computed !== null && f.totalMinor !== null && computed === BigInt(f.totalMinor))
		return { status: 'match', computedMinor: f.totalMinor };
	return { status: 'mismatch', computedMinor, totalMinor: f.totalMinor };
}

/**
 * The combined "Pajak & servis" amount of a split: tax + service − discount (missing figures count as 0). Positive:
 * one extra row; zero: no extra row; negative: the receipt cannot be split (owner decision 5).
 */
export function adjustmentsMinor(
	f: Pick<ReceiptFigures, 'taxMinor' | 'serviceMinor' | 'discountMinor'>
): number {
	return Number(big(f.taxMinor) + big(f.serviceMinor) - big(f.discountMinor));
}

/** Whether "Pisah per item" is allowed: the discount does not exceed tax plus service. */
export const canSplit = (f: Pick<ReceiptFigures, 'taxMinor' | 'serviceMinor' | 'discountMinor'>) =>
	adjustmentsMinor(f) >= 0;

export type ReceiptDateCheck = 'ok' | 'future' | 'old';

/**
 * "Periksa tanggalnya": a date after today (WIB) or more than RECEIPT_DATE_PAST_YEARS years before it. A loose
 * sanity bound, never a refusal. Both arguments are `YYYY-MM-DD` (string order is date order).
 */
export function receiptDateCheck(date: string, today: string): ReceiptDateCheck {
	if (date > today) return 'future';
	const { year, month, day } = wibDateParts(today);
	const pad = (n: number) => String(n).padStart(2, '0');
	const floor = `${String(year - RECEIPT_DATE_PAST_YEARS).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
	return date < floor ? 'old' : 'ok';
}

/**
 * The preset expense tile an item name suggests, from FN-20's shared dictionary and the keyword groups
 * (FN-06/39) behind it, tokenised like an import title: lower-cased, split at every character that is not a
 * letter or digit. Undefined: no guess.
 */
export function itemCategoryHint(name: string): TileKey | undefined {
	const words = Array.from(name.slice(0, 400))
		.slice(0, 200)
		.join('')
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w !== '');
	return tileFromWords(words, 'expense')?.tile;
}

/**
 * The wallet the review screen preselects: the IDR wallet the printed payment line names (FN-14's name/type
 * matching), else the favourite IDR wallet, else the first IDR wallet; '' when the space has none. Never saved
 * without the user seeing it.
 */
export function receiptWalletGuess(
	paymentMethod: string,
	wallets: readonly {
		id: string;
		name: string;
		type: WalletType;
		currency: string;
		isFavourite: boolean;
	}[]
): string {
	const idr = wallets.filter((w) => w.currency === 'IDR');
	const named = paymentMethod ? walletHintFromText(paymentMethod, idr) : undefined;
	return named ?? idr.find((w) => w.isFavourite)?.id ?? idr[0]?.id ?? '';
}
