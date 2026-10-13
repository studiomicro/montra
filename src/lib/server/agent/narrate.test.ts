import { describe, expect, it } from 'vitest';
import { narrativeHasLure } from './narrate';

// FN-23 red team S1: a prompt-injected URL or credential lure never reaches the stored narrative.
describe('narrativeHasLure', () => {
	it.each([
		'Akunmu perlu verifikasi ulang di https://montra-bantuan.com/login segera.',
		'Buka www.contoh.id untuk detailnya.',
		'Verifikasi di evil.co/x sekarang.',
		'Masukkan PIN kamu untuk melanjutkan.',
		'Kirim OTP ke admin.',
		'Please log in again.',
		'Ganti password-mu hari ini.',
		'Ketik kata sandi di halaman berikut.'
	])('flags %s', (text) => {
		expect(narrativeHasLure(text)).toBe(true);
	});

	it.each([
		'Pengeluaranmu Rp 25.000 bulan ini, naik 12% dari bulan lalu.',
		'Makan & Minum jadi kategori terbesar. Transport turun.',
		'Spending on Food rose from Rp 25.000 to Rp 30.000.',
		'Kamu belanja di Indomaret dan Alfamart. Pinjaman tidak berubah.'
	])('keeps %s', (text) => {
		expect(narrativeHasLure(text)).toBe(false);
	});
});

// fix-lows-services red team N3 (cycle 2): spellings around the filter are normalised first.
describe('narrativeHasLure cycle 2 (red team N3)', () => {
	it.each([
		'Verifikasi di montra-bantuan .com segera.',
		'Buka montra-bantuan(.)com.',
		'Buka montra-bantuan[.]com.',
		'Buka montra-bantuan.cöm sekarang.',
		'Kunjungi montra-bantuan titik com.',
		'Visit montra dot com today.',
		'Masuk ke akunmu dan isi kata-sandi.',
		'Isi katasandi kamu.',
		'Kirim sandi lewat chat.',
		'Enter your passcode.',
		'Masuk ke aplikasi lalu konfirmasi.'
	])('flags %s', (text) => {
		expect(narrativeHasLure(text)).toBe(true);
	});

	it.each([
		'Pengeluaranmu naik bulan ini. Kamu paling sering belanja di Indomaret.',
		'Pemasukan stabil; tabungan bertambah.',
		'Makan & Minum tetap terbesar. Transport turun.'
	])('keeps %s', (text) => {
		expect(narrativeHasLure(text)).toBe(false);
	});
});
