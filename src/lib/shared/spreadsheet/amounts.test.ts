import { describe, expect, it } from 'vitest';
import { amountOfCell, decimalToMinor } from './amounts';

const num = (text: string, foreign = false) => ({
	kind: 'number' as const,
	text,
	date: false,
	foreign
});
const txt = (text: string) => ({ kind: 'text' as const, text });

describe('decimalToMinor (exact, never a float)', () => {
	it.each([
		['28000', 2_800_000],
		['-28000', -2_800_000],
		['28000.5', 2_800_050],
		['28000.50', 2_800_050],
		['1.5E+5', 15_000_000],
		['1.5e5', 15_000_000],
		['2.5E-1', 25],
		['0', 0],
		['0.1', 10],
		['100000000000', 10_000_000_000_000]
	])('%s → %d', (text, minor) => expect(decimalToMinor(text)).toBe(minor));

	it('refuses more fractional digits than IDR has, floats artefacts, junk and out-of-range values', () => {
		for (const t of [
			'28000.005',
			'0.30000000000000004',
			'1e-3',
			'NaN',
			'Infinity',
			'',
			'1,5',
			'100000000001'
		])
			expect(decimalToMinor(t)).toBeNull();
	});
});

describe('amountOfCell', () => {
	it('numeric cells and numeric text through the shared money parser (checklist money vectors)', () => {
		expect(amountOfCell(num('28000'))).toEqual({ minor: 2_800_000 });
		expect(amountOfCell(txt('Rp 1.250.000'))).toEqual({ minor: 125_000_000 });
		expect(amountOfCell(txt('1.250.000,50'))).toEqual({ minor: 125_000_050 });
		expect(amountOfCell(txt('Rp 28.000,00'))).toEqual({ minor: 2_800_000 });
		expect(amountOfCell(txt('IDR 1,250,000.00'))).toEqual({ minor: 125_000_000 });
		expect(amountOfCell(txt('28.000'))).toEqual({ minor: 2_800_000 });
		expect(amountOfCell(txt('-25.000'))).toEqual({ minor: -2_500_000 });
		expect(amountOfCell(txt('(25.000)'))).toEqual({ minor: -2_500_000 });
		expect(amountOfCell(txt('50.000 DB'))).toEqual({ minor: -5_000_000 });
		expect(amountOfCell(txt('50.000 CR'))).toEqual({ minor: 5_000_000 });
	});

	it('shorthand is not a number here: "25rb", "25k", "1,5 jt", "2 ceban", "goceng", "gopek", "cepek", "goban"', () => {
		for (const t of ['25rb', '25k', '1,5 jt', '2 ceban', 'goceng', 'gopek', 'cepek', 'goban'])
			expect(amountOfCell(txt(t))).toBe('not_number');
	});

	it('foreign marks and formats are foreign; blanks are missing', () => {
		expect(amountOfCell(txt('USD 10'))).toBe('foreign');
		// FN-47: the three new wallet currencies are foreign marks too (IDR only, owner decision 6).
		for (const code of ['TWD 10', 'hkd 10', 'CNY 10'])
			expect(amountOfCell(txt(code))).toBe('foreign');
		expect(amountOfCell(txt('$10.00'))).toBe('foreign');
		expect(amountOfCell(num('10', true))).toBe('foreign');
		expect(amountOfCell(null)).toBe('missing');
		expect(amountOfCell(txt(' - '))).toBe('missing');
		expect(amountOfCell({ kind: 'bool', value: true })).toBe('not_number');
		expect(amountOfCell({ kind: 'error' })).toBe('not_number');
	});
});
