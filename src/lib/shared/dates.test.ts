import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	rowTimeLabel,
	formatWeekdayDay,
	addDays,
	daysBetween,
	formatDateTimeWib,
	formatDayHeader,
	formatDayLabel,
	formatMonthLabel,
	isDateString,
	isMonthString,
	isTimeString,
	monthOf,
	monthRange,
	parseRelativeIndonesianDate,
	shiftMonth,
	wibDateParts,
	wibDateString,
	wibDayRangeUtcMs,
	wibInstantUtcMs,
	wibHour,
	wibIsoString,
	wibTimeString,
	wibTodayString,
	formatShortDate,
	formatShortMonth,
	monthsBetween,
	yearToDateRange
} from './dates';

describe('yearToDateRange, monthsBetween and formatShortMonth (FN-09)', () => {
	it('runs from 1 January of the date’s own WIB year through the date', () => {
		expect(yearToDateRange('2026-10-08')).toEqual({ from: '2026-01-01', to: '2026-10-08' });
		expect(yearToDateRange('2027-01-01')).toEqual({ from: '2027-01-01', to: '2027-01-01' });
		expect(yearToDateRange('2028-12-31')).toEqual({ from: '2028-01-01', to: '2028-12-31' });
		// 00:30 WIB on 1 January is still 31 December in UTC: the WIB year wins.
		expect(yearToDateRange(wibTodayString(Date.parse('2026-12-31T17:30:00Z'))).from).toBe(
			'2027-01-01'
		);
		expect(() => yearToDateRange('2026-02-30')).toThrow(RangeError);
	});

	it('lists every month between two months, inclusive, at most 12 in a year', () => {
		expect(monthsBetween('2026-01', '2026-03')).toEqual(['2026-01', '2026-02', '2026-03']);
		expect(monthsBetween('2025-11', '2026-02')).toEqual([
			'2025-11',
			'2025-12',
			'2026-01',
			'2026-02'
		]);
		expect(monthsBetween('2026-01', '2026-12')).toHaveLength(12);
		expect(monthsBetween('2026-05', '2026-05')).toEqual(['2026-05']);
		expect(monthsBetween('2026-05', '2026-04')).toEqual([]);
	});

	it('labels a month briefly', () => {
		expect(formatShortMonth('2026-10', 'id')).toBe('Okt');
		expect(formatShortMonth('2026-10', 'en')).toBe('Oct');
	});
});

describe('formatDateTimeWib', () => {
	it('shows a UTC instant in WIB (UTC+7), crossing the date line', () => {
		// 2026-10-31 17:30 UTC = 2026-11-01 00:30 WIB
		const at = Date.UTC(2026, 9, 31, 17, 30);
		const id = formatDateTimeWib(at, 'id');
		expect(id).toContain('1 November 2026');
		expect(id).toContain('00.30');
		expect(id.endsWith('WIB')).toBe(true);
		expect(formatDateTimeWib(at, 'en')).toContain('1 November 2026');
	});

	it('keeps the last day of the month at 23:30 WIB', () => {
		const at = Date.UTC(2026, 9, 31, 16, 30); // 23:30 WIB on 31 Oct
		expect(formatDateTimeWib(at, 'id')).toContain('31 Oktober 2026');
	});
});

describe('WIB calendar dates (occurred_on)', () => {
	// The checklist vectors: 23:30 WIB on the last day of a month, 00:30 WIB on the first of the next.
	const lastDay2330 = Date.UTC(2026, 9, 31, 16, 30); // 2026-10-31 23:30 WIB
	const firstDay0030 = Date.UTC(2026, 9, 31, 17, 30); // 2026-11-01 00:30 WIB

	it('buckets 23:30 WIB on the last day into that month', () => {
		expect(wibDateString(lastDay2330)).toBe('2026-10-31');
		expect(monthOf(wibDateString(lastDay2330))).toBe('2026-10');
	});

	it('buckets 00:30 WIB on the first into the new month, although UTC is still the previous day', () => {
		expect(new Date(firstDay0030).toISOString().slice(0, 10)).toBe('2026-10-31');
		expect(wibDateString(firstDay0030)).toBe('2026-11-01');
		expect(monthOf(wibDateString(firstDay0030))).toBe('2026-11');
	});

	it('crosses the year boundary the same way', () => {
		expect(wibDateString(Date.UTC(2026, 11, 31, 16, 30))).toBe('2026-12-31');
		expect(wibDateString(Date.UTC(2026, 11, 31, 17, 30))).toBe('2027-01-01');
		expect(wibTodayString(Date.UTC(2026, 11, 31, 17, 0))).toBe('2027-01-01');
	});

	it('maps a WIB day to its UTC instants (start inclusive, end exclusive)', () => {
		const { startMs, endMs } = wibDayRangeUtcMs('2026-11-01');
		expect(startMs).toBe(Date.UTC(2026, 9, 31, 17, 0));
		expect(endMs - startMs).toBe(24 * 60 * 60 * 1000);
		expect(wibDateString(startMs)).toBe('2026-11-01');
		expect(wibDateString(endMs - 1)).toBe('2026-11-01');
		expect(wibDateString(endMs)).toBe('2026-11-02');
	});

	it('reads the WIB hour, not the UTC one', () => {
		const at = (iso: string) => Date.parse(iso);
		expect(wibHour(at('2026-10-07T23:00:00Z'))).toBe(6);
		expect(wibHour(at('2026-10-08T16:59:00Z'))).toBe(23);
		expect(wibHour(at('2026-10-08T17:00:00Z'))).toBe(0);
		expect(wibHour(-1)).toBe(6);
	});

	it('turns a WIB date and time into the UTC instant and back', () => {
		const at = wibInstantUtcMs('2026-10-31', '23:30');
		expect(at).toBe(lastDay2330);
		expect(wibTimeString(at)).toBe('23:30');
		expect(wibInstantUtcMs('2026-11-01', '00:30')).toBe(firstDay0030);
		expect(() => wibInstantUtcMs('2026-11-01', '24:00')).toThrow(RangeError);
	});

	it('validates dates, months and times strictly', () => {
		for (const ok of ['2026-02-28', '2028-02-29', '2000-01-01', '2099-12-31'])
			expect(isDateString(ok)).toBe(true);
		for (const bad of [
			'2026-02-29',
			'2026-13-01',
			'2026-1-01',
			'1999-12-31',
			'2100-01-01',
			'',
			'x'
		])
			expect(isDateString(bad)).toBe(false);
		expect(isMonthString('2026-10')).toBe(true);
		expect(isMonthString('2026-00')).toBe(false);
		expect(isTimeString('23:59')).toBe(true);
		expect(isTimeString('7:30')).toBe(false);
		expect(isTimeString('12:60')).toBe(false);
	});

	it('computes month ranges, month shifts and day offsets', () => {
		expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
		expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
		expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
		expect(shiftMonth('2026-01', -1)).toBe('2025-12');
		expect(shiftMonth('2026-12', 1)).toBe('2027-01');
		expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
		expect(daysBetween('2026-10-31', '2026-10-01')).toBe(-30);
	});

	it('formats day and month labels in both languages', () => {
		expect(formatDayLabel('2026-10-08', 'id')).toBe('Kamis, 8 Oktober 2026');
		expect(formatDayLabel('2026-10-08', 'en')).toContain('Thursday');
		expect(formatMonthLabel('2026-11', 'id')).toBe('November 2026');
		expect(formatMonthLabel('2026-11', 'en')).toBe('November 2026');
	});

	it('day headers use the short month and drop the year only in the current year', () => {
		expect(formatDayHeader('2026-10-01', '2026-10-15', 'id')).toBe('Kamis, 1 Okt');
		expect(formatDayHeader('2025-12-31', '2026-01-02', 'id')).toBe('Rabu, 31 Des 2025');
		expect(formatDayHeader('2026-10-01', '2026-10-15', 'en')).toBe('Thursday 1 Oct');
	});
});

describe('wibDateString — WIB month boundaries', () => {
	it.each<[string, number, string]>([
		['23:30 WIB on 31 Oct stays 31 Oct', Date.UTC(2026, 9, 31, 16, 30), '2026-10-31'],
		['00:30 WIB on 1 Nov is 1 Nov (UTC still 31 Oct)', Date.UTC(2026, 9, 31, 17, 30), '2026-11-01'],
		['23:30 WIB on 31 Dec stays in the old year', Date.UTC(2026, 11, 31, 16, 30), '2026-12-31'],
		['00:30 WIB on 1 Jan is the new year', Date.UTC(2026, 11, 31, 17, 30), '2027-01-01'],
		['23:30 WIB on 29 Feb 2024', Date.UTC(2024, 1, 29, 16, 30), '2024-02-29'],
		['00:30 WIB on 1 Mar 2024', Date.UTC(2024, 1, 29, 17, 30), '2024-03-01'],
		['exactly 00:00 WIB starts the new day', Date.UTC(2026, 9, 31, 17, 0), '2026-11-01'],
		['23:59:59.999 WIB is still the old day', Date.UTC(2026, 9, 31, 16, 59, 59, 999), '2026-10-31']
	])('%s', (_label, epochMs, expected) => {
		expect(wibDateString(epochMs)).toBe(expected);
	});
});

describe('addDays and wibDateParts', () => {
	it.each<[string, number, string]>([
		['2026-11-01', -1, '2026-10-31'],
		['2025-03-01', -1, '2025-02-28'],
		['2024-03-01', -1, '2024-02-29'],
		['2027-01-01', -1, '2026-12-31'],
		['2026-10-31', 1, '2026-11-01'],
		['2026-10-08', 0, '2026-10-08'],
		['2026-10-08', -366, '2025-10-07']
	])('%s %d days → %s', (date, days, expected) => {
		expect(addDays(date, days)).toBe(expected);
	});

	it('parses a date string into numbers', () => {
		expect(wibDateParts('2026-10-08')).toStrictEqual({ year: 2026, month: 10, day: 8 });
	});

	it.each([
		'2026-02-30',
		'2025-02-29',
		'2026-13-01',
		'2026-1-08',
		'08/10/2026',
		'',
		'x'.repeat(5000)
	])('%j is not a calendar date', (bad) => {
		expect(() => wibDateParts(bad)).toThrow(RangeError);
	});
});

describe('parseRelativeIndonesianDate', () => {
	const today = '2026-10-08'; // Thursday

	it.each<[string, string | null]>([
		['hari ini', '2026-10-08'],
		['kemarin', '2026-10-07'],
		['tadi pagi', '2026-10-08'],
		['tadi siang', '2026-10-08'],
		['tadi sore', '2026-10-08'],
		['tadi malam', '2026-10-08'],
		['kemarin pagi', '2026-10-07'],
		['kemarin siang', '2026-10-07'],
		['kemarin sore', '2026-10-07'],
		['kemarin malam', '2026-10-07'],
		['senin lalu', '2026-10-05'],
		['selasa lalu', '2026-10-06'],
		['rabu lalu', '2026-10-07'],
		['kamis lalu', '2026-10-01'], // today is Thursday: strictly before, never today
		['jumat lalu', '2026-10-02'],
		["jum'at lalu", '2026-10-02'],
		['sabtu lalu', '2026-10-03'],
		['minggu lalu', '2026-10-04'],
		['hari senin lalu', '2026-10-05'],
		['3 hari yang lalu', '2026-10-05'],
		['2 hari lalu', '2026-10-06'],
		['1 hari lalu', '2026-10-07'],
		['366 hari lalu', '2025-10-07'],
		['  Kemarin  ', '2026-10-07'],
		['KEMARIN​', '2026-10-07'],
		['besok', null],
		['lusa', null],
		['0 hari lalu', null],
		['367 hari lalu', null],
		['bulan lalu', null],
		['kemarin dulu', null],
		['', null],
		['beli kopi kemarin', null] // whole phrase only
	])('%j → %s', (phrase, expected) => {
		expect(parseRelativeIndonesianDate(phrase, today)).toBe(expected);
	});

	it.each<[string, string]>([
		['2026-11-01', '2026-10-31'],
		['2025-03-01', '2025-02-28'],
		['2024-03-01', '2024-02-29'],
		['2027-01-01', '2026-12-31']
	])('kemarin on %s → %s', (todayWib, expected) => {
		expect(parseRelativeIndonesianDate('kemarin', todayWib)).toBe(expected);
	});

	it('uses only the passed-in today, far from the real clock', () => {
		expect(parseRelativeIndonesianDate('senin lalu', '1999-01-01')).toBe('1998-12-28');
		expect(parseRelativeIndonesianDate('kemarin', '2101-03-01')).toBe('2101-02-28');
		expect(parseRelativeIndonesianDate('hari ini', '1970-01-01')).toBe('1970-01-01');
	});

	it('rejects a malformed today instead of guessing', () => {
		expect(() => parseRelativeIndonesianDate('kemarin', '2026-02-30')).toThrow(RangeError);
	});

	it('never reads the wall clock', () => {
		const source = readFileSync(new URL('./dates.ts', import.meta.url), 'utf8');
		const body = source.slice(source.indexOf('export function parseRelativeIndonesianDate'));
		expect(body).not.toMatch(/Date\.now|new Date\(\)/);
	});
});

describe('cycle 2 — L4: addDays validates its range', () => {
	it.each<[string, number]>([
		['2026-10-08', 0.5],
		['2026-10-08', Number.NaN],
		['2026-10-08', Number.POSITIVE_INFINITY],
		['2026-10-08', 2 ** 60],
		['9999-12-31', 1],
		['1970-01-01', -1],
		['1969-12-31', 0]
	])('addDays(%s, %d) throws RangeError', (date, days) => {
		expect(() => addDays(date, days)).toThrow(RangeError);
	});

	it('accepts the edges of the range', () => {
		expect(addDays('9999-12-30', 1)).toBe('9999-12-31');
		expect(addDays('1970-01-02', -1)).toBe('1970-01-01');
	});
});

describe('formatShortDate (FN-27)', () => {
	it('shows the calendar date with its year, never shifted by a time zone', () => {
		expect(formatShortDate('2024-10-08', 'id')).toMatch(/^8 Okt 2024$/);
		expect(formatShortDate('2024-12-31', 'en')).toMatch(/^31 Dec 2024$/);
		expect(formatShortDate('1999-01-01', 'id')).toMatch(/^1 Jan 1999$/);
	});
});

describe('wibIsoString (FN-31 export)', () => {
	it('shows the WIB wall clock with its +07:00 offset, across the UTC day boundary', () => {
		expect(wibIsoString(Date.UTC(2026, 9, 31, 16, 30, 5))).toBe('2026-10-31T23:30:05+07:00');
		expect(wibIsoString(Date.UTC(2026, 9, 31, 17, 30, 0))).toBe('2026-11-01T00:30:00+07:00');
		expect(new Date(wibIsoString(1_800_000_000_000)).getTime()).toBe(1_800_000_000_000);
	});
});

describe('rowTimeLabel', () => {
	// 2026-10-07 09:32 UTC = 16:32 WIB on 2026-10-07.
	const at = Date.UTC(2026, 9, 7, 9, 32);
	it('shows the WIB time with a dot in Indonesian, a colon in English', () => {
		expect(rowTimeLabel('2026-10-07', at, 'id')).toBe('16.32');
		expect(rowTimeLabel('2026-10-07', at, 'en')).toBe('16:32');
	});
	it('uses the WIB date, never the UTC date, at a month boundary', () => {
		// 2026-10-31 16:30 UTC = 23:30 WIB on the 31st; 2026-10-31 17:30 UTC = 00:30 WIB on 1 Nov.
		expect(rowTimeLabel('2026-10-31', Date.UTC(2026, 9, 31, 16, 30), 'id')).toBe('23.30');
		expect(rowTimeLabel('2026-11-01', Date.UTC(2026, 9, 31, 17, 30), 'id')).toBe('00.30');
		expect(rowTimeLabel('2026-10-31', Date.UTC(2026, 9, 31, 17, 30), 'id')).toBeNull();
	});
	it('hides the time of a back-dated row saved without one', () => {
		expect(rowTimeLabel('2026-10-05', at, 'id')).toBeNull();
	});
});

describe('formatWeekdayDay', () => {
	it('reads as Beranda’s date line in both languages', () => {
		expect(formatWeekdayDay('2026-10-08', 'id')).toBe('Kamis, 8 Okt');
		expect(formatWeekdayDay('2026-10-08', 'en')).toBe('Thursday 8 Oct');
	});
});
