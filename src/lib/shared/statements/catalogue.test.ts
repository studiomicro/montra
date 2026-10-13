import { describe, expect, it } from 'vitest';
import { statementCatalogue } from './catalogue';
import { STATEMENT_PARSERS } from './parsers';

describe('statementCatalogue (FN-16i)', () => {
	it('makes exactly the parsers selectable, first, and every other FN-04 institution disabled', () => {
		const rows = statementCatalogue(STATEMENT_PARSERS);
		const selectable = rows.filter((r) => r.supported).map((r) => r.id);
		expect(new Set(selectable)).toEqual(new Set(STATEMENT_PARSERS.map((p) => p.id)));
		expect(selectable).toEqual(['bca', 'mandiri', 'bni', 'ocbc']);
		expect(rows.slice(0, selectable.length).every((r) => r.supported)).toBe(true);
		expect(rows.filter((r) => !r.supported).map((r) => r.label)).toEqual([
			'BRI',
			'Bank Jago',
			'BSI',
			'CIMB Niaga',
			'Permata',
			'Jenius',
			'SeaBank',
			'GoPay',
			'OVO',
			'DANA',
			'ShopeePay',
			'Lainnya'
		]);
	});

	it('names the real alternative per kind: BRImo screenshot, app screenshot, or CSV/Spreadsheet', () => {
		const alt = Object.fromEntries(
			statementCatalogue(STATEMENT_PARSERS)
				.filter((r) => !r.supported)
				.map((r) => [r.id, r.supported ? null : r.alternative])
		);
		expect(alt.bri).toBe('brimo_screenshot');
		for (const id of ['gopay', 'ovo', 'dana', 'shopeepay']) expect(alt[id]).toBe('app_screenshot');
		for (const id of ['jago', 'bsi', 'cimb', 'permata', 'jenius', 'seabank', 'other'])
			expect(alt[id]).toBe('csv_or_sheet');
	});

	it('carries the FN-43 brand id for registry institutions and none for Lainnya', () => {
		const brands = Object.fromEntries(
			statementCatalogue(STATEMENT_PARSERS).map((r) => [r.id, r.brand])
		);
		expect(brands.bca).toBe('bca');
		expect(brands.jago).toBe('jago');
		expect(brands.shopeepay).toBe('shopeepay');
		expect(brands.other).toBeNull();
	});

	it('follows the parser list: a new parser becomes selectable, an unknown one is listed too', () => {
		const rows = statementCatalogue([
			{ id: 'bca', label: 'BCA' },
			{ id: 'bri', label: 'BRI' },
			{ id: 'banknew', label: 'Bank Baru' }
		]);
		expect(rows.filter((r) => r.supported).map((r) => r.id)).toEqual(['bca', 'bri', 'banknew']);
		expect(rows.find((r) => r.id === 'mandiri')?.supported).toBe(false);
		expect(rows.filter((r) => r.id === 'bri')).toHaveLength(1);
	});
});
