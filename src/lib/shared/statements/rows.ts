import { isDateString } from '../dates.ts';
import { MAX_AMOUNT_MINOR, parseMoneyAmount } from '../money-parse.ts';
import type { MappedRow, SkipReason } from '../csv.ts';
import type { StatementParse } from './types.ts';

/**
 * Building blocks every institution parser uses (FN-16a): one row builder (the only place a statement amount
 * is read, through FN-14a's `parseMoneyAmount`), the year of a day-month date from the printed period, and the
 * balance check.
 */

/** A statement period as printed (WIB calendar dates, inclusive). */
export interface StatementPeriod {
	from: string;
	to: string;
}

/**
 * A day and month printed without a year (`01/12`) → the WIB date inside the statement's own printed period:
 * the year is taken from the period (a December–January statement puts `31/12` in the first year and `02/01`
 * in the second), never assumed from "this year". Null when no year of the period gives a real date inside it.
 */
export function dateInPeriod(day: number, month: number, period: StatementPeriod): string | null {
	if (!isDateString(period.from) || !isDateString(period.to) || period.from > period.to)
		return null;
	const first = Number(period.from.slice(0, 4));
	const last = Number(period.to.slice(0, 4));
	for (let year = first; year <= last; year++) {
		const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
		if (isDateString(date) && date >= period.from && date <= period.to) return date;
	}
	return null;
}

export interface StatementCells {
	/** WIB date `YYYY-MM-DD`, or null when the row's date could not be read. */
	date: string | null;
	/** `debit` (money out) or `credit` (money in); null: taken from a DB/CR mark on the amount, if any. */
	direction: 'debit' | 'credit' | null;
	/** The amount cell exactly as printed (`1.250.000,00`, `50.000 DB`). */
	amount: string;
	description: string;
	/** Bank reference, if the statement prints one. */
	reference?: string;
}

/**
 * One transaction line → FN-18's `MappedRow`. The amount goes through the shared money parser; a debit is an
 * expense, a credit an income; no direction, an unreadable or zero amount, or a missing date is a typed reject.
 * Text stays untrusted: the server cleans and masks it before storage.
 */
export function statementRow(index: number, cells: StatementCells): MappedRow {
	const reject = (reason: SkipReason): MappedRow => ({ index, ok: false, reason });
	if (!cells.date) return reject('missing_date');
	if (!isDateString(cells.date)) return reject('unparseable_date');
	if (cells.amount.trim() === '') return reject('missing_amount');
	const parsed = parseMoneyAmount(cells.amount);
	// Past the cap of one transaction (also keeps the balance check's sums exact) is unreadable, never stored.
	if (!parsed || parsed.minor === 0 || Math.abs(parsed.minor) > MAX_AMOUNT_MINOR)
		return reject('unparseable_amount');
	const direction = cells.direction ?? parsed.direction ?? null;
	if (!direction) return reject('unparseable_amount');
	return {
		index,
		ok: true,
		value: {
			date: cells.date,
			type: direction === 'debit' ? 'expense' : 'income',
			title: cells.description,
			amountMinor: Math.abs(parsed.minor),
			currency: 'IDR',
			categoryName: '',
			walletName: '',
			paymentMethod: '',
			recurrence: '',
			tag: '',
			notes: '',
			reference: cells.reference ?? ''
		}
	};
}

/**
 * The FN-16 balance check (docs/FEATURES.md FN-16): opening + Σ signed rows = closing. `pass`, else `gap` with
 * the missing amount (closing − opening − Σ, integer minor units); `omitted` when the statement prints no
 * opening or no closing balance — never guessed. Rejected rows are not in the sum, so they show as a gap.
 */
export type BalanceCheck =
	{ status: 'pass' } | { status: 'gap'; gapMinor: number } | { status: 'omitted' };

export function balanceCheck(parse: StatementParse): BalanceCheck {
	const { openingBalanceMinor: opening, closingBalanceMinor: closing } = parse;
	if (opening === null || closing === null) return { status: 'omitted' };
	let sum = 0;
	for (const r of parse.rows)
		if (r.ok) sum += r.value.type === 'income' ? r.value.amountMinor : -r.value.amountMinor;
	const gap = closing - opening - sum;
	return gap === 0 ? { status: 'pass' } : { status: 'gap', gapMinor: gap };
}
