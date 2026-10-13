import { describe, expect, it } from 'vitest';
import { DICTIONARY_SIZE, tileFromWords, tileKind } from './dictionary';

const words = (s: string) => s.split(' ');

describe('dictionary and keyword groups (FN-20 AC-2)', () => {
	it('about 150 curated patterns (owner decision 2)', () => {
		expect(DICTIONARY_SIZE).toBeGreaterThanOrEqual(120);
		expect(DICTIONARY_SIZE).toBeLessThanOrEqual(200);
	});

	it('coffee, ride-hailing and salary words, with the layer that matched', () => {
		expect(tileFromWords(words('kopitiam senja'), 'expense')).toEqual({
			tile: 'kopi',
			layer: 'dictionary'
		});
		expect(tileFromWords(words('kopi kenangan'), 'expense')).toEqual({
			tile: 'kopi',
			layer: 'keyword'
		});
		expect(tileFromWords(words('ojek pangkalan'), 'expense')?.tile).toBe('ojek-online');
		expect(tileFromWords(words('gojek'), 'expense')).toEqual({
			tile: 'ojek-online',
			layer: 'keyword'
		});
		expect(tileFromWords(words('gaji okt'), 'income')).toEqual({
			tile: 'gaji',
			layer: 'dictionary'
		});
		expect(tileFromWords(words('payroll pt contoh'), 'income')?.tile).toBe('gaji');
	});

	it('kind check: income words never answer an expense row and vice versa', () => {
		expect(tileFromWords(words('gaji okt'), 'expense')).toBeUndefined();
		expect(tileFromWords(words('indomaret'), 'income')).toBeUndefined();
		expect(tileFromWords(words('kopi'), 'income')).toBeUndefined();
	});

	it('whole tokens only: grabber is not grab, kopitiamku is not kopitiam', () => {
		expect(tileFromWords(words('grabber shop'), 'expense')).toBeUndefined();
		expect(tileFromWords(words('kopitiamku'), 'expense')).toBeUndefined();
		expect(tileFromWords(words('toltec'), 'expense')).toBeUndefined();
	});

	it('phrases match as consecutive tokens only', () => {
		expect(tileFromWords(words('rumah makan padang'), 'expense')?.tile).toBe('makan');
		expect(tileFromWords(words('rumah sakit'), 'expense')?.tile).toBe('kesehatan');
		expect(tileFromWords(words('circle k'), 'expense')?.tile).toBe('belanja-harian');
		expect(tileFromWords(words('k circle'), 'expense')).toBeUndefined();
	});

	it('food delivery beats ride-hailing (FN-39 order kept)', () => {
		expect(tileFromWords(words('gojek gofood'), 'expense')?.tile).toBe('pesan-antar-makanan');
	});

	it('tile kinds follow the presets', () => {
		expect(tileKind('gaji')).toBe('income');
		expect(tileKind('kopi')).toBe('expense');
	});
});
