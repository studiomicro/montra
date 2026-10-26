import type { Locale } from './i18n.ts';
import { cleanText } from './text.ts';

/** Western Indonesia Time: every date the user sees is in this zone. */
export const WIB = 'Asia/Jakarta';

/** WIB is UTC+7 all year (Indonesia has no daylight saving), so WIB dates are plain arithmetic. */
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
/** One day in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD`, the shape of `occurred_on` and of a native `<input type="date">`. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `YYYY-MM`, a calendar month. */
const MONTH = /^(\d{4})-(\d{2})$/;
/** `HH:MM`, a native `<input type="time">` value (seconds are not used). */
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** UTC midnight of a calendar date (used only to read and format the date itself, never as an instant). */
function utcMidnight(date: string): number {
	const m = DATE.exec(date);
	if (!m) throw new RangeError('not a YYYY-MM-DD date');
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function dateOfUtcFields(ms: number): string {
	const d = new Date(ms);
	return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** True for a real calendar date `YYYY-MM-DD` (no 2026-02-30) in the years 2000–2099. */
export function isDateString(value: string): boolean {
	const m = DATE.exec(value);
	if (!m) return false;
	const year = Number(m[1]);
	if (year < 2000 || year > 2099) return false;
	return dateOfUtcFields(utcMidnight(value)) === value;
}

/** True for a month `YYYY-MM` in the years 2000–2099. */
export function isMonthString(value: string): boolean {
	return MONTH.test(value) && isDateString(`${value}-01`);
}

/** True for a time `HH:MM` (00:00–23:59). */
export function isTimeString(value: string): boolean {
	return TIME.test(value);
}

/** The WIB calendar date of a UTC instant: what `occurred_on` stores and every day/month bucket uses. */
export function wibDateString(utcMs: number): string {
	return dateOfUtcFields(utcMs + WIB_OFFSET_MS);
}

/** Today in WIB (the compose form's default date). */
export function wibTodayString(utcMs: number = Date.now()): string {
	return wibDateString(utcMs);
}

/** The WIB hour (0–23) of a UTC instant, from the epoch arithmetic only (never `getHours()`, the device's zone). */
export function wibHour(utcMs: number): number {
	const hours = Math.floor(utcMs / 3_600_000) + WIB_OFFSET_MS / 3_600_000;
	return ((hours % 24) + 24) % 24;
}

/** `HH:MM` of a UTC instant in WIB. */
export function wibTimeString(utcMs: number): string {
	const d = new Date(utcMs + WIB_OFFSET_MS);
	return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** A UTC instant as ISO 8601 in WIB, to the second: `2026-10-08T14:30:05+07:00` (data exports, FN-31). */
export function wibIsoString(utcMs: number): string {
	return new Date(utcMs + WIB_OFFSET_MS).toISOString().slice(0, 19) + '+07:00';
}

/**
 * The WIB clock time of a row for its list line ("16.32"; English "16:32"), or null when its instant is not on
 * its own WIB date (a back-dated row saved without a time keeps the save instant only for ordering).
 */
export function rowTimeLabel(
	occurredOn: string,
	occurredAt: number,
	locale: Locale
): string | null {
	if (wibDateString(occurredAt) !== occurredOn) return null;
	const time = wibTimeString(occurredAt);
	return locale === 'en' ? time : time.replace(':', '.');
}

/** The WIB day `date` as UTC instants: `startMs` inclusive, `endMs` exclusive (the next WIB midnight). */
export function wibDayRangeUtcMs(date: string): { startMs: number; endMs: number } {
	const startMs = utcMidnight(date) - WIB_OFFSET_MS;
	return { startMs, endMs: startMs + DAY_MS };
}

/** The UTC instant of `time` (`HH:MM`) on the WIB date `date`. */
export function wibInstantUtcMs(date: string, time: string): number {
	const m = TIME.exec(time);
	if (!m) throw new RangeError('not an HH:MM time');
	return wibDayRangeUtcMs(date).startMs + (Number(m[1]) * 60 + Number(m[2])) * 60 * 1000;
}

/** `YYYY-MM` of a `YYYY-MM-DD` date. */
export function monthOf(date: string): string {
	return date.slice(0, 7);
}

/** First and last day (inclusive) of the month `YYYY-MM`. */
export function monthRange(month: string): { from: string; to: string } {
	const m = MONTH.exec(month);
	if (!m) throw new RangeError('not a YYYY-MM month');
	return {
		from: `${month}-01`,
		to: dateOfUtcFields(Date.UTC(Number(m[1]), Number(m[2]), 1) - DAY_MS)
	};
}

/** 1 January of `date`'s year through `date` itself (inclusive): the WIB year to date. */
export function yearToDateRange(date: string): { from: string; to: string } {
	const { year } = wibDateParts(date);
	return { from: `${pad(year, 4)}-01-01`, to: date };
}

/** Every month `YYYY-MM` from `fromMonth` through `toMonth` (inclusive), oldest first; [] when reversed. */
export function monthsBetween(fromMonth: string, toMonth: string): string[] {
	const months: string[] = [];
	for (let m = fromMonth; m <= toMonth && months.length < 1200; m = shiftMonth(m, 1))
		months.push(m);
	return months;
}

/** The month `delta` months after `month` (negative for earlier). */
export function shiftMonth(month: string, delta: number): string {
	const m = MONTH.exec(month);
	if (!m) throw new RangeError('not a YYYY-MM month');
	return dateOfUtcFields(Date.UTC(Number(m[1]), Number(m[2]) - 1 + delta, 1)).slice(0, 7);
}

/** `YYYY-MM-DD` → numeric parts; throws RangeError on anything that is not a real calendar date. */
export function wibDateParts(date: string): { year: number; month: number; day: number } {
	const m = DATE.exec(date);
	if (m && dateOfUtcFields(utcMidnight(date)) === date) {
		return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
	}
	throw new RangeError(`not a calendar date: ${date.slice(0, 20)}`);
}

const MIN_YEAR = 1970;
const MAX_YEAR = 9999;

/**
 * The date `days` days after `date` (negative for earlier), across month, year and leap-day boundaries.
 * Internal API: `date` must be a real calendar date and `days` a safe integer, and the input and result years
 * must lie in 1970–9999; anything else throws RangeError.
 */
export function addDays(date: string, days: number): string {
	const { year } = wibDateParts(date);
	if (!Number.isSafeInteger(days)) throw new RangeError('days must be a safe integer');
	const result = utcMidnight(date) + days * DAY_MS;
	const resultYear = Number.isFinite(result) ? new Date(result).getUTCFullYear() : Number.NaN;
	if (year < MIN_YEAR || !(resultYear >= MIN_YEAR && resultYear <= MAX_YEAR)) {
		throw new RangeError(`date out of range ${MIN_YEAR}–${MAX_YEAR}`);
	}
	return dateOfUtcFields(result);
}

/** Whole days from `from` to `to` (0 for the same date, negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
	return Math.round((utcMidnight(to) - utcMidnight(from)) / DAY_MS);
}

const intlLocale = (locale: Locale) => (locale === 'en' ? 'en-GB' : 'id-ID');

/** A WIB calendar date as a day heading, e.g. "Kamis, 8 Oktober 2026". */
export function formatDayLabel(date: string, locale: Locale): string {
	return new Intl.DateTimeFormat(intlLocale(locale), {
		timeZone: 'UTC',
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric'
	}).format(new Date(utcMidnight(date)));
}

/** A month `YYYY-MM` as a label, e.g. "Oktober 2026". */
export function formatMonthLabel(month: string, locale: Locale): string {
	return new Intl.DateTimeFormat(intlLocale(locale), {
		timeZone: 'UTC',
		month: 'long',
		year: 'numeric'
	}).format(new Date(utcMidnight(`${month}-01`)));
}

/** A month `YYYY-MM` as its name alone, e.g. "Oktober" ("Pengeluaran Oktober"). */
export function formatMonthName(month: string, locale: Locale): string {
	return new Intl.DateTimeFormat(intlLocale(locale), { timeZone: 'UTC', month: 'long' }).format(
		new Date(utcMidnight(`${month}-01`))
	);
}

/** A month `YYYY-MM` as a short chart label, e.g. "Okt". */
export function formatShortMonth(month: string, locale: Locale): string {
	return new Intl.DateTimeFormat(intlLocale(locale), { timeZone: 'UTC', month: 'short' }).format(
		new Date(utcMidnight(`${month}-01`))
	);
}

/** A WIB calendar date as a short chart label, e.g. "8 Okt". */
export function formatShortDay(date: string, locale: Locale): string {
	return new Intl.DateTimeFormat(intlLocale(locale), {
		timeZone: 'UTC',
		day: 'numeric',
		month: 'short'
	}).format(new Date(utcMidnight(date)));
}

/** A WIB calendar date as Beranda's date line, e.g. "Kamis, 8 Okt" ("Thursday, 8 Oct"). */
export function formatWeekdayDay(date: string, locale: Locale): string {
	return new Intl.DateTimeFormat(intlLocale(locale), {
		timeZone: 'UTC',
		weekday: 'long',
		day: 'numeric',
		month: 'short'
	}).format(new Date(utcMidnight(date)));
}

/**
 * A grouped list's day header (DESIGN_SYSTEM § Grouped list, § Formatting): "Kamis, 1 Okt" in the current year,
 * "Rabu, 31 Des 2025" in another, so a header never wraps at 360 px. `today` is the WIB date the page was built for.
 */
export function formatDayHeader(date: string, today: string, locale: Locale): string {
	return new Intl.DateTimeFormat(intlLocale(locale), {
		timeZone: 'UTC',
		weekday: 'long',
		day: 'numeric',
		month: 'short',
		...(date.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' as const })
	}).format(new Date(utcMidnight(date)));
}

/** A WIB calendar date with its year, e.g. "8 Okt 2024" (a purchase date, FN-27). */
export function formatShortDate(date: string, locale: Locale): string {
	return new Intl.DateTimeFormat(intlLocale(locale), {
		timeZone: 'UTC',
		day: 'numeric',
		month: 'short',
		year: 'numeric'
	}).format(new Date(utcMidnight(date)));
}

/** A stored UTC epoch-ms instant as a WIB date and time, e.g. "7 Oktober 2026 pukul 08.30 WIB". */
export function formatDateTimeWib(epochMs: number, locale: Locale): string {
	const text = new Intl.DateTimeFormat(intlLocale(locale), {
		timeZone: WIB,
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	}).format(new Date(epochMs));
	return `${text} WIB`;
}

/** Indonesian weekday names, index = `Date#getUTCDay()` (0 = Sunday). */
const WEEKDAYS: readonly string[] = [
	'minggu',
	'senin',
	'selasa',
	'rabu',
	'kamis',
	'jumat',
	'sabtu'
];
const MAX_DAYS_AGO = 366;
const RELATIVE_PHRASE_MAX = 40;

/**
 * A spoken or typed relative date (the whole phrase) → WIB `YYYY-MM-DD`, relative to the caller's `todayWib`.
 * `hari ini`, `tadi pagi|siang|sore|malam` → today; `kemarin [pagi|siang|sore|malam]` → yesterday;
 * `[hari] <weekday> lalu` → that weekday strictly before today; `N hari [yang] lalu` (1–366) → N days back.
 * Anything else → null (the caller keeps its own default). Throws RangeError if `todayWib` is not a date.
 */
export function parseRelativeIndonesianDate(text: string, todayWib: string): string | null {
	const { year, month, day } = wibDateParts(todayWib);
	const phrase = cleanText(text, RELATIVE_PHRASE_MAX).toLowerCase().replace(/'/g, '');
	if (phrase === 'hari ini' || /^tadi (pagi|siang|sore|malam)$/.test(phrase)) return todayWib;
	if (/^kemarin( (pagi|siang|sore|malam))?$/.test(phrase)) return addDays(todayWib, -1);
	const weekday = /^(?:hari )?([a-z]+) lalu$/.exec(phrase);
	if (weekday) {
		const target = WEEKDAYS.indexOf(weekday[1] as string);
		if (target < 0) return null;
		const today = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
		return addDays(todayWib, -((today - target + 7) % 7 || 7));
	}
	const daysAgo = /^(\d{1,3}) hari (?:yang )?lalu$/.exec(phrase);
	if (daysAgo) {
		const n = Number(daysAgo[1]);
		return n >= 1 && n <= MAX_DAYS_AGO ? addDays(todayWib, -n) : null;
	}
	return null;
}
