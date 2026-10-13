import { describe, expect, it } from 'vitest';
import { narrativeTile, narrativeWords } from './bank-narratives';

/** The owner's sample narratives (masked), PRD FN-48 AC-1 … AC-11, with the parser's DB/CR kind. */
const VECTORS: [string, 'expense' | 'income', string | undefined][] = [
	['BIAYA ADM', 'expense', 'biaya-bank'],
	['BUNGA', 'income', 'bunga'],
	['PAJAK BUNGA', 'expense', 'pajak'],
	['TARIKAN ATM 19/••••0872', 'expense', 'tarik-tunai'],
	['KARTU KREDIT/PL 0806 WSIDZX••••0100 BCA', 'expense', 'kartu-kredit'],
	['KARTU DEBIT KACAMATAMOO ••••0872', 'expense', undefined],
	['TRSF E-BANKING DB 10/01 ZQ181 ERWIN PRIA', 'expense', 'transfer'],
	['TRSF E-BANKING CR 1407/FTSCY/WS95031', 'income', 'transfer'],
	['BI-FAST CR BIF TRANSFER DR 009 BUDI SA', 'income', 'transfer'],
	['SWITCHING CR TRF CIPTA KREASI ABDI', 'income', 'transfer'],
	['SWITCHING DB BIAYA TXN KE 009 BANK', 'expense', 'biaya-bank']
];

describe('narrativeTile (FN-48 AC-1 … AC-11)', () => {
	it.each(VECTORS)('%s (%s) → %s', (raw, kind, tile) => {
		expect(narrativeTile(raw, kind)).toBe(tile);
	});

	it('is deterministic: the same text twice gives the same tile (AC-13)', () => {
		for (const [raw, kind] of VECTORS)
			expect(narrativeTile(raw, kind)).toBe(narrativeTile(raw, kind));
	});

	it('a fee outranks a transfer code in the same narrative (AC-11)', () => {
		expect(narrativeTile('TRSF E-BANKING DB BIAYA TRANSFER', 'expense')).toBe('biaya-bank');
		expect(narrativeTile('BI-FAST DB BIAYA', 'expense')).toBe('biaya-bank');
	});

	it('tax outranks interest ("PAJAK BUNGA" is never "Bunga")', () => {
		expect(narrativeTile('PAJAK BUNGA', 'income')).toBeUndefined();
		expect(narrativeTile('PPH BUNGA DEPOSITO', 'expense')).toBe('pajak');
	});

	it('answers only for the kind a signal belongs to', () => {
		expect(narrativeTile('BIAYA ADM', 'income')).toBeUndefined();
		expect(narrativeTile('BUNGA', 'expense')).toBeUndefined();
		expect(narrativeTile('TARIKAN ATM 19/0872', 'income')).toBeUndefined();
		expect(narrativeTile('KARTU KREDIT/PL 0806', 'income')).toBeUndefined();
	});

	it('"biaya" alone is not a bank fee ("biaya sekolah")', () => {
		expect(narrativeTile('BIAYA SEKOLAH ANAK', 'expense')).toBeUndefined();
	});

	it('a purchase that merely mentions a credit card is not a card bill', () => {
		expect(narrativeTile('BELI KOPI PAKAI KARTU KREDIT', 'expense')).toBeUndefined();
		expect(narrativeTile('PEMBAYARAN KARTU KREDIT BCA', 'expense')).toBe('kartu-kredit');
	});

	it('red team L1: a sender’s note or a merchant’s name never picks a fee, tax or interest tile', () => {
		expect(narrativeTile('TRSF E-BANKING CR 1407/FTSCY BUNGA DEPOSITO ANDI', 'income')).toBe(
			'transfer'
		);
		expect(narrativeTile('BI-FAST CR BIF TRANSFER DR 009 PAJAK', 'income')).toBe('transfer');
		expect(narrativeTile('SWITCHING CR TRF JASA GIRO', 'income')).toBe('transfer');
		expect(narrativeTile('KARTU DEBIT TOKO BIAYA ADM', 'expense')).toBeUndefined();
		expect(narrativeTile('QRIS TOKO PAJAK', 'expense')).toBeUndefined();
		expect(narrativeTile('ＫＡＲＴＵ　ＤＥＢＩＴ　ＢＩＡＹＡ　ＡＤＭ', 'expense')).toBeUndefined();
		// The bank's own words before the channel still count.
		expect(narrativeTile('BUNGA TABUNGAN', 'income')).toBe('bunga');
	});

	it('cycle 2 L2: only the bank’s own leading words pick a tile, whatever prefix the rest follows', () => {
		expect(
			narrativeTile('KR OTOMATIS LLG-BANK MANDIRI ANDI BUNGA DEPOSITO', 'income')
		).toBeUndefined();
		expect(narrativeTile('SETORAN TUNAI BUNGA', 'income')).toBeUndefined();
		expect(narrativeTile('TRANSAKSI DEBIT TGL: 0105 QR 014 TOKO PAJAK', 'expense')).toBeUndefined();
		expect(narrativeTile('TRANSAKSI DEBIT TGL: 0105 TOKO BIAYA ADM', 'expense')).toBeUndefined();
		expect(narrativeTile('DB DEBIT DOMESTIK TOKO PAJAK', 'expense')).toBeUndefined();
		expect(narrativeTile('PEMBAYARAN QRIS TOKO PAJAK', 'expense')).toBeUndefined();
		expect(narrativeTile('TOKO TRANSFER JAYA', 'expense')).toBeUndefined();
		// The bank's own narratives keep their tiles.
		expect(narrativeTile('BIAYA TXN', 'expense')).toBe('biaya-bank');
		expect(narrativeTile('JASA GIRO', 'income')).toBe('bunga');
	});

	it('matches whole words only', () => {
		expect(narrativeTile('ADMINISTRATOR TOKO', 'expense')).toBeUndefined();
		expect(narrativeTile('TRANSFERAN TOKO', 'expense')).toBeUndefined();
		expect(narrativeTile('BUNGALOW SEWA', 'income')).toBeUndefined();
	});

	it('drops digits, card tails, invisible characters and anything past the cap', () => {
		expect(narrativeWords('TRSF​ E-BANKING DB 10/01 ZQ181')).toEqual([
			'trsf',
			'e',
			'banking',
			'db',
			'zq'
		]);
		expect(narrativeTile(`${'X '.repeat(200)}BIAYA ADM`, 'expense')).toBeUndefined();
		expect(narrativeTile('', 'expense')).toBeUndefined();
		expect(narrativeTile(null as unknown as string, 'expense')).toBeUndefined();
	});
});
