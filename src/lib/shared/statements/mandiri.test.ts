import { describe, expect, it } from 'vitest';
import { BCA_SEPTEMBER, bcaPages } from '../../../../test/fixtures/statements/bca';
import {
	MANDIRI_AUGUST,
	MANDIRI_AUGUST_ROWS,
	MANDIRI_SINGLE,
	mandiriForgedSectionRemarks,
	mandiriPages,
	mandiriWithLastRemarks as withLastRemarks,
	type MandiriAccount,
	type MandiriFixture
} from '../../../../test/fixtures/statements/mandiri';
import { BCA } from './bca';
import { detectInstitution } from './detect';
import { MANDIRI, MANDIRI_MAX_SECTIONS } from './mandiri';
import { STATEMENT_PARSERS } from './parsers';
import { balanceCheck } from './rows';
import type { MappedRow, StatementDocument, StatementSection } from './types';

const doc = (f: MandiriFixture): StatementDocument => ({
	format: 'pdf_text',
	pages: mandiriPages(f)
});
const parse = (f: MandiriFixture) => MANDIRI.parse(doc(f));
const sections = (f: MandiriFixture): readonly StatementSection[] => parse(f).sections ?? [];
const values = (rows: readonly MappedRow[]) =>
	rows.map((r) => (r.ok ? [r.value.date, r.value.type, r.value.amountMinor, r.value.title] : r));

/** One savings account around `pages`, opening 1.000.000,00. */
const account = (pages: MandiriAccount['pages'], over: Partial<MandiriAccount> = {}) => ({
	product: 'Tabungan Fiktif',
	account: '1230009876543',
	opening: '1.000.000,00',
	pages,
	...over
});
const single = (pages: MandiriAccount['pages'], over: Partial<MandiriAccount> = {}) =>
	sections({ accounts: [account(pages, over)] });
const KOPI = { remarks: ['QR fiktif', 'KEDAI FIKTIF'], amount: '-25.000,00', date: '05 Aug 2026' };
const GAJI = { remarks: ['Transfer masuk fiktif'], amount: '+100.000,00', date: '06 Aug 2026' };

describe('Mandiri detection', () => {
	it('is detected from its letterhead, footer and table header, and ships in the registry', () => {
		expect(MANDIRI.detect(doc(MANDIRI_AUGUST))).toBe(0.9);
		expect(detectInstitution(doc(MANDIRI_AUGUST), STATEMENT_PARSERS).institution?.id).toBe(
			'mandiri'
		);
		expect(STATEMENT_PARSERS.map((p) => p.id)).toContain('mandiri');
	});

	it('claims nothing without the bank footer or the table header, nor a CSV; BCA does not claim it', () => {
		const noFooter = mandiriPages(MANDIRI_SINGLE).map((p) =>
			p.replaceAll('PT Bank Mandiri (Persero) Tbk.', 'PT Bank Lain')
		);
		expect(MANDIRI.detect({ format: 'pdf_text', pages: noFooter })).toBe(0);
		const noHeader = mandiriPages(MANDIRI_SINGLE).map((p) => p.replaceAll('Remarks', 'Catatan'));
		expect(MANDIRI.detect({ format: 'pdf_text', pages: noHeader })).toBe(0);
		expect(MANDIRI.detect({ format: 'csv', rows: [['Tanggal', 'Keterangan']] })).toBe(0);
		expect(MANDIRI.parse({ format: 'csv', rows: [] }).inconsistent).toBe(true);
		expect(BCA.detect(doc(MANDIRI_AUGUST))).toBe(0);
		expect(MANDIRI.detect({ format: 'pdf_text', pages: bcaPages(BCA_SEPTEMBER) })).toBe(0);
	});
});

describe('Mandiri consolidated statement', () => {
	it('reads each savings/current account as its own section; a summary-only block is not a section', () => {
		const r = parse(MANDIRI_AUGUST);
		expect(r.inconsistent).toBe(false);
		expect(r.rows).toEqual([]);
		const s = r.sections ?? [];
		expect(s.map((x) => [x.label, x.accountLast4, x.refusal])).toEqual([
			['Tabungan Fiktif', '6543', null],
			['Giro Fiktif', '6667', null]
		]);
		expect(s.map((x) => values(x.parse.rows))).toEqual(
			MANDIRI_AUGUST_ROWS.map((rows) => rows.map((row) => [...row]))
		);
		// Row indices are unique across the file: the dedupe keys of two accounts never collide.
		expect(s.map((x) => x.parse.rows.map((row) => row.index))).toEqual([
			[0, 1, 2, 3],
			[4, 5]
		]);
		expect(s.map((x) => [x.parse.openingBalanceMinor, x.parse.closingBalanceMinor])).toEqual([
			[100_000_000, 323_949_950],
			[50_000_000, 38_500_000]
		]);
		expect(s.map((x) => balanceCheck(x.parse))).toEqual([{ status: 'pass' }, { status: 'pass' }]);
	});

	it('reads a one-account statement as one section, continuation page included', () => {
		const s = sections(MANDIRI_SINGLE);
		expect(s).toHaveLength(1);
		expect(s[0]!.refusal).toBeNull();
		expect(values(s[0]!.parse.rows)).toEqual(MANDIRI_AUGUST_ROWS[0].map((row) => [...row]));
	});

	it('reads a second account that starts on the same page as the first one ends', () => {
		const giro = { ...MANDIRI_AUGUST.accounts[1]!, samePage: true };
		const s = sections({ accounts: [MANDIRI_AUGUST.accounts[0]!, giro] });
		expect(s.map((x) => [x.accountLast4, x.refusal, x.parse.rows.length])).toEqual([
			['6543', null, 4],
			['6667', null, 2]
		]);
	});

	it('lists a deposit or card section with a table but never makes it importable', () => {
		const s = single([[KOPI]], { product: 'Deposito Fiktif' });
		expect(s[0]!.refusal).toBe('not_transaction_account');
		expect(s[0]!.parse.inconsistent).toBe(true);
	});

	it('refuses a foreign-currency account: every row unsupported_currency', () => {
		const s = single([[KOPI, GAJI]], { currency: 'USD' });
		expect(s[0]!.refusal).toBe('unsupported_currency');
		// FN-47: a TWD heading is recognised (and refused) like the other foreign codes.
		for (const currency of ['TWD', 'HKD', 'CNY'])
			expect(single([[KOPI, GAJI]], { currency })[0]!.refusal, currency).toBe(
				'unsupported_currency'
			);
		expect(s[0]!.parse.rows.map((r) => (r.ok ? 'ok' : r.reason))).toEqual([
			'unsupported_currency',
			'unsupported_currency'
		]);
		// A table header in another currency under an IDR heading is refused the same way.
		const pages = mandiriPages({ accounts: [account([[KOPI]])] }).map((p) =>
			p.replace('Nominal (IDR)', 'Nominal (USD)')
		);
		expect(MANDIRI.parse({ format: 'pdf_text', pages }).sections?.[0]?.refusal).toBe(
			'unsupported_currency'
		);
	});
});

describe('Mandiri self-checks (remarks are third-party text)', () => {
	const refusalOf = (pages: MandiriAccount['pages'], over: Partial<MandiriAccount> = {}) =>
		single(pages, over)[0]?.refusal;

	it('accepts a clean account', () => {
		expect(refusalOf([[KOPI, GAJI]])).toBeNull();
	});

	it('a remark shaped like an amount line makes the row unreadable and the account refused', () => {
		const forged = { ...GAJI, remarks: ['Transfer masuk fiktif', '1.000.000,001 +5.000.000,00'] };
		const s = single([[forged]]);
		expect(s[0]!.parse.rows[0]).toMatchObject({ ok: false, reason: 'unparseable_amount' });
		expect(s[0]!.refusal).toBe('inconsistent');
	});

	it('a whole forged row inside a remark (with a matching balance) breaks the row numbers', () => {
		const forged = {
			...GAJI,
			remarks: ['Transfer masuk fiktif', '1.100.000,001 +100.000,00', '10:00:00 WIB', '06 Aug 2026']
		};
		expect(refusalOf([[forged]])).toBe('inconsistent');
	});

	it('a remark imitating a time or date line splits the row and is refused', () => {
		expect(refusalOf([[{ ...KOPI, remarks: ['QR fiktif', '10:00:00 WIB'] }]])).toBe('inconsistent');
		expect(refusalOf([[{ ...KOPI, remarks: ['QR fiktif', '07 Aug 2026'] }]])).toBe('inconsistent');
	});

	it('refuses a wrong running balance, row number, closing balance or dana masuk/keluar total', () => {
		expect(refusalOf([[{ ...KOPI, balance: '975.000,01' }]])).toBe('inconsistent');
		expect(refusalOf([[{ ...KOPI, no: 2 }]])).toBe('inconsistent');
		expect(refusalOf([[KOPI]], { closing: '975.000,01' })).toBe('inconsistent');
		expect(refusalOf([[KOPI, GAJI]], { credit: '100.000,01' })).toBe('inconsistent');
		expect(refusalOf([[KOPI, GAJI]], { debit: '0,00' })).toBe('inconsistent');
	});

	it('refuses a date outside the printed period or an unknown month', () => {
		expect(refusalOf([[{ ...KOPI, date: '01 Sep 2026' }]])).toBe('inconsistent');
		expect(refusalOf([[{ ...KOPI, date: '05 Xyz 2026' }]])).toBe('inconsistent');
		expect(single([[{ ...KOPI, date: '05 Agu 2026' }]])[0]!.refusal).toBeNull();
	});

	it('refuses an amount past MAX_AMOUNT_MINOR', () => {
		const huge = { ...GAJI, amount: '+100.000.000.000,01' };
		const s = single([[huge]]);
		expect(s[0]!.parse.rows[0]).toMatchObject({ ok: false, reason: 'unparseable_amount' });
		expect(s[0]!.refusal).toBe('inconsistent');
	});

	it('refuses a row cut off at a page end', () => {
		const cut = ['Transfer fiktif', '975.000,001 -25.000,00'];
		expect(refusalOf([[cut], [KOPI]])).toBe('inconsistent');
	});

	it('refuses an account block label inside the table (the rest of the page is lost)', () => {
		expect(refusalOf([[KOPI, ['Nomor Rekening/Account Number'], GAJI]])).toBe('inconsistent');
		expect(
			parse({ accounts: [account([[KOPI, ['Nomor Rekening/Account Number'], GAJI]])] }).inconsistent
		).toBe(true);
	});

	describe('red team M1 (FN-16e): a remark equal to an account-block label', () => {
		it('cannot open a forged importable section: the whole file is refused (the report PoC)', () => {
			// Same account as the real one (also a duplicate) and a new one (only the cut section refuses it).
			for (const number of ['1230009876543', '1230005550001']) {
				const r = parse(withLastRemarks(mandiriForgedSectionRemarks(number)));
				expect(r.inconsistent, number).toBe(true);
			}
		});

		it('a forged section after a zero-amount real row still refuses the file (its amount line is left over)', () => {
			// The forgery opens the row (no remark before the label) and the cut real row moved nothing, so the real
			// section still checks out: only the real row's amount line, left outside any table, gives it away.
			const remarks = mandiriForgedSectionRemarks('1230005550001').slice(1);
			const r = parse(withLastRemarks(remarks, '+0,00'));
			expect(r.sections?.map((s) => s.refusal)).toEqual([null, null]);
			expect(r.inconsistent).toBe(true);
		});

		it('a lone Nama/Name, Periode/Period or account label in a remark refuses the whole file', () => {
			for (const label of ['Nama/Name', 'Periode/Period', 'Nomor Rekening/Account Number']) {
				expect(parse(withLastRemarks(['Pajak rekening', label])).inconsistent, label).toBe(true);
				expect(parse(withLastRemarks([label])).inconsistent, label).toBe(true);
			}
		});

		it('two sections of one account number are refused (the picker could not tell them apart)', () => {
			const twin = { ...MANDIRI_AUGUST.accounts[1]!, account: '1230009876543' };
			const r = parse({ accounts: [MANDIRI_AUGUST.accounts[0]!, twin] });
			expect(r.inconsistent).toBe(true);
			const sameProduct = { ...twin, product: 'Tabungan Fiktif', samePage: true };
			expect(parse({ accounts: [MANDIRI_AUGUST.accounts[0]!, sameProduct] }).inconsistent).toBe(
				true
			);
		});

		it('a complete section followed by the next account on the same page still reads', () => {
			const giro = { ...MANDIRI_AUGUST.accounts[1]!, samePage: true };
			expect(parse({ accounts: [MANDIRI_AUGUST.accounts[0]!, giro] }).inconsistent).toBe(false);
		});
	});

	it('refuses an account without its summary values', () => {
		const pages = mandiriPages(MANDIRI_SINGLE).map((p) => p.replace(/^\+ .*\n/m, ''));
		expect(MANDIRI.parse({ format: 'pdf_text', pages }).sections?.[0]?.refusal).toBe(
			'inconsistent'
		);
	});

	it('refuses the whole file when pages disagree on the period', () => {
		const pages = mandiriPages(MANDIRI_SINGLE);
		pages[1] = pages[1]!.replace('01 Aug 2026 - 31 Aug 2026', '01 Jul 2026 - 31 Jul 2026');
		expect(MANDIRI.parse({ format: 'pdf_text', pages }).inconsistent).toBe(true);
	});

	it('refuses the whole file when a table comes before any account block', () => {
		const pages = mandiriPages(MANDIRI_SINGLE);
		expect(MANDIRI.parse({ format: 'pdf_text', pages: [pages[1]!, pages[0]!] }).inconsistent).toBe(
			true
		);
	});

	it(`refuses a file with more than ${MANDIRI_MAX_SECTIONS} accounts`, () => {
		const accounts = Array.from({ length: MANDIRI_MAX_SECTIONS + 1 }, (_, i) =>
			account([[KOPI]], { account: `12300098765${String(i).padStart(2, '0')}` })
		);
		const r = parse({ accounts });
		expect(r.inconsistent).toBe(true);
		expect(r.sections).toHaveLength(MANDIRI_MAX_SECTIONS);
	});
});
