import { describe, expect, it } from 'vitest';
import { guardAnswer } from './answer-guard';
import { FigureBook } from './figures';

// QA fix-lows-services: ordinary Indonesian and English answers that a normal user gets must still pass the
// tightened guard (S11/S12). Placeholders {1}..{3} stand for the book's figure ids.
function guard(text: string) {
	const b = new FigureBook('id');
	const ids = [
		b.money('expense', 2_500_000, 'IDR')!.id,
		b.money('refund', -2_500_000, 'IDR')!.id,
		b.percent('change', 12)!.id
	];
	return guardAnswer(
		text.replace(/\{(\d)\}/g, (_, n: string) => `[[f:${ids[Number(n) - 1]}]]`),
		b
	);
}

describe('ordinary answers still pass the tightened guard', () => {
	it.each([
		'Pengeluaran terbesar bulan ini ada di Makanan ({1}), diikuti Transportasi ({2}).',
		'Kamu belanja di Indomaret 4 kali bulan ini, total {1}.',
		'Rata-rata per transaksi {1}; tertinggi {2}.',
		'Dibanding September, Oktober naik {3}. Penyebab utamanya langganan streaming.',
		'Anggaran Makan: terpakai {1} dari {2}; sisa waktu 12 hari.',
		'Sisa anggaran bulan ini {1}. Ini bukan nasihat keuangan.',
		'Total transfer masuk {1} dan transfer keluar {2} selama kuartal ketiga.',
		'Pengeluaran Grab {1} dan Gojek {2} bulan ini.',
		'You spent {1} on coffee in 12 visits, mostly at Kopi Kenangan.',
		'Biaya admin bank sebulan {1}, lebih rendah dari bulan lalu {2}.'
	])('keeps %s', (text) => {
		expect(guard(text).kind).toBe('prose');
	});
});

// S12 drops prose with a sign word right before a figure ("minus {1}" falls back to figures only). Cycle 2 (QA
// observation 1): the shortfall phrase "kurang {1} lagi" keeps the positive server figure and stays prose.
describe('sign words before a figure (S12)', () => {
	it('"minus {1}" falls back to figures only', () => {
		expect(guard('Saldo minus {1} bulan ini.').kind).toBe('figures_only');
	});
	it('"kurang {1} lagi" stays prose', () => {
		expect(guard('Kamu kurang {1} lagi dari anggaran.').kind).toBe('prose');
	});
});
