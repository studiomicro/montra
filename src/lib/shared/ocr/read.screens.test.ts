import { describe, expect, it } from 'vitest';
import { ocrDoc, type ConfOf } from '../../../../test/helpers/ocr';
import type { MappedRow } from '../csv';
import { buildPage, lineText } from './lines';
import { readOcrDocument, type OcrReadResult } from './read';
import { amountsIn } from './screens/common';

/*
 * Fictional screenshots only (FN-16g PRD Scope 5.4): invented merchants, names, amounts and numbers, laid out
 * the way the PRD describes the families. No real person's data and no app's copy.
 */

const TODAY = '2026-10-10';
const read = (
	pages: string[][],
	conf: ConfOf = 96,
	institution: string | null = null
): OcrReadResult =>
	readOcrDocument({ doc: ocrDoc(pages, conf), institution, section: null, todayWib: TODAY });
const rowsOf = (r: OcrReadResult) => {
	if (!r.ok) throw new Error(`refused: ${r.error}`);
	return r.reading.rows;
};
const brief = (rows: MappedRow[]) =>
	rows.map((r) =>
		r.ok
			? [r.value.date, r.value.type, r.value.amountMinor, r.value.title, r.review ?? null]
			: ['rejected', r.reason]
	);

const GOPAY_CLEAN = [
	'09:41',
	'GoPay',
	'Riwayat transaksi',
	'Hari ini',
	'Kopi Senja Fiktif          -Rp25.000',
	'14:30 · Berhasil',
	'Isi saldo dari Bank Contoh   +Rp100.000',
	'09:12',
	'Kemarin',
	'Bayar Listrik Fiktif       -Rp250.000',
	'Gagal',
	'08 Okt 2026',
	'Parkir Mal Contoh          -Rp5.000',
	'18:45'
];

describe('e-wallet history screenshots (criterion 24)', () => {
	it('clean: rows, explicit signs, relative days in review, failed row skipped and counted', () => {
		const r = read([GOPAY_CLEAN]);
		expect(r.ok && r.reading.institution).toEqual({ id: 'gopay', label: 'GoPay' });
		expect(brief(rowsOf(r))).toEqual([
			['2026-10-10', 'expense', 2_500_000, 'Kopi Senja Fiktif', 'relative_date'],
			['2026-10-10', 'income', 10_000_000, 'Isi saldo dari Bank Contoh', 'relative_date'],
			['2026-10-08', 'expense', 500_000, 'Parkir Mal Contoh', null]
		]);
		expect(r.ok && r.reading.notCompleted).toBe(1);
	});

	it('noisy: middling confidence goes to review; a lost sign is direction_unknown, never inferred', () => {
		const noisy = [
			'09:41',
			'OVO',
			'Riwayat',
			'08 Okt 2026',
			'Top Up Contoh               Rp50.000',
			'Lihat detail',
			'Pembayaran Warung Fiktif   -Rp12.500',
			'07 Okt 2026',
			'Transfer ke Teman Fiktif   -Rp75.000',
			'Dibatalkan',
			'Belanja Toko Contoh        -Rp40.000'
		];
		const r = read([noisy], (w) => (w === '-Rp12.500' ? 80 : 95));
		expect(brief(rowsOf(r))).toEqual([
			['2026-10-08', 'expense', 5_000_000, 'Top Up Contoh', 'direction_unknown'],
			['2026-10-08', 'expense', 1_250_000, 'Pembayaran Warung Fiktif', 'low_confidence'],
			['2026-10-07', 'expense', 4_000_000, 'Belanja Toko Contoh', null]
		]);
		expect(r.ok && r.reading.notCompleted).toBe(1);
	});

	it('partial/cropped: a row above the first day header has no date and is rejected; title on its own line', () => {
		const cropped = [
			'09:41',
			'DANA',
			'Riwayat Transaksi',
			'Kirim ke Contoh            -Rp20.000',
			'05 Okt 2026',
			'Pulsa Fiktif',
			'-Rp10.000',
			'05 Okt 2026, 21:10'
		];
		expect(brief(rowsOf(read([cropped])))).toEqual([
			['rejected', 'missing_date'],
			['2026-10-05', 'expense', 1_000_000, 'Pulsa Fiktif', null]
		]);
	});

	it('a figure below 70 confidence in the list refuses the whole reading (criterion 21)', () => {
		const r = read([GOPAY_CLEAN], (w) => (w === '-Rp25.000' ? 60 : 96));
		expect(r).toMatchObject({ ok: false, error: 'inconsistent' });
		for (const [c, review] of [
			[69, 'refused'],
			[70, 'low_confidence'],
			[89, 'low_confidence'],
			[90, 'relative_date']
		] as const) {
			const x = read([GOPAY_CLEAN], (w) => (w === '-Rp25.000' ? c : 96));
			if (review === 'refused') expect(x.ok).toBe(false);
			else expect(rowsOf(x)[0]).toMatchObject({ ok: true, review });
		}
	});

	it('a letter inside a figure is never a digit (criterion 22)', () => {
		const lines = GOPAY_CLEAN.map((l) => l.replace('-Rp25.000', '-Rp2O.000'));
		expect(brief(rowsOf(read([lines])))[0]).toEqual([
			'2026-10-10',
			'income',
			10_000_000,
			'Isi saldo dari Bank Contoh',
			'relative_date'
		]);
		const l = GOPAY_CLEAN.map((x) => x.replace('-Rp5.000', '-Rp5.0O0'));
		expect(brief(rowsOf(read([l]))).some((r) => r[2] === 500_000)).toBe(false);
	});
});

const BCA_MOBILE = [
	'10:02',
	'm-BCA',
	'Mutasi Rekening',
	'Periode 01/10/2026 - 10/10/2026',
	'10/10 KOPI SENJA FIKTIF 25.000 DB',
	'09/10 TRANSFER MASUK CONTOH 100.000 CR',
	'08/10 BIAYA ADMIN 10.000 DB'
];

describe('mobile-banking mutation screenshots (criterion 24)', () => {
	it('clean: DB/CR marks, year from the printed period', () => {
		const r = read([BCA_MOBILE]);
		expect(r.ok && r.reading.institution.id).toBe('m-bca');
		expect(brief(rowsOf(r))).toEqual([
			['2026-10-10', 'expense', 2_500_000, 'KOPI SENJA FIKTIF', null],
			['2026-10-09', 'income', 10_000_000, 'TRANSFER MASUK CONTOH', null],
			['2026-10-08', 'expense', 1_000_000, 'BIAYA ADMIN', null]
		]);
	});

	it('noisy: D/K marks and +/− signs, description wrapped over two lines, a stray UI line', () => {
		const brimo = [
			'10:02',
			'BRImo',
			'Mutasi',
			'Periode 01/10/2026 - 10/10/2026',
			'07/10/2026 PEMBAYARAN QRIS',
			'WARUNG FIKTIF 18.000 D',
			'06/10/2026 SETORAN CONTOH 500.000 K',
			'Muat lebih banyak',
			'05/10/2026 TARIK TUNAI -Rp200.000'
		];
		expect(brief(rowsOf(read([brimo])))).toEqual([
			['2026-10-07', 'expense', 1_800_000, 'PEMBAYARAN QRIS WARUNG FIKTIF', null],
			['2026-10-06', 'income', 50_000_000, 'SETORAN CONTOH', null],
			['2026-10-05', 'expense', 20_000_000, 'TARIK TUNAI', null]
		]);
	});

	it('partial: no year anywhere → current WIB year assumed and reviewed; a would-be future date is refused', () => {
		const bni = [
			'10:02',
			'BNI Mobile',
			'Mutasi Rekening',
			'03/10 GAJI CONTOH 5.000.000 CR',
			'15/12 TAGIHAN FIKTIF 100.000 DB'
		];
		expect(brief(rowsOf(read([bni])))).toEqual([
			['2026-10-03', 'income', 500_000_000, 'GAJI CONTOH', 'year_assumed'],
			['rejected', 'unparseable_date']
		]);
	});

	it('running saldo: a row disagreeing with the balance difference marks both neighbours (criterion 27)', () => {
		const livin = (amount: string) => [
			'10:02',
			"Livin' by Mandiri",
			'Mutasi',
			'10 Okt 2026',
			`Toko Fiktif   -Rp ${amount}`,
			'Saldo Rp 1.225.000',
			'09 Okt 2026',
			'Gaji Contoh   +Rp 1.000.000',
			'Saldo Rp 1.250.000',
			'08 Okt 2026',
			'Pulsa Contoh   -Rp 50.000',
			'Saldo Rp 250.000'
		];
		expect(rowsOf(read([livin('25.000')])).map((r) => r.ok && r.review)).toEqual([
			undefined,
			undefined,
			undefined
		]);
		const bad = rowsOf(read([livin('35.000')]));
		expect(bad.map((r) => r.ok && r.review)).toEqual([
			'balance_mismatch',
			'balance_mismatch',
			undefined
		]);
		expect(bad[0]).toMatchObject({ ok: true, value: { amountMinor: 3_500_000 } });
	});

	it('the generic reader claims a mutation list of another bank; two apps claiming is a conflict', () => {
		const generic = [
			'10:02',
			'Mutasi Rekening',
			'Periode 01/10/2026 - 10/10/2026',
			'02/10 BELANJA CONTOH 20.000 DB'
		];
		const r = read([generic]);
		expect(r.ok && r.reading.institution.id).toBe('m-mutasi');
		expect(read([['GoPay', 'BCA', ...BCA_MOBILE.slice(2)]])).toMatchObject({
			ok: false,
			error: 'institution_conflict'
		});
		expect(read([['10:02', 'Riwayat', '02/10 BELANJA 20.000 DB']])).toMatchObject({
			ok: false,
			error: 'institution_unknown'
		});
		expect(read([['10:02', 'Riwayat', '02/10/2026 BELANJA 20.000 DB']], 96, 'm-mutasi').ok).toBe(
			true
		);
		expect(read([BCA_MOBILE], 96, 'gopay')).toMatchObject({
			ok: false,
			error: 'institution_mismatch'
		});
	});
});

describe('amounts from screenshot text (criterion 25)', () => {
	const one = (text: string) => {
		const page = buildPage(
			[...text.matchAll(/\S+/g)].map((m) => ({
				text: m[0],
				confidence: 96,
				x0: m.index * 10,
				x1: (m.index + m[0].length) * 10,
				y0: 0,
				y1: 20
			})),
			500,
			40
		);
		const line = page.lines[0]!;
		return amountsIn({ text: line.words.map((w) => w.t).join(' '), words: [] });
	};
	it('reads the money vectors as integers, refuses slang and bare numbers', () => {
		const rows = read([
			[
				'10:02',
				'GoPay',
				'Riwayat',
				'08 Okt 2026',
				'Satu   Rp 1.250.000',
				'Dua   1.250.000,50',
				'Tiga   Rp 28.000,00',
				'Empat   IDR 1,250,000.00',
				'Lima   -Rp25.000',
				'Enam   +Rp 100.000',
				'Tujuh   25rb',
				'Delapan   Rp 0',
				'Sembilan   Rp 999.999.999.999.999'
			]
		]);
		expect(brief(rowsOf(rows)).map((r) => r.slice(0, 3))).toEqual([
			['2026-10-08', 'expense', 125_000_000],
			['2026-10-08', 'expense', 125_000_050],
			['2026-10-08', 'expense', 2_800_000],
			['2026-10-08', 'expense', 125_000_000],
			['2026-10-08', 'expense', 2_500_000],
			['2026-10-08', 'income', 10_000_000],
			['rejected', 'unparseable_amount'],
			['rejected', 'unparseable_amount']
		]);
		expect(one('Tujuh 25rb')).toEqual([]);
		expect(one('Pesanan 3 item 2026')).toEqual([]);
	});
});

describe('WIB dates (criterion 26)', () => {
	it('23:30 on the last day and 00:30 on the first land on their printed dates; Dec/Jan periods get the right years', () => {
		const lines = [
			'10:02',
			'BRImo',
			'Mutasi',
			'31/10/2025 23:30 MAKAN MALAM FIKTIF 50.000 DB',
			'01/11/2025 00:30 TAKSI CONTOH 30.000 DB'
		];
		expect(brief(rowsOf(read([lines]))).map((r) => r[0])).toEqual(['2025-10-31', '2025-11-01']);
		const decJan = [
			'10:02',
			'm-BCA',
			'Mutasi Rekening',
			'Periode 15/12/2025 - 15/01/2026',
			'31/12 PESTA FIKTIF 75.000 DB',
			'02/01 GAJI CONTOH 900.000 CR'
		];
		expect(brief(rowsOf(read([decJan]))).map((r) => r[0])).toEqual(['2025-12-31', '2026-01-02']);
	});
});

describe('planted text and untrusted input (criteria 28, 29)', () => {
	it('a figure planted in a remark next to the amount leaves the row unreadable, never re-priced', () => {
		const planted = [
			'10:02',
			'GoPay',
			'Riwayat',
			'08 Okt 2026',
			'Catatan Rp 999.000 Fiktif   -Rp25.000'
		];
		expect(brief(rowsOf(read([planted, ['GoPay', '08 Okt 2026', 'Kopi   -Rp1.000']])))[0]).toEqual([
			'rejected',
			'unparseable_amount'
		]);
		const direction = [
			'10:02',
			'GoPay',
			'Riwayat',
			'08 Okt 2026',
			'Masuk +Rp DB Top Up   -Rp25.000'
		];
		expect(rowsOf(read([direction]))[0]).toMatchObject({
			ok: true,
			value: { type: 'expense', amountMinor: 2_500_000 }
		});
	});

	it('control and zero-width characters do not break a figure apart into a different amount', () => {
		const r = read([
			['10:02', 'GoPay', 'Riwayat', '08 Okt 2026', 'Kopi​ <script>x</script>   -Rp25.000']
		]);
		expect(rowsOf(r)[0]).toMatchObject({ ok: true, value: { amountMinor: 2_500_000 } });
	});
});

describe('multi-image overlap and determinism (A7, criterion 30)', () => {
	it('the same row on two images is flagged on the second, never merged', () => {
		const first = [
			'09:41',
			'GoPay',
			'Riwayat',
			'08 Okt 2026',
			'Kopi Fiktif   -Rp25.000',
			'14:30',
			'Roti Contoh   -Rp15.000',
			'15:00'
		];
		const second = [
			'09:42',
			'GoPay',
			'Riwayat',
			'08 Okt 2026',
			'Roti Contoh   -Rp15.000',
			'15:00',
			'Susu Fiktif   -Rp9.000',
			'16:00'
		];
		const rows = rowsOf(read([first, second]));
		expect(rows.map((r) => r.ok && r.review)).toEqual([undefined, undefined, 'overlap', undefined]);
	});

	it('the same document twice gives identical rows, keys and order', () => {
		const a = read([GOPAY_CLEAN, BCA_MOBILE.slice(0, 0).concat(GOPAY_CLEAN)]);
		const b = read([GOPAY_CLEAN, GOPAY_CLEAN]);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		expect(
			lineText([
				{ t: 'a', c: 1, x0: 0, x1: 10 },
				{ t: 'b', c: 1, x0: 40, x1: 50 }
			])
		).toBe('a   b');
	});
});
