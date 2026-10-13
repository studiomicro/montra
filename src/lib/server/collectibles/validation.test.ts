import { describe, expect, it } from 'vitest';
import { NOTE_INVALID, PRICE_INVALID, PURCHASED_ON_INVALID } from '../belongings/messages';
import { NAME_INVALID, VALUE_INVALID } from './messages';
import { parseCollectibleForm } from './validation';

const TODAY = '2026-10-08';
const form = (fields: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
};
const base = {
	name: 'Kartu langka',
	purchasePrice: '1.500.000',
	purchasedOn: '2024-10-08',
	currentValue: '2.100.000'
};

describe('parseCollectibleForm', () => {
	it('reads whole IDR amounts into minor units and cleans the text', () => {
		expect(parseCollectibleForm(form({ ...base, note: '  Kondisi​ mulus ' }), TODAY)).toEqual({
			ok: true,
			value: {
				name: 'Kartu langka',
				purchasePriceMinor: 150_000_000,
				purchasedOn: '2024-10-08',
				manualValueMinor: 210_000_000,
				note: 'Kondisi mulus'
			}
		});
		const zero = parseCollectibleForm(
			form({ ...base, purchasePrice: '0', currentValue: '0' }),
			TODAY
		);
		expect(zero.ok && [zero.value.purchasePriceMinor, zero.value.manualValueMinor]).toEqual([0, 0]);
	});

	it.each([
		[{ purchasePrice: '' }, 'purchasePriceMinor', PRICE_INVALID],
		[{ purchasePrice: '12,50' }, 'purchasePriceMinor', PRICE_INVALID],
		[{ purchasePrice: '-5' }, 'purchasePriceMinor', PRICE_INVALID],
		[{ purchasePrice: '12345678901234' }, 'purchasePriceMinor', PRICE_INVALID],
		[{ currentValue: '' }, 'manualValueMinor', VALUE_INVALID],
		[{ currentValue: '   ' }, 'manualValueMinor', VALUE_INVALID],
		[{ currentValue: '1.5' }, 'manualValueMinor', VALUE_INVALID],
		[{ currentValue: '1e9' }, 'manualValueMinor', VALUE_INVALID],
		[{ currentValue: '-100' }, 'manualValueMinor', VALUE_INVALID],
		[{ currentValue: '10.000.000.000.000' }, 'manualValueMinor', VALUE_INVALID],
		[{ purchasedOn: '2026-10-09' }, 'purchasedOn', PURCHASED_ON_INVALID],
		[{ purchasedOn: '2026-02-30' }, 'purchasedOn', PURCHASED_ON_INVALID],
		[{ purchasedOn: '1949-12-31' }, 'purchasedOn', PURCHASED_ON_INVALID],
		[{ name: '​\u0007 ' }, 'name', NAME_INVALID],
		[{ name: 'x'.repeat(81) }, 'name', NAME_INVALID],
		[{ note: 'x'.repeat(301) }, 'note', NOTE_INVALID]
	])('refuses %j (%s), never reinterprets', (fields, field, message) => {
		const r = parseCollectibleForm(form({ ...base, ...fields }), TODAY);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[field as keyof typeof r.errors]).toBe(message);
			// The refused form echoes what was typed.
			expect(r.values.name).toBe({ ...base, ...fields }.name);
		}
	});

	it('accepts the 13-digit maximum (10^13 − 1 rupiah) and today', () => {
		const max = parseCollectibleForm(
			form({ ...base, currentValue: '9.999.999.999.999', purchasedOn: TODAY }),
			TODAY
		);
		expect(max.ok && max.value.manualValueMinor).toBe(999_999_999_999_900);
	});
});
