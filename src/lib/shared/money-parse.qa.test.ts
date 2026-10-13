import { describe, expect, it } from 'vitest';
import { findMoneyMentions, parseMoneyAmount } from './money-parse';
import { addDays, parseRelativeIndonesianDate, wibDateString } from './dates';

/**
 * QA vectors for FN-14a (independent of the engineer's own `money-parse.test.ts`/`dates.test.ts`).
 * Realistic Indonesian bank/e-wallet statement and e-mail amount formats, Chrome `id-ID` speech-recogniser
 * voice-transcript number-word styles, WIB month-boundary vectors and safe-integer limits.
 *
 * A `null`/no-mention result here is only a PASS when it matches a PRD rule (Owner decision A/B/C) that the
 * QA report names explicitly; any `null` that is a plausible, common spoken amount is additionally flagged as
 * a product risk for FN-14 (voice capture), not a parser bug — the module is doing exactly what its PRD says.
 */

type Vector = [string, ReturnType<typeof parseMoneyAmount>];

describe('QA — bank/e-wallet statement and e-mail amount formats', () => {
	it.each<Vector>([
		// BCA e-statement / e-mail style: amount glued to Rp, comma-decimal, dot-grouped.
		['Rp25.000,00', { minor: 2_500_000 }],
		// Mandiri mutasi style: IDR prefix, grouping only, no decimal.
		['IDR 25.000', { minor: 2_500_000 }],
		// BRI/teller-receipt style: trailing ",-" marks "no sen".
		['Rp 1.000.000,-', { minor: 100_000_000 }],
		// BNI mutasi rekening: bare grouped amount + DB/CR suffix, no currency symbol at all.
		['25.000 CR', { minor: 2_500_000, direction: 'credit' }],
		['25.000 DB', { minor: 2_500_000, direction: 'debit' }],
		// GoPay/OVO/DANA/ShopeePay push-notification style: signed, glued, no space.
		['-Rp25.000', { minor: -2_500_000 }],
		['+Rp25.000', { minor: 2_500_000 }],
		['Rp25.000', { minor: 2_500_000 }],
		// "Rp. " with a literal dot after the symbol, as several bank apps render it.
		['Rp. 25.000', { minor: 2_500_000 }],
		// Compact design-system display format (`docs/design/DESIGN_SYSTEM.md`): "Rp5,24 jt" round-trips.
		['Rp5,24 jt', { minor: 524_000_000 }],
		// A bare mutasi-column cell with sen and no currency marker at all.
		['25.000,00', { minor: 2_500_000 }]
	])('%j', (input, expected) => {
		expect(parseMoneyAmount(input)).toStrictEqual(expected);
	});

	it('reads a bank mutasi line with description, amount and DB/CR as one mention', () => {
		expect(findMoneyMentions('TRSFR E-BANKING 25.000 DB 08/10')).toStrictEqual([
			{ minor: 2_500_000, direction: 'debit', start: 16, end: 25, raw: '25.000 DB' }
		]);
	});

	it('reads a mutasi amount when the DB/CR marker sits before it (cycle 2: marker accepted on either side)', () => {
		expect(findMoneyMentions('TRSFR E-BANKING DB 25.000 08/10')).toStrictEqual([
			{ minor: 2_500_000, direction: 'debit', start: 16, end: 25, raw: 'DB 25.000' }
		]);
	});
});

describe('QA — Chrome id-ID speech-recognition transcript number-word styles', () => {
	it.each<Vector>([
		// Already-digit transcripts (Chrome frequently normalises spoken numbers to digits itself).
		['25 ribu', { minor: 2_500_000 }],
		['1,5 juta', { minor: 150_000_000 }],
		// The one bounded compound the PRD names (Owner decision B).
		['seratus ribu', { minor: 10_000_000 }],
		// Single small-number-word + unit, in scope per Owner decision B.
		['tiga ribu', { minor: 300_000 }],
		['sepuluh ribu', { minor: 1_000_000 }],
		['dua juta', { minor: 200_000_000 }]
	])('%j → in-scope word form parses', (input, expected) => {
		expect(parseMoneyAmount(input)).toStrictEqual(expected);
	});

	it.each<Vector>([
		// Common two/three-word Indonesian compounds. Owner decision B changed 2026-10-08 (auto-accepted):
		// spoken number words are supported by a bounded grammar, so these now parse (were null in cycle 1).
		['dua puluh lima ribu', { minor: 2_500_000 }], // 25.000
		['lima belas ribu', { minor: 1_500_000 }], // 15.000
		['dua ratus ribu', { minor: 20_000_000 }], // 200.000
		['tiga ratus lima puluh ribu', { minor: 35_000_000 }], // 350.000
		['seribu', { minor: 100_000 }],
		['sejuta', { minor: 100_000_000 }]
	])('%j → parses under the changed Owner decision B', (input, expected) => {
		expect(parseMoneyAmount(input)).toStrictEqual(expected);
	});
});

describe('QA — safe-integer limits', () => {
	it('accepts the largest amount at exactly MAX_SAFE_INTEGER and rejects one sen beyond it', () => {
		expect(parseMoneyAmount('Rp 90.071.992.547.409,91')).toStrictEqual({
			minor: Number.MAX_SAFE_INTEGER
		});
		expect(parseMoneyAmount('Rp 90.071.992.547.409,92')).toBeNull();
	});

	it('accepts a realistic large net-worth statement figure well under the safe-integer bound', () => {
		// Rp 999.999.999.999 (under a trillion rupiah) — plausible top end for net-worth/property entries.
		const parsed = parseMoneyAmount('Rp 999.999.999.999');
		expect(parsed).toStrictEqual({ minor: 99_999_999_999_900 });
		expect(Number.isSafeInteger(parsed?.minor)).toBe(true);
	});

	it('never returns a float or NaN for any parseable sen-bearing input', () => {
		for (const input of ['Rp 1,99', '0,01', '1.250.000,99', '999.999.999,99']) {
			const parsed = parseMoneyAmount(input);
			expect(parsed, input).not.toBeNull();
			expect(Number.isInteger(parsed?.minor), input).toBe(true);
			expect(Number.isNaN(parsed?.minor), input).toBe(false);
		}
	});
});

describe('QA — WIB boundaries (23:30 WIB on the last day of a month)', () => {
	it('23:30 WIB on 31 Oct is still October in both the raw epoch bucket and a "kemarin" voice capture', () => {
		// 2026-10-31 23:30 WIB = 2026-10-31 16:30 UTC.
		const epochMs = Date.UTC(2026, 9, 31, 16, 30);
		const occurredOn = wibDateString(epochMs);
		expect(occurredOn).toBe('2026-10-31');
		// A voice capture made at that instant saying "kemarin" must resolve to 30 Oct, not fall back to the
		// UTC date (30 Oct UTC would be wrong here anyway; the real risk is an off-by-one at 00:00 WIB, not
		// this instant, but both are asserted against the same `occurredOn` the capture would actually store).
		expect(parseRelativeIndonesianDate('kemarin', occurredOn)).toBe('2026-10-30');
	});

	it('23:30 WIB on the last day of a 31-day month rolls into next month only one minute later, in WIB not UTC', () => {
		const stillOct = Date.UTC(2026, 9, 31, 16, 59); // 23:59 WIB, still 31 Oct
		const nowNov = Date.UTC(2026, 9, 31, 17, 0); // 00:00 WIB, 1 Nov
		expect(wibDateString(stillOct)).toBe('2026-10-31');
		expect(wibDateString(nowNov)).toBe('2026-11-01');
	});

	it('a budget/report month bucket for the last day of February in a leap year matches addDays', () => {
		expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
		expect(wibDateString(Date.UTC(2024, 1, 29, 16, 30))).toBe('2024-02-29'); // 23:30 WIB
	});
});
