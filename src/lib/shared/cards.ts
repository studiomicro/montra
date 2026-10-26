import { daysBetween, wibDateParts } from './dates.ts';
import type { Locale } from './i18n.ts';
import { currencyExponent, SEPARATORS } from './money-format.ts';

/**
 * Credit-card arithmetic (FN-55a), shared by the card page, Dompet, Kekayaan and the tests so the client and the
 * Worker agree. Every figure is integer minor units in the card wallet's own currency, computed on BigInt, and every
 * input is either a stored row sum or a figure printed on a stored statement: nothing here estimates interest,
 * recommends an amount or scores usage (product boundary: information, not advice).
 *
 * Sign convention (the wallet's): a card's balance is negative while money is owed; a printed "new balance" N owed
 * is stored as −N (card_statements.new_balance_minor).
 */

/** Smallest and largest day of the month a card's statement or due day may name. */
export const CARD_DAY_MIN = 1;
export const CARD_DAY_MAX = 31;

/** `YYYY-MM-DD` of `day` in `year`/`month`, clamped to the month's last day (31 in February → 28 or 29). */
export function clampedMonthDay(year: number, month: number, day: number): string {
	const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
	const d = Math.min(day, last);
	return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The next due date for a typed due day: this month's (clamped) when it is today or later, else next month's.
 * `today` is the WIB date of now.
 */
export function nextDueDate(today: string, dueDay: number): string {
	const { year, month } = wibDateParts(today);
	const thisMonth = clampedMonthDay(year, month, dueDay);
	if (thisMonth >= today) return thisMonth;
	return month === 12
		? clampedMonthDay(year + 1, 1, dueDay)
		: clampedMonthDay(year, month + 1, dueDay);
}

/** The in-app due chip: due in N WIB days, today, or N days late (only while something is still owed). */
export type DueChip =
	| { kind: 'in'; days: number; date: string }
	| { kind: 'today'; date: string }
	| { kind: 'late'; days: number; date: string };

/**
 * The due chip of a card (A2 "Due soon"): with a stored statement that printed a due date, that date — late only
 * while the bill is not paid (`outstanding`); when it has passed and nothing is outstanding, or without a printed
 * date, the next occurrence of the typed due day; else none.
 */
export function dueChip(
	today: string,
	printedDueDate: string | null,
	outstanding: boolean,
	dueDay: number | null
): DueChip | null {
	if (printedDueDate !== null && (printedDueDate >= today || outstanding))
		return chipFor(printedDueDate, today);
	if (dueDay === null) return null;
	return chipFor(nextDueDate(today, dueDay), today);
}

function chipFor(date: string, today: string): DueChip {
	const days = daysBetween(today, date);
	if (days === 0) return { kind: 'today', date };
	return days > 0 ? { kind: 'in', days, date } : { kind: 'late', days: -days, date };
}

/** What is owed now: the negative of a negative balance, else 0 (a positive balance is a credit, "Saldo kredit"). */
export function owedMinor(balanceMinor: number): bigint {
	return balanceMinor < 0 ? -BigInt(balanceMinor) : 0n;
}

/**
 * Kredit tersedia = limit − owed, in money (never a percent): `over` when owed is above the limit (never a
 * negative figure), null without a typed limit.
 */
export function availableCredit(
	limitMinor: number | null,
	balanceMinor: number
): { kind: 'available'; minor: bigint } | { kind: 'over' } | null {
	if (limitMinor === null) return null;
	const left = BigInt(limitMinor) - owedMinor(balanceMinor);
	return left < 0n ? { kind: 'over' } : { kind: 'available', minor: left };
}

/**
 * Sisa tagihan = max(0, printed new balance owed − paid since the statement date). A printed credit balance owes
 * nothing. 0 shows as "Lunas".
 */
export function billRemaining(newBalanceMinor: number, paidMinor: bigint): bigint {
	const owed = newBalanceMinor < 0 ? -BigInt(newBalanceMinor) : 0n;
	const left = owed - paidMinor;
	return left > 0n ? left : 0n;
}

/**
 * The reconciliation guard: the wallet's balance minus what the last statement plus the rows after it say it
 * should be (new balance + paid − unbilled, wallet convention). 0 when they agree; never written anywhere.
 */
export function reconciliationGap(
	balanceMinor: number,
	newBalanceMinor: number,
	paidMinor: bigint,
	unbilledMinor: bigint
): bigint {
	return BigInt(balanceMinor) - (BigInt(newBalanceMinor) + paidMinor - unbilledMinor);
}

/**
 * Fraction digits a card amount field takes (FN-55a): the currency's full ISO exponent, so an IDR card's printed
 * sen (`1.250.000,50`) are typed exactly as the bill shows them, never rounded.
 */
export function cardFractionDigits(currency: string): number {
	return currencyExponent(currency);
}

/** A stored card amount as its form field's text (`1.250.000,50`; the sen only when not zero); '' for null/0. */
export function cardAmountText(minor: number | null, currency: string, locale: Locale): string {
	if (minor === null || minor === 0) return '';
	const fd = cardFractionDigits(currency);
	const { group, decimal } = SEPARATORS[locale];
	const digits = String(Math.abs(minor)).padStart(fd + 1, '0');
	const whole = (fd === 0 ? digits : digits.slice(0, -fd)).replace(/\B(?=(\d{3})+(?!\d))/g, group);
	const frac = fd === 0 ? '' : digits.slice(-fd);
	return frac === '' || /^0+$/.test(frac) ? whole : `${whole}${decimal}${frac}`;
}
