import { describe, expect, it } from 'vitest';
import { FORMULA_VECTORS, MASKING_VECTORS as M } from '../../../../test/fixtures/export-vectors.ts';
import { exportLine } from '../../server/imports/csv-export.ts';
import { parseCsv, TEMPLATE_COLUMNS, type ExportRow } from '../csv.ts';
import { buildSheetsRows } from './sheets-export.ts';

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
	id: 'r1',
	type: 'expense',
	amountMinor: 2_800_000,
	currency: 'IDR',
	title: 'Kopi',
	note: null,
	occurredOn: '2026-10-31',
	occurredAt: 0,
	categoryName: 'Kopi',
	walletName: 'Tunai',
	paymentMethod: null,
	recurrence: null,
	tag: null,
	reference: null,
	...over
});

/** FN-18's own export line read back into cells (CSV quoting undone, the formula guard kept). */
function csvCells(r: ExportRow): string[] {
	const parsed = parseCsv(exportLine(r));
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.rows[0] as string[];
}

describe('buildSheetsRows', () => {
	it('starts with the template header row, then one row per transaction', () => {
		const rows = buildSheetsRows([row(), row({ id: 'r2', type: 'income' })]);
		expect(rows[0]).toEqual([...TEMPLATE_COLUMNS]);
		expect(rows).toHaveLength(3);
		expect(rows[1]).toEqual([
			'2026-10-31',
			'expense',
			'Kopi',
			'28000',
			'IDR',
			'Kopi',
			'',
			'',
			'',
			'',
			'Tunai',
			''
		]);
		expect(buildSheetsRows([])).toEqual([[...TEMPLATE_COLUMNS]]);
	});

	it("gives exactly FN-18's guarded cells for the shared formula-injection vectors (AC6)", () => {
		for (const v of FORMULA_VECTORS) {
			const r = row({ title: v, note: v, tag: v, reference: v, categoryName: v, walletName: v });
			const [, sheet] = buildSheetsRows([r]);
			expect(sheet).toEqual(csvCells(r));
		}
		const [, ...guarded] = buildSheetsRows(
			FORMULA_VECTORS.slice(0, 4).map((v) => row({ title: v, note: v }))
		);
		for (const cells of guarded) {
			expect(cells[2]).toMatch(/^'/);
			expect(cells[9]).toMatch(/^'/);
		}
	});

	it('guards fullwidth, leading-space, tab, CR and LF formula starts too (red team FN-18 L4)', () => {
		for (const v of ['＝1+1', '  @x', '\tx', '\rx', '\n=1', "'=x"]) {
			const r = row({ title: v });
			const [, sheet] = buildSheetsRows([r]);
			expect(sheet![2]!.startsWith("'")).toBe(true);
			expect(sheet).toEqual(csvCells(r));
		}
	});

	it("masks account and card numbers exactly as FN-18's export does (shared masking vectors)", () => {
		const r = row({
			paymentMethod: M.paymentMethod.input,
			walletName: M.walletName.input,
			reference: M.storedReference.input,
			tag: M.reference.input,
			recurrence: M.reference.input
		});
		const [, sheet] = buildSheetsRows([r]);
		expect(sheet).toEqual(csvCells(r));
		expect(sheet![6]).toBe(M.paymentMethod.masked);
		expect(sheet![10]).toBe(M.walletName.masked);
		expect(sheet![11]).toBe(M.storedReference.masked);
		expect(sheet![8]).toBe(M.reference.masked);
		expect(JSON.stringify(sheet)).not.toMatch(/\d{8}/);
	});

	it('keeps exact amounts (no float), sen only when present', () => {
		const [, a, b] = buildSheetsRows([
			row({ amountMinor: 2_800_050 }),
			row({ amountMinor: 1_000, currency: 'JPY' })
		]);
		expect(a![3]).toBe('28000.50');
		expect(b![3]).toBe('1000');
	});
});
