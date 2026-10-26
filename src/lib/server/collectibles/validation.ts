import { z } from 'zod';
import {
	COLLECTIBLE_CURRENCY,
	COLLECTIBLE_NAME_MAX_LENGTH,
	COLLECTIBLE_NOTE_MAX_LENGTH,
	type CollectibleFormValues
} from '#lib/shared/collectibles';
import { cleanText } from '#lib/shared/text';
import { NOTE_INVALID, PRICE_INVALID, PURCHASED_ON_INVALID } from '../belongings/messages';
import { isPurchaseDate } from '../belongings/validation';
import { textField, wholeAmountMinor } from '../forms';
import { NAME_INVALID, VALUE_INVALID } from './messages';

const codePoints = (text: string) => Array.from(text).length;
const wholeMinor = (message: string) =>
	z.number().int(message).nonnegative(message).refine(Number.isSafeInteger, message);

const schema = (today: string) =>
	z.object({
		name: z
			.string()
			.min(1, NAME_INVALID)
			.refine((s) => codePoints(s) <= COLLECTIBLE_NAME_MAX_LENGTH, NAME_INVALID),
		purchasePriceMinor: wholeMinor(PRICE_INVALID),
		purchasedOn: z.string().refine((v) => isPurchaseDate(v, today), PURCHASED_ON_INVALID),
		manualValueMinor: wholeMinor(VALUE_INVALID),
		note: z
			.string()
			.refine((s) => codePoints(s) <= COLLECTIBLE_NOTE_MAX_LENGTH, NOTE_INVALID)
			.nullable()
	});
export type CollectibleInput = z.infer<ReturnType<typeof schema>>;
type CollectibleField = keyof CollectibleInput;

type Parsed =
	| { ok: true; value: CollectibleInput }
	| {
			ok: false;
			errors: Partial<Record<CollectibleField, string>>;
			values: CollectibleFormValues;
	  };

/** The fields as typed, bounded, for echoing a refused no-JS form back. */
export function collectibleFormValues(form: FormData): CollectibleFormValues {
	return {
		name: textField(form, 'name').slice(0, COLLECTIBLE_NAME_MAX_LENGTH * 4),
		purchasePrice: textField(form, 'purchasePrice').slice(0, 64),
		purchasedOn: textField(form, 'purchasedOn').slice(0, 16),
		currentValue: textField(form, 'currentValue').slice(0, 64),
		note: textField(form, 'note').slice(0, COLLECTIBLE_NOTE_MAX_LENGTH * 4)
	};
}

/** Whole IDR units as typed → minor units; -1 (refused by the schema) when blank or not a whole amount. */
const requiredWhole = (text: string) =>
	text.trim() === '' ? -1 : (wholeAmountMinor(text, COLLECTIBLE_CURRENCY) ?? -1);

/**
 * The add/edit form → a validated collectible, or field errors (msg() phrases). Name and note are stripped of
 * control and zero-width characters (one code point past the cap kept, so an over-long value is refused, never
 * cut). The purchase price and the current value are required whole IDR units (`1.250.000`, 0 allowed: a gift,
 * or an item now worth nothing); decimals, signs and exponents are refused, never reinterpreted; both at most
 * 13 digits (forms.ts wholeAmountMinor). The purchase date is a real date from 1950 up to `today` (WIB).
 */
export function parseCollectibleForm(form: FormData, today: string): Parsed {
	const values = collectibleFormValues(form);
	const note = cleanText(values.note, COLLECTIBLE_NOTE_MAX_LENGTH + 1);
	const parsed = schema(today).safeParse({
		name: cleanText(values.name, COLLECTIBLE_NAME_MAX_LENGTH + 1),
		purchasePriceMinor: requiredWhole(values.purchasePrice),
		purchasedOn: values.purchasedOn.trim(),
		manualValueMinor: requiredWhole(values.currentValue),
		note: note === '' ? null : note
	});
	if (!parsed.success) {
		const errors: Partial<Record<CollectibleField, string>> = {};
		for (const issue of parsed.error.issues)
			errors[issue.path[0] as CollectibleField] ??= issue.message;
		return { ok: false, errors, values };
	}
	return { ok: true, value: parsed.data };
}
