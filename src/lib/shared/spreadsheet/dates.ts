import { parseCsvDate } from '../csv.ts';
import { isDateString, isMonthString } from '../dates.ts';

/**
 * Dates of a spreadsheet import (FN-17). An Excel serial is a local wall-clock date: it becomes the WIB
 * calendar date as it is, with no timezone shift. Anything ambiguous or impossible is null, never a guess.
 */

/** Serial range treated as a date in the mapped date column without a date format (1990-01-01 … 2100-01-01). */
const SERIAL_MIN = 32_874;
const SERIAL_MAX = 73_051;

const DAY_MS = 86_400_000;
const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function utcDate(ms: number): string {
	const d = new Date(ms);
	return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * An Excel date serial (its whole days; a time fraction is dropped) → `YYYY-MM-DD`, or null. The 1900 system
 * keeps Lotus's bug: serial 60 is the non-existent 1900-02-29 (null), and serials below 60 sit one day later
 * than the plain count from 1899-12-30. The 1904 system counts from 1904-01-01 (serial 0).
 */
export function serialToDate(serial: number, date1904: boolean): string | null {
	if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
	const days = Math.floor(serial);
	if (date1904) return utcDate(Date.UTC(1904, 0, 1) + days * DAY_MS);
	if (days < 1 || days === 60) return null;
	const base = days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
	return utcDate(base + days * DAY_MS);
}

/** Month names and abbreviations, Indonesian and English (ASCII lower case) → month number. */
const MONTHS: Readonly<Record<string, number>> = {
	januari: 1,
	january: 1,
	jan: 1,
	februari: 2,
	february: 2,
	feb: 2,
	pebruari: 2,
	maret: 3,
	march: 3,
	mar: 3,
	april: 4,
	apr: 4,
	mei: 5,
	may: 5,
	juni: 6,
	june: 6,
	jun: 6,
	juli: 7,
	july: 7,
	jul: 7,
	agustus: 8,
	august: 8,
	agu: 8,
	agt: 8,
	ags: 8,
	aug: 8,
	september: 9,
	sept: 9,
	sep: 9,
	oktober: 10,
	october: 10,
	okt: 10,
	oct: 10,
	november: 11,
	nov: 11,
	nop: 11,
	desember: 12,
	december: 12,
	des: 12,
	dec: 12
};

const monthNumber = (word: string) =>
	Object.hasOwn(MONTHS, word) ? (MONTHS[word] as number) : undefined;

const fullYear = (text: string) => (text.length === 2 ? 2000 + Number(text) : Number(text));

const lower = (text: string) =>
	text
		.slice(0, 64)
		.replace(/[A-Z]/g, (c) => c.toLowerCase())
		.trim();

/**
 * The month a tab title names ("Januari 2026", "Jan 26", "2026-01", "Okt 2026", "01/2026"), as `YYYY-MM`, or
 * null when it names none (or more than one reading is possible).
 */
export function monthFromTitle(title: string): string | null {
	const t = lower(title).replace(/[_]+/g, ' ');
	let m = /^(\d{4})[-/. ](\d{1,2})$/.exec(t);
	if (m) return monthOf(Number(m[1]), Number(m[2]));
	m = /^(\d{1,2})[-/. ](\d{4})$/.exec(t);
	if (m) return monthOf(Number(m[2]), Number(m[1]));
	m = /^(?:.*?[^a-z])?([a-z]+)\.?[\s'’-]*(\d{4}|\d{2})$/.exec(t);
	if (m) {
		const month = monthNumber(m[1] as string);
		if (month) return monthOf(fullYear(m[2] as string), month);
	}
	return null;
}

function monthOf(year: number, month: number): string | null {
	const value = `${pad(year, 4)}-${pad(month)}`;
	return isMonthString(value) ? value : null;
}

/** `YYYY-MM` + day → `YYYY-MM-DD` when that day exists in the month. */
function dayIn(month: string, day: number): string | null {
	const value = `${month}-${pad(day)}`;
	return isDateString(value) ? value : null;
}

export type CellDate =
	| { kind: 'date'; date: string }
	/** Only a day (`15`, "15 Okt"): needs the tab's month (and maybe its year). */
	| { kind: 'day'; day: number; month: number | null }
	| { kind: 'invalid' };

/** Day-first with `-` or `.` too (`01-10-2026`, `01.10.2026`); `/` goes through the CSV reader. */
const DAY_FIRST_DASH = /^(\d{1,2})[-.](\d{1,2})[-.](\d{4})$/;
/** "1 Okt 2026", "1 Oktober 2026", "15 Okt", "15-Okt-26". */
const DAY_MONTH_NAME = /^(\d{1,2})[\s-]+([a-z]+)\.?(?:[\s-]+(\d{4}|\d{2}))?$/;

/** A text date cell: ISO, day-first `DD/MM/YYYY` (shared CSV reader), `DD-MM-YYYY`, "1 Okt 2026", or a day. */
export function parseTextDate(text: string): CellDate {
	const t = lower(text);
	if (t === '') return { kind: 'invalid' };
	const csv = parseCsvDate(t);
	if (csv) return { kind: 'date', date: csv };
	let m = DAY_FIRST_DASH.exec(t);
	if (m) {
		const value = `${m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
		return isDateString(value) ? { kind: 'date', date: value } : { kind: 'invalid' };
	}
	m = DAY_MONTH_NAME.exec(t);
	if (m) {
		const month = monthNumber(m[2] as string);
		const day = Number(m[1]);
		if (!month || day < 1 || day > 31) return { kind: 'invalid' };
		if (!m[3]) return { kind: 'day', day, month };
		const value = `${pad(fullYear(m[3]), 4)}-${pad(month)}-${pad(day)}`;
		return isDateString(value) ? { kind: 'date', date: value } : { kind: 'invalid' };
	}
	if (/^\d{1,2}$/.test(t)) {
		const day = Number(t);
		return day >= 1 && day <= 31 ? { kind: 'day', day, month: null } : { kind: 'invalid' };
	}
	return { kind: 'invalid' };
}

/**
 * A number cell in the date column: a date-formatted serial, or (unformatted) a plausible serial
 * (SERIAL_MIN … SERIAL_MAX), or a day 1–31. Exact text, so `45678.75` is day 45678.
 */
export function numberDate(text: string, dateFormatted: boolean, date1904: boolean): CellDate {
	if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return { kind: 'invalid' };
	const value = Number(text);
	if (!dateFormatted && Number.isInteger(value) && value >= 1 && value <= 31)
		return { kind: 'day', day: value, month: null };
	if (!dateFormatted && (value < SERIAL_MIN || value >= SERIAL_MAX)) return { kind: 'invalid' };
	const date = serialToDate(value, date1904);
	return date && isDateString(date) ? { kind: 'date', date } : { kind: 'invalid' };
}

/** A day-only reading placed in the tab's month (`YYYY-MM`): its own month name wins, the year is the tab's. */
export function placeDay(
	read: { day: number; month: number | null },
	month: string
): string | null {
	const [year] = month.split('-');
	const m = read.month ?? Number(month.slice(5, 7));
	return dayIn(`${year}-${pad(m)}`, read.day);
}
