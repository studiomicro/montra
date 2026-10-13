import { describe, expect, it } from 'vitest';
import {
	amountCaret,
	amountDigits,
	caretAfterDigits,
	digitsToMinor,
	formatAmountText,
	groupDigits,
	minorToAmountText,
	minorToDigits,
	readAmountText,
	switchAmountText,
	typedAmountMinor
} from '#lib/shared/amount-input';

describe('minorToDigits', () => {
	it('turns minor units into whole-unit digits', () => {
		expect(minorToDigits(null)).toBe('');
		expect(minorToDigits(2_500_000)).toBe('25000');
		expect(minorToDigits(125_000_050)).toBe('1250000');
		expect(minorToDigits(0)).toBe('');
	});
});

describe('caretAfterDigits', () => {
	it('places the caret after the given number of digits', () => {
		expect(caretAfterDigits('1.264.000', 4)).toBe(5);
		expect(caretAfterDigits('1.264.000', 0)).toBe(0);
		expect(caretAfterDigits('25.000', 5)).toBe(6);
	});
});

describe('amount input', () => {
	it('keeps digits only and drops leading zeros', () => {
		expect(amountDigits('Rp 25.000')).toBe('25000');
		expect(amountDigits('00120')).toBe('120');
		expect(amountDigits('abc')).toBe('');
	});
	it('caps at 13 digits (under Rp 10 triliun)', () => {
		expect(amountDigits('99999999999999999')).toBe('9999999999999');
	});
	it('groups with dots', () => {
		expect(groupDigits('1264000')).toBe('1.264.000');
		expect(groupDigits('')).toBe('');
	});
	it('converts whole rupiah digits to integer minor units', () => {
		expect(digitsToMinor('25000')).toBe(2_500_000);
		expect(digitsToMinor('')).toBeNull();
		expect(Number.isSafeInteger(digitsToMinor('9999999999999'))).toBe(true);
	});
});

describe('FN-47: amounts with cents (every wallet currency but IDR and JPY)', () => {
	const shown = (text: string, currency: string, locale: 'id' | 'en') =>
		formatAmountText(readAmountText(text, currency, locale), currency, locale);

	it('reads the typed text with the UI language’s separators: id `12,50`, en `12.50`', () => {
		expect(shown('12,50', 'USD', 'id')).toBe('12,50');
		expect(typedAmountMinor('12,50', 'USD', 'id')).toBe(1250);
		expect(shown('12.50', 'USD', 'en')).toBe('12.50');
		expect(typedAmountMinor('12.50', 'USD', 'en')).toBe(1250);
		expect(shown('1250,5', 'EUR', 'id')).toBe('1.250,5');
		expect(shown('1250.5', 'EUR', 'en')).toBe('1,250.5');
		expect(typedAmountMinor('1,250.50', 'USD', 'en')).toBe(125_050);
		expect(typedAmountMinor('1.234,56', 'CNY', 'id')).toBe(123_456);
		expect(typedAmountMinor('20,75', 'TWD', 'id')).toBe(2075);
		expect(typedAmountMinor('20.75', 'HKD', 'en')).toBe(2075);
	});

	it('pads a short fraction on the right only: `0,5` is fifty cents, `,50` the same as `0,50`', () => {
		expect(typedAmountMinor('0,5', 'USD', 'id')).toBe(50);
		expect(typedAmountMinor(',50', 'USD', 'id')).toBe(50);
		expect(typedAmountMinor('0,50', 'USD', 'id')).toBe(50);
		expect(typedAmountMinor('.5', 'USD', 'en')).toBe(50);
		expect(typedAmountMinor('12,', 'USD', 'id')).toBe(1200);
		// The field keeps what was typed (a leading 0 before a bare mark), never reinterpreting it.
		expect(shown('0,5', 'USD', 'id')).toBe('0,5');
		expect(shown(',50', 'USD', 'id')).toBe('0,50');
		expect(shown(',', 'USD', 'id')).toBe('0,');
		expect(shown('12,', 'USD', 'id')).toBe('12,');
	});

	it('a third fraction digit is cut, never rounded (paste `12,345` → `12,34`), and flagged', () => {
		expect(readAmountText('12,345', 'USD', 'id')).toEqual({
			whole: '12',
			frac: '34',
			overflow: true
		});
		expect(shown('12,345', 'USD', 'id')).toBe('12,34');
		expect(typedAmountMinor('12,349', 'USD', 'id')).toBe(1234);
		expect(readAmountText('12,50', 'USD', 'id').overflow).toBe(false);
		expect(shown('12.345', 'USD', 'en')).toBe('12.34');
	});

	it('the last decimal mark wins; every other separator before it is grouping (owner decision 3)', () => {
		expect(shown('1.234.567,89', 'USD', 'id')).toBe('1.234.567,89');
		expect(shown('1,2,50', 'USD', 'id')).toBe('12,50');
		// English text pasted in an Indonesian field is read with Indonesian separators (documented limitation).
		expect(typedAmountMinor('1,234.56', 'USD', 'id')).toBe(123);
		expect(shown('12.50', 'USD', 'id')).toBe('1.250');
	});

	it('nothing typed, or only zero, is no amount', () => {
		for (const text of ['', ',', '0', '0,00', 'abc'])
			expect(typedAmountMinor(text, 'USD', 'id')).toBeNull();
	});

	it('stays a safe integer at the 13-digit cap', () => {
		const minor = typedAmountMinor('99999999999999999,99', 'USD', 'id');
		expect(minor).toBe(999_999_999_999_999);
		expect(Number.isSafeInteger(minor)).toBe(true);
	});

	it('pre-fills a stored amount with its cents (the edit bug: `minorToDigits` showed 1250 as `12`)', () => {
		expect(groupDigits(minorToDigits(1250, 'USD'))).toBe('12');
		expect(minorToAmountText(1250, 'USD', 'id')).toBe('12,50');
		expect(minorToAmountText(1250, 'USD', 'en')).toBe('12.50');
		expect(minorToAmountText(5, 'USD', 'id')).toBe('0,05');
		expect(minorToAmountText(50, 'USD', 'id')).toBe('0,50');
		expect(minorToAmountText(125_000_00, 'GBP', 'id')).toBe('125.000');
		expect(minorToAmountText(123_456_789, 'CNY', 'en')).toBe('1,234,567.89');
		expect(minorToAmountText(-1250, 'USD', 'id')).toBe('12,50');
		expect(minorToAmountText(0, 'USD', 'id')).toBe('');
		expect(minorToAmountText(null, 'USD', 'id')).toBe('');
		for (const minor of [1, 99, 100, 1250, 123_456, 999_999_999_999_999])
			for (const locale of ['id', 'en'] as const)
				expect(typedAmountMinor(minorToAmountText(minor, 'USD', locale), 'USD', locale)).toBe(
					minor
				);
	});

	it('moves the caret with the digits it stood after', () => {
		// Typing `5` at the end of `1.234,5` (raw `1.234,55`) → after the 2nd fraction digit.
		expect(amountCaret('1.234,55', 8, 'USD', 'id')).toBe(8);
		// A grouping dot appears: `1234` + `5` → `12.345`, caret at the end.
		expect(amountCaret('12345', 5, 'USD', 'id')).toBe(6);
		// Typing `,` into an empty field shows `0,` with the caret after the mark.
		expect(amountCaret(',', 1, 'USD', 'id')).toBe(2);
		// A pasted `12,345` (caret at the end) → `12,34`, caret after the 2nd fraction digit.
		expect(amountCaret('12,345', 6, 'USD', 'id')).toBe(5);
		expect(amountCaret('1,250.5', 7, 'USD', 'en')).toBe(7);
		// The caret inside the whole part stays after the same digits: `1.2|50` → `1.2|50`.
		expect(amountCaret('1.250', 3, 'USD', 'id')).toBe(3);
	});
});

describe('FN-47: IDR and JPY stay whole units, byte-identical to before', () => {
	it.each(['id', 'en'] as const)('drops a decimal mark and groups with dots (%s)', (locale) => {
		for (const currency of ['IDR', 'JPY']) {
			for (const text of [
				'25,50',
				'25.50',
				'1.250.000',
				'Rp 25.000',
				'00120',
				'99999999999999999'
			]) {
				const before = groupDigits(amountDigits(text));
				expect(formatAmountText(readAmountText(text, currency, locale), currency, locale)).toBe(
					before
				);
				expect(typedAmountMinor(text, currency, locale)).toBe(
					digitsToMinor(amountDigits(text), currency)
				);
				for (let caret = 0; caret <= text.length; caret++)
					expect(amountCaret(text, caret, currency, locale)).toBe(
						caretAfterDigits(
							before,
							Math.min(amountDigits(text.slice(0, caret)).length, amountDigits(text).length)
						)
					);
			}
			for (const minor of [null, 0, 2_500_000, 125_000_050, 1500])
				expect(minorToAmountText(minor, currency, locale)).toBe(
					groupDigits(minorToDigits(minor, currency))
				);
			expect(readAmountText('12,50', currency, locale).frac).toBeNull();
		}
	});
});

describe('switchAmountText (owner decision 4)', () => {
	it('keeps the text between two currencies with cents', () => {
		expect(switchAmountText('12,50', 'USD', 'EUR', 'id')).toBe('12,50');
		expect(switchAmountText('1,250.50', 'TWD', 'CNY', 'en')).toBe('1,250.50');
	});
	it('clears it going to IDR or JPY from a currency with cents (never guesses 12 or 13)', () => {
		expect(switchAmountText('12,50', 'USD', 'IDR', 'id')).toBe('');
		expect(switchAmountText('12', 'HKD', 'JPY', 'en')).toBe('');
	});
	it('keeps the whole number going from IDR or JPY to a currency with cents, regrouped', () => {
		expect(switchAmountText('25.000', 'IDR', 'USD', 'id')).toBe('25.000');
		expect(switchAmountText('25.000', 'IDR', 'USD', 'en')).toBe('25,000');
		expect(typedAmountMinor(switchAmountText('25.000', 'IDR', 'USD', 'en'), 'USD', 'en')).toBe(
			2_500_000
		);
		expect(switchAmountText('1.500', 'JPY', 'IDR', 'en')).toBe('1.500');
	});
});
