import { describe, expect, it } from 'vitest';
import {
	addressDomain,
	cleanMailText,
	gmailConfirmationCode,
	htmlToText,
	looksLikePayment,
	mailAmounts,
	quotedSenderDomain
} from './mail';

describe('mail text (untrusted)', () => {
	it('cleans line by line: invisible characters, quote marks and empty lines go; it is capped', () => {
		expect(cleanMailText('> Nominal :​ Rp 28.000\r\n\r\n>> Merchant‮ : KOPI\n')).toBe(
			'Nominal : Rp 28.000\nMerchant : KOPI'
		);
		expect(cleanMailText('a'.repeat(1_000_000)).length).toBeLessThanOrEqual(20_000);
		expect(cleanMailText('x\n'.repeat(10_000)).split('\n').length).toBeLessThanOrEqual(400);
	});

	it('reads HTML as text, never rendering it', () => {
		const text = htmlToText(
			'<style>p{color:red}</style><p>Total&nbsp;bayar <b>Rp28.000</b></p><script>x()</script>&#65;&#x42;&bogus;'
		);
		expect(cleanMailText(text)).toBe('Total bayar Rp28.000\nAB&bogus;');
		expect(text).not.toMatch(/[<>]|color|x\(\)/);
	});

	it('finds the quoted original sender of a manual forward (only to pick a parser)', () => {
		expect(
			quotedSenderDomain(
				'---------- Forwarded message ---------\nDari: Budi Santoso\nFrom: Bank <noreply@Notifikasi.Bank-QRIS.example>'
			)
		).toBe('notifikasi.bank-qris.example');
		expect(quotedSenderDomain('Dari: Budi Santoso')).toBeNull();
		expect(addressDomain('a@B.example')).toBe('b.example');
		expect(addressDomain('not an address')).toBeNull();
	});

	it('keeps only the digits of a Gmail forwarding confirmation code', () => {
		const from = 'forwarding-noreply@google.com';
		expect(
			gmailConfirmationCode(
				from,
				'(#123456789) Gmail Forwarding Confirmation - Receive Mail from a@b.example',
				''
			)
		).toBe('123456789');
		expect(
			gmailConfirmationCode(from, 'Gmail Forwarding Confirmation', 'Confirmation code: 4455')
		).toBe('4455');
		expect(
			gmailConfirmationCode('spoof@other.example', '(#1) Gmail Forwarding Confirmation', '')
		).toBeNull();
		expect(gmailConfirmationCode(from, 'Hello', 'Confirmation code: 1')).toBeNull();
		expect(
			gmailConfirmationCode(
				from,
				'Gmail Forwarding Confirmation',
				'Confirmation code: 1234567890123'
			)
		).toBeNull();
	});

	it('a payment needs a payment subject (or an allowlisted sender) and an amount; promos, OTPs, unpaid bills and shipping never are', () => {
		const text = 'Total pembayaran: Rp 125.500';
		expect(looksLikePayment({ allowlisted: false, subject: 'Invoice pesanan', text })).toBe(true);
		expect(looksLikePayment({ allowlisted: true, subject: 'Halo', text })).toBe(true);
		expect(looksLikePayment({ allowlisted: false, subject: 'Halo', text })).toBe(false);
		expect(
			looksLikePayment({ allowlisted: false, subject: 'Bukti pembayaran', text: 'tanpa angka' })
		).toBe(false);
		for (const subject of [
			'Promo spesial akhir pekan',
			'Kode OTP Anda',
			'Tagihan jatuh tempo besok',
			'Tagihan belum dibayar',
			'Pesanan sedang dalam pengiriman',
			'Nomor resi pesananmu'
		])
			expect(looksLikePayment({ allowlisted: true, subject, text }), subject).toBe(false);
	});

	it('reads every printed amount of a long mail, line by line', () => {
		const long = `${'baris\n'.repeat(1000)}Total Rp 45.000`;
		expect(mailAmounts(long)).toEqual([4_500_000]);
	});
});
