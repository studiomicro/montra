import { describe, expect, it } from 'vitest';
import { createTranslator } from '#lib/shared/i18n';
import { en } from '#lib/shared/i18n-en';
import { createClientTranslator, loadEnglish } from './client-i18n';

describe('client translator', () => {
	it('leaves Indonesian phrases alone and fills templates', () => {
		const t = createClientTranslator('id');
		expect(t.tr('Beranda')).toBe('Beranda');
		expect(t.trf('Halo {nama} {x}', { nama: 'Sari' })).toBe('Halo Sari {x}');
	});

	it('translates like the shared translator once the English table is loaded', async () => {
		await loadEnglish('en');
		const mine = createClientTranslator('en');
		const shared = createTranslator('en');
		for (const phrase of [...Object.keys(en).slice(0, 200), 'tidak ada di tabel', 'toString']) {
			expect(mine.tr(phrase)).toBe(shared.tr(phrase));
		}
		expect(mine.tr('Beranda')).toBe('Home');
		expect(mine.trf('Halo {nama}', { nama: 'Sari' })).toBe(
			shared.trf('Halo {nama}', { nama: 'Sari' })
		);
	});
});
