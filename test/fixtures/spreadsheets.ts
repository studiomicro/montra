import { buildXlsx, serialOf, type FixtureCell } from '../helpers/xlsx';

/**
 * Fictional spreadsheet data for FN-17 (no real names, banks or accounts). The generator keeps its own exact
 * sums in integer minor units, computed independently of the reader, so tests compare the import with them.
 */

export interface GeneratedRow {
	date: string;
	title: string;
	category: string;
	type: 'expense' | 'income';
	/** Integer IDR minor units (sen). */
	minor: number;
}

const CATEGORIES = ['Makan & Minum', 'Transportasi', 'Belanja', 'Jajan Fiktif', 'Tagihan'];
const INCOME_CATEGORIES = ['Gaji', 'Bonus', 'Usaha Fiktif'];
const MONTH_NAMES = [
	'Januari',
	'Februari',
	'Maret',
	'April',
	'Mei',
	'Juni',
	'Juli',
	'Agustus',
	'September',
	'Oktober',
	'November',
	'Desember'
];

export function generateRows(count: number, seed = 42): GeneratedRow[] {
	let s = seed;
	const next = () => (s = (s * 1103515245 + 12345) & 0x7fffffff);
	const rows: GeneratedRow[] = [];
	for (let i = 0; i < count; i++) {
		const month = i % 12;
		const day = 1 + (next() % 28);
		const income = next() % 5 === 0;
		const rupiah = 1000 + (next() % 2_000_000);
		const sen = i % 7 === 0 ? 50 : 0;
		rows.push({
			date: `2026-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
			title: `Transaksi fiktif #${i}`,
			category: income
				? (INCOME_CATEGORIES[i % INCOME_CATEGORIES.length] as string)
				: (CATEGORIES[i % CATEGORIES.length] as string),
			type: income ? 'income' : 'expense',
			minor: rupiah * 100 + sen
		});
	}
	return rows;
}

export function sums(rows: readonly GeneratedRow[]) {
	let incomeMinor = 0;
	let expenseMinor = 0;
	for (const r of rows) {
		if (r.type === 'income') incomeMinor += r.minor;
		else expenseMinor += r.minor;
	}
	return { incomeMinor, expenseMinor, rows: rows.length };
}

/** The exact decimal text of a minor amount (`1234.5`, `-1234.5`), as Excel stores it. */
function decimal(minor: number): string {
	const abs = Math.abs(minor);
	const sign = minor < 0 ? '-' : '';
	const sen = abs % 100;
	if (sen === 0) return `${sign}${abs / 100}`;
	return `${sign}${Math.floor(abs / 100)}.${String(sen).padStart(2, '0').replace(/0$/, '')}`;
}

/** Layout (a)+(c): one long table, a date-formatted serial, separate Pemasukan / Pengeluaran columns. */
export function longTableXlsx(rows: readonly GeneratedRow[]): Uint8Array {
	const body: FixtureCell[][] = rows.map((r) => [
		{ serial: serialOf(r.date) },
		r.title,
		r.category,
		r.type === 'income' ? { num: decimal(r.minor) } : null,
		r.type === 'expense' ? { num: decimal(r.minor) } : null
	]);
	return buildXlsx([
		{
			name: 'Transaksi 2026',
			rows: [
				['Catatan Keuangan Keluarga Fiktif'],
				[],
				['Tanggal', 'Keterangan', 'Kategori', 'Pemasukan', 'Pengeluaran'],
				...body,
				[
					null,
					'Total',
					null,
					{ formula: 'SUM(D4:D9999)', cached: 1 },
					{ formula: 'SUM(E4:E9999)', cached: 1 }
				]
			]
		}
	]);
}

/** Layout (b)+(c): one tab per month titled "Januari 2026", a day-only date, Jumlah + Tipe. */
export function monthTabsXlsx(rows: readonly GeneratedRow[]): Uint8Array {
	return buildXlsx(
		MONTH_NAMES.map((name, m) => ({
			name: `${name} 2026`,
			rows: [
				['Tgl', 'Keterangan', 'Kategori', 'Jumlah', 'Tipe'],
				...rows
					.filter((r) => Number(r.date.slice(5, 7)) === m + 1)
					.map((r): FixtureCell[] => [
						Number(r.date.slice(8, 10)),
						r.title,
						r.category,
						{ num: decimal(r.minor) },
						r.type === 'income' ? 'Masuk' : 'Keluar'
					])
			]
		}))
	);
}

/** A tab whose headers no heuristic knows (for the AI suggestion and the manual picker). */
export function unlabeledXlsx(rows: readonly GeneratedRow[]): Uint8Array {
	return buildXlsx([
		{
			name: 'Data',
			rows: [
				['Kapan', 'Apa', 'Berapa'],
				...rows.map((r): FixtureCell[] => [
					{ serial: serialOf(r.date) },
					r.title,
					{ num: decimal(r.type === 'expense' ? -r.minor : r.minor) }
				])
			]
		}
	]);
}

/** Only a budget and an asset list: not a transaction record (AC 12). */
export function budgetOnlyXlsx(): Uint8Array {
	return buildXlsx([
		{
			name: 'Anggaran',
			rows: [
				['Kategori', 'Anggaran', 'Terpakai'],
				['Makan & Minum', 2_000_000, 1_250_000]
			]
		},
		{
			name: 'Aset',
			rows: [
				['Aset', 'Nilai'],
				['Tabungan fiktif', 10_000_000]
			]
		}
	]);
}
