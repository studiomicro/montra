import { z } from 'zod';
import { CARD_DAY_MAX, CARD_DAY_MIN, cardFractionDigits } from '#lib/shared/cards';
import { MAX_AMOUNT_MINOR } from '#lib/shared/money-parse';
import { cleanText } from '#lib/shared/text';
import {
	EMONEY_FORM_TYPE,
	EMONEY_ISSUERS,
	isCardType,
	isEmoneyIssuer,
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
	CARD_BALANCE_INVALID,
	CARD_DAY_INVALID,
	CARD_FIELD_ONLY,
	CARD_LIMIT_INVALID,
	CURRENCY_INVALID,
	EMONEY_FIELD_ONLY,
	EMONEY_ISSUER_REQUIRED,
	LAST_FOUR_INVALID,
	NAME_REQUIRED,
	TYPE_INVALID
} from './messages';

const walletInputSchema = z.object({
	name: z.string().min(1, NAME_REQUIRED).max(WALLET_NAME_MAX_LENGTH, NAME_REQUIRED),
	type: z.enum(WALLET_TYPES, { error: TYPE_INVALID }),
	currency: z.enum(WALLET_CURRENCIES, { error: CURRENCY_INVALID }),
	openingBalanceMinor: z.number().int().refine(Number.isSafeInteger, BALANCE_INVALID),
	isFavourite: z.boolean(),
	lastFour: z
		.string()
		.regex(/^\d{4}$/, LAST_FOUR_INVALID)
		.nullable(),
	/**
	 * FN-55a, `kartu_kredit` only (null otherwise, refused when sent for another type). Optional for callers that
	 * write a wallet without the form (imports, tests): absent is none.
	 */
	creditLimitMinor: z.number().int().min(1).max(MAX_AMOUNT_MINOR).nullish(),
	statementDay: z.number().int().min(CARD_DAY_MIN).max(CARD_DAY_MAX).nullish(),
	dueDay: z.number().int().min(CARD_DAY_MIN).max(CARD_DAY_MAX).nullish(),
	/**
	 * FN-58 pass 1, an `e_wallet` saved through the "Kartu e-money" choice only (null otherwise). Optional like the
	 * card fields: absent is none.
	 */
	emoneyIssuer: z.enum(EMONEY_ISSUERS, { error: EMONEY_ISSUER_REQUIRED }).nullish()
});
export type WalletInput = z.infer<typeof walletInputSchema>;
type WalletField = keyof WalletInput;

export type ParsedWalletForm =
	| { ok: true; value: WalletInput }
	| { ok: false; errors: Partial<Record<WalletField, string>>; values: WalletFormValues };

/**
 * Opening balance text → signed minor units in `currency`; null when it is not an amount. Plain mode: cents for
 * every currency but IDR and JPY (FN-47), negative when `negative` is ticked. Card mode (FN-55a): the bill as owed,
 * with the currency's full exponent (an IDR card's sen), stored negative unless the card is `overpaid`.
 */
function openingBalanceMinor(values: WalletFormValues, currency: string, locale: Locale) {
	if (values.balanceMode === 'card') {
		const minor = amountMinorFromText(
			values.openingBalance,
			currency,
			locale,
			cardFractionDigits(currency)
		);
		return minor !== null && minor > 0 && !values.overpaid ? -minor : minor;
	}
	const minor = amountMinorFromText(values.openingBalance, currency, locale);
	return values.negative && minor !== null && minor > 0 ? -minor : minor;
}

/** A day of the month as typed: null for '', the day for 1-31 written as digits, else `invalid`. */
function cardDay(text: string): number | null | 'invalid' {
	if (text === '') return null;
	if (!/^\d{1,2}$/.test(text)) return 'invalid';
	const day = Number(text);
	return day >= CARD_DAY_MIN && day <= CARD_DAY_MAX ? day : 'invalid';
}

/** The limit as typed: null for '', a positive amount of `currency` (with its sen) up to the cap, else `invalid`. */
function creditLimit(text: string, currency: string, locale: Locale): number | null | 'invalid' {
	if (text === '') return null;
	const minor = amountMinorFromText(text, currency, locale, cardFractionDigits(currency));
	return minor !== null && minor >= 1 && minor <= MAX_AMOUNT_MINOR ? minor : 'invalid';
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
		lastFour: textField(form, 'lastFour').trim().slice(0, 64),
		balanceMode: textField(form, 'balanceMode') === 'card' ? 'card' : 'plain',
		overpaid: textField(form, 'overpaid') === 'on',
		creditLimit: textField(form, 'creditLimit').trim().slice(0, 64),
		statementDay: textField(form, 'statementDay').trim().slice(0, 8),
		dueDay: textField(form, 'dueDay').trim().slice(0, 8),
		emoneyIssuer: textField(form, 'emoneyIssuer').trim().slice(0, 32)
	};
}

/**
 * The add/edit wallet form → a validated wallet, or field errors (msg() phrases). The name is stripped of
 * control and zero-width characters and capped before validation; the last 4 must be exactly 4 digits (a
 * longer number is refused, never truncated); the opening balance is read as `openingBalanceMinor` says.
 * FN-55a: a limit, statement day or due day is read only for a `kartu_kredit` wallet; sent with any other type it
 * is refused with a field message (a hidden field is not authorization), never ignored or rounded.
 * FN-58 pass 1: the `e_money` choice ("Kartu e-money") is saved as an `e_wallet` with its issuer, which it needs; an
 * issuer sent with any other choice, or an unknown issuer key, is refused the same way.
 */
export function parseWalletForm(form: FormData, locale: Locale): ParsedWalletForm {
	const values = walletFormValues(form);
	const errors: Partial<Record<WalletField, string>> = {};
	// An unknown code is refused below; until then the amounts are read with IDR's exponent.
	const known = (WALLET_CURRENCIES as readonly string[]).includes(values.currency);
	const currency = known ? values.currency : 'IDR';
	const minor = openingBalanceMinor(values, currency, locale);
	if (minor === null)
		errors.openingBalanceMinor = !known
			? BALANCE_INVALID
			: values.balanceMode === 'card'
				? cardFractionDigits(currency) > 0
					? CARD_BALANCE_INVALID
					: BALANCE_INVALID
				: amountRefusal(currency, BALANCE_INVALID, BALANCE_INVALID_CENTS);
	const card = isCardType(values.type);
	const limit = creditLimit(values.creditLimit, currency, locale);
	const statementDay = cardDay(values.statementDay);
	const dueDay = cardDay(values.dueDay);
	if (!card) {
		if (values.creditLimit !== '') errors.creditLimitMinor = CARD_FIELD_ONLY;
		if (values.statementDay !== '') errors.statementDay = CARD_FIELD_ONLY;
		if (values.dueDay !== '') errors.dueDay = CARD_FIELD_ONLY;
	} else {
		if (limit === 'invalid') errors.creditLimitMinor = CARD_LIMIT_INVALID;
		if (statementDay === 'invalid') errors.statementDay = CARD_DAY_INVALID;
		if (dueDay === 'invalid') errors.dueDay = CARD_DAY_INVALID;
	}
	const cardValue = (v: number | null | 'invalid') => (card && v !== 'invalid' ? v : null);
	const emoney = values.type === EMONEY_FORM_TYPE;
	if (!emoney && values.emoneyIssuer !== '') errors.emoneyIssuer = EMONEY_FIELD_ONLY;
	else if (emoney && !isEmoneyIssuer(values.emoneyIssuer))
		errors.emoneyIssuer = EMONEY_ISSUER_REQUIRED;
	const parsed = walletInputSchema.safeParse({
		name: cleanText(values.name, WALLET_NAME_MAX_LENGTH),
		type: emoney ? 'e_wallet' : values.type,
		currency: values.currency,
		openingBalanceMinor: minor ?? 0,
		isFavourite: values.isFavourite,
		lastFour: values.lastFour === '' ? null : values.lastFour,
		creditLimitMinor: cardValue(limit),
		statementDay: cardValue(statementDay),
		dueDay: cardValue(dueDay),
		emoneyIssuer: emoney && isEmoneyIssuer(values.emoneyIssuer) ? values.emoneyIssuer : null
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
