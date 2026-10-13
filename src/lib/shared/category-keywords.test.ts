import { describe, expect, it } from 'vitest';
import { categoryHintFromWords, importCategoryFromTitle } from './category-keywords';

describe('categoryHintFromWords (FN-39 shared keyword table)', () => {
	it.each(['gojek', 'goride', 'gocar', 'grab', 'grabbike', 'grabcar', 'maxim', 'ojol'])(
		'"%s" → Ojek Online',
		(w) => expect(categoryHintFromWords(['naik', w, 'ke', 'kantor'])).toBe('ojek-online')
	);
	it.each(['gofood', 'grabfood', 'shopeefood'])('"%s" → Pesan Antar Makanan', (w) =>
		expect(categoryHintFromWords(['laper', w])).toBe('pesan-antar-makanan')
	);
	it('food wins over ride wherever the words stand', () => {
		expect(categoryHintFromWords(['grab', 'terus', 'gofood'])).toBe('pesan-antar-makanan');
		expect(categoryHintFromWords(['gofood', 'grab'])).toBe('pesan-antar-makanan');
		expect(categoryHintFromWords(['makan', 'gofood'])).toBe('pesan-antar-makanan');
	});
	it('ride wins over the fixed words; the fixed words keep reading order among themselves', () => {
		expect(categoryHintFromWords(['kopi', 'gojek'])).toBe('ojek-online');
		expect(categoryHintFromWords(['makan', 'kopi'])).toBe('makan');
		expect(categoryHintFromWords(['kopi', 'makan'])).toBe('kopi');
		expect(categoryHintFromWords(['bensin'])).toBe('transportasi');
	});
	it('whole words only: no prefix, substring or two-word phrase match', () => {
		expect(categoryHintFromWords(['grabfoodku'])).toBeUndefined();
		expect(categoryHintFromWords(['gopay'])).toBeUndefined();
		expect(categoryHintFromWords(['go', 'food'])).toBeUndefined();
		// "grab food" as two words is read as the ride word (documented limit).
		expect(categoryHintFromWords(['grab', 'food'])).toBe('ojek-online');
		expect(categoryHintFromWords(['pulsa'])).toBeUndefined();
		expect(categoryHintFromWords([])).toBeUndefined();
	});
	it('never reads inherited object keys as keywords', () => {
		expect(categoryHintFromWords(['constructor', '__proto__', 'tostring'])).toBeUndefined();
	});
});

describe('importCategoryFromTitle (CSV and statement descriptions)', () => {
	it('reads service names in upper case and glued to punctuation', () => {
		expect(importCategoryFromTitle('GRABFOOD JKT')).toBe('pesan-antar-makanan');
		expect(importCategoryFromTitle('GOJEK*JAKARTA')).toBe('ojek-online');
		expect(importCategoryFromTitle('QRIS-ShopeeFood/Bandung')).toBe('pesan-antar-makanan');
		expect(importCategoryFromTitle('Grab ke bandara')).toBe('ojek-online');
		expect(importCategoryFromTitle('GOJEK GOFOOD 123')).toBe('pesan-antar-makanan');
	});
	it('only the ride-hailing and food-delivery groups: the fixed words fall through', () => {
		expect(importCategoryFromTitle('KOPI CONTOH')).toBeUndefined();
		expect(importCategoryFromTitle('MAKAN SIANG')).toBeUndefined();
		expect(importCategoryFromTitle('BENSIN PERTAMINA')).toBeUndefined();
		expect(importCategoryFromTitle('TRANSFER KE ••••0987')).toBeUndefined();
		expect(importCategoryFromTitle('')).toBeUndefined();
	});
	it('reads only the first title-length characters of a long description', () => {
		expect(importCategoryFromTitle(`${'x'.repeat(200)} gojek`)).toBeUndefined();
		expect(importCategoryFromTitle(`gojek ${'x '.repeat(100_000)}`)).toBe('ojek-online');
	});
});
