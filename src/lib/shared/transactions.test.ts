import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '#lib/ui/kit/category';
import { createTranslator } from './i18n';
import { categoryLabel, isFallbackCategory, PRESET_CATEGORIES, TILE_KEYS } from './transactions';

describe('category tile slots and presets (FN-06)', () => {
	it('uses exactly the kit’s 23 category keys as tile slots, no 24th', () => {
		expect([...TILE_KEYS].sort()).toEqual(Object.keys(CATEGORIES).sort());
	});

	// The current constraint is the one migration 0037 (FN-48) rebuilt `categories` with; 0004's (15 slots) and
	// 0027's (17 slots) texts stay as the historical versions and are never edited.
	const tileCheck = (file: string) =>
		(readFileSync(file, 'utf8').match(/"tile_key" in \(([^)]*)\)/)?.[1] ?? '')
			.split(',')
			.map((s) => s.trim().replace(/'/g, ''));

	it('repeats the same 23 slots in the tile_key CHECK of migration 0037 (the current one)', () => {
		expect(tileCheck('migrations/0037_fn48_categories.sql')).toEqual([...TILE_KEYS]);
	});

	it('0027 only adds the two FN-39 slots to 0004’s original 15, 0037 the six FN-48 ones', () => {
		const original = tileCheck('migrations/0004_transactions_categories.sql');
		expect(original).toHaveLength(15);
		const fn39 = tileCheck('migrations/0027_ride_food_categories.sql');
		expect(fn39.filter((k) => !original.includes(k))).toEqual([
			'ojek-online',
			'pesan-antar-makanan'
		]);
		expect(TILE_KEYS.filter((k) => !fn39.includes(k))).toEqual([
			'biaya-bank',
			'pajak',
			'tarik-tunai',
			'kartu-kredit',
			'transfer',
			'bunga'
		]);
	});

	it('seeds 17 expense and 7 income presets, one per slot (Transfer twice), with the mirror names', () => {
		expect(PRESET_CATEGORIES).toHaveLength(24);
		expect(PRESET_CATEGORIES.filter((p) => p.kind === 'expense')).toHaveLength(17);
		expect(PRESET_CATEGORIES.filter((p) => p.kind === 'income')).toHaveLength(7);
		expect(new Set(PRESET_CATEGORIES.map((p) => p.tileKey)).size).toBe(23);
		expect(new Set(PRESET_CATEGORIES.map((p) => `${p.tileKey}:${p.kind}`)).size).toBe(24);
		expect(PRESET_CATEGORIES.filter((p) => p.tileKey === 'transfer').map((p) => p.kind)).toEqual([
			'expense',
			'income'
		]);
		expect(PRESET_CATEGORIES.map((p) => p.name)).toEqual([
			'Kopi',
			'Makan & Minum',
			'Belanja Harian',
			'Belanja',
			'Transportasi',
			'Ojek Online',
			'Pesan Antar Makanan',
			'Tagihan',
			'Kesehatan',
			'Hiburan',
			'Pendidikan',
			'Tempat Tinggal',
			'Biaya Bank',
			'Pajak',
			'Tarik Tunai',
			'Kartu Kredit',
			'Transfer keluar',
			'Gaji',
			'Bonus',
			'Freelance',
			'Hadiah',
			'Bunga',
			'Transfer masuk',
			'Pemasukan Lain'
		]);
		expect(PRESET_CATEGORIES.find((p) => p.tileKey === 'lain')).toMatchObject({
			kind: 'income',
			name: 'Pemasukan Lain'
		});
	});

	it('translates a preset’s seeded name but never what a user typed', () => {
		const { tr } = createTranslator('en');
		expect(categoryLabel({ name: 'Pemasukan Lain', isPreset: true }, tr)).toBe('Other income');
		expect(categoryLabel({ name: 'Ojek Online', isPreset: true }, tr)).toBe('Ride-hailing');
		expect(categoryLabel({ name: 'Pesan Antar Makanan', isPreset: true }, tr)).toBe(
			'Food delivery'
		);
		expect(categoryLabel({ name: 'Biaya Bank', isPreset: true }, tr)).toBe('Bank fees');
		expect(categoryLabel({ name: 'Transfer keluar', isPreset: true }, tr)).toBe('Transfer out');
		expect(categoryLabel({ name: 'Transfer masuk', isPreset: true }, tr)).toBe('Transfer in');
		expect(categoryLabel({ name: 'Ngopi pagi', isPreset: true }, tr)).toBe('Ngopi pagi');
		// A custom category that happens to be named like a phrase in the table is shown as typed.
		expect(categoryLabel({ name: 'Gaji', isPreset: false }, tr)).toBe('Gaji');
		expect(categoryLabel({ name: 'Keluar', isPreset: false }, tr)).toBe('Keluar');
	});
});

describe('isFallbackCategory (FN-48)', () => {
	it('the `lain` preset (any name) and the import-made "Lainnya" are fallbacks; nothing else is', () => {
		expect(isFallbackCategory({ tileKey: 'lain', isPreset: true, name: 'Pemasukan Lain' })).toBe(
			true
		);
		expect(isFallbackCategory({ tileKey: 'lain', isPreset: true, name: 'Lain-lain' })).toBe(true);
		expect(isFallbackCategory({ tileKey: 'lain', isPreset: false, name: ' lainnya ' })).toBe(true);
		expect(isFallbackCategory({ tileKey: 'lain', isPreset: false, name: 'Arisan' })).toBe(false);
		expect(isFallbackCategory({ tileKey: 'kopi', isPreset: false, name: 'Lainnya' })).toBe(false);
		expect(
			isFallbackCategory({ tileKey: 'transfer', isPreset: true, name: 'Transfer keluar' })
		).toBe(false);
	});
});
