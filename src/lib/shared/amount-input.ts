import type { Locale } from './i18n';
import { currencyExponent, groupThousands, SEPARATORS } from './money-format';

const MAX_DIGITS = 13;

/** Whole-unit digits typed into an amount field. Not a general money parser (Phase 2 owns that). */
export function amountDigits(text: string): string {
	return text.replace(/\D/g, '').replace(/^0+/, '').slice(0, MAX_DIGITS);
}

export function groupDigits(digits: string): string {
	return groupThousands(digits, '.');
}

/** Whole-unit digits for a stored amount; sen are truncated. Zero and null show as an empty field. */
export function minorToDigits(minor: number | null, currency = 'IDR'): string {
	if (minor === null) return '';
	return amountDigits(String(Math.trunc(minor / 10 ** currencyExponent(currency))));
}

/** Caret index in a grouped string right after the first `digitsBefore` digits. */
export function caretAfterDigits(formatted: string, digitsBefore: number): number {
	if (digitsBefore <= 0) return 0;
	let seen = 0;
	for (let i = 0; i < formatted.length; i++) {
		if (/\d/.test(formatted[i]!)) seen++;
		if (seen === digitsBefore) return i + 1;
	}
	return formatted.length;
}

export function digitsToMinor(digits: string, currency = 'IDR'): number | null {
	if (digits === '') return null;
	return Number(digits) * 10 ** currencyExponent(currency);
}

/**
 * FN-47: how many fraction digits (sen, cents) an amount in `currency` is typed with. IDR and JPY are typed in
 * whole units (owner decision; IDR keeps exponent 2 for stored sen, which nobody types); every other wallet
 * currency takes its full ISO exponent (2 for USD, SGD, MYR, EUR, AUD, GBP, TWD, HKD, CNY).
 */
export function amountFractionDigits(currency: string): number {
	return currency === 'IDR' ? 0 : currencyExponent(currency);
}

/**
 * The separators an amount field uses. A whole-unit currency keeps the Indonesian dot grouping in both
 * languages (IDR and JPY stay byte-identical to before FN-47); a currency with cents follows the UI language,
 * like formatMoney: `1.250,50` (id), `1,250.50` (en).
 */
function amountSeparators(
	currency: string,
	locale: Locale
): { group: string; decimal: string | null } {
	return amountFractionDigits(currency) === 0 ? { group: '.', decimal: null } : SEPARATORS[locale];
}

/** A typed amount split into whole digits (no leading zeros) and fraction digits (null: no decimal mark). */
export interface AmountParts {
	whole: string;
	frac: string | null;
	/** More fraction digits were present than the currency allows (they are cut from `frac`, never rounded). */
	overflow: boolean;
}

const digitsOf = (text: string) => text.replace(/\D/g, '');

/**
 * Typed or pasted text read under the UI language's separators only (never auto-detected, owner decision 3).
 * A whole-unit currency keeps digits only, as before. Otherwise the last decimal mark starts the fraction and
 * every other separator before it is grouping, dropped. Extra fraction digits are cut, never rounded.
 */
export function readAmountText(text: string, currency: string, locale: Locale): AmountParts {
	const fd = amountFractionDigits(currency);
	const { decimal } = amountSeparators(currency, locale);
	const at = decimal === null ? -1 : text.lastIndexOf(decimal);
	const whole = amountDigits(at < 0 ? text : text.slice(0, at));
	if (at < 0) return { whole, frac: null, overflow: false };
	const frac = digitsOf(text.slice(at + 1));
	return { whole, frac: frac.slice(0, fd), overflow: frac.length > fd };
}

/** The field's text for `parts`: grouped whole units, then the decimal mark and the fraction as typed (`0,5`). */
export function formatAmountText(
	parts: Pick<AmountParts, 'whole' | 'frac'>,
	currency: string,
	locale: Locale
): string {
	const { group, decimal } = amountSeparators(currency, locale);
	const whole = groupThousands(parts.whole, group);
	if (parts.frac === null || decimal === null) return whole;
	return `${whole === '' ? '0' : whole}${decimal}${parts.frac}`;
}

/**
 * Where the caret goes in the reformatted text: after the same number of whole digits, or after the same
 * number of fraction digits when it stood behind the decimal mark.
 */
export function amountCaret(text: string, caret: number, currency: string, locale: Locale): number {
	const parts = readAmountText(text, currency, locale);
	const out = formatAmountText(parts, currency, locale);
	const { decimal } = amountSeparators(currency, locale);
	const at = decimal === null ? -1 : text.lastIndexOf(decimal);
	if (decimal !== null && parts.frac !== null && caret > at) {
		const fracBefore = Math.min(digitsOf(text.slice(at + 1, caret)).length, parts.frac.length);
		return out.indexOf(decimal) + 1 + fracBefore;
	}
	const wholeText = digitsOf(at < 0 ? text : text.slice(0, at));
	const leadingZeros = wholeText.length - wholeText.replace(/^0+/, '').length;
	const before = digitsOf(text.slice(0, caret)).length - leadingZeros;
	return caretAfterDigits(out, Math.min(Math.max(0, before), parts.whole.length));
}

/**
 * Typed text → integer minor units, read leniently like the field reads keystrokes (`readAmountText`); null when
 * nothing (or only zero) is typed. A short fraction is padded on the right (`0,5` → 50), never on the left.
 * Never `parseFloat`: the whole and fraction digits are joined into one integer string.
 */
export function typedAmountMinor(text: string, currency: string, locale: Locale): number | null {
	const fd = amountFractionDigits(currency);
	const { whole, frac } = readAmountText(text, currency, locale);
	if (fd === 0) return digitsToMinor(whole, currency);
	const minor = Number(`${whole}${(frac ?? '').padEnd(fd, '0')}`);
	return minor === 0 ? null : minor;
}

/**
 * A stored amount as the field's starting text: grouped whole units, plus the cents when they are not zero
 * (formatMoney's "sen only when non-zero" rule, so an edit never drops them). Whole-unit currencies read as
 * before (minorToDigits); zero and null show as an empty field.
 */
export function minorToAmountText(minor: number | null, currency: string, locale: Locale): string {
	const fd = amountFractionDigits(currency);
	if (fd === 0) return groupDigits(minorToDigits(minor, currency));
	if (minor === null || minor === 0) return '';
	const digits = String(Math.abs(minor)).padStart(fd + 1, '0');
	const frac = digits.slice(-fd);
	const whole = amountDigits(digits.slice(0, -fd));
	return formatAmountText({ whole, frac: /^0+$/.test(frac) ? null : frac }, currency, locale);
}

/**
 * The field's text after its currency changes (owner decision 4): kept between two currencies of the same kind;
 * cleared when going from one with cents to a whole-unit currency (no guessing whether `12,50` means 12 or
 * 13); the whole number kept, regrouped for the new separators, when going the other way.
 */
export function switchAmountText(text: string, from: string, to: string, locale: Locale): string {
	const fromFd = amountFractionDigits(from);
	const toFd = amountFractionDigits(to);
	if (fromFd > 0 && toFd === 0) return '';
	if (fromFd === 0 && toFd > 0)
		return formatAmountText(
			{ whole: readAmountText(text, from, locale).whole, frac: null },
			to,
			locale
		);
	return text;
}
