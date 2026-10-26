import { isDateString } from '#lib/shared/dates';
import type { Locale } from '#lib/shared/i18n';
import {
	NET_WORTH_KINDS,
	NET_WORTH_NAME_MAX_LENGTH,
	NET_WORTH_NOTE_MAX_LENGTH,
	PRICED_SOURCE_OF_KIND,
	QUANTITY_SCALE,
	type NetWorthFormValues,
	type NetWorthKind,
	type PriceSource
} from '#lib/shared/net-worth';
import { cleanText } from '#lib/shared/text';
import { WALLET_CURRENCIES } from '#lib/shared/wallets';
import { amountMinorFromText, amountRefusal, textField } from '../forms';
import {
	NW_CURRENCY_INVALID,
	NW_DATE_INVALID,
	NW_KIND_INVALID,
	NW_NAME_INVALID,
	NW_NOTE_INVALID,
	NW_QUANTITY_INVALID,
	NW_QUANTITY_PRECISION,
	NW_QUANTITY_REQUIRED,
	NW_SOURCE_INVALID,
	NW_SYMBOL_INVALID,
	NW_SYMBOL_UNKNOWN,
	NW_VALUE_INVALID,
	NW_VALUE_INVALID_CENTS,
	NW_VALUE_REQUIRED,
	NW_VALUE_TOO_LARGE
} from './messages';

/** Largest manual value in minor units: the same 10^13 cap as a transaction amount (and the DB CHECK). */
const MAX_VALUE_MINOR = 10_000_000_000_000;
/** Most whole-unit digits of a quantity (below 10^15 coins or grams). */
const QUANTITY_MAX_WHOLE_DIGITS = 15;
/** A quantity as typed: whole digits, then optionally one decimal separator (comma or dot) and digits. */
const QUANTITY_TEXT = /^(\d{1,15})(?:([.,])(\d{1,40}))?$/;
/** An Indodax coin code as stored (`btc`); the pair queried is `<code>_idr`. */
const COIN_CODE = /^[a-z0-9]{1,15}$/;

export type QuantityResult =
	{ ok: true; scaled: string } | { ok: false; reason: 'empty' | 'invalid' | 'precision' };

/**
 * A physical quantity (coins, grams) as typed → the integer text `quantity × 10^scale`, exact. Comma or dot
 * is the decimal separator; there is no thousands grouping, so a dot followed by exactly three digits after a
 * non-zero whole part (`1.000`, `2.500`) is refused as ambiguous rather than guessed. More decimals than
 * `scale` are refused, never truncated; zero, signs, exponents and spaces are refused.
 */
export function parseQuantity(text: string, scale: number): QuantityResult {
	const trimmed = text.trim();
	if (trimmed === '') return { ok: false, reason: 'empty' };
	const m = QUANTITY_TEXT.exec(trimmed);
	if (!m) return { ok: false, reason: 'invalid' };
	const whole = (m[1] as string).replace(/^0+/, '');
	const separator = m[2];
	const frac = m[3] ?? '';
	if (separator === '.' && frac.length === 3 && whole !== '')
		return { ok: false, reason: 'invalid' };
	if (whole.length > QUANTITY_MAX_WHOLE_DIGITS) return { ok: false, reason: 'invalid' };
	if (frac.length > scale) return { ok: false, reason: 'precision' };
	const scaled = (whole + frac.padEnd(scale, '0')).replace(/^0+/, '');
	if (scaled === '') return { ok: false, reason: 'invalid' };
	return { ok: true, scaled };
}

/** A validated item, ready for the repo. */
export interface NetWorthInput {
	kind: NetWorthKind;
	name: string;
	currency: string;
	priceSource: PriceSource;
	priceSymbol: string | null;
	quantityScaled: string | null;
	quantityScale: number | null;
	manualValueMinor: number | null;
	acquiredOn: string | null;
	note: string | null;
}
type NetWorthField =
	| 'kind'
	| 'name'
	| 'currency'
	| 'priceSource'
	| 'symbol'
	| 'quantity'
	| 'manualValue'
	| 'acquiredOn'
	| 'note';

export type ParsedNetWorth =
	| { ok: true; value: NetWorthInput }
	| { ok: false; errors: Partial<Record<NetWorthField, string>>; values: NetWorthFormValues };

const isKind = (v: string): v is NetWorthKind => (NET_WORTH_KINDS as readonly string[]).includes(v);
const codePoints = (text: string) => Array.from(text).length;

/** The form's fields as typed, each cut to a bound (a refused no-JS form echoes them back). */
function netWorthFormValues(form: FormData): NetWorthFormValues {
	return {
		kind: textField(form, 'kind').slice(0, 32),
		name: textField(form, 'name').slice(0, NET_WORTH_NAME_MAX_LENGTH * 4),
		currency: textField(form, 'currency').slice(0, 8),
		priceSource: textField(form, 'priceSource').slice(0, 16),
		symbol: textField(form, 'symbol').slice(0, 32),
		quantity: textField(form, 'quantity').slice(0, 64),
		manualValue: textField(form, 'manualValue').slice(0, 64),
		acquiredOn: textField(form, 'acquiredOn').slice(0, 16),
		note: textField(form, 'note').slice(0, NET_WORTH_NOTE_MAX_LENGTH * 4)
	};
}

/**
 * The add/edit item form → a validated item, or field errors (msg() phrases).
 * - `kind` from the fixed list; `priceSource` is `manual` or the one source of that kind (crypto → indodax,
 *   gold → gold_api); a priced item is IDR (the source quotes IDR), a manual one any wallet currency.
 * - A priced item needs a quantity (and crypto a coin code); its manual value is the optional fallback.
 *   A manual item needs its value; crypto and gold may still record a quantity, other kinds never do.
 * - The value is an amount read with `locale`'s separators (`amountMinorFromText`; cents for every currency
 *   but IDR and JPY, FN-47), positive, at most 10^13 minor units.
 * - `knownCoins`: the coin codes of the latest cached Indodax ticker; a code outside it is refused. Null while
 *   no ticker is cached yet (cold cache or KV outage): the code is then accepted and its item shows no price.
 */
export function parseNetWorthForm(
	form: FormData,
	locale: Locale,
	knownCoins: ReadonlySet<string> | null = null
): ParsedNetWorth {
	const values = netWorthFormValues(form);
	const errors: Partial<Record<NetWorthField, string>> = {};
	const fail = () => ({ ok: false as const, errors, values });

	if (!isKind(values.kind)) {
		errors.kind = NW_KIND_INVALID;
		return fail();
	}
	const kind = values.kind;

	const name = cleanText(values.name, NET_WORTH_NAME_MAX_LENGTH + 1);
	if (name === '' || codePoints(name) > NET_WORTH_NAME_MAX_LENGTH) errors.name = NW_NAME_INVALID;

	const sourceText = values.priceSource === '' ? 'manual' : values.priceSource;
	const pricedSource = PRICED_SOURCE_OF_KIND[kind];
	let priceSource: PriceSource = 'manual';
	if (sourceText === 'manual') priceSource = 'manual';
	else if (pricedSource && sourceText === pricedSource) priceSource = pricedSource;
	else errors.priceSource = NW_SOURCE_INVALID;

	const priced = priceSource !== 'manual';
	let currency = 'IDR';
	if (!priced) {
		if ((WALLET_CURRENCIES as readonly string[]).includes(values.currency))
			currency = values.currency;
		else errors.currency = NW_CURRENCY_INVALID;
	}

	let priceSymbol: string | null = null;
	if (priceSource === 'indodax') {
		const code = values.symbol.trim().toLowerCase();
		if (!COIN_CODE.test(code)) errors.symbol = NW_SYMBOL_INVALID;
		else if (knownCoins && !knownCoins.has(code)) errors.symbol = NW_SYMBOL_UNKNOWN;
		else priceSymbol = code;
	}

	const scale = QUANTITY_SCALE[kind] ?? null;
	let quantityScaled: string | null = null;
	if (scale !== null) {
		const q = parseQuantity(values.quantity, scale);
		if (q.ok) quantityScaled = q.scaled;
		else if (q.reason === 'precision') errors.quantity = NW_QUANTITY_PRECISION;
		else if (q.reason === 'invalid') errors.quantity = NW_QUANTITY_INVALID;
		else if (priced) errors.quantity = NW_QUANTITY_REQUIRED;
	}

	let manualValueMinor: number | null = null;
	const minor = amountMinorFromText(values.manualValue, currency, locale);
	if (minor === null)
		errors.manualValue = amountRefusal(currency, NW_VALUE_INVALID, NW_VALUE_INVALID_CENTS);
	else if (minor > MAX_VALUE_MINOR) errors.manualValue = NW_VALUE_TOO_LARGE;
	else if (minor > 0) manualValueMinor = minor;
	else if (!priced) errors.manualValue = NW_VALUE_REQUIRED;

	const acquired = values.acquiredOn.trim();
	if (acquired !== '' && !isDateString(acquired)) errors.acquiredOn = NW_DATE_INVALID;

	const note = cleanText(values.note, NET_WORTH_NOTE_MAX_LENGTH + 1);
	if (codePoints(note) > NET_WORTH_NOTE_MAX_LENGTH) errors.note = NW_NOTE_INVALID;

	if (Object.keys(errors).length > 0) return fail();
	return {
		ok: true,
		value: {
			kind,
			name,
			currency,
			priceSource,
			priceSymbol,
			quantityScaled,
			quantityScale: quantityScaled === null ? null : scale,
			manualValueMinor,
			acquiredOn: acquired === '' ? null : acquired,
			note: note === '' ? null : note
		}
	};
}
