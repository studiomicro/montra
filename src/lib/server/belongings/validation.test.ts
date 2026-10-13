import { describe, expect, it } from 'vitest';
import {
	NAME_INVALID,
	NOTE_INVALID,
	PRICE_INVALID,
	PURCHASED_ON_INVALID,
	VALUE_INVALID
} from './messages';
import { parseBelongingForm } from './validation';

const TODAY = '2026-10-08';
const form = (fields: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
};
const base = { name: 'Laptop', purchasePrice: '15.000.000', purchasedOn: '2024-10-08' };

describe('parseBelongingForm', () => {
	it('reads whole IDR amounts into minor units; a blank current value means "use the estimate"', () => {
		expect(parseBelongingForm(form({ ...base, note: '  Garansi​ 2 tahun ' }), TODAY)).toEqual({
			ok: true,
			value: {
				name: 'Laptop',
				purchasePriceMinor: 1_500_000_000,
				purchasedOn: '2024-10-08',
				currentValueMinor: null,
				note: 'Garansi 2 tahun'
			}
		});
		const own = parseBelongingForm(form({ ...base, currentValue: '0' }), TODAY);
		expect(own.ok && own.value.currentValueMinor).toBe(0);
		const gift = parseBelongingForm(form({ ...base, purchasePrice: '0' }), TODAY);
		expect(gift.ok && gift.value.purchasePriceMinor).toBe(0);
	});

	it.each([
		[{ purchasePrice: '' }, 'purchasePriceMinor', PRICE_INVALID],
		[{ purchasePrice: '12,50' }, 'purchasePriceMinor', PRICE_INVALID],
		[{ purchasePrice: '-5' }, 'purchasePriceMinor', PRICE_INVALID],
		[{ purchasePrice: '1e9' }, 'purchasePriceMinor', PRICE_INVALID],
		[{ purchasePrice: '12345678901234' }, 'purchasePriceMinor', PRICE_INVALID],
		[{ currentValue: '1.5' }, 'currentValueMinor', VALUE_INVALID],
		[{ purchasedOn: '2026-10-09' }, 'purchasedOn', PURCHASED_ON_INVALID],
		[{ purchasedOn: '2026-02-30' }, 'purchasedOn', PURCHASED_ON_INVALID],
		[{ purchasedOn: '1949-12-31' }, 'purchasedOn', PURCHASED_ON_INVALID],
		[{ purchasedOn: '08/10/2024' }, 'purchasedOn', PURCHASED_ON_INVALID],
		[{ name: '​\u0007 ' }, 'name', NAME_INVALID],
		[{ name: 'x'.repeat(81) }, 'name', NAME_INVALID],
		[{ note: 'x'.repeat(301) }, 'note', NOTE_INVALID]
	])('refuses %j (%s), never reinterprets', (fields, field, message) => {
		const r = parseBelongingForm(form({ ...base, ...fields }), TODAY);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[field as keyof typeof r.errors]).toBe(message);
	});

	it('accepts today and 1950-01-01, and the 13-digit maximum', () => {
		expect(parseBelongingForm(form({ ...base, purchasedOn: TODAY }), TODAY).ok).toBe(true);
		expect(parseBelongingForm(form({ ...base, purchasedOn: '1950-01-01' }), TODAY).ok).toBe(true);
		const max = parseBelongingForm(form({ ...base, purchasePrice: '9.999.999.999.999' }), TODAY);
		expect(max.ok && max.value.purchasePriceMinor).toBe(999_999_999_999_900);
	});
});
