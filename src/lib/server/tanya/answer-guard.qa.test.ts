import { describe, expect, it } from 'vitest';
import { guardAnswer } from './answer-guard';
import { FigureBook } from './figures';

// QA cycle 2: the broadened guard keeps ordinary prose that holds only placeholders, words, dates and small counts.
function run(text: string) {
	const b = new FigureBook('id');
	const a = b.money('a', 2_500_000, 'IDR')!.id;
	const c = b.percent('c', 12)!.id;
	return guardAnswer(
		text.replace('{A}', `[[f:${a}]]`).replace('{B}', `[[f:${a}]]`).replace('{C}', `[[f:${c}]]`),
		b
	);
}
const OK = [
	'Di Oktober 2026 kamu habis {A} untuk Makan & Minum.',
	'Dalam 3 bulan terakhir pengeluaran Transportasi rata-rata {A} per bulan, naik {C}.',
	'Pada 2026-10-01 ada 12 transaksi di kategori Belanja Bulanan: total {A}.',
	'Dari 1 Oktober sampai 10 Oktober 2026 kamu habis {A}; bulan lalu {B}.',
	'Ada 5 langganan aktif dan 2 dompet. Saldo dompet utama {A}.',
	'Selama 7 hari terakhir: {A} di Kopi, {B} di Transportasi (tertinggi).',
	'Your spending in October 2026 was {A}, across 3 categories in the last 3 months.',
	'1. Makan: {A}\n2. Transport: {B}\n3. Hiburan: {C}',
	'Pengeluaranmu {A}-{B} per minggu. Kategori terbesar: Kebutuhan Rumah Tangga.',
	'Pukul 23:30 WIB tanggal 31 Oktober 2026 tercatat 1 transaksi senilai {A}.',
	'Kamu punya 20 anggaran; 4 sudah lewat batas. Anggaran Makan terpakai {C}.'
];
describe('guard false positives', () => {
	it.each(OK)('keeps %s', (t) => {
		expect(run(t).kind).toBe('prose');
	});
	it('renders the server figure', () => {
		expect(run('Total {A}.').text).toBe('Total Rp 25.000.');
	});
});

// QA cycle 3: allowlist guard (S8-S10). Realistic answers using placeholders {A} {B} {C}.
const OK3 = [
	'Pengeluaran Makan naik dari {A} ke {B} bulan ini.',
	'Dibanding bulan lalu, pengeluaranmu naik {C} menjadi {A}.',
	'Spending on Food rose from {A} to {B} compared with last month.',
	'Tiga kategori teratas:\n1. Makan: {A}\n2. Transport: {B}\n3. Hiburan: {C}',
	'Top 3 categories:\n1) Food {A}\n2) Transport {B}\n3) Fun {C}',
	'- Makan: {A}\n- Transport: {B}\n* Hiburan: {C}',
	'• Makan: {A}\n• Transport: {B}',
	'Kamu paling sering belanja di Indomaret ({A}) dan Alfamart ({B}).',
	'Ini hanya gambaran dari datamu, bukan nasihat keuangan.',
	'This is a summary of your data, not financial advice.',
	'Pengeluaran "Kopi" sebesar {A}; itu — menurut catatan — yang tertinggi!',
	'Kamu punya 3 dompet: BCA, GoPay, dan Cash. Total saldo {A}.',
	'Hari ini (10 Oktober 2026) kamu belum mencatat transaksi apa pun. Mau tambah?',
	'Tidak ada data untuk bulan ini. Coba tanya periode lain, misalnya September 2026.',
	'Anggaran Makan terpakai {C} dari {A} (sisa {B}).',
	'Kamu bayar {A} di Warung 99 minggu ini.',
	'Rata-rata per hari: {A}. Hari termahal: Sabtu, 3 Oktober 2026.'
];
describe('guard false positives (cycle 3 allowlist)', () => {
	it.each(OK3)('keeps %s', (t) => {
		expect(run(t).kind).toBe('prose');
	});
});
// Merchant names with digits next to a number or a figure fall back to the cards (fail closed, accepted).
const FALLBACK3 = [
	'Kamu belanja 3 kali di 7-Eleven dengan total {A}.',
	'Transaksi di 7-Eleven senilai {A}.',
	'Naik 12% dibanding bulan lalu.'
];
describe('guard known fail-closed forms (cycle 3)', () => {
	it.each(FALLBACK3)('falls back for %s', (t) => {
		expect(run(t).kind).toBe('figures_only');
	});
});

describe('FigureBook.count (FN-23)', () => {
	it('groups a count by locale so the guard accepts it only as a placeholder', () => {
		const id = new FigureBook('id');
		const en = new FigureBook('en');
		expect(id.count('transactions', 1234)?.formatted).toBe('1.234');
		expect(en.count('transactions', 1234567)?.formatted).toBe('1,234,567');
		expect(id.count('transactions', 12)?.formatted).toBe('12');
		expect(id.count('bad', -1)).toBeNull();
		expect(id.count('bad', 1.5)).toBeNull();
		const f = id.count('transactions', 1234)!;
		expect(guardAnswer(`Ada [[f:${f.id}]] transaksi.`, id)).toEqual({
			kind: 'prose',
			text: 'Ada 1.234 transaksi.'
		});
		expect(guardAnswer('Ada 1234 transaksi.', id).kind).toBe('figures_only');
	});
});
