import { daysBetween, isDateString } from '../dates.ts';

/** How far before its statement date a card row's day-month date may lie (FN-55 B3). */
const CARD_ROW_MAX_AGE_DAYS = 400;

/**
 * A card row's day and month printed without a year → the WIB date: the latest real date not after the statement
 * date and at most CARD_ROW_MAX_AGE_DAYS before it (`28/12` on a 2026-01-05 statement is 2025-12-28; `29/02` on a
 * 2026-03-01 statement has no such year and is unreadable). Null when no year qualifies; never "this year".
 */
export function cardRowDate(day: number, month: number, statementDate: string): string | null {
	if (!isDateString(statementDate)) return null;
	if (!Number.isInteger(day) || !Number.isInteger(month)) return null;
	const year = Number(statementDate.slice(0, 4));
	for (let y = year; y >= year - 2; y--) {
		const date = `${String(y).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
		if (!isDateString(date) || date > statementDate) continue;
		return daysBetween(date, statementDate) <= CARD_ROW_MAX_AGE_DAYS ? date : null;
	}
	return null;
}
