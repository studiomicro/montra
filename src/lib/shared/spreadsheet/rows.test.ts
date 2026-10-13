import { describe, expect, it } from 'vitest';
import { proposeTab, roleOfHeader, headerKey } from './layout';
import { columnsIssue, kindOfType, mapSheets } from './rows';
import {
	SHEET_MAX_ROW,
	TAB_KEY_STRIDE,
	type SheetCell,
	type SheetGrid,
	type SheetMapping,
	type TabMapping,
	type Workbook
} from './types';

type In = string | number | null | { d: number };

const cell = (v: In): SheetCell | null =>
	v === null
		? null
		: typeof v === 'string'
			? { kind: 'text', text: v }
			: typeof v === 'number'
				? { kind: 'number', text: String(v), date: false, foreign: false }
				: { kind: 'number', text: String(v.d), date: true, foreign: false };

function grid(index: number, name: string, rows: In[][], start = 1): SheetGrid {
	const kept = rows
		.map((r, i) => ({ r: start + i, cells: r.map(cell) }))
		.filter((r) => r.cells.some((c) => c));
	return {
		index,
		name,
		rows: kept,
		columns: Math.max(...kept.map((r) => r.cells.length)),
		droppedRows: 0
	};
}

const wb = (...sheets: SheetGrid[]): Workbook => ({ date1904: false, sheets, skipped: [] });

/** The heuristic mapping of every tab, as a fresh read proposes it. */
function proposed(book: Workbook): SheetMapping {
	const tabs: TabMapping[] = [];
	for (const g of book.sheets) {
		const p = proposeTab(g, book.date1904);
		if (!('skip' in p)) tabs.push(p.mapping);
	}
	return { tabs, fillDown: false };
}

const ok = (book: Workbook, mapping = proposed(book)) => {
	const out = mapSheets(book, mapping, 5000);
	return {
		out,
		rows: out.rows.flatMap((r) => (r.ok ? [{ i: r.index, ...r.value }] : []))
	};
};

// Serials: 2026-10-01 = 46296.
const OCT1 = 46296;

describe('header words', () => {
	it('normalises case, punctuation and (Rp)', () => {
		expect(headerKey(' Jumlah (Rp) ')).toBe('jumlah');
		expect(roleOfHeader('TGL.')).toBe('date');
		expect(roleOfHeader('Nominal Rp')).toBe('amount');
		expect(roleOfHeader('Uang Keluar')).toBe('expense');
		expect(roleOfHeader('Saldo')).toBe('ignore');
		expect(roleOfHeader('Sesuatu')).toBeUndefined();
	});
	it('type cells', () => {
		expect(kindOfType('Masuk')).toBe('income');
		expect(kindOfType('DB')).toBe('expense');
		expect(kindOfType('transfer')).toBeNull();
	});
	it('mapping issues: missing date/amount, amount next to in/out, a role twice', () => {
		expect(columnsIssue(['date', 'amount'])).toBeNull();
		expect(columnsIssue(['title', 'amount'])).toBe('needs_mapping');
		expect(columnsIssue(['date', 'title'])).toBe('needs_mapping');
		expect(columnsIssue(['date', 'amount', 'income'])).toBe('needs_mapping');
		expect(columnsIssue(['date', 'date', 'amount'])).toBe('needs_mapping');
		expect(columnsIssue(['date', 'ignore', 'ignore', 'expense'])).toBeNull();
	});
});

describe('layout (a): one long table', () => {
	const book = wb(
		grid(0, 'Transaksi', [
			['Tanggal', 'Keterangan', 'Kategori', 'Jumlah'],
			[{ d: OCT1 }, 'Kopi susu', 'Makan', -28000],
			['2026-10-02', 'Gaji Oktober', 'Gaji', 9_500_000],
			['03/10/2026', 'Parkir', 'Transportasi', '-5.000']
		])
	);
	it('is proposed ready, signs give the kind, amounts are exact minor units', () => {
		const p = proposeTab(book.sheets[0]!, false);
		expect(p).toMatchObject({
			status: 'ready',
			mapping: { headerRow: 1, columns: ['date', 'title', 'category', 'amount'] }
		});
		const { rows } = ok(book);
		expect(rows).toEqual([
			expect.objectContaining({
				i: 2,
				date: '2026-10-01',
				type: 'expense',
				title: 'Kopi susu',
				categoryName: 'Makan',
				amountMinor: 2_800_000
			}),
			expect.objectContaining({
				i: 3,
				date: '2026-10-02',
				type: 'income',
				amountMinor: 950_000_000
			}),
			expect.objectContaining({ i: 4, date: '2026-10-03', type: 'expense', amountMinor: 500_000 })
		]);
	});
	it('only positive amounts and no other hint: the user must choose the kind', () => {
		const pos = wb(
			grid(0, 'Data', [
				['Tanggal', 'Jumlah'],
				[{ d: OCT1 }, 1000],
				[{ d: OCT1 }, 2000]
			])
		);
		expect(ok(pos).out.tabs).toEqual([{ tab: 0, rows: 0, issue: 'needs_kind' }]);
		const chosen = proposed(pos);
		chosen.tabs[0]!.kind = 'expense';
		expect(ok(pos, chosen).rows.map((r) => r.type)).toEqual(['expense', 'expense']);
	});
});

describe('layout (b): one tab per month, day-only dates', () => {
	it('month and year from the tab title; a title without one needs a chosen month', () => {
		const book = wb(
			grid(0, 'Januari 2026', [
				['Tgl', 'Keterangan', 'Pengeluaran'],
				[1, 'Sewa', 1_500_000],
				['15', 'Listrik', 300_000],
				['20 Jan', 'Air', 50_000]
			]),
			grid(1, 'Okt 26', [
				['Tgl', 'Pengeluaran'],
				[31, 1000]
			]),
			grid(2, 'Catatan', [
				['Tgl', 'Pengeluaran'],
				[2, 1000]
			])
		);
		const { rows, out } = ok(book);
		expect(rows.map((r) => r.date)).toEqual([
			'2026-01-01',
			'2026-01-15',
			'2026-01-20',
			'2026-10-31'
		]);
		expect(out.tabs.find((t) => t.tab === 2)?.issue).toBe('needs_month');
		const m = proposed(book);
		m.tabs[2]!.month = '2026-02';
		expect(ok(book, m).rows.at(-1)).toMatchObject({
			date: '2026-02-02',
			i: 2 * TAB_KEY_STRIDE + 2
		});
	});
});

describe('layout (c): in/out columns, or amount + type', () => {
	it('separate Pemasukan / Pengeluaran columns', () => {
		const book = wb(
			grid(0, 'Kas', [
				['Tanggal', 'Uraian', 'Pemasukan', 'Pengeluaran', 'Saldo'],
				[{ d: OCT1 }, 'Gaji', 5_000_000, null, 5_000_000],
				[{ d: OCT1 }, 'Makan', null, 25_000, 4_975_000]
			])
		);
		expect(ok(book).rows.map((r) => [r.type, r.amountMinor])).toEqual([
			['income', 500_000_000],
			['expense', 2_500_000]
		]);
	});
	it('Jumlah + Tipe; an unknown type is skipped and counted', () => {
		const book = wb(
			grid(0, 'Kas', [
				['Tanggal', 'Jumlah', 'Tipe'],
				[{ d: OCT1 }, 1000, 'Masuk'],
				[{ d: OCT1 }, 2000, 'Keluar'],
				[{ d: OCT1 }, 3000, 'Transfer']
			])
		);
		const { rows, out } = ok(book);
		expect(rows.map((r) => r.type)).toEqual(['income', 'expense']);
		expect(out.skips.type_unknown).toBe(1);
	});
});

describe('layout (d): an income tab next to an expense tab', () => {
	it('kind from the tab title, or the user choice', () => {
		const book = wb(
			grid(0, 'Pemasukan', [
				['Tanggal', 'Jumlah'],
				[{ d: OCT1 }, 1000]
			]),
			grid(1, 'Pengeluaran', [
				['Tanggal', 'Jumlah'],
				[{ d: OCT1 }, 2000]
			])
		);
		expect(ok(book).rows.map((r) => r.type)).toEqual(['income', 'expense']);
		const m = proposed(book);
		m.tabs[0]!.kind = 'expense';
		expect(ok(book, m).rows.map((r) => r.type)).toEqual(['expense', 'expense']);
	});
});

describe('layout (e)-(g): titles above, repeated header, totals', () => {
	const book = wb(
		grid(0, 'Okt', [
			['Catatan keuangan keluarga'],
			[null],
			['Dibuat oleh: Budi Fiktif'],
			['Tanggal', 'Keterangan', 'Jumlah'],
			[{ d: OCT1 }, 'Kopi', -20_000],
			[{ d: OCT1 + 1 }, 'Gaji', 100_000],
			['Tanggal', 'Keterangan', 'Jumlah'],
			[{ d: OCT1 + 2 }, 'Bensin', -50_000],
			[null, 'Total', 30_000],
			['Saldo akhir', null, 30_000],
			[null, 'Catatan tanpa tanggal', -1_000]
		])
	);
	it('finds the header below the title rows, never counts the repeated header, skips totals by reason', () => {
		const p = proposeTab(book.sheets[0]!, false);
		expect(p).toMatchObject({ status: 'ready', mapping: { headerRow: 4 } });
		const { rows, out } = ok(book);
		expect(rows.map((r) => r.title)).toEqual(['Kopi', 'Gaji', 'Bensin']);
		expect(out.skips.total_row).toBe(2);
		expect(out.skips.date_missing).toBe(1);
		expect(out.tabs[0]?.rows).toBe(6);
		// A total's value is never added.
		expect(rows.reduce((s, r) => s + r.amountMinor, 0)).toBe(17_000_000);
	});
});

describe('layout (h): merged-looking dates', () => {
	const book = wb(
		grid(0, 'Okt 2026', [
			['Tanggal', 'Keterangan', 'Pengeluaran'],
			[1, 'Kopi', 20_000],
			[null, 'Roti', 15_000],
			[2, 'Bensin', 50_000]
		])
	);
	it('fills down only when the user enables it (default off)', () => {
		expect(ok(book).out.skips.date_missing).toBe(1);
		const m = proposed(book);
		m.fillDown = true;
		expect(ok(book, m).rows.map((r) => r.date)).toEqual(['2026-10-01', '2026-10-01', '2026-10-02']);
	});
});

describe('amount rules', () => {
	it('"25rb" and "1,5 jt" are skipped as not a number; foreign amounts counted apart', () => {
		const book = wb(
			grid(0, 'Pengeluaran', [
				['Tanggal', 'Jumlah'],
				[{ d: OCT1 }, '25rb'],
				[{ d: OCT1 }, '1,5 jt'],
				[{ d: OCT1 }, 'USD 10'],
				[{ d: OCT1 }, 'Rp 28.000,00']
			])
		);
		const { rows, out } = ok(book);
		expect(rows.map((r) => r.amountMinor)).toEqual([2_800_000]);
		expect(out.skips.amount_not_number).toBe(2);
		expect(out.skips.foreign_currency).toBe(1);
		expect(out.rows.find((r) => !r.ok && r.reason === 'unsupported_currency')).toBeTruthy();
	});
	it('an invalid date is skipped, not guessed', () => {
		const book = wb(
			grid(0, 'Pengeluaran', [
				['Tanggal', 'Jumlah'],
				['10/31/2026', 1000],
				[{ d: OCT1 }, 1000]
			])
		);
		expect(ok(book).out.skips.date_invalid).toBe(1);
	});
});

describe('row cap and keys', () => {
	it('rows past the cap are not processed; keys are tab * 2^20 + row number, stable across mappings', () => {
		const rows: In[][] = [['Tanggal', 'Keterangan', 'Pengeluaran']];
		for (let i = 0; i < 10; i++) rows.push([{ d: OCT1 }, `Baris ${i}`, 1000 + i]);
		const book = wb(grid(3, 'Pengeluaran', rows));
		const out = mapSheets(book, proposed(book), 4);
		expect(out.rows).toHaveLength(4);
		expect(out.notProcessed).toBe(6);
		expect(out.rows.map((r) => r.index)).toEqual([2, 3, 4, 5].map((r) => 3 * TAB_KEY_STRIDE + r));
		const other = proposed(book);
		other.tabs[0]!.columns = ['date', 'ignore', 'expense'];
		expect(mapSheets(book, other, 4).rows.map((r) => r.index)).toEqual(
			out.rows.map((r) => r.index)
		);
	});
});

describe('dedupe keys never collide across tabs (L2)', () => {
	it('the last Excel row of tab 0 and the first row of tab 1 get different keys', () => {
		expect(0 * TAB_KEY_STRIDE + SHEET_MAX_ROW).not.toBe(1 * TAB_KEY_STRIDE + 1);
		for (const tab of [0, 1, 7]) {
			const key = tab * TAB_KEY_STRIDE + SHEET_MAX_ROW;
			expect(Math.floor(key / TAB_KEY_STRIDE)).toBe(tab);
			expect(key % TAB_KEY_STRIDE).toBe(SHEET_MAX_ROW);
		}
	});

	it("mapSheets keys a row at Excel's last row to its own tab", () => {
		const book = wb(
			grid(0, 'A', [
				['Tanggal', 'Keterangan', 'Pengeluaran'],
				[{ d: OCT1 }, 'Satu', 1000]
			]),
			grid(1, 'B', [
				['Tanggal', 'Keterangan', 'Pengeluaran'],
				[{ d: OCT1 }, 'Dua', 2000]
			])
		);
		book.sheets[0]!.rows.push({ ...book.sheets[0]!.rows[1]!, r: SHEET_MAX_ROW });
		const keys = mapSheets(book, proposed(book), 100).rows.map((r) => r.index);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

describe('tabs that are not transactions (AC 12)', () => {
	it('budget and asset tables are skipped with their reason; a tab of dates and numbers without words is offered for mapping', () => {
		expect(
			proposeTab(
				grid(0, 'Anggaran', [
					['Kategori', 'Anggaran', 'Terpakai'],
					['Makan', 1000, 500]
				]),
				false
			)
		).toEqual({ skip: 'budget' });
		expect(
			proposeTab(
				grid(0, 'Kekayaan', [
					['Aset', 'Nilai'],
					['Rumah', 1000]
				]),
				false
			)
		).toEqual({ skip: 'assets' });
		expect(
			proposeTab(
				grid(0, 'X', [
					['a', 'b'],
					['c', 'd']
				]),
				false
			)
		).toEqual({ skip: 'no_data' });
		expect(proposeTab(grid(0, 'X', []), false)).toEqual({ skip: 'empty' });
		const unlabeled = proposeTab(
			grid(0, 'X', [
				['Kapan', 'Apa', 'Berapa'],
				[{ d: OCT1 }, 'Kopi', 1000]
			]),
			false
		);
		expect(unlabeled).toMatchObject({
			status: 'needs_mapping',
			fromHeader: false,
			mapping: { headerRow: 1, columns: ['date', 'title', 'amount'] }
		});
	});
	it('two different header readings tie: the picker is needed', () => {
		const p = proposeTab(
			grid(0, 'X', [
				['Tanggal', 'Jumlah'],
				['Date', 'Amount', 'Tanggal', 'Jumlah']
			]),
			false
		);
		expect(p).toMatchObject({ status: 'needs_mapping' });
	});
});
