import { describe, expect, it } from 'vitest';
import { maskAccountNumbers } from './text';

// QA fix-lows-services cycle 2: legitimate amounts stay readable, account and card numbers do not.
describe('maskAccountNumbers keeps amounts, masks accounts (cycle 2)', () => {
	it.each([
		'Rp 1.234.567,89',
		'Saldo Rp1.234.567,89 hari ini',
		'Total 1.234.567,89 dari toko',
		'IDR 1234567,89',
		'Rp 12345678,90',
		'Bayar 1,234,567.89 USD',
		'Rp 25.000,00 pada 2026-10-13 pukul 18:05',
		'Cicilan Rp150.000*12',
		'Transfer Rp 10.000.000'
	])('keeps %s', (text) => {
		expect(maskAccountNumbers(text)).toBe(text);
	});

	it.each([
		['Rek 1234567890,12', '9012'],
		['Kartu 4111 1111 1111 1111,00', '1100'],
		['Kartu 4111  1111  1111  4321', '4321'],
		['Kartu 4111·1111·1111·4321', '4321'],
		['Kartu 4111~1111~1111~4321', '4321'],
		['Rek 1234567890', '7890']
	])('masks %s to the last 4 digits', (text, last4) => {
		const out = maskAccountNumbers(text);
		expect(out).toContain('••••');
		expect(out.replace(/\D/g, '').length).toBeLessThanOrEqual(last4.length);
		expect(out).toContain(last4);
	});
});
