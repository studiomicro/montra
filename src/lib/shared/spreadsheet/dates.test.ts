import { describe, expect, it } from 'vitest';
import { monthFromTitle, numberDate, parseTextDate, placeDay, serialToDate } from './dates';

describe('serialToDate', () => {
	it('1900 system: the 1900-02-29 bug, serials below 60 shift by one', () => {
		expect(serialToDate(1, false)).toBe('1900-01-01');
		expect(serialToDate(59, false)).toBe('1900-02-28');
		expect(serialToDate(60, false)).toBeNull();
		expect(serialToDate(61, false)).toBe('1900-03-01');
		expect(serialToDate(0, false)).toBeNull();
	});

	it('1900 system: month and year boundaries, a time fraction dropped (no timezone shift)', () => {
		expect(serialToDate(46053, false)).toBe('2026-01-31');
		expect(serialToDate(46054, false)).toBe('2026-02-01');
		expect(serialToDate(46387, false)).toBe('2026-12-31');
		expect(serialToDate(46388, false)).toBe('2027-01-01');
		// 23:30 on 31 Jan stays 31 Jan (a serial is a wall-clock date, never shifted to UTC).
		expect(serialToDate(46053.979, false)).toBe('2026-01-31');
		expect(serialToDate(46054.02, false)).toBe('2026-02-01');
	});

	it('1904 system counts from 1904-01-01', () => {
		expect(serialToDate(0, true)).toBe('1904-01-01');
		expect(serialToDate(46053 - 1462, true)).toBe('2026-01-31');
	});

	it('refuses negative and absurd serials', () => {
		expect(serialToDate(-1, false)).toBeNull();
		expect(serialToDate(Number.NaN, false)).toBeNull();
		expect(serialToDate(9e9, false)).toBeNull();
	});
});

describe('monthFromTitle', () => {
	it.each([
		['Januari 2026', '2026-01'],
		['Jan 26', '2026-01'],
		['2026-01', '2026-01'],
		['Okt 2026', '2026-10'],
		['Oktober 2026', '2026-10'],
		['01/2026', '2026-01'],
		['Pengeluaran Des 2026', '2026-12'],
		['Agt 2026', '2026-08'],
		['May 2026', '2026-05']
	])('%s → %s', (title, month) => expect(monthFromTitle(title)).toBe(month));

	it.each(['Pemasukan', 'Sheet1', 'Sheet12', '2026', 'Okt', 'Foo 2026'])('%s → null', (t) =>
		expect(monthFromTitle(t)).toBeNull()
	);
});

describe('parseTextDate', () => {
	it('reads ISO, day-first and month names', () => {
		expect(parseTextDate('2026-10-01')).toEqual({ kind: 'date', date: '2026-10-01' });
		expect(parseTextDate('01/10/2026')).toEqual({ kind: 'date', date: '2026-10-01' });
		expect(parseTextDate('01-10-2026')).toEqual({ kind: 'date', date: '2026-10-01' });
		expect(parseTextDate('1 Okt 2026')).toEqual({ kind: 'date', date: '2026-10-01' });
		expect(parseTextDate('1 Oktober 2026')).toEqual({ kind: 'date', date: '2026-10-01' });
		expect(parseTextDate('15-Okt-26')).toEqual({ kind: 'date', date: '2026-10-15' });
	});

	it('a day alone or a day + month name needs the tab month', () => {
		expect(parseTextDate('15')).toEqual({ kind: 'day', day: 15, month: null });
		expect(parseTextDate('15 Okt')).toEqual({ kind: 'day', day: 15, month: 10 });
	});

	it('ambiguous or impossible dates are invalid, never guessed', () => {
		for (const t of ['10/31/2026', '31/02/2026', '32', 'kemarin', '2026/10', '', '1 Foo 2026'])
			expect(parseTextDate(t)).toEqual({ kind: 'invalid' });
	});
});

describe('numberDate', () => {
	it('a date-formatted serial is a date; unformatted only in the plausible range', () => {
		expect(numberDate('46296', true, false)).toEqual({ kind: 'date', date: '2026-10-01' });
		expect(numberDate('46296', false, false)).toEqual({ kind: 'date', date: '2026-10-01' });
		expect(numberDate('28000', false, false)).toEqual({ kind: 'invalid' });
		expect(numberDate('15', false, false)).toEqual({ kind: 'day', day: 15, month: null });
	});
});

describe('placeDay', () => {
	it('puts a day in the tab month; its own month name wins; a non-existent day is null', () => {
		expect(placeDay({ day: 15, month: null }, '2026-10')).toBe('2026-10-15');
		expect(placeDay({ day: 1, month: 11 }, '2026-10')).toBe('2026-11-01');
		expect(placeDay({ day: 31, month: null }, '2026-02')).toBeNull();
	});
});
