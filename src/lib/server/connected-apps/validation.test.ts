import { describe, expect, it } from 'vitest';
import { EXTERNAL_LABEL_MAX_LENGTH, maskExternalLabel, providerField } from './validation.ts';

const formOf = (fields: Record<string, string>) => {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.set(k, v);
	return form;
};

describe('providerField', () => {
	it('accepts exactly the five providers', () => {
		for (const p of ['gmail', 'google_sheets', 'google_calendar', 'notion', 'slack'])
			expect(providerField(formOf({ provider: p }))).toBe(p);
	});

	it('refuses anything else', () => {
		for (const p of [
			'',
			'Gmail',
			'dropbox',
			'__proto__',
			'constructor',
			'gmail ',
			'x'.repeat(5000)
		])
			expect(providerField(formOf({ provider: p }))).toBeNull();
		expect(providerField(formOf({}))).toBeNull();
	});
});

describe('maskExternalLabel', () => {
	it('keeps only the domain of an e-mail address', () => {
		expect(maskExternalLabel('budi.santoso@contoh.id')).toBe('contoh.id');
		expect(maskExternalLabel('a@b@keluarga.id')).toBe('keluarga.id');
	});

	it('cuts account-like numbers to the last 4 digits', () => {
		expect(maskExternalLabel('Workspace 1234567890123')).toBe(
			'Workspace \u2022\u2022\u2022\u20220123'
		);
	});

	it('strips invisible characters, caps the length, and gives null when nothing is left', () => {
		expect(maskExternalLabel('Tim\u200b \u202eKeuangan')).toBe('Tim Keuangan');
		expect(maskExternalLabel('k'.repeat(500))).toHaveLength(EXTERNAL_LABEL_MAX_LENGTH);
		expect(maskExternalLabel('   ')).toBeNull();
		expect(maskExternalLabel('nama@')).toBeNull();
	});
});
