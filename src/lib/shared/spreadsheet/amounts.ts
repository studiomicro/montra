import { MAX_AMOUNT_MINOR, parseMoneyAmount } from '../money-parse.ts';
import { cleanText } from '../text.ts';
import type { SheetCell } from './types.ts';

/**
 * Amount cells of a spreadsheet import (FN-17): copied by code, never by a model, never through a float.
 * Pure: no D1, Workers or DOM dependency.
 */

/** IDR minor-unit exponent (sen): `Rp 28.000,00` is 2 800 000 minor units. */
const IDR_EXPONENT = 2;

/**
 * An exact decimal text (`28000`, `-28000.5`, `1.5E+5`) → integer minor units, or null when it has more
 * fractional digits than IDR allows, is not a plain decimal, or is out of range. String arithmetic only.
 */
export function decimalToMinor(text: string, exponent = IDR_EXPONENT): number | null {
	const m = /^([+-]?)(\d{1,30})(?:\.(\d{1,30}))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text.trim());
	if (!m) return null;
	const sign = m[1] === '-' ? -1 : 1;
	let digits = (m[2] as string) + (m[3] ?? '');
	// Position of the decimal point within `digits`, shifted by the exponent and the minor-unit exponent.
	const point = (m[2] as string).length + Number(m[4] ?? 0) + exponent;
	if (point < 0) return /^0*$/.test(digits) ? 0 : null;
	if (point >= digits.length) digits = digits.padEnd(point, '0');
	const whole = digits.slice(0, point);
	const rest = digits.slice(point);
	if (/[1-9]/.test(rest)) return null;
	const value = Number(whole.replace(/^0+(?=\d)/, '') || '0');
	if (!Number.isSafeInteger(value) || value > MAX_AMOUNT_MINOR) return null;
	return value === 0 ? 0 : sign * value;
}

/** A numeric text amount: digits with `.`/`,`/space groups, an optional Rp/IDR, sign, brackets or DB/CR. */
const TEXT_AMOUNT = /^\(?\s*[-−+]?\s*(?:rp\.?|idr)?\s*[-−]?\s*\d[\d., ]*\s*\)?\s*(?:db|cr)?$/i;
/** A foreign currency mark in an amount cell (owner decision 6: IDR only, the rest counted as foreign). */
const FOREIGN_MARK = /[$€£¥]|\b(?:usd|sgd|eur|myr|aud|jpy|gbp|cny|hkd|twd|thb|krw|sar)\b/i;

export type AmountRead = { minor: number } | 'missing' | 'not_number' | 'foreign';

/** An amount cell → signed minor units (a DB suffix is negative, CR positive). */
export function amountOfCell(cell: SheetCell | null | undefined): AmountRead {
	if (!cell) return 'missing';
	if (cell.kind === 'number') {
		if (cell.foreign) return 'foreign';
		const minor = decimalToMinor(cell.text);
		return minor === null ? 'not_number' : { minor };
	}
	if (cell.kind !== 'text') return 'not_number';
	const text = cleanText(cell.text, 64);
	if (text === '' || text === '-') return 'missing';
	if (FOREIGN_MARK.test(text)) return 'foreign';
	if (!TEXT_AMOUNT.test(text)) return 'not_number';
	const parsed = parseMoneyAmount(text);
	if (!parsed) return 'not_number';
	const minor = parsed.direction === 'debit' ? -Math.abs(parsed.minor) : parsed.minor;
	return { minor };
}
