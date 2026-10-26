import type { Locale } from './i18n.ts';

const NBSP = ' ';
const MINUS = '−';

/**
 * ISO 4217 minor-unit exponents of every active code with a minor unit (List One, as published by the SIX
 * maintenance agency; ANG kept while it is still accepted beside its successor XCG). Codes without a minor
 * unit (precious metals XAU/XAG…, XDR, XTS, XXX) are not currencies a money row can hold.
 */
const EXPONENT_GROUPS: readonly (readonly [number, string])[] = [
	[0, 'BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF'],
	[3, 'BHD IQD JOD KWD LYD OMR TND'],
	[4, 'CLF UYW'],
	[
		2,
		`AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE
CHF CHW CNY COP COU CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG
HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK
MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE
SOS SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD USN UZS VED VES WST XCD XCG YER ZAR ZMW ZWG`
	]
];

const EXPONENTS: ReadonlyMap<string, number> = new Map(
	EXPONENT_GROUPS.flatMap(([exp, codes]) => codes.split(/\s+/).map((code) => [code, exp] as const))
);

const SYMBOLS: Readonly<Record<string, string>> = { IDR: 'Rp' };

/**
 * ISO 4217 minor-unit exponent. An unknown code is refused (RangeError), never guessed: a wrong exponent would
 * misread every amount in it by a factor of 10 or more. Stored currencies are validated before they are saved.
 */
export function currencyExponent(currency: string): number {
	const exp = EXPONENTS.get(currency);
	if (exp === undefined) throw new RangeError('unknown currency code');
	return exp;
}

function assertMinor(minor: number): void {
	if (!Number.isSafeInteger(minor)) throw new RangeError('amount_minor must be a safe integer');
}

/** Digit-group and decimal separators of the UI language: `1.264.000,50` (id), `1,264,000.50` (en). */
export const SEPARATORS: Readonly<Record<Locale, { group: string; decimal: string }>> = {
	id: { group: '.', decimal: ',' },
	en: { group: ',', decimal: '.' }
};

/** `1264000` → `1.264.000` with the given separator (digits only, no sign or decimals). */
export function groupThousands(digits: string, separator: string): string {
	return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/**
 * `Rp 1.264.000` (NBSP), sen only when non-zero, `−` U+2212 for negatives, `+` for income when signed. The
 * separators follow the UI language: Indonesian by default, `Rp 1,264,000` in English.
 */
export function formatMoney(
	minor: number,
	currency = 'IDR',
	sign: 'auto' | 'signed' = 'auto',
	locale: Locale = 'id'
): string {
	assertMinor(minor);
	const sep = SEPARATORS[locale];
	const exp = currencyExponent(currency);
	const abs = BigInt(Math.abs(minor));
	const base = 10n ** BigInt(exp);
	const whole = groupThousands((abs / base).toString(), sep.group);
	const frac = abs % base;
	const fracText = frac === 0n ? '' : sep.decimal + frac.toString().padStart(exp, '0');
	const body = `${Object.hasOwn(SYMBOLS, currency) ? SYMBOLS[currency] : currency}${NBSP}${whole}${fracText}`;
	if (minor < 0) return MINUS + body;
	if (sign === 'signed' && minor > 0) return '+' + body;
	return body;
}

const SIZES = [1_000_000_000_000n, 1_000_000_000n, 1_000_000n, 1_000n] as const;
/** Unit words per size (same order as SIZES); Indonesian puts a no-break space before the unit, English none. */
const UNIT_LABELS: Readonly<Record<Locale, { labels: readonly string[]; gap: string }>> = {
	id: { labels: ['T', 'M', 'jt', 'rb'], gap: NBSP },
	en: { labels: ['t', 'b', 'm', 'k'], gap: '' }
};

/**
 * `Rp5,24 jt`, `Rp187 rb` (English `Rp5.24m`, `Rp187k`): three significant digits, truncated (never
 * overstates). IDR only; other currencies use the full format.
 */
export function formatMoneyCompact(minor: number, currency = 'IDR', locale: Locale = 'id'): string {
	assertMinor(minor);
	if (currency !== 'IDR') return formatMoney(minor, currency, 'auto', locale);
	const rupiah = BigInt(Math.abs(minor)) / 100n;
	const prefix = minor < 0 ? MINUS : '';
	const index = SIZES.findIndex((size) => rupiah >= size);
	if (index < 0) return `${prefix}Rp${rupiah.toString()}`;
	const { labels, gap } = UNIT_LABELS[locale];
	const unit = { size: SIZES[index] as bigint, label: labels[index] as string };
	const whole = rupiah / unit.size;
	const decimals = whole >= 100n ? 0 : whole >= 10n ? 1 : 2;
	const scaled = (rupiah * 10n ** BigInt(decimals)) / unit.size;
	let text = scaled.toString();
	if (decimals > 0) {
		const intPart = text.slice(0, -decimals) || '0';
		const fracPart = text.slice(-decimals).replace(/0+$/, '');
		text = fracPart ? `${intPart}${SEPARATORS[locale].decimal}${fracPart}` : intPart;
	}
	return `${prefix}Rp${text}${gap}${unit.label}`;
}

/** Symbol and figure of formatMoney(minor, currency) for the hero layout; a minus sign stays with the figure. */
export function moneyParts(
	minor: number,
	currency = 'IDR',
	locale: Locale = 'id'
): { symbol: string; figure: string } {
	const text = formatMoney(Math.abs(minor), currency, 'auto', locale);
	const cut = text.indexOf(NBSP);
	const symbol = text.slice(0, cut);
	const figure = text.slice(cut + 1);
	return { symbol, figure: minor < 0 ? MINUS + figure : figure };
}
