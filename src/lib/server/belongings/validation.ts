import { z } from 'zod';
import {
	BELONGING_CURRENCY,
	BELONGING_NAME_MAX_LENGTH,
	BELONGING_NOTE_MAX_LENGTH,
	type BelongingFormValues
} from '#lib/shared/belongings';
import { wibDateParts } from '#lib/shared/dates';
import { cleanText } from '#lib/shared/text';
import { textField, wholeAmountMinor } from '../forms';
import {
	NAME_INVALID,
	NOTE_INVALID,
	PRICE_INVALID,
	PURCHASED_ON_INVALID,
	VALUE_INVALID
} from './messages';

/** Earliest purchase date accepted: older heirlooms are still entered, just not as year 0001. */
const EARLIEST_PURCHASE = '1950-01-01';

const codePoints = (text: string) => Array.from(text).length;
const wholeMinor = (message: string) =>
	z.number().int(message).nonnegative(message).refine(Number.isSafeInteger, message);

/**
 * A real calendar date `YYYY-MM-DD` from 1950-01-01 up to `today` (WIB); string compare is date order. Shared
 * with FN-28 collectibles.
 */
export function isPurchaseDate(value: string, today: string): boolean {
	try {
		wibDateParts(value);
	} catch {
		return false;
	}
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= EARLIEST_PURCHASE && value <= today;
}

const schema = (today: string) =>
	z.object({
		name: z
			.string()
			.min(1, NAME_INVALID)
			.refine((s) => codePoints(s) <= BELONGING_NAME_MAX_LENGTH, NAME_INVALID),
		purchasePriceMinor: wholeMinor(PRICE_INVALID),
		purchasedOn: z.string().refine((v) => isPurchaseDate(v, today), PURCHASED_ON_INVALID),
		currentValueMinor: wholeMinor(VALUE_INVALID).nullable(),
		note: z
			.string()
			.refine((s) => codePoints(s) <= BELONGING_NOTE_MAX_LENGTH, NOTE_INVALID)
			.nullable()
	});
export type BelongingInput = z.infer<ReturnType<typeof schema>>;
export type BelongingField = keyof BelongingInput;

type Parsed =
	| { ok: true; value: BelongingInput }
	| { ok: false; errors: Partial<Record<BelongingField, string>>; values: BelongingFormValues };

/** The fields as typed, bounded, for echoing a refused no-JS form back. */
export function belongingFormValues(form: FormData): BelongingFormValues {
	return {
		name: textField(form, 'name').slice(0, BELONGING_NAME_MAX_LENGTH * 4),
		purchasePrice: textField(form, 'purchasePrice').slice(0, 64),
		purchasedOn: textField(form, 'purchasedOn').slice(0, 16),
		currentValue: textField(form, 'currentValue').slice(0, 64),
		note: textField(form, 'note').slice(0, BELONGING_NOTE_MAX_LENGTH * 4)
	};
}

/**
 * The add/edit form → a validated belonging, or field errors (msg() phrases). Name and note are stripped of
 * control and zero-width characters (one code point past the cap kept, so an over-long value is refused, never
 * cut). The purchase price is required whole IDR units (`1.250.000`, 0 allowed for a gift); the current value
 * is optional (blank = use the estimate); decimals, signs and exponents are refused, never reinterpreted; both
 * at most 13 digits. The purchase date is a real date from 1950 up to `today` (WIB).
 */
export function parseBelongingForm(form: FormData, today: string): Parsed {
	const values = belongingFormValues(form);
	const price =
		values.purchasePrice.trim() === ''
			? null
			: wholeAmountMinor(values.purchasePrice, BELONGING_CURRENCY);
	const current =
		values.currentValue.trim() === ''
			? null
			: (wholeAmountMinor(values.currentValue, BELONGING_CURRENCY) ?? -1);
	const note = cleanText(values.note, BELONGING_NOTE_MAX_LENGTH + 1);
	const parsed = schema(today).safeParse({
		name: cleanText(values.name, BELONGING_NAME_MAX_LENGTH + 1),
		purchasePriceMinor: price ?? -1,
		purchasedOn: values.purchasedOn.trim(),
		currentValueMinor: current,
		note: note === '' ? null : note
	});
	if (!parsed.success) {
		const errors: Partial<Record<BelongingField, string>> = {};
		for (const issue of parsed.error.issues)
			errors[issue.path[0] as BelongingField] ??= issue.message;
		return { ok: false, errors, values };
	}
	return { ok: true, value: parsed.data };
}
