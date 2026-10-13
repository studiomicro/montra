import { z } from 'zod';
import { cleanText } from '#lib/shared/text';
import {
	WALLET_CURRENCIES,
	WALLET_NAME_MAX_LENGTH,
	WALLET_TYPES,
	type WalletFormValues
} from '#lib/shared/wallets';
import type { Locale } from '#lib/shared/i18n';
import { amountMinorFromText, amountRefusal, textField } from '../forms';
import {
	BALANCE_INVALID,
	BALANCE_INVALID_CENTS,
	CURRENCY_INVALID,
	LAST_FOUR_INVALID,
	NAME_REQUIRED,
	TYPE_INVALID
} from './messages';

export const walletInputSchema = z.object({
	name: z.string().min(1, NAME_REQUIRED).max(WALLET_NAME_MAX_LENGTH, NAME_REQUIRED),
	type: z.enum(WALLET_TYPES, { error: TYPE_INVALID }),
	currency: z.enum(WALLET_CURRENCIES, { error: CURRENCY_INVALID }),
	openingBalanceMinor: z.number().int().refine(Number.isSafeInteger, BALANCE_INVALID),
	isFavourite: z.boolean(),
	lastFour: z
		.string()
		.regex(/^\d{4}$/, LAST_FOUR_INVALID)
		.nullable()
});
export type WalletInput = z.infer<typeof walletInputSchema>;
export type WalletField = keyof WalletInput;

export type ParsedWalletForm =
	| { ok: true; value: WalletInput }
	| { ok: false; errors: Partial<Record<WalletField, string>>; values: WalletFormValues };

/** Opening balance text → signed minor units in `currency`; null when it is not an amount (FN-47: cents). */
function openingBalanceMinor(
	text: string,
	negative: boolean,
	currency: string,
	locale: Locale
): number | null {
	const minor = amountMinorFromText(text, currency, locale);
	return negative && minor !== null && minor > 0 ? -minor : minor;
}

/** The add/edit wallet form's fields as typed, each cut to a bounded length (echoed back when refused). */
export function walletFormValues(form: FormData): WalletFormValues {
	return {
		name: textField(form, 'name').slice(0, WALLET_NAME_MAX_LENGTH * 4),
		type: textField(form, 'type').slice(0, 32),
		currency: textField(form, 'currency').slice(0, 8) || 'IDR',
		openingBalance: textField(form, 'openingBalance').slice(0, 64),
		negative: textField(form, 'negative') === 'on',
		isFavourite: textField(form, 'favourite') === 'on',
		lastFour: textField(form, 'lastFour').trim().slice(0, 64)
	};
}

/**
 * The add/edit wallet form → a validated wallet, or field errors (msg() phrases). The name is stripped of
 * control and zero-width characters and capped before validation; the last 4 must be exactly 4 digits (a
 * longer number is refused, never truncated); the opening balance is an amount of the chosen currency read
 * with `locale`'s separators (cents for every currency but IDR and JPY, FN-47), negative when `negative` is
 * ticked (owner decision D).
 */
export function parseWalletForm(form: FormData, locale: Locale): ParsedWalletForm {
	const values = walletFormValues(form);
	const errors: Partial<Record<WalletField, string>> = {};
	// An unknown code is refused below; until then the balance is read with IDR's exponent.
	const known = (WALLET_CURRENCIES as readonly string[]).includes(values.currency);
	const minor = openingBalanceMinor(
		values.openingBalance,
		values.negative,
		known ? values.currency : 'IDR',
		locale
	);
	if (minor === null)
		errors.openingBalanceMinor = known
			? amountRefusal(values.currency, BALANCE_INVALID, BALANCE_INVALID_CENTS)
			: BALANCE_INVALID;
	const parsed = walletInputSchema.safeParse({
		name: cleanText(values.name, WALLET_NAME_MAX_LENGTH),
		type: values.type,
		currency: values.currency,
		openingBalanceMinor: minor ?? 0,
		isFavourite: values.isFavourite,
		lastFour: values.lastFour === '' ? null : values.lastFour
	});
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			const field = issue.path[0] as WalletField;
			errors[field] ??= issue.message;
		}
	}
	if (!parsed.success || Object.keys(errors).length > 0) {
		// A refused last 4 may be a full card or account number: never sent back or re-filled (red team L1).
		if (errors.lastFour) values.lastFour = '';
		return { ok: false, errors, values };
	}
	return { ok: true, value: parsed.data };
}
