import { describe, expect, it } from 'vitest';
import {
	RK_JULY,
	RK_JULY_ROWS,
	rkPages,
	rkWithAfter,
	type RkFixture,
	type RkItem
} from '../../../../test/fixtures/statements/ocbc-rekening-koran';
import { OCBC_SINGLE, ocbcPages } from '../../../../test/fixtures/statements/ocbc';
import { detectInstitution, LETTERHEAD_CONFIDENCE } from './detect';
import { OCBC, OCBC_MAX_SECTIONS } from './ocbc';
import { STATEMENT_PARSERS } from './parsers';
import { balanceCheck } from './rows';
import type { MappedRow, StatementDocument, StatementSection } from './types';

const doc = (f: RkFixture): StatementDocument => ({ format: 'pdf_text', pages: rkPages(f) });
const parse = (f: RkFixture) => OCBC.parse(doc(f));
const sections = (f: RkFixture): readonly StatementSection[] => parse(f).sections ?? [];
const idr = (f: RkFixture) => sections(f)[0]!;
const values = (rows: readonly MappedRow[]) =>
	rows.map((r) => (r.ok ? [r.value.date, r.value.type, r.value.amountMinor, r.value.title] : r));
const pagesWith = (edit: (page: string, i: number) => string) => ({
	format: 'pdf_text' as const,
	pages: rkPages(RK_JULY).map(edit)
});

/** RK_JULY with raw lines inserted after the first page's first row (its note). */
const withLinesAfterFirstRow = (lines: readonly string[]): RkFixture => {
	const pages = RK_JULY.pages.map((p) => [...p]);
	pages[0]!.splice(2, 0, lines as RkItem);
	return { ...RK_JULY, pages };
};

describe('OCBC Rekening Koran detection (FN-16h)', () => {
	it('is claimed at letterhead confidence and auto-detected as OCBC (the bug report: institution_unknown)', () => {
		expect(OCBC.detect(doc(RK_JULY))).toBe(LETTERHEAD_CONFIDENCE);
		expect(detectInstitution(doc(RK_JULY), STATEMENT_PARSERS).institution?.id).toBe('ocbc');
	});

	it('claims nothing without the bank line, the title, the branch or the account label', () => {
		expect(OCBC.detect(doc({ ...RK_JULY, noFooter: true }))).toBe(0);
		for (const [from, to] of [
			[' REKENING KORAN\n', ' MUTASI\n'],
			['CABANG / BRANCH :', 'CABANG :'],
			['NOMOR REKENING /\n', 'NOMOR /\n']
		] as const)
			expect(OCBC.detect(pagesWith((p) => p.replaceAll(from, to)))).toBe(0);
		// The bank line printed letter-spaced (legal text) is no anchor.
		expect(
			OCBC.detect(
				pagesWith((p) =>
					p.replaceAll('PT. Bank OCBC NISP Tbk', 'P T . B a n k O C B C N I S P T b k')
				)
			)
		).toBe(0);
	});

	it('a file with both OCBC layouts’ marks claims nothing and is refused', () => {
		const mixed = {
			format: 'pdf_text' as const,
			pages: [...ocbcPages(OCBC_SINGLE), ...rkPages(RK_JULY)]
		};
		expect(OCBC.detect(mixed)).toBe(0);
		expect(OCBC.parse(mixed).inconsistent).toBe(true);
	});

	it('the Konsolidasi layout is still claimed and read by its own path', () => {
		const konsolidasi: StatementDocument = { format: 'pdf_text', pages: ocbcPages(OCBC_SINGLE) };
		expect(OCBC.detect(konsolidasi)).toBe(LETTERHEAD_CONFIDENCE);
		expect(OCBC.parse(konsolidasi).sections?.[0]?.refusal).toBeNull();
	});
});

describe('OCBC Rekening Koran reading (FN-16h)', () => {
	it('reads one section per currency of the one account; IDR importable, SGD listed only (the bug report: inconsistent)', () => {
		const parsed = parse(RK_JULY);
		expect(parsed.inconsistent).toBe(false);
		const [rupiah, sgd] = parsed.sections!;
		expect(parsed.sections).toHaveLength(2);
		expect(rupiah).toMatchObject({
			label: 'Tabungan Fiktif IDR',
			accountLast4: '0300',
			refusal: null,
			parse: {
				openingBalanceMinor: 500_000_000,
				closingBalanceMinor: 697_500_000,
				inconsistent: false
			}
		});
		expect(values(rupiah!.parse.rows)).toEqual(RK_JULY_ROWS);
		expect(balanceCheck(rupiah!.parse)).toEqual({ status: 'pass' });
		expect(sgd).toMatchObject({
			label: 'Tabungan Fiktif SGD',
			accountLast4: '0300',
			refusal: 'unsupported_currency',
			parse: { openingBalanceMinor: null, closingBalanceMinor: null }
		});
		expect(sgd!.parse.rows).toEqual([{ index: 6, ok: false, reason: 'unsupported_currency' }]);
		// One running index over the whole file: dedupe keys never collide between sections.
		const indices = parsed.sections!.flatMap((s) => s.parse.rows.map((r) => r.index));
		expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	it('reads slash dates day first, never month first', () => {
		const swapped = rkWithAfter(0, 1, ['Berita : PENERIMA FIKTIF/-'], { date: '07/13/2026' });
		expect(idr(swapped).parse.rows[0]).toEqual({ index: 0, ok: false, reason: 'unparseable_date' });
		expect(idr(swapped).refusal).toBe('inconsistent');
	});

	it('a currency closes on its own-currency summary balance, never the IDR column or the rate', () => {
		// SGD closes on 0.50 while its IDR column prints 6,000.00: the file checks out only on the own-currency figure.
		expect(parse(RK_JULY).inconsistent).toBe(false);
		const rerated = rkPages(RK_JULY).map((p) =>
			p.replace('SGD 12,000.000 0.50 6,000.00', 'SGD 99,999.999 0.50 6,000.00')
		);
		const reread = OCBC.parse({ format: 'pdf_text', pages: rerated });
		expect(reread.inconsistent).toBe(false);
		expect(reread.sections).toEqual(parse(RK_JULY).sections);
		// The SGD own-currency balance off by one: its block no longer checks out, the file is refused.
		expect(
			OCBC.parse(
				pagesWith((p) => p.replace('SGD 12,000.000 0.50 6,000.00', 'SGD 12,000.000 0.51 6,000.00'))
			).inconsistent
		).toBe(true);
	});

	it('an account with no rows checks out when its summary balance equals its opening', () => {
		const empty: RkFixture = { pages: [[{ currency: 'IDR', opening: '1,000.00' }]] };
		expect(idr(empty)).toMatchObject({
			refusal: null,
			parse: { rows: [], openingBalanceMinor: 100_000, closingBalanceMinor: 100_000 }
		});
	});
});

describe('OCBC Rekening Koran self-checks (notes are third-party text)', () => {
	it('refuses the whole file when the summary total is not its IDR column', () => {
		expect(parse({ ...RK_JULY, total: '6,981,000.01' }).inconsistent).toBe(true);
	});

	it('refuses the whole file when the summary misses a currency, adds one, or misprints IDR', () => {
		// Each summary's total equals its own IDR column, so only the named defect refuses it.
		for (const [summaryRows, total] of [
			[['IDR 1.000 6,975,000.00 6,975,000.00'], '6,975,000.00'],
			[
				[
					'IDR 1.000 6,975,000.00 6,975,000.00',
					'SGD 12,000.000 0.50 6,000.00',
					'USD 1.000 0.00 0.00'
				],
				'6,981,000.00'
			],
			[
				[
					'IDR 1.000 6,975,000.00 6,975,000.00',
					'SGD 12,000.000 0.50 6,000.00',
					'SGD 12,000.000 0.50 6,000.00'
				],
				'6,987,000.00'
			],
			[['IDR 1.500 6,975,000.00 6,975,000.00', 'SGD 12,000.000 0.50 6,000.00'], '6,981,000.00'],
			[['IDR 1.000 6,975,000.00 6,975,000.01', 'SGD 12,000.000 0.50 6,000.00'], '6,981,000.01']
		] as const)
			expect(parse({ ...RK_JULY, summaryRows, total }).inconsistent).toBe(true);
		expect(parse({ ...RK_JULY, total: undefined, summaryRows: [] }).inconsistent).toBe(true);
	});

	it('refuses a wrong running balance by one unit, or a wrong closing balance', () => {
		expect(idr(rkWithAfter(0, 2, ['Berita : X'], { balance: '3,849,999.99' })).refusal).toBe(
			'inconsistent'
		);
		const closing = {
			...RK_JULY,
			summaryRows: ['IDR 1.000 6,975,000.01 6,975,000.01', 'SGD 12,000.000 0.50 6,000.00'],
			total: '6,981,000.01'
		};
		expect(parse(closing).inconsistent).toBe(false);
		expect(idr(closing).refusal).toBe('inconsistent');
	});

	it('refuses both or neither of debet/kredit and an amount past MAX_AMOUNT_MINOR', () => {
		expect(idr(rkWithAfter(0, 1, [], { credit: '1.00' })).refusal).toBe('inconsistent');
		expect(idr(rkWithAfter(0, 1, [], { debit: '0.00' })).refusal).toBe('inconsistent');
		expect(
			idr(rkWithAfter(0, 1, [], { debit: '999,999,999,999,999.00', balance: '1.00' })).parse.rows[0]
		).toMatchObject({ ok: false, reason: 'unparseable_amount' });
	});

	it('a note line shaped like an amount line, after or before the real one, makes the row unreadable', () => {
		const after = rkWithAfter(0, 2, ['Berita : TOKO', '1.00 0.00 3,849,999.00']);
		expect(idr(after).parse.rows[1]).toEqual({ index: 1, ok: false, reason: 'unparseable_amount' });
		expect(idr(after).refusal).toBe('inconsistent');
		const before = rkWithAfter(0, 2, ['Berita : TOKO'], { wrap: ['1.00 0.00 3,849,999.00'] });
		expect(idr(before).parse.rows[1]).toEqual({
			index: 1,
			ok: false,
			reason: 'unparseable_amount'
		});
		// A description tail ending in a fourth amount is ambiguous.
		const tail = rkWithAfter(0, 2, [], { type: 'Pos Sales Debit 5.00' });
		expect(idr(tail).parse.rows[1]).toMatchObject({ ok: false, reason: 'unparseable_amount' });
	});

	describe('forged structure in a row’s note (red team M1, FN-16b/e/f)', () => {
		it.each([
			['a Beginning Balance', ['Beginning Balance 9,999,999.00']],
			['a duplicate IDR block', ['Currency Code : IDR', 'Beginning Balance 4,000,000.00']],
			['a new currency block', ['Currency Code : USD', 'Beginning Balance 4,000,000.00']],
			['a currency code alone', ['Currency Code : USD']],
			['a table header', ['SALDO /', 'BALANCE']],
			['the legal text', ['BILAMANA DALAM 14 HARI KALENDER TEKS PALSU']],
			['a page title', ['00/00-1/1-0000 REKENING KORAN']],
			['a branch line', ['CABANG / BRANCH : 00002 - PALSU']],
			['a period line', ['PERIODE / PERIOD : 01 July 2026 - 31 July 2026']],
			['a page counter', ['HALAMAN / PAGE : 1 of 3']],
			['an account label', ['NOMOR REKENING /', 'ACCOUNT NUMBER', ': 700100200301 - Palsu']],
			['a summary row', ['IDR 1.000 1.00 1.00']],
			['a summary total', ['Total Saldo Dalam IDR / Balance Total in IDR 1.00']],
			['the bank line', ['PT. Bank OCBC NISP Tbk']]
		])('%s refuses the whole file', (_name, lines) => {
			expect(parse(withLinesAfterFirstRow(lines)).inconsistent).toBe(true);
		});

		it('a forged block at the end of the IDR table opens a section the summary lacks', () => {
			const pages = RK_JULY.pages.map((p) => [...p]);
			pages[1]!.splice(3, 0, ['Currency Code : USD', 'Beginning Balance 6,975,000.00']);
			expect(parse({ ...RK_JULY, pages }).inconsistent).toBe(true);
		});

		it('a forged legal text in a page’s last note (nothing after it to cut) refuses the whole file', () => {
			const forged = rkWithAfter(1, 4, [
				'NASABAH FIKTIF/31',
				'BILAMANA DALAM 14 HARI KALENDER PALSU'
			]);
			expect(parse(forged).inconsistent).toBe(true);
		});

		it('a whole forged row inside a note does not check out', () => {
			const forged = withLinesAfterFirstRow(['01/07/2026 01/07/2026 Palsu 0.00 1.00 4,000,001.00']);
			expect(idr(forged).refusal).toBe('inconsistent');
		});
	});

	it('refuses a row cut at a page end whose next page never supplies its amounts', () => {
		const pages = RK_JULY.pages.map((p) => [...p]);
		pages[0]![4] = { date: '12/07/2026', type: 'Transfer Keluar BI Fast/', noAmounts: true };
		const cut = { ...RK_JULY, pages };
		expect(idr(cut).parse.rows[3]).toEqual({ index: 3, ok: false, reason: 'missing_amount' });
		expect(idr(cut).refusal).toBe('inconsistent');
	});

	it('refuses the whole file when a table page has no legal text to end it', () => {
		expect(parse({ ...RK_JULY, noLegalOnPage: 0 }).inconsistent).toBe(true);
		// Without the bank line either, the table would otherwise silently run to the page end.
		expect(parse({ ...RK_JULY, noLegalOnPage: 1, noFooter: true }).inconsistent).toBe(true);
	});

	it('refuses the whole file when pages disagree on the period, or one prints none', () => {
		expect(
			parse({ ...RK_JULY, pagePeriods: { 1: '01 June 2026 - 30 June 2026' } }).inconsistent
		).toBe(true);
		expect(parse({ ...RK_JULY, pagePeriods: { 2: null } }).inconsistent).toBe(true);
	});

	it('refuses the whole file when pages disagree on the account', () => {
		const other = pagesWith((p, i) =>
			i === 1 ? p.replace(': 700100200300 - ', ': 700100200301 - ') : p
		);
		expect(OCBC.parse(other).inconsistent).toBe(true);
	});

	it('refuses a date outside the printed period', () => {
		const outside = rkWithAfter(0, 1, [], { date: '01/08/2026' });
		expect(idr(outside).parse.rows[0]).toMatchObject({ ok: false, reason: 'unparseable_date' });
	});

	it(`refuses a file with more than ${OCBC_MAX_SECTIONS} currency blocks`, () => {
		const codes = Array.from(
			{ length: OCBC_MAX_SECTIONS + 1 },
			(_, i) =>
				`A${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`
		);
		const many: RkFixture = {
			pages: [
				[
					{ currency: 'IDR', opening: '1.00' },
					...codes.map((currency) => ({ currency, opening: '1.00' }))
				]
			]
		};
		expect(parse(many).inconsistent).toBe(true);
		expect(parse(many).sections!.length).toBeLessThanOrEqual(OCBC_MAX_SECTIONS);
	});
});

describe('OCBC Rekening Koran row starts by position (red team L1)', () => {
	/** `pages` laid out as the PDF prints them: the listed note lines in the description column, the rest left. */
	const laidOut = (pages: string[], notes: readonly string[]): StatementDocument => ({
		format: 'pdf_text',
		pages,
		layout: pages.map((page) => ({
			width: 595,
			lineX: page.split('\n').map((l) => (notes.includes(l) ? 150 : 30))
		}))
	});

	it('a Berita note imitating two rows with amounts is refused once positions are known', () => {
		const notes = [
			'Berita : X',
			'05/07/2026 05/07/2026 Koreksi 0.00 900,000,000.00 906,350,000.00',
			'05/07/2026 05/07/2026 Koreksi 900,000,000.00 0.00 6,350,000.00'
		];
		const forged = rkWithAfter(0, 3, notes);
		// Text alone (the documented limit before positions): the pair checks out.
		expect(idr(forged).refusal).toBeNull();
		const placed = OCBC.parse(laidOut(rkPages(forged), notes));
		expect(placed.sections?.[0]?.refusal).toBe('inconsistent');
		expect(placed.sections?.[0]?.parse.rows.filter((r) => !r.ok)).toEqual([
			{ index: 2, ok: false, reason: 'unparseable_amount' }
		]);
		// The honest statement laid out the same way reads exactly as from its text.
		expect(OCBC.parse(laidOut(rkPages(RK_JULY), []))).toEqual(parse(RK_JULY));
	});

	it('cycle 2 L3: pages read at different scales (OCR) still find the date column on every page', () => {
		const notes = [
			'Berita : X',
			'05/07/2026 05/07/2026 Koreksi 0.00 900,000,000.00 906,350,000.00',
			'05/07/2026 05/07/2026 Koreksi 900,000,000.00 0.00 6,350,000.00'
		];
		// Page 1 photographed at 1240 px wide, page 2 at 2480 px: the same columns at twice the pixels.
		const scaled = (pages: string[]): StatementDocument => ({
			format: 'pdf_text',
			pages,
			layout: pages.map((page, p) => {
				const k = p === 0 ? 1 : 2;
				return {
					width: 1240 * k,
					lineX: page.split('\n').map((l) => (notes.includes(l) ? 310 : 60) * k)
				};
			})
		});
		// Honest: every real row on both pages starts a row, exactly as from the text.
		expect(OCBC.parse(scaled(rkPages(RK_JULY)))).toEqual(parse(RK_JULY));
		// Forged rows in the note are still caught on the scaled page set.
		const placed = OCBC.parse(scaled(rkPages(rkWithAfter(0, 3, notes))));
		expect(placed.sections?.[0]?.refusal).toBe('inconsistent');
	});
});
