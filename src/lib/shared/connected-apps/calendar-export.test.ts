import { describe, expect, it } from 'vitest';
import { buildCalendarEvents } from './calendar-export.ts';

const at = (iso: string) => Date.parse(iso);

describe('buildCalendarEvents', () => {
	it('maps an FN-26 bill reminder (WIB next_charge_on) to an all-day event', () => {
		expect(
			buildCalendarEvents([{ title: 'Tagihan Netflix', date: '2026-10-15', note: 'Rp 186.000' }])
		).toEqual([
			{
				summary: 'Tagihan Netflix',
				start: { date: '2026-10-15' },
				end: { date: '2026-10-16' },
				description: 'Rp 186.000'
			}
		]);
	});

	it('23:30 WIB on a month’s last day stays on that WIB date, its end crosses into the next month', () => {
		// 2026-10-31 23:30 WIB = 2026-10-31 16:30 UTC.
		expect(
			buildCalendarEvents([{ title: 'Bayar listrik', at: at('2026-10-31T16:30:00Z') }])
		).toEqual([
			{ summary: 'Bayar listrik', start: { date: '2026-10-31' }, end: { date: '2026-11-01' } }
		]);
		// 2026-12-31 23:30 WIB: across the year boundary.
		expect(
			buildCalendarEvents([{ title: 'Akhir tahun', at: at('2026-12-31T16:30:00Z') }])[0]
		).toMatchObject({ start: { date: '2026-12-31' }, end: { date: '2027-01-01' } });
	});

	it('00:30 WIB on the first is that WIB date, never the UTC date one bucket earlier', () => {
		// 2026-11-01 00:30 WIB = 2026-10-31 17:30 UTC.
		expect(
			buildCalendarEvents([{ title: 'Gaji', at: at('2026-10-31T17:30:00Z') }])[0]!.start.date
		).toBe('2026-11-01');
	});

	it('handles the leap day and refuses impossible or timestamp-shaped dates (never slices a UTC date)', () => {
		expect(buildCalendarEvents([{ title: 'Kabisat', date: '2028-02-29' }])[0]).toMatchObject({
			end: { date: '2028-03-01' }
		});
		expect(
			buildCalendarEvents([
				{ title: 'x', date: '2026-02-30' },
				{ title: 'x', date: '2026-10-31T23:30:00+07:00' },
				{ title: 'x', date: '' },
				{ title: 'x', at: Number.NaN },
				{ title: 'x', at: 1.5 }
			])
		).toEqual([]);
	});

	it('cleans untrusted titles and notes, and drops a reminder with no title left', () => {
		const [event] = buildCalendarEvents([
			{ title: '  Tagihan\u200b\u202e  PLN\n', date: '2026-10-01', note: '\u0000\u2028' }
		]);
		expect(event).toEqual({
			summary: 'Tagihan PLN',
			start: { date: '2026-10-01' },
			end: { date: '2026-10-02' }
		});
		expect(buildCalendarEvents([{ title: '\u200b ', date: '2026-10-01' }])).toEqual([]);
		expect(
			buildCalendarEvents([{ title: 'k'.repeat(10_000), date: '2026-10-01' }])[0]!.summary.length
		).toBeLessThanOrEqual(80);
	});

	it('is pure: same input, same output, input untouched', () => {
		const input = [{ title: 'Kopi', date: '2026-10-01' }];
		const copy = structuredClone(input);
		expect(buildCalendarEvents(input)).toEqual(buildCalendarEvents(input));
		expect(input).toEqual(copy);
	});
});
