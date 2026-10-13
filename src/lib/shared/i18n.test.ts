import { describe, expect, it } from 'vitest';
import { createTranslator, msg, resolveLocale } from '#lib/shared/i18n';

describe('createTranslator', () => {
	it('returns the Indonesian phrase for id', () => {
		expect(createTranslator('id').tr('Beranda')).toBe('Beranda');
	});

	it('returns the English entry for en', () => {
		expect(createTranslator('en').tr('Beranda')).toBe('Home');
	});

	it('falls back to the Indonesian phrase when English is missing', () => {
		expect(createTranslator('en').tr('Frasa yang tidak ada')).toBe('Frasa yang tidak ada');
	});

	it('substitutes named placeholders only', () => {
		const t = createTranslator('id');
		expect(t.trf('{n} transaksi', { n: 3 })).toBe('3 transaksi');
		expect(t.trf('{n} transaksi', { n: '<b>' })).toBe('<b> transaksi');
		expect(t.trf('{a} dan {b}', { a: 'x' })).toBe('x dan {b}');
	});

	it('translates the template before substituting', () => {
		expect(createTranslator('en').trf('{n} transaksi', { n: 2 })).toBe('2 transactions');
	});

	it('ignores Object.prototype keys', () => {
		for (const locale of ['id', 'en'] as const) {
			const t = createTranslator(locale);
			for (const phrase of ['constructor', 'toString', '__proto__', 'valueOf']) {
				expect(t.tr(phrase)).toBe(phrase);
			}
		}
	});

	it('two translators do not share state', () => {
		const id = createTranslator('id');
		const en = createTranslator('en');
		expect(en.tr('Beranda')).toBe('Home');
		expect(id.tr('Beranda')).toBe('Beranda');
		expect(en.tr('Beranda')).toBe('Home');
	});
});

describe('msg', () => {
	it('is the identity', () => {
		expect(msg('Riwayat')).toBe('Riwayat');
	});
});

describe('resolveLocale', () => {
	it('prefers a valid cookie', () => {
		expect(resolveLocale('en', 'id-ID,id;q=0.9')).toBe('en');
	});
	it('ignores an invalid cookie', () => {
		expect(resolveLocale('fr', null)).toBe('id');
	});
	it('reads Accept-Language when no cookie', () => {
		expect(resolveLocale(undefined, 'en-US,en;q=0.9')).toBe('en');
		expect(resolveLocale(undefined, 'id-ID,en;q=0.5')).toBe('id');
	});
	it('defaults to id', () => {
		expect(resolveLocale(undefined, null)).toBe('id');
		expect(resolveLocale(undefined, 'fr-FR')).toBe('id');
	});
});
