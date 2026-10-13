/**
 * A synthetic BCA mutation CSV (FN-16c): the layout of the KlikBCA / myBCA "unduh mutasi" export — header block,
 * column row, `'DD/MM/YYYY` rows with `DB`/`CR` and a running balance, footer block — with every name, account
 * number, description and amount invented. Nothing here comes from a real export.
 */

export interface BcaCsvFixture {
	currency?: string;
	/** The transaction records exactly as they appear in the file (one line each). */
	rows: readonly string[];
	/** Footer values; a null value leaves that line out. */
	footer: {
		opening: string | null;
		credit: string | null;
		debit: string | null;
		closing: string | null;
	};
}

/** The file text (LF line ends; tests vary CRLF, BOM and the separator themselves). */
export function bcaCsv(f: BcaCsvFixture): string {
	const footer = [
		['Saldo Awal', f.footer.opening],
		['Kredit', f.footer.credit],
		['Debet', f.footer.debit],
		['Saldo Akhir', f.footer.closing]
	]
		.filter(([, v]) => v !== null)
		.map(([label, v]) => `${label},=,${v}`);
	return [
		"No. Rekening,=,'1234567890",
		'Nama,=,NAMA NASABAH FIKTIF',
		`Mata Uang,=,${f.currency ?? 'IDR'}`,
		'',
		'Tanggal,Keterangan,Cabang,Jumlah,,Saldo',
		...f.rows,
		...footer,
		''
	].join('\n');
}

/**
 * Seven September 2026 rows: debits, credits, a date and `CR` inside a description, a card number in a
 * description, multiple spaces. 1000000.00 + 2501234.56 − 285747.41 = 3215487.15.
 */
export const BCA_CSV_SEPTEMBER: BcaCsvFixture = {
	rows: [
		"'02/09/2026,TARIKAN ATM 02/09    1234567890123456,'0001,200000.00,DB,800000.00",
		"'03/09/2026,BIAYA ADM ,'0000,10000.00,DB,790000.00",
		"'05/09/2026,KARTU DEBIT 05/09 TOKO CONTOH,'0001,50000.00,DB,740000.00",
		"'05/09/2026,QR 014 KEDAI FIKTIF        KOTA CONTOH,'0001,25500.50,DB,714499.50",
		"'10/09/2026,TRSF E-BANKING CR 1009/CONTOH   PT CONTOH FIKTIF,'0000,2500000.00,CR,3214499.50",
		"'30/09/2026,BUNGA,'0000,1234.56,CR,3215734.06",
		"'30/09/2026,PAJAK BUNGA,'0000,246.91,DB,3215487.15"
	],
	footer: {
		opening: '1000000.00',
		credit: '2501234.56',
		debit: '285747.41',
		closing: '3215487.15'
	}
};

/** The rows BCA_CSV_SEPTEMBER must read to: date, type, integer minor units, description. */
export const BCA_CSV_SEPTEMBER_ROWS = [
	['2026-09-02', 'expense', 20_000_000, 'TARIKAN ATM 02/09 1234567890123456'],
	['2026-09-03', 'expense', 1_000_000, 'BIAYA ADM'],
	['2026-09-05', 'expense', 5_000_000, 'KARTU DEBIT 05/09 TOKO CONTOH'],
	['2026-09-05', 'expense', 2_550_050, 'QR 014 KEDAI FIKTIF KOTA CONTOH'],
	['2026-09-10', 'income', 250_000_000, 'TRSF E-BANKING CR 1009/CONTOH PT CONTOH FIKTIF'],
	['2026-09-30', 'income', 123_456, 'BUNGA'],
	['2026-09-30', 'expense', 24_691, 'PAJAK BUNGA']
] as const;
