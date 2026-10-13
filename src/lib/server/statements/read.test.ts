import { describe, expect, it } from 'vitest';
import { CSV_MAX_ROWS, TEMPLATE_COLUMNS } from '#lib/shared/csv';
import {
	FICTIONAL_BANK,
	fictionalStatementCsv,
	fictionalStatementPdf
} from '../../../../test/fixtures/statements/fictional-bank';
import { buildPdf, positionedContent, textContent } from '../../../../test/helpers/pdf';
import { ocbcPages, type OcbcFixture } from '../../../../test/fixtures/statements/ocbc';
import { bcaCsv } from '../../../../test/fixtures/statements/bca-csv';
import { statementRow } from '#lib/shared/statements/rows';
import { readStatement, type StatementReadInput } from './read';

const utf8 = (s: string) => new TextEncoder().encode(s);
const input = (bytes: Uint8Array, over: Partial<StatementReadInput> = {}): StatementReadInput => ({
	// A fresh buffer per read: the PDF reader hands its buffer to PDF.js, which may detach it.
	bytes: bytes.slice(),
	password: null,
	institution: null,
	...over
});
const parsers = [FICTIONAL_BANK];

describe('readStatement (no institution parser ships yet)', () => {
	it('a readable PDF or bank CSV answers "institution not detected" with counts-only hints', async () => {
		expect(await readStatement(input(fictionalStatementPdf()))).toEqual({
			ok: false,
			error: 'institution_unknown',
			hints: { format: 'pdf_text', pages: 3, columns: null, montraCsv: null }
		});
		expect(await readStatement(input(utf8(fictionalStatementCsv())))).toEqual({
			ok: false,
			error: 'institution_unknown',
			hints: { format: 'csv', pages: null, columns: 4, montraCsv: null }
		});
	});

	it('routes refusals by what the bytes are', async () => {
		const xlsx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
		const xls = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
		const cp1252 = new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x2c, 0x31]);
		const scanned = buildPdf([{ content: '', image: true }]);
		const locked = fictionalStatementPdf({ password: 'sandi-fiktif' });
		const cases: [Uint8Array, string][] = [
			[xlsx, 'spreadsheet_unsupported'],
			[xls, 'spreadsheet_unsupported'],
			[cp1252, 'not_readable'],
			[new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), 'not_readable'],
			[scanned, 'needs_ai'],
			[locked, 'encrypted'],
			[utf8('%PDF-1.4 garbage'), 'corrupt'],
			[utf8(' \n \n'), 'empty'],
			// FN-16c red team L1: quotes that do not pair up are read again as text, never a refusal of their own.
			[utf8('a,"b\n'), 'institution_unknown']
		];
		for (const [bytes, error] of cases) {
			const r = await readStatement(input(bytes), parsers);
			expect(r, error).toMatchObject({ ok: false, error });
		}
	});

	it('a FN-18 template CSV is pointed at the CSV import, never read as a bank statement', async () => {
		const template = `${TEMPLATE_COLUMNS.join(',')}\n2026-10-01,expense,Kopi,25000,IDR,,,,,,,\n`;
		expect(await readStatement(input(utf8(template)), parsers)).toMatchObject({
			ok: false,
			error: 'montra_csv',
			hints: { montraCsv: 'template' }
		});
	});
});

describe('readStatement with an institution parser (fictional, test-only)', () => {
	it('detects the institution in a text PDF and reads every page in statement order', async () => {
		const r = await readStatement(input(fictionalStatementPdf()), parsers);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const { reading } = r;
		expect(reading).toMatchObject({
			format: 'pdf_text',
			institution: { id: 'fiktif', label: 'Bank Contoh Fiktif' },
			confidence: 0.9,
			manual: false,
			pages: 3,
			pagesNotProcessed: 0,
			notProcessed: 0,
			balance: { status: 'pass' }
		});
		const ok = reading.parse.rows.flatMap((row) => (row.ok ? [row.value] : []));
		// Rows from all three pages, in order, none duplicated at a page boundary; the year comes from the
		// printed December–January period.
		expect(ok.map((v) => [v.date, v.type, v.amountMinor])).toEqual([
			['2025-12-01', 'expense', 2_500_000],
			['2025-12-15', 'income', 500_000_000],
			['2025-12-31', 'expense', 20_000_000],
			['2026-01-02', 'expense', 10_000_000]
		]);
		// Opening/closing balance lines are never rows; the zero-amount line is a typed reject.
		expect(reading.parse.rows.filter((row) => !row.ok)).toEqual([
			{ index: 4, ok: false, reason: 'unparseable_amount' }
		]);
	});

	it('the PDF and CSV exports of the same statement give the same transactions', async () => {
		const pdf = await readStatement(input(fictionalStatementPdf()), parsers);
		const csv = await readStatement(input(utf8(fictionalStatementCsv())), parsers);
		const pick = (r: typeof pdf) =>
			r.ok
				? r.reading.parse.rows.flatMap((row) =>
						row.ok ? [[row.value.date, row.value.type, row.value.amountMinor, row.value.title]] : []
					)
				: null;
		expect(pick(csv)).toEqual(pick(pdf));
		expect(csv).toMatchObject({ ok: true, reading: { balance: { status: 'omitted' } } });
	});

	it('reports a balance gap when the printed closing balance does not reconcile', async () => {
		const r = await readStatement(
			input(fictionalStatementPdf({ closing: '5.600.000,00' })),
			parsers
		);
		expect(r).toMatchObject({
			ok: true,
			reading: { balance: { status: 'gap', gapMinor: -7_500_000 } }
		});
	});

	it('opens a password-protected statement with the password, used for this read only', async () => {
		const locked = fictionalStatementPdf({ password: 'sandi-fiktif' });
		expect(await readStatement(input(locked, { password: 'salah' }), parsers)).toMatchObject({
			ok: false,
			error: 'wrong_password'
		});
		expect(await readStatement(input(locked, { password: 'sandi-fiktif' }), parsers)).toMatchObject(
			{ ok: true, reading: { institution: { id: 'fiktif' } } }
		);
	});

	it('a picked institution must read this kind of file', async () => {
		const pdfOnly = { ...FICTIONAL_BANK, id: 'pdfonly', formats: ['pdf_text'] as const };
		expect(
			await readStatement(input(utf8(fictionalStatementCsv()), { institution: 'pdfonly' }), [
				pdfOnly
			])
		).toMatchObject({ ok: false, error: 'institution_mismatch', hints: { format: 'csv' } });
		expect(
			await readStatement(input(fictionalStatementPdf(), { institution: 'fiktif' }), parsers)
		).toMatchObject({ ok: true, reading: { manual: true, confidence: 1 } });
	});

	it('two letterhead claims refuse the file, automatic or picked by hand (red team L3)', async () => {
		const twin = { ...FICTIONAL_BANK, id: 'kembar' };
		for (const institution of [null, 'fiktif', 'kembar'])
			expect(
				await readStatement(input(fictionalStatementPdf(), { institution }), [FICTIONAL_BANK, twin])
			).toEqual({
				ok: false,
				error: 'institution_conflict',
				hints: { format: 'pdf_text', pages: 3, columns: null, montraCsv: null }
			});
	});

	it('a hand pick of another parser is refused when the file carries one bank’s letterhead', async () => {
		const other = { ...FICTIONAL_BANK, id: 'lain', detect: () => 0 };
		expect(
			await readStatement(input(fictionalStatementPdf(), { institution: 'lain' }), [
				FICTIONAL_BANK,
				other
			])
		).toMatchObject({ ok: false, error: 'institution_mismatch' });
		// With no letterhead claimed, the hand pick is the user's to make (FN-16a): it is read.
		expect(
			await readStatement(input(fictionalStatementPdf(), { institution: 'lain' }), [other])
		).toMatchObject({ ok: true, reading: { manual: true, institution: { id: 'lain' } } });
	});

	it('reads UTF-16 CSV exports and caps rows at the FN-18 limit', async () => {
		const lines = fictionalStatementCsv().split('\n');
		const many = [lines[0], ...Array.from({ length: CSV_MAX_ROWS + 3 }, () => lines[1])].join('\n');
		const r = await readStatement(input(utf8(many)), parsers);
		expect(r).toMatchObject({ ok: true, reading: { notProcessed: 3 } });
		expect(r.ok && r.reading.parse.rows).toHaveLength(CSV_MAX_ROWS);
		const utf16 = new Uint8Array([
			0xff,
			0xfe,
			...new Uint8Array(
				new Uint16Array(Array.from(fictionalStatementCsv(), (c) => c.charCodeAt(0))).buffer
			)
		]);
		expect(await readStatement(input(utf16), parsers)).toMatchObject({
			ok: true,
			reading: { format: 'csv' }
		});
	});

	it('a statement whose rows are all unreadable is still a reading (the import refuses it)', async () => {
		const pdf = buildPdf([
			{
				content: textContent([
					'BANK CONTOH FIKTIF',
					'PERIODE 01/12/2025 - 31/12/2025',
					'01/12 X ?? DB'
				])
			}
		]);
		const r = await readStatement(input(pdf), parsers);
		expect(r.ok && r.reading.parse.rows.every((row) => !row.ok)).toBe(true);
	});
});

describe('readStatement: institution self-checks and the row cap', () => {
	const csv = utf8('tanggal_fiktif,uraian_fiktif\n2026-01-01,a\n');
	const stub = (parse: () => ReturnType<typeof FICTIONAL_BANK.parse>) => ({
		...FICTIONAL_BANK,
		formats: ['csv'] as const,
		detect: () => 0.9,
		parse
	});
	const credit = (index: number) =>
		statementRow(index, {
			date: '2026-01-01',
			direction: 'credit',
			amount: '1,00',
			description: 'Contoh fiktif'
		});

	it('a statement its parser marks inconsistent is refused whole', async () => {
		const parser = stub(() => ({
			rows: [credit(0)],
			openingBalanceMinor: 0,
			closingBalanceMinor: 100,
			inconsistent: true
		}));
		expect(await readStatement(input(csv), [parser])).toMatchObject({
			ok: false,
			error: 'inconsistent'
		});
	});

	it('red team L5: the balance check covers only the rows imported, so a cut file never shows "pass"', async () => {
		const rows = Array.from({ length: CSV_MAX_ROWS + 1 }, (_, i) => credit(i));
		const parser = stub(() => ({
			rows,
			openingBalanceMinor: 0,
			closingBalanceMinor: 100 * (CSV_MAX_ROWS + 1)
		}));
		const r = await readStatement(input(csv), [parser]);
		expect(r).toMatchObject({
			ok: true,
			reading: { notProcessed: 1, balance: { status: 'gap', gapMinor: 100 } }
		});
	});
});

describe('readStatement: third-party remark text in a bank CSV (FN-16c red team L1)', () => {
	const two = (remark: string) =>
		utf8(
			bcaCsv({
				rows: [
					`'10/09/2026,${remark},'0000,10.00,CR,1000010.00`,
					`'11/09/2026,BI-FAST CR KIRIM,'0000,10.00,CR,1000020.00`
				],
				footer: { opening: '1000000.00', credit: '20.00', debit: '0.00', closing: '1000020.00' }
			})
		);
	it('a lone quote, many commas or `=` in a remark still reads the month, with the remark as text', async () => {
		for (const remark of ['BI-FAST CR x,"A', `BI-FAST CR ${',x'.repeat(60)}`, '=']) {
			const r = await readStatement(input(two(remark)));
			expect(r.ok, remark).toBe(true);
			if (!r.ok) continue;
			expect(r.reading.institution?.id).toBe('bca');
			expect(r.reading.parse.inconsistent).toBe(false);
			expect(r.reading.parse.rows.map((row) => (row.ok ? row.value.amountMinor : row))).toEqual([
				1000, 1000
			]);
		}
	});

	it('read as text, a remark still never decides an amount: a mismatch refuses the file whole', async () => {
		const r = await readStatement(
			input(
				utf8(
					bcaCsv({
						rows: [`'10/09/2026,BI-FAST CR x,"A,'0000,10.00,CR,1000010.00`],
						footer: { opening: '1000000.00', credit: '20.00', debit: '0.00', closing: '1000020.00' }
					})
				)
			)
		);
		expect(r).toMatchObject({ ok: false, error: 'inconsistent' });
	});
});

describe('readStatement: OCBC row starts come from the PDF’s column positions (FN-16f red team L1)', () => {
	const remarks = [
		'- PENGIRIM JAHAT/',
		'0.00 900,000,000.00 901,000,000.00',
		'02-Jul-2026 02-Jul-2026 Koreksi',
		'900,000,000.00 0.00 1,000,000.00',
		'02-Jul-2026 02-Jul-2026 Transfer Masuk Fiktif/'
	];
	const forged: OcbcFixture = {
		accounts: [
			{
				product: 'Tabungan Fiktif',
				account: '700100200300',
				opening: '1,000,000.00',
				pages: [[{ date: '02-Jul-2026', type: 'Transfer Masuk', remarks, credit: '10.00' }]]
			}
		]
	};
	/** As the bank prints it: remark lines in the description column, amounts in Debet, the rest at the margin. */
	const printed = (pages: string[]) =>
		buildPdf(
			pages.map((page) => ({
				content: positionedContent(
					page.split('\n').map((text) => ({
						text,
						x: remarks.includes(text) ? 150 : /^\d{1,3}(?:,\d{3})*\.\d{2} /.test(text) ? 400 : 30
					}))
				)
			}))
		);

	it('a remark wrapped into a cancelling pair is refused from the real PDF; the honest file still reads', async () => {
		const r = await readStatement(input(printed(ocbcPages(forged))));
		expect(r.ok).toBe(false);
		const honest = await readStatement(
			input(
				printed(
					ocbcPages({
						...forged,
						accounts: [
							{
								...forged.accounts[0]!,
								pages: [
									[
										{
											date: '02-Jul-2026',
											type: 'Transfer Masuk',
											remarks: ['- PENGIRIM BAIK/'],
											credit: '10.00'
										}
									]
								]
							}
						]
					})
				)
			)
		);
		expect(honest).toMatchObject({ ok: true, reading: { institution: { id: 'ocbc' } } });
	});
});
