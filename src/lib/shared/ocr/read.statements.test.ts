import { describe, expect, it } from 'vitest';
import { BCA_SEPTEMBER, bcaPages } from '../../../../test/fixtures/statements/bca';
import { BNI_JUNE, bniPages } from '../../../../test/fixtures/statements/bni';
import {
	MANDIRI_AUGUST,
	MANDIRI_SINGLE,
	mandiriPages
} from '../../../../test/fixtures/statements/mandiri';
import { OCBC_SINGLE, ocbcPages } from '../../../../test/fixtures/statements/ocbc';
import { ocrDocFromText, type ConfOf } from '../../../../test/helpers/ocr';
import { STATEMENT_PARSERS } from '../statements/parsers';
import type { MappedRow, StatementParser } from '../statements/types';
import { readOcrDocument } from './read';

const TODAY = '2026-10-10';
const read = (
	pages: string[],
	conf: ConfOf = 96,
	institution: string | null = null,
	section: number | null = null
) => readOcrDocument({ doc: ocrDocFromText(pages, conf), institution, section, todayWib: TODAY });
const values = (rows: MappedRow[]) =>
	rows.map((r) =>
		r.ok
			? [r.index, r.value.date, r.value.type, r.value.amountMinor, r.value.title]
			: [r.index, r.reason]
	);
const parserOf = (id: string) => STATEMENT_PARSERS.find((p) => p.id === id) as StatementParser;

describe('scanned bank statements read like their text layer (criterion 20)', () => {
	const cases: [string, string[], number | null][] = [
		['bca', bcaPages(BCA_SEPTEMBER), null],
		['bni', bniPages(BNI_JUNE), null],
		['mandiri', mandiriPages(MANDIRI_SINGLE), null],
		['ocbc', ocbcPages(OCBC_SINGLE), null]
	];
	for (const [id, pages, section] of cases) {
		it(`${id}: same rows as the text-layer parser, balance chain passes`, () => {
			const expected = parserOf(id).parse({ format: 'pdf_text', pages });
			const want = expected.sections ? expected.sections[section ?? 0]!.parse : expected;
			const result = read(pages, 96, null, section);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.reading.kind).toBe('statement');
			expect(result.reading.institution.id).toBe(id);
			expect(values(result.reading.rows)).toEqual(values(want.rows));
			expect(result.reading.balance.status).toBe('pass');
			expect(result.reading.rows.every((r) => !r.ok || r.review === undefined)).toBe(true);
		});
	}

	it('a multi-account statement asks for the account, then reads the picked one', () => {
		const pages = mandiriPages(MANDIRI_AUGUST);
		const asked = read(pages);
		expect(asked).toMatchObject({ ok: false, error: 'section_required' });
		if (asked.ok) return;
		expect(asked.sections?.length).toBeGreaterThan(1);
		expect(read(pages, 96, null, 0).ok).toBe(true);
	});
});

/** Confidence `c` for the first amount-shaped word of the BCA table, 96 elsewhere. */
function amountAt(c: number): ConfOf {
	let done = false;
	return (word) => {
		if (!done && /^\d{1,3}(?:,\d{3})*\.\d{2}$/.test(word) && word !== '1,000,000.00') {
			done = true;
			return c;
		}
		return 96;
	};
}

describe('low-confidence figures are poisoned or reviewed, never repaired (criteria 21, 22)', () => {
	const pages = bcaPages(BCA_SEPTEMBER);
	it('confidence below 70 in an amount refuses the whole file; 70 and 89 review; 90 and 95 clean', () => {
		for (const c of [60, 69])
			expect(read(pages, amountAt(c))).toMatchObject({ ok: false, error: 'inconsistent' });
		for (const c of [70, 80, 89]) {
			const r = read(pages, amountAt(c));
			expect(r.ok).toBe(true);
			if (r.ok)
				expect(r.reading.rows.some((x) => x.ok && x.review === 'low_confidence')).toBe(true);
		}
		for (const c of [90, 95]) {
			const r = read(pages, amountAt(c));
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.reading.rows.some((x) => x.ok && x.review)).toBe(false);
		}
	});

	it('a letter read inside a figure is never turned into a digit: the statement does not check out', () => {
		for (const [digit, letter] of [
			['0', 'O'],
			['1', 'l']
		] as const) {
			let done = false;
			const tampered = pages.map((p) =>
				p.replace(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g, (m) => {
					if (done || m === '1,000,000.00' || !m.includes(digit)) return m;
					done = true;
					return m.replace(digit, letter);
				})
			);
			expect(done).toBe(true);
			expect(read(tampered)).toMatchObject({ ok: false, error: 'inconsistent' });
		}
	});
});

describe('balance self-checks of scanned statements (criterion 23)', () => {
	it('a dropped row (opening + rows ≠ closing) is refused whole with counts only', () => {
		const dropped = bcaPages({
			...BCA_SEPTEMBER,
			pages: [BCA_SEPTEMBER.pages[0]!, [], BCA_SEPTEMBER.pages[2]!]
		});
		const r = read(dropped);
		expect(r).toMatchObject({ ok: false, error: 'inconsistent' });
		if (!r.ok) expect(Object.keys(r.counts).sort()).toEqual(['gapMinor', 'pages', 'rows']);
	});

	it('a statement printing no balances puts every row in review (no_balance_check)', () => {
		const fictional: StatementParser = {
			id: 'fiktif',
			label: 'Bank Fiktif',
			formats: ['pdf_text'],
			detect: (d) =>
				d.format === 'pdf_text' && d.pages.join('').includes('BANK FIKTIF') ? 0.9 : 0,
			parse: () => ({
				rows: [
					{
						index: 0,
						ok: true,
						value: {
							date: '2026-10-01',
							type: 'expense',
							title: 'Contoh',
							amountMinor: 100,
							currency: 'IDR',
							categoryName: '',
							walletName: '',
							paymentMethod: '',
							recurrence: '',
							tag: '',
							notes: '',
							reference: ''
						}
					}
				],
				openingBalanceMinor: null,
				closingBalanceMinor: null
			})
		};
		const r = readOcrDocument(
			{
				doc: ocrDocFromText(['BANK FIKTIF\nbaris satu dua tiga empat lima enam tujuh']),
				institution: null,
				section: null,
				todayWib: TODAY
			},
			[fictional]
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.reading.balance.status).toBe('omitted');
			expect(r.reading.rows.every((x) => x.ok && x.review === 'no_balance_check')).toBe(true);
		}
	});
});

describe('planted structure (criterion 28)', () => {
	it('two banks’ letterheads in one document are refused; a manual pick of another bank is a mismatch', () => {
		const both = [bcaPages(BCA_SEPTEMBER)[0]! + '\n' + bniPages(BNI_JUNE)[0]!];
		expect(read(both)).toMatchObject({ ok: false, error: 'institution_conflict' });
		expect(read(bcaPages(BCA_SEPTEMBER), 96, 'bni')).toMatchObject({
			ok: false,
			error: 'institution_mismatch'
		});
		expect(read(bcaPages(BCA_SEPTEMBER), 96, 'gopay')).toMatchObject({
			ok: false,
			error: 'institution_mismatch'
		});
		expect(read(bcaPages(BCA_SEPTEMBER), 96, 'bca').ok).toBe(true);
	});
});
