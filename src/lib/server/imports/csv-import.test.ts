import { describe, expect, it } from 'vitest';
import type { TileKey } from '#lib/shared/transactions';
import { categoryNameOf } from './csv-import';

/** A space whose visible presets are the given tiles, under the given (possibly renamed) names. */
const presets =
	(names: Partial<Record<TileKey, string>>) =>
	(tileKey: TileKey): { name: string } | undefined =>
		names[tileKey] === undefined ? undefined : { name: names[tileKey] };
const both = presets({
	'ojek-online': 'Ojek Online',
	'pesan-antar-makanan': 'Pesan Antar Makanan'
});
const row = (title: string, categoryName = '', type: 'expense' | 'income' = 'expense') => ({
	title,
	categoryName,
	type
});

describe('categoryNameOf (FN-39 order: category cell → service word in the title → fallback)', () => {
	it('an explicit category cell always wins', () => {
		expect(categoryNameOf(row('GRABFOOD JKT', 'Kantor'), both)).toBe('Kantor');
		expect(categoryNameOf(row('GOJEK', '  Ojol  '), both)).toBe('Ojol');
	});
	it('a blank cell on an expense guesses from the title, then falls back to "Lainnya"', () => {
		expect(categoryNameOf(row('GRABFOOD JKT'), both)).toBe('Pesan Antar Makanan');
		expect(categoryNameOf(row('GOJEK*JAKARTA'), both)).toBe('Ojek Online');
		expect(categoryNameOf(row('KOPI CONTOH'), both)).toBe('Lainnya');
		expect(categoryNameOf(row('TOKO BUKU'), both)).toBe('Lainnya');
	});
	it('uses the preset’s current name; a hidden or retiled preset falls back instead', () => {
		expect(categoryNameOf(row('GOJEK'), presets({ 'ojek-online': 'Ojol kantor' }))).toBe(
			'Ojol kantor'
		);
		expect(categoryNameOf(row('GOJEK'), presets({}))).toBe('Lainnya');
	});
	it('an income row never gets an expense guess', () => {
		expect(categoryNameOf(row('REFUND GOJEK', '', 'income'), both)).toBe('Pemasukan Lain');
		expect(categoryNameOf(row('REFUND GOJEK', 'Refund', 'income'), both)).toBe('Refund');
	});
});
