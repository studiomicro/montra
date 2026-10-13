import { describe, expect, it } from 'vitest';
import {
	NW_CURRENCY_INVALID,
	NW_KIND_INVALID,
	NW_NAME_INVALID,
	NW_QUANTITY_INVALID,
	NW_QUANTITY_PRECISION,
	NW_QUANTITY_REQUIRED,
	NW_SOURCE_INVALID,
	NW_SYMBOL_INVALID,
	NW_SYMBOL_UNKNOWN,
	NW_VALUE_INVALID,
	NW_VALUE_INVALID_CENTS,
	NW_VALUE_REQUIRED,
	NW_VALUE_TOO_LARGE
} from './messages';
import { parseNetWorthForm, parseQuantity } from './validation';

describe('parseQuantity (crypto scale 8, gold scale 3)', () => {
	it('parses whole numbers and decimals to the exact scaled integer', () => {
		expect(parseQuantity('1', 8)).toEqual({ ok: true, scaled: '100000000' });
		expect(parseQuantity('0,015', 8)).toEqual({ ok: true, scaled: '1500000' });
		expect(parseQuantity('0.015', 8)).toEqual({ ok: true, scaled: '1500000' });
		expect(parseQuantity('0,12345678', 8)).toEqual({ ok: true, scaled: '12345678' });
		expect(parseQuantity('0,00000001', 8)).toEqual({ ok: true, scaled: '1' });
		expect(parseQuantity(' 2,5 ', 3)).toEqual({ ok: true, scaled: '2500' });
		expect(parseQuantity('2,500', 3)).toEqual({ ok: true, scaled: '2500' });
		expect(parseQuantity('007', 3)).toEqual({ ok: true, scaled: '7000' });
		expect(parseQuantity('1000000000', 8)).toEqual({ ok: true, scaled: '100000000000000000' });
	});

	it('refuses more decimals than the scale instead of truncating', () => {
		expect(parseQuantity('0.123456789', 8)).toEqual({ ok: false, reason: 'precision' });
		expect(parseQuantity('2,5005', 3)).toEqual({ ok: false, reason: 'precision' });
	});

	it('refuses ambiguous thousands dots, zero, signs, exponents and junk', () => {
		for (const bad of [
			'1.000',
			'2.500',
			'12.345',
			'0',
			'0,000',
			'-1',
			'+1',
			'1e3',
			'1 000',
			'1,2,3',
			'abc',
			',5',
			'5,'
		])
			expect(parseQuantity(bad, 8), bad).toEqual({ ok: false, reason: 'invalid' });
		expect(parseQuantity('9999999999999999', 8)).toEqual({ ok: false, reason: 'invalid' });
	});

	it('reports a blank field as empty', () => {
		expect(parseQuantity('  ', 8)).toEqual({ ok: false, reason: 'empty' });
	});
});

const form = (fields: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
};

describe('parseNetWorthForm', () => {
	it('accepts a manual item in a wallet currency', () => {
		const r = parseNetWorthForm(
			form({ kind: 'property', name: 'Rumah', currency: 'IDR', manualValue: '1.250.000.000' }),
			'id'
		);
		expect(r).toEqual({
			ok: true,
			value: {
				kind: 'property',
				name: 'Rumah',
				currency: 'IDR',
				priceSource: 'manual',
				priceSymbol: null,
				quantityScaled: null,
				quantityScale: null,
				manualValueMinor: 125_000_000_000,
				acquiredOn: null,
				note: null
			}
		});
	});

	it('accepts an Indodax crypto item: IDR, lowercase coin code, quantity, optional fallback', () => {
		const r = parseNetWorthForm(
			form({
				kind: 'investment_crypto',
				name: 'Bitcoin',
				currency: 'USD',
				priceSource: 'indodax',
				symbol: ' BTC ',
				quantity: '0,015',
				manualValue: ''
			}),
			'id'
		);
		expect(r.ok && r.value).toMatchObject({
			currency: 'IDR',
			priceSource: 'indodax',
			priceSymbol: 'btc',
			quantityScaled: '1500000',
			quantityScale: 8,
			manualValueMinor: null
		});
	});

	it('accepts a gold item priced by gold-api with grams at scale 3', () => {
		const r = parseNetWorthForm(
			form({ kind: 'investment_gold', name: 'Antam', priceSource: 'gold_api', quantity: '2,5' }),
			'id'
		);
		expect(r.ok && r.value).toMatchObject({
			currency: 'IDR',
			priceSource: 'gold_api',
			priceSymbol: null,
			quantityScaled: '2500',
			quantityScale: 3
		});
	});

	it('keeps stocks manual-only and refuses a source the kind does not have', () => {
		const r = parseNetWorthForm(
			form({
				kind: 'investment_stock',
				name: 'BBCA',
				priceSource: 'indodax',
				manualValue: '1.000'
			}),
			'id'
		);
		expect(r).toMatchObject({ ok: false, errors: { priceSource: NW_SOURCE_INVALID } });
		const g = parseNetWorthForm(
			form({ kind: 'investment_gold', name: 'Emas', priceSource: 'indodax', quantity: '1' }),
			'id'
		);
		expect(g).toMatchObject({ ok: false, errors: { priceSource: NW_SOURCE_INVALID } });
	});

	it('refuses each invalid field with its message', () => {
		expect(parseNetWorthForm(form({ kind: 'saham' }), 'id')).toMatchObject({
			ok: false,
			errors: { kind: NW_KIND_INVALID }
		});
		expect(
			parseNetWorthForm(form({ kind: 'cash', name: '​', currency: 'XXX', manualValue: '0' }), 'id')
		).toMatchObject({
			ok: false,
			errors: {
				name: NW_NAME_INVALID,
				currency: NW_CURRENCY_INVALID,
				manualValue: NW_VALUE_REQUIRED
			}
		});
		expect(
			parseNetWorthForm(
				form({ kind: 'investment_crypto', name: 'X', priceSource: 'indodax', symbol: 'btc/idr' }),
				'id'
			)
		).toMatchObject({
			ok: false,
			errors: { symbol: NW_SYMBOL_INVALID, quantity: NW_QUANTITY_REQUIRED }
		});
		expect(
			parseNetWorthForm(
				form({
					kind: 'investment_crypto',
					name: 'X',
					priceSource: 'indodax',
					symbol: 'btc',
					quantity: '0.123456789'
				}),
				'id'
			)
		).toMatchObject({ ok: false, errors: { quantity: NW_QUANTITY_PRECISION } });
		expect(
			parseNetWorthForm(
				form({ kind: 'investment_gold', name: 'X', priceSource: 'gold_api', quantity: '1.000' }),
				'id'
			)
		).toMatchObject({ ok: false, errors: { quantity: NW_QUANTITY_INVALID } });
		expect(
			parseNetWorthForm(
				form({ kind: 'cash', name: 'X', currency: 'IDR', manualValue: '12,50' }),
				'id'
			)
		).toMatchObject({ ok: false, errors: { manualValue: NW_VALUE_INVALID } });
	});

	it('caps the value at 10^13 minor units (the DB CHECK)', () => {
		const ok = parseNetWorthForm(
			form({ kind: 'cash', name: 'X', currency: 'IDR', manualValue: '100.000.000.000' }),
			'id'
		);
		expect(ok.ok && ok.value.manualValueMinor).toBe(10_000_000_000_000);
		expect(
			parseNetWorthForm(
				form({ kind: 'cash', name: 'X', currency: 'IDR', manualValue: '100.000.000.001' }),
				'id'
			)
		).toMatchObject({ ok: false, errors: { manualValue: NW_VALUE_TOO_LARGE } });
	});

	it('ignores a quantity on kinds that carry none', () => {
		const r = parseNetWorthForm(
			form({
				kind: 'vehicle',
				name: 'Motor',
				currency: 'IDR',
				manualValue: '15.000.000',
				quantity: '3'
			}),
			'id'
		);
		expect(r.ok && r.value).toMatchObject({ quantityScaled: null, quantityScale: null });
	});

	it('refuses a coin code missing from the cached Indodax ticker; accepts any code while none is cached', () => {
		const crypto = (symbol: string) =>
			form({ kind: 'investment_crypto', name: 'X', priceSource: 'indodax', symbol, quantity: '1' });
		const known = new Set(['btc', 'eth']);
		expect(parseNetWorthForm(crypto('a0001'), 'id', known)).toMatchObject({
			ok: false,
			errors: { symbol: NW_SYMBOL_UNKNOWN }
		});
		expect(parseNetWorthForm(crypto('BTC'), 'id', known).ok).toBe(true);
		expect(parseNetWorthForm(crypto('a0001'), 'id', null).ok).toBe(true);
	});

	it('FN-47: a manual value with cents in a currency that has them; refused past 2 digits or for IDR', () => {
		const value = (manualValue: string, currency: string, locale: 'id' | 'en' = 'id') => {
			const r = parseNetWorthForm(form({ kind: 'cash', name: 'X', currency, manualValue }), locale);
			return r.ok ? r.value.manualValueMinor : r.errors.manualValue;
		};
		expect(value('1.234,56', 'TWD')).toBe(123_456);
		expect(value('1,234.56', 'CNY', 'en')).toBe(123_456);
		expect(value('0,5', 'HKD')).toBe(50);
		expect(value('1.234,567', 'TWD')).toBe(NW_VALUE_INVALID_CENTS);
		expect(value('12,50', 'IDR')).toBe(NW_VALUE_INVALID);
	});
});
