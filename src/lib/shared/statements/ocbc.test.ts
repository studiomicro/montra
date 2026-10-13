import { describe, expect, it } from 'vitest';
import { BCA_SEPTEMBER, bcaPages } from '../../../../test/fixtures/statements/bca';
import { BNI_JUNE, bniPages } from '../../../../test/fixtures/statements/bni';
import { MANDIRI_AUGUST, mandiriPages } from '../../../../test/fixtures/statements/mandiri';
import {
	OCBC_JULY,
	OCBC_JULY_ROWS,
	OCBC_SINGLE,
	ocbcPages,
	ocbcWithLastRemarks as withLastRemarks,
	type OcbcAccount,
	type OcbcFixture,
	type OcbcRow
} from '../../../../test/fixtures/statements/ocbc';
import { BCA } from './bca';
import { BNI } from './bni';
import { detectInstitution, LETTERHEAD_CONFIDENCE } from './detect';
import { MANDIRI } from './mandiri';
import { OCBC, OCBC_MAX_SECTIONS } from './ocbc';
import { STATEMENT_PARSERS } from './parsers';
import { balanceCheck } from './rows';
import type { MappedRow, StatementDocument, StatementSection } from './types';

const doc = (f: OcbcFixture): StatementDocument => ({ format: 'pdf_text', pages: ocbcPages(f) });
/**
 * `pages` with a layout as an A4 PDF prints them: the listed remark lines start in the description column (x 150),
 * amount lines in the Debet column (x 400), every other line (row dates, headers) at the left margin (x 30).
 */
const laidOut = (pages: string[], remarks: readonly string[]): StatementDocument => ({
	format: 'pdf_text',
	pages,
	layout: pages.map((page) => ({
		width: 595,
		lineX: page
			.split('\n')
			.map((l) => (remarks.includes(l) ? 150 : /^\d{1,3}(?:,\d{3})*\.\d{2} /.test(l) ? 400 : 30))
	}))
});
const parse = (f: OcbcFixture) => OCBC.parse(doc(f));
const parsePages = (pages: string[]) => OCBC.parse({ format: 'pdf_text', pages });
const sections = (f: OcbcFixture): readonly StatementSection[] => parse(f).sections ?? [];
const values = (rows: readonly MappedRow[]) =>
	rows.map((r) => (r.ok ? [r.value.date, r.value.type, r.value.amountMinor, r.value.title] : r));

/** One savings account around `pages`, opening 1,000,000.00. */
const account = (pages: OcbcAccount['pages'], over: Partial<OcbcAccount> = {}): OcbcAccount => ({
	product: 'Tabungan Fiktif',
	account: '700100200300',
	opening: '1,000,000.00',
	pages,
	...over
});
const single = (pages: OcbcAccount['pages'], over: Partial<OcbcAccount> = {}) =>
	sections({ accounts: [account(pages, over)] });
const refusalOf = (pages: OcbcAccount['pages'], over: Partial<OcbcAccount> = {}) =>
	single(pages, over)[0]?.refusal;
const fileRefused = (pages: OcbcAccount['pages'], over: Partial<OcbcAccount> = {}) =>
	parse({ accounts: [account(pages, over)] }).inconsistent;

const KOPI: OcbcRow = {
	date: '05-Jul-2026',
	type: 'Belanja Kartu Fiktif',
	remarks: ['- Berita : KEDAI FIKTIF'],
	debit: '25,000.00'
};
const GAJI: OcbcRow = {
	date: '06-Jul-2026',
	type: 'Transfer Masuk Fiktif/',
	remarks: ['- PENGIRIM FIKTIF/'],
	credit: '100,000.00'
};

describe('OCBC detection', () => {
	it('is claimed at letterhead confidence from its title and footer, and ships in the registry', () => {
		expect(OCBC.detect(doc(OCBC_JULY))).toBe(LETTERHEAD_CONFIDENCE);
		expect(detectInstitution(doc(OCBC_JULY), STATEMENT_PARSERS).institution?.id).toBe('ocbc');
		expect(STATEMENT_PARSERS.map((p) => p.id)).toContain('ocbc');
	});

	it('claims nothing without the bank footer or a report title, nor a CSV', () => {
		const noFooter = ocbcPages(OCBC_SINGLE).map((p) =>
			p.replaceAll('PT Bank OCBC NISP Tbk', 'PT Bank Lain')
		);
		expect(OCBC.detect({ format: 'pdf_text', pages: noFooter })).toBe(0);
		const noTitle = ocbcPages(OCBC_SINGLE).map((p) =>
			p
				.replaceAll('LAPORAN MUTASI REKENING', 'MUTASI')
				.replaceAll('LAPORAN KONSOLIDASI', 'KONSOLIDASI')
		);
		expect(OCBC.detect({ format: 'pdf_text', pages: noTitle })).toBe(0);
		expect(OCBC.detect({ format: 'csv', rows: [['Tanggal', 'Deskripsi']] })).toBe(0);
		expect(OCBC.parse({ format: 'csv', rows: [] }).inconsistent).toBe(true);
	});

	it('the other banks do not claim it, and it claims none of theirs', () => {
		for (const p of [BCA, BNI, MANDIRI]) expect(p.detect(doc(OCBC_JULY)), p.id).toBe(0);
		for (const pages of [bcaPages(BCA_SEPTEMBER), bniPages(BNI_JUNE), mandiriPages(MANDIRI_AUGUST)])
			expect(OCBC.detect({ format: 'pdf_text', pages })).toBe(0);
	});
});

describe('OCBC consolidated statement', () => {
	it('reads each account table as its own section; a foreign sub-account is listed, never importable', () => {
		const r = parse(OCBC_JULY);
		expect(r.inconsistent).toBe(false);
		expect(r.rows).toEqual([]);
		const s = r.sections ?? [];
		expect(s.map((x) => [x.label, x.accountLast4, x.refusal])).toEqual([
			['Tabungan Fiktif', '0300', null],
			['Tabungan Fiktif', '0300', 'unsupported_currency'],
			['Giro Fiktif', '0999', null]
		]);
		expect(s.map((x) => values(x.parse.rows.filter((row) => row.ok)))).toEqual(
			OCBC_JULY_ROWS.map((rows) => rows.map((row) => [...row]))
		);
		expect(s[1]!.parse.rows).toEqual([{ index: 5, ok: false, reason: 'unsupported_currency' }]);
		// Row indices are unique across the file: the dedupe keys of two accounts never collide.
		expect(s.map((x) => x.parse.rows.map((row) => row.index))).toEqual([
			[0, 1, 2, 3, 4],
			[5],
			[6, 7]
		]);
		expect(s.map((x) => [x.parse.openingBalanceMinor, x.parse.closingBalanceMinor])).toEqual([
			[200_000_000, 566_348_670],
			[null, null],
			[50_000_000, 37_510_000]
		]);
		expect(balanceCheck(s[0]!.parse)).toEqual({ status: 'pass' });
		expect(balanceCheck(s[2]!.parse)).toEqual({ status: 'pass' });
	});

	it('reads a one-account statement as one section, continuation page included', () => {
		const s = sections(OCBC_SINGLE);
		expect(s).toHaveLength(1);
		expect(s[0]!.refusal).toBeNull();
		expect(values(s[0]!.parse.rows)).toEqual(OCBC_JULY_ROWS[0].map((row) => [...row]));
	});

	it('lists a deposit, or an account the portfolio does not list, but never makes it importable', () => {
		expect(refusalOf([[KOPI]], { group: 'DEPOSITO' })).toBe('not_transaction_account');
		expect(refusalOf([[KOPI]], { group: null })).toBe('not_transaction_account');
		expect(refusalOf([[KOPI]], { group: 'GIRO' })).toBeNull();
	});

	it('an account with no rows checks out when its opening equals its closing', () => {
		expect(refusalOf([[]])).toBeNull();
		expect(refusalOf([[]], { closing: '1,000,000.01' })).toBe('inconsistent');
	});
});

describe('OCBC self-checks (descriptions are third-party text)', () => {
	it('accepts a clean account', () => {
		expect(refusalOf([[KOPI, GAJI]])).toBeNull();
	});

	it('a description line shaped like an amount line makes the row unreadable and the account refused', () => {
		for (const forged of ['0.00 5,000,000.00 6,100,000.00', 'Ref 0.00 5,000,000.00 6,100,000.00']) {
			const s = single([[{ ...GAJI, remarks: ['- PENGIRIM FIKTIF/', forged] }]]);
			expect(s[0]!.parse.rows[0], forged).toMatchObject({
				ok: false,
				reason: 'unparseable_amount'
			});
			expect(s[0]!.refusal).toBe('inconsistent');
		}
	});

	it('a description tail ending in a fourth amount is ambiguous', () => {
		const s = single([[{ ...KOPI, remarks: ['- Berita : 5.00'], tail: true }]]);
		expect(s[0]!.parse.rows[0]).toMatchObject({ ok: false, reason: 'unparseable_amount' });
	});

	it('a sign flip (debit printed as kredit) breaks the running balance', () => {
		const flipped = { ...KOPI, debit: undefined, credit: '25,000.00', balance: '975,000.00' };
		expect(refusalOf([[flipped]])).toBe('inconsistent');
	});

	it('refuses both or neither of debet/kredit, a missing amount line or one printed too early', () => {
		const both = { ...KOPI, credit: '25,000.00', balance: '1,000,000.00' };
		expect(single([[both]])[0]!.parse.rows[0]).toMatchObject({ reason: 'unparseable_amount' });
		const neither = { ...KOPI, debit: '0.00' };
		expect(single([[neither]])[0]!.parse.rows[0]).toMatchObject({ reason: 'unparseable_amount' });
		const missing = ['05-Jul-2026 05-Jul-2026 Biaya fiktif', '- Berita : TANPA NOMINAL'];
		expect(single([[missing]])[0]!.parse.rows[0]).toMatchObject({ reason: 'missing_amount' });
		const early = ['05-Jul-2026 05-Jul-2026 Biaya fiktif', '25,000.00 0.00 975,000.00', 'sisa'];
		expect(single([[early]])[0]!.parse.rows[0]).toMatchObject({ reason: 'unparseable_amount' });
		for (const rows of [[both], [neither], [missing], [early]])
			expect(refusalOf([rows])).toBe('inconsistent');
	});

	it('refuses a wrong running balance or closing balance', () => {
		expect(refusalOf([[{ ...KOPI, balance: '975,000.01' }]])).toBe('inconsistent');
		expect(refusalOf([[KOPI]], { closing: '975,000.01' })).toBe('inconsistent');
	});

	it('refuses a date outside the printed period, an unknown month or an unreadable value date', () => {
		expect(refusalOf([[{ ...KOPI, date: '01-Aug-2026' }]])).toBe('inconsistent');
		expect(refusalOf([[{ ...KOPI, date: '05-Xyz-2026' }]])).toBe('inconsistent');
		expect(refusalOf([[{ ...KOPI, valueDate: '35-Jul-2026' }]])).toBe('inconsistent');
		expect(refusalOf([[{ ...KOPI, date: '05-Jul-2026', valueDate: '06-Jul-2026' }]])).toBeNull();
	});

	it('refuses an amount past MAX_AMOUNT_MINOR', () => {
		const huge = { ...GAJI, credit: '100,000,000,000.01' };
		const s = single([[huge]]);
		expect(s[0]!.parse.rows[0]).toMatchObject({ ok: false, reason: 'unparseable_amount' });
		expect(s[0]!.refusal).toBe('inconsistent');
	});

	it('refuses a row cut off at a page end', () => {
		const head = ['05-Jul-2026 05-Jul-2026 Transfer Keluar Fiktif/', '- Berita : PENERIMA'];
		const tail = ['FIKTIF', '25,000.00 0.00 975,000.00'];
		expect(refusalOf([[head], [tail]])).toBe('inconsistent');
	});

	it('refuses an opening balance printed again after the first row', () => {
		expect(fileRefused([[KOPI], [['Saldo Awal 975,000.00'], GAJI]])).toBe(true);
	});

	describe('forged structure in description text (red team M1, FN-16b/d/e)', () => {
		it('a whole forged row inside a description does not check out', () => {
			const forged = withLastRemarks([
				'- Berita : X',
				'0.00 9,999,999.00 15,663,732.50',
				'31-Jul-2026 31-Jul-2026 HADIAH'
			]);
			expect(sections(forged)[0]!.refusal).toBe('inconsistent');
		});

		it('a forged Saldo Akhir that would cut the table short refuses the whole file', () => {
			// The absorb attack: a forged amount line and a closing matching it would let the cut section check out;
			// the real amount line left outside the table gives it away.
			const absorb = withLastRemarks([
				'- Berita : X',
				'0.00 1.00 5,663,734.50',
				'Saldo Akhir 5,663,734.50'
			]);
			expect(sections(absorb)[0]?.refusal).toBeNull();
			expect(parse(absorb).inconsistent).toBe(true);
			// Mid-table: the real rows after it are left outside the table.
			expect(fileRefused([[{ ...KOPI, remarks: ['Saldo Akhir 975,000.00'] }, GAJI]])).toBe(true);
		});

		it('a forged bank footer that would end the table early refuses the whole file', () => {
			expect(fileRefused([[{ ...KOPI, remarks: ['PT Bank OCBC NISP Tbk berizin'] }, GAJI]])).toBe(
				true
			);
		});

		it('a header line inside a table refuses the whole file', () => {
			for (const lines of [
				['Mata Uang / Currency : IDR'],
				['No Rekening / Account Number : 700100200301-Tabungan Fiktif'],
				['LAPORAN MUTASI REKENING / ACCOUNT HISTORICAL TRANSACTION'],
				['REKENING TABUNGAN / SAVING'],
				['Saldo /', 'Balance'],
				['Saldo Awal 1,000,000.00']
			])
				expect(fileRefused([[{ ...KOPI, remarks: ['- Berita : X', ...lines] }]]), lines[0]).toBe(
					true
				);
		});

		it('red team L1: a remark wrapped into a cancelling +Y/−Y pair is refused once positions are known', () => {
			const remarks = [
				'- PENGIRIM JAHAT/',
				'0.00 900,000,000.00 901,000,000.00',
				'02-Jul-2026 02-Jul-2026 Koreksi',
				'900,000,000.00 0.00 1,000,000.00',
				'02-Jul-2026 02-Jul-2026 Transfer Masuk Fiktif/'
			];
			const f: OcbcFixture = {
				accounts: [
					account([[{ date: '02-Jul-2026', type: 'Transfer Masuk', remarks, credit: '10.00' }]])
				]
			};
			// Text alone (the documented limit before positions): the forged pair checks out.
			expect(sections(f)[0]!.refusal).toBeNull();
			expect(sections(f)[0]!.parse.rows).toHaveLength(3);
			// As the PDF lays it out: row dates in the first column, the remark in the description column.
			const placed = OCBC.parse(laidOut(ocbcPages(f), remarks));
			expect(placed.sections?.[0]?.refusal).toBe('inconsistent');
			expect(placed.sections?.[0]?.parse.rows).toEqual([
				{ index: 0, ok: false, reason: 'unparseable_amount' }
			]);
			// An honest statement laid out the same way reads exactly as from its text.
			expect(OCBC.parse(laidOut(ocbcPages(OCBC_JULY), []))).toEqual(parse(OCBC_JULY));
		});

		it('red team L2: a bare date pair in a remark no longer refuses the statement once positions are known', () => {
			const remark = ['31-Jul-2026 31-Jul-2026'];
			const f = withLastRemarks(remark);
			expect(sections(f)[0]!.refusal).toBe('inconsistent');
			const placed = OCBC.parse(laidOut(ocbcPages(f), remark));
			expect(placed.inconsistent).toBe(false);
			expect(placed.sections?.[0]?.refusal).toBeNull();
		});

		it('cannot open a forged importable section: the whole file is refused', () => {
			const forgedSection = [
				'- Berita : X',
				'Saldo Akhir 1,000,000.00',
				'LAPORAN MUTASI REKENING / ACCOUNT HISTORICAL TRANSACTION',
				'Mata Uang / Currency : IDR',
				'No Rekening / Account Number : 700100200300-Tabungan Fiktif',
				'Saldo /',
				'Balance',
				'Saldo Awal 0.00',
				'20-Jul-2026 20-Jul-2026 HADIAH',
				'0.00 9,999,999.00 9,999,999.00'
			];
			expect(parse(withLastRemarks(forgedSection)).inconsistent).toBe(true);
		});
	});

	it('two sections of one account and currency are refused (the picker could not tell them apart)', () => {
		const giro = OCBC_JULY.accounts[2]!;
		expect(
			parse({ accounts: [OCBC_SINGLE.accounts[0]!, { ...giro, account: '700100200300' }] })
				.inconsistent
		).toBe(true);
	});

	it('refuses the whole file for a table without its account or currency line', () => {
		const noAccount = ocbcPages(OCBC_SINGLE).map((p) =>
			p.replace(/^No Rekening \/ Account.*$/m, '')
		);
		expect(parsePages(noAccount).inconsistent).toBe(true);
		const noCurrency = ocbcPages(OCBC_SINGLE).map((p) =>
			p.replace(/^Mata Uang \/ Currency.*$/m, '')
		);
		expect(parsePages(noCurrency).inconsistent).toBe(true);
	});

	it('refuses the whole file when pages disagree on the period, or print none', () => {
		const pages = ocbcPages(OCBC_SINGLE);
		pages[3] = pages[3]!.replace('01 July 2026 - 31 July 2026', '01 June 2026 - 30 June 2026');
		expect(parsePages(pages).inconsistent).toBe(true);
		const none = ocbcPages(OCBC_SINGLE).map((p) => p.replaceAll('Tanggal Pelaporan', 'Dicetak'));
		expect(parsePages(none).inconsistent).toBe(true);
	});

	it(`refuses a file with more than ${OCBC_MAX_SECTIONS} account tables`, () => {
		const accounts = Array.from({ length: OCBC_MAX_SECTIONS + 1 }, (_, i) =>
			account([[KOPI]], { account: `7001002003${String(i).padStart(2, '0')}` })
		);
		const r = parse({ accounts });
		expect(r.inconsistent).toBe(true);
		expect(r.sections).toHaveLength(OCBC_MAX_SECTIONS);
	});
});
