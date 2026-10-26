import { describe, expect, it } from 'vitest';
import { createTranslator } from './i18n';
import {
	parseReportPeriod,
	periodDates,
	periodName,
	periodStepLabel,
	periodTitle,
	previousPeriodDates,
	reportPeriodHref,
	stepReportPeriod,
	switchReportKind,
	type ReportKind,
	type ReportPeriod
} from './report-period';

const TODAY = '2026-10-13';
const parse = (query: string, kind: ReportKind = 'bulan', today = TODAY) =>
	parseReportPeriod(new URLSearchParams(query), today, kind);
const q = (year: string, quarter: 1 | 2 | 3 | 4): ReportPeriod => ({
	kind: 'kuartal',
	year,
	quarter
});
const y = (year: string): ReportPeriod => ({ kind: 'tahun', year });
const m = (month: string): ReportPeriod => ({ kind: 'bulan', month });

describe('parseReportPeriod (AC 1)', () => {
	it('reads k, y and p; k wins over y over p; unparsable values fall through', () => {
		expect(parse('k=2026-Q3')).toEqual(q('2026', 3));
		expect(parse('y=2025')).toEqual(y('2025'));
		expect(parse('p=2026-05')).toEqual(m('2026-05'));
		expect(parse('k=2026-Q5&y=2025')).toEqual(y('2025'));
		expect(parse('k=2026-Q1&y=2025&p=2026-05')).toEqual(q('2026', 1));
		expect(parse('y=2025&p=2026-05')).toEqual(y('2025'));
		expect(parse('y=25&p=2026-05')).toEqual(m('2026-05'));
	});

	it('clamps a future period to the current one and anything before 2000 to 2000', () => {
		expect(parse('k=2027-Q1')).toEqual(q('2026', 4));
		expect(parse('k=2026-Q4')).toEqual(q('2026', 4));
		expect(parse('y=2027')).toEqual(y('2026'));
		expect(parse('p=2026-11')).toEqual(m('2026-10'));
		expect(parse('y=1999')).toEqual(y('2000'));
		expect(parse('k=1999-Q4')).toEqual(q('2000', 1));
		// `p` keeps FN-35's month grammar (2000–2099): an earlier month is unparsable, so the default.
		expect(parse('p=1999-12')).toEqual(m('2026-10'));
		expect(parse('p=2000-01')).toEqual(m('2000-01'));
	});

	it('nothing valid is the page default; never throws on junk', () => {
		expect(parse('p=garbage')).toEqual(m('2026-10'));
		expect(parse('', 'kuartal')).toEqual(q('2026', 4));
		expect(parse('', 'tahun')).toEqual(y('2026'));
		for (const junk of [
			'k=%00',
			'k=2026-q3',
			'y=２０２５',
			'p=2026-13',
			'k=0000-Q1',
			'm=x',
			'y=9999'
		])
			expect(() => parse(junk)).not.toThrow();
		expect(parse('y=0000')).toEqual(y('2000'));
	});
});

describe('periodDates (AC 2, 3)', () => {
	it('calendar quarters', () => {
		const dates = (quarter: 1 | 2 | 3 | 4) => periodDates(q('2025', quarter), TODAY);
		expect([dates(1).from, dates(1).to]).toEqual(['2025-01-01', '2025-03-31']);
		expect([dates(2).from, dates(2).to]).toEqual(['2025-04-01', '2025-06-30']);
		expect([dates(3).from, dates(3).to]).toEqual(['2025-07-01', '2025-09-30']);
		expect([dates(4).from, dates(4).to]).toEqual(['2025-10-01', '2025-12-31']);
		expect(dates(3)).toMatchObject({
			months: ['2025-07', '2025-08', '2025-09'],
			elapsedMonths: 3,
			partial: false
		});
	});

	it('a leap year is 2028-01-01..2028-12-31 (366 days)', () => {
		const d = periodDates(y('2028'), '2029-02-01');
		expect([d.from, d.to, d.months.length]).toEqual(['2028-01-01', '2028-12-31', 12]);
		expect(periodDates(q('2028', 1), '2029-02-01').to).toBe('2028-03-31');
		expect(periodDates(m('2028-02'), '2029-02-01').to).toBe('2028-02-29');
	});

	it('the current quarter and year run through today; the current month stays whole (FN-35)', () => {
		expect(periodDates(q('2026', 4), TODAY)).toEqual({
			from: '2026-10-01',
			to: '2026-10-13',
			months: ['2026-10'],
			elapsedMonths: 1,
			partial: true
		});
		const year = periodDates(y('2026'), TODAY);
		expect(year.to).toBe('2026-10-13');
		expect(year.months).toEqual([
			'2026-01',
			'2026-02',
			'2026-03',
			'2026-04',
			'2026-05',
			'2026-06',
			'2026-07',
			'2026-08',
			'2026-09',
			'2026-10'
		]);
		expect(year.partial).toBe(true);
		expect(periodDates(m('2026-10'), TODAY)).toMatchObject({
			from: '2026-10-01',
			to: '2026-10-31',
			partial: true
		});
		expect(periodDates(y('2025'), TODAY)).toMatchObject({ to: '2025-12-31', partial: false });
	});
});

describe('previousPeriodDates (AC 4)', () => {
	it('a running period is compared with the same day offset of the previous one', () => {
		expect(previousPeriodDates(q('2026', 4), TODAY)).toEqual({
			period: q('2026', 3),
			from: '2026-07-01',
			to: '2026-07-13',
			cut: true
		});
		expect(previousPeriodDates(y('2026'), '2026-03-31')).toMatchObject({
			period: y('2025'),
			from: '2025-01-01',
			to: '2025-03-31',
			cut: true
		});
		expect(previousPeriodDates(m('2026-10'), TODAY)).toMatchObject({
			period: m('2026-09'),
			to: '2026-09-13',
			cut: true
		});
	});

	it('a complete period is compared with the whole previous one', () => {
		expect(previousPeriodDates(q('2026', 3), TODAY)).toEqual({
			period: q('2026', 2),
			from: '2026-04-01',
			to: '2026-06-30',
			cut: false
		});
		expect(previousPeriodDates(q('2026', 1), TODAY)).toMatchObject({
			period: q('2025', 4),
			from: '2025-10-01',
			to: '2025-12-31'
		});
	});

	it('the 31st clamps to a shorter previous month; leap days line up', () => {
		expect(previousPeriodDates(m('2026-03'), '2026-03-31')).toMatchObject({
			from: '2026-02-01',
			to: '2026-02-28'
		});
		expect(previousPeriodDates(m('2028-03'), '2028-03-31')?.to).toBe('2028-02-29');
		// Day 92 of Q4 (31 Dec) against Q3's 92 days; day 92 of Q3 (30 Sep) against Q2's 91 days.
		expect(previousPeriodDates(q('2026', 4), '2026-12-31')?.to).toBe('2026-09-30');
		expect(previousPeriodDates(q('2026', 3), '2026-09-30')?.to).toBe('2026-06-30');
		// A leap year running on 31 Dec (offset 365) against a 365-day year: clamped to its end.
		expect(previousPeriodDates(y('2028'), '2028-12-31')).toMatchObject({
			from: '2027-01-01',
			to: '2027-12-31',
			cut: false
		});
	});
});

describe('stepping and links (AC 5)', () => {
	it('next is null for the current period; previous is null at the 2000 floor', () => {
		expect(stepReportPeriod(q('2026', 4), 1, TODAY)).toBeNull();
		expect(stepReportPeriod(y('2026'), 1, TODAY)).toBeNull();
		expect(stepReportPeriod(m('2026-10'), 1, TODAY)).toBeNull();
		expect(stepReportPeriod(q('2000', 1), -1, TODAY)).toBeNull();
		expect(stepReportPeriod(y('2000'), -1, TODAY)).toBeNull();
		expect(stepReportPeriod(m('2000-01'), -1, TODAY)).toBeNull();
		expect(stepReportPeriod(q('2026', 1), -1, TODAY)).toEqual(q('2025', 4));
		expect(stepReportPeriod(q('2025', 4), 1, TODAY)).toEqual(q('2026', 1));
	});

	it('every step href re-parses to the stepped period (round trip)', () => {
		for (const kind of ['bulan', 'kuartal', 'tahun'] as const) {
			let p: ReportPeriod | null = parse('', kind);
			for (let i = 0; i < 30 && p; i++) {
				for (const defaultKind of ['bulan', 'kuartal'] as const) {
					const href = reportPeriodHref('/x', p, TODAY, defaultKind);
					const params = new URL(`http://h${href}`).searchParams;
					expect(parseReportPeriod(params, TODAY, defaultKind)).toEqual(p);
				}
				p = stepReportPeriod(p, -1, TODAY);
			}
		}
	});

	it('the default period is the plain path', () => {
		expect(reportPeriodHref('/alur-uang', m('2026-10'), TODAY, 'bulan')).toBe('/alur-uang');
		expect(reportPeriodHref('/alur-uang', q('2026', 4), TODAY, 'bulan')).toBe(
			'/alur-uang?k=2026-Q4'
		);
		expect(reportPeriodHref('/kekayaan/laporan', q('2026', 4), TODAY, 'kuartal')).toBe(
			'/kekayaan/laporan'
		);
		expect(reportPeriodHref('/kekayaan/laporan', m('2026-10'), TODAY, 'kuartal')).toBe(
			'/kekayaan/laporan?p=2026-10'
		);
		expect(reportPeriodHref('/alur-uang', y('2025'), TODAY, 'bulan')).toBe('/alur-uang?y=2025');
	});
});

describe('switching kinds (AC 6, ?m=)', () => {
	it('a month opens its quarter or year', () => {
		expect(switchReportKind(m('2026-05'), 'kuartal', TODAY)).toEqual(q('2026', 2));
		expect(switchReportKind(m('2026-05'), 'tahun', TODAY)).toEqual(y('2026'));
		expect(parse('p=2026-05&m=kuartal')).toEqual(q('2026', 2));
	});

	it('a quarter opens its last month so far or its year', () => {
		expect(switchReportKind(q('2026', 2), 'bulan', TODAY)).toEqual(m('2026-06'));
		expect(switchReportKind(q('2026', 4), 'bulan', TODAY)).toEqual(m('2026-10'));
		expect(switchReportKind(q('2026', 2), 'tahun', TODAY)).toEqual(y('2026'));
		expect(parse('k=2026-Q2&m=kuartal')).toEqual(q('2026', 2));
	});

	it('a year opens its last quarter or month so far (Q4 / December for a past year)', () => {
		expect(switchReportKind(y('2025'), 'kuartal', TODAY)).toEqual(q('2025', 4));
		expect(switchReportKind(y('2026'), 'kuartal', TODAY)).toEqual(q('2026', 4));
		expect(switchReportKind(y('2026'), 'kuartal', '2026-05-02')).toEqual(q('2026', 2));
		expect(switchReportKind(y('2025'), 'bulan', TODAY)).toEqual(m('2025-12'));
		expect(parse('y=2025&m=bulan')).toEqual(m('2025-12'));
		expect(parse('y=2025&m=junk')).toEqual(y('2025'));
	});
});

describe('labels (AC 36)', () => {
	it('stepper labels are the same text in both languages', () => {
		expect(periodStepLabel(m('2026-10'), 'id')).toBe("Okt '26");
		expect(periodStepLabel(m('2026-10'), 'en')).toBe("Oct '26");
		expect(periodStepLabel(q('2026', 3), 'id')).toBe("Q3 '26");
		expect(periodStepLabel(q('2026', 3), 'en')).toBe("Q3 '26");
		expect(periodStepLabel(y('2026'), 'en')).toBe('2026');
	});

	it('quarter titles read naturally', () => {
		expect(periodTitle(q('2026', 3), createTranslator('id'))).toBe('Kuartal 3 · Jul–Sep 2026');
		expect(periodTitle(q('2026', 2), createTranslator('en'))).toBe('Quarter 2 · Apr–Jun 2026');
		expect(periodTitle(y('2026'), createTranslator('en'))).toBe('Year 2026');
		expect(periodTitle(m('2026-10'), createTranslator('id'))).toBe('Oktober 2026');
		expect(periodName(q('2026', 2), 'id')).toBe('Q2 2026');
	});
});

describe('the 2000 floor (red team L1)', () => {
	it('a period at the floor has no previous period (1999 is outside every bounded query)', () => {
		expect(previousPeriodDates(y('2000'), TODAY)).toBeNull();
		expect(previousPeriodDates(q('2000', 1), TODAY)).toBeNull();
		expect(previousPeriodDates(m('2000-01'), TODAY)).toBeNull();
		expect(previousPeriodDates(q('2000', 2), TODAY)).toMatchObject({ from: '2000-01-01' });
		for (const query of ['y=0000', 'k=1999-Q4', 'k=2000-Q1&m=tahun', 'p=2000-01&m=kuartal'])
			expect(previousPeriodDates(parse(query), TODAY), query).toBeNull();
	});

	it('the stepper never offers a step below 2000 or above 2099', () => {
		expect(stepReportPeriod(y('2099'), 1, '2099-12-31')).toBeNull();
		expect(stepReportPeriod(q('2099', 4), 1, '2099-12-31')).toBeNull();
		expect(stepReportPeriod(m('2099-12'), 1, '2099-12-31')).toBeNull();
		expect(stepReportPeriod(m('2000-02'), -1, TODAY)).toEqual(m('2000-01'));
	});
});
