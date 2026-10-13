import { describe, expect, it } from 'vitest';
import {
	currencyExponent,
	formatMoney,
	formatMoneyCompact,
	moneyParts
} from '#lib/shared/money-format';

const NBSP = ' ';
const MINUS = '−';

describe('currencyExponent', () => {
	it('uses ISO 4217 exponents', () => {
		expect(currencyExponent('IDR')).toBe(2);
		expect(currencyExponent('USD')).toBe(2);
		expect(currencyExponent('JPY')).toBe(0);
		expect(currencyExponent('KWD')).toBe(3);
	});

	it('knows every active ISO 4217 code, not only the wallet currencies', () => {
		expect(currencyExponent('CLP')).toBe(0);
		expect(currencyExponent('ISK')).toBe(0);
		expect(currencyExponent('UGX')).toBe(0);
		expect(currencyExponent('TND')).toBe(3);
		expect(currencyExponent('IQD')).toBe(3);
		expect(currencyExponent('CLF')).toBe(4);
		expect(currencyExponent('THB')).toBe(2);
		expect(currencyExponent('PHP')).toBe(2);
	});

	it('refuses an unknown code instead of guessing exponent 2', () => {
		for (const code of ['XYZ', 'idr', 'BTC', 'XAU', '', 'IDRR'])
			expect(() => currencyExponent(code), code).toThrow(RangeError);
		expect(() => formatMoney(100, 'XYZ')).toThrow(RangeError);
	});
});

describe('inherited object keys are not currency codes', () => {
	it('refuses prototype keys', () => {
		for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
			expect(() => currencyExponent(code)).toThrow(RangeError);
			expect(() => formatMoney(100, code)).toThrow(RangeError);
		}
	});
});

describe('formatMoney', () => {
	it.each([
		[0, `Rp${NBSP}0`],
		[2_500_000, `Rp${NBSP}25.000`],
		[126_400_000, `Rp${NBSP}1.264.000`],
		[125_000_050, `Rp${NBSP}1.250.000,50`],
		[5, `Rp${NBSP}0,05`],
		[-2_500_000, `${MINUS}Rp${NBSP}25.000`]
	])('IDR %i → %s', (minor, text) => {
		expect(formatMoney(minor)).toBe(text);
	});

	it('signs income and expense when asked', () => {
		expect(formatMoney(950_000_000, 'IDR', 'signed')).toBe(`+Rp${NBSP}9.500.000`);
		expect(formatMoney(-2_500_000, 'IDR', 'signed')).toBe(`${MINUS}Rp${NBSP}25.000`);
		expect(formatMoney(0, 'IDR', 'signed')).toBe(`Rp${NBSP}0`);
	});

	it('treats -0 as 0', () => {
		expect(formatMoney(-0, 'IDR', 'signed')).toBe(`Rp${NBSP}0`);
	});

	it('formats other currencies with their code and exponent', () => {
		expect(formatMoney(1999, 'USD')).toBe(`USD${NBSP}19,99`);
		expect(formatMoney(1500, 'JPY')).toBe(`JPY${NBSP}1.500`);
	});

	it('rejects floats and unsafe integers', () => {
		expect(() => formatMoney(12.5)).toThrow(RangeError);
		expect(() => formatMoney(2 ** 60)).toThrow(RangeError);
		expect(() => formatMoney(Number.NaN)).toThrow(RangeError);
	});
});

describe('formatMoneyCompact', () => {
	it.each([
		[95_000, `Rp950`],
		[18_700_000, `Rp187${NBSP}rb`],
		[99_999_900, `Rp999${NBSP}rb`],
		[100_000_000, `Rp1${NBSP}jt`],
		[524_000_000, `Rp5,24${NBSP}jt`],
		[1_250_000_000, `Rp12,5${NBSP}jt`],
		[12_500_000_000, `Rp125${NBSP}jt`],
		[320_000_000_000, `Rp3,2${NBSP}M`],
		[-524_000_000, `${MINUS}Rp5,24${NBSP}jt`]
	])('IDR %i → %s', (minor, text) => {
		expect(formatMoneyCompact(minor)).toBe(text);
	});

	it('never rounds up past the true value', () => {
		expect(formatMoneyCompact(529_900_000)).toBe(`Rp5,29${NBSP}jt`);
	});

	it('falls back to the full format for other currencies', () => {
		expect(formatMoneyCompact(1999, 'USD')).toBe(`USD${NBSP}19,99`);
	});
});

describe('moneyParts', () => {
	it('splits symbol and figure', () => {
		expect(moneyParts(126_400_000)).toEqual({ symbol: 'Rp', figure: '1.264.000' });
		expect(moneyParts(1999, 'USD')).toEqual({ symbol: 'USD', figure: '19,99' });
	});
	it('keeps the minus with the figure', () => {
		expect(moneyParts(-2_500_000)).toEqual({ symbol: 'Rp', figure: `${MINUS}25.000` });
	});
	it('rejects non-integers', () => {
		expect(() => moneyParts(12.5)).toThrow(RangeError);
	});
});

describe('separators follow the UI language (APP_PARITY § 2)', () => {
	it('keeps Indonesian separators by default', () => {
		expect(formatMoney(402_550_000)).toBe(`Rp${NBSP}4.025.500`);
		expect(formatMoney(150, 'USD', 'auto', 'id')).toBe(`USD${NBSP}1,50`);
	});
	it('uses English separators in English', () => {
		expect(formatMoney(402_550_000, 'IDR', 'auto', 'en')).toBe(`Rp${NBSP}4,025,500`);
		expect(formatMoney(402_550_050, 'IDR', 'auto', 'en')).toBe(`Rp${NBSP}4,025,500.50`);
		expect(formatMoney(-2_500_000, 'IDR', 'auto', 'en')).toBe(`${MINUS}Rp${NBSP}25,000`);
		expect(formatMoney(2_500_000, 'IDR', 'signed', 'en')).toBe(`+Rp${NBSP}25,000`);
	});
	it.each([
		[402_550_000, 'id', `Rp4,02${NBSP}jt`],
		[402_550_000, 'en', 'Rp4.02m'],
		[50_300_000, 'id', `Rp503${NBSP}rb`],
		[50_300_000, 'en', 'Rp503k'],
		[320_000_000_000, 'en', 'Rp3.2b'],
		[200_000_000_000_000, 'en', 'Rp2t'],
		[-524_000_000, 'en', `${MINUS}Rp5.24m`],
		[99_900, 'en', 'Rp999']
	] as const)('compact %i in %s → %s', (minor, locale, text) => {
		expect(formatMoneyCompact(minor, 'IDR', locale)).toBe(text);
	});
	it('falls back to the full English format for other currencies', () => {
		expect(formatMoneyCompact(1999, 'USD', 'en')).toBe(`USD${NBSP}19.99`);
	});
	it('splits English figures for the hero', () => {
		expect(moneyParts(126_400_000, 'IDR', 'en')).toEqual({ symbol: 'Rp', figure: '1,264,000' });
	});
});
