import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { CSV_MAX_ROWS } from '../csv';
import {
	FICTIONAL_CARD,
	FICTIONAL_CARD_SPEC,
	fictionalCardPages
} from '../../../../test/fixtures/statements/fictional-card';
import { cardRowDate } from './card-dates';
import { buildCardStatement, classifyCardRow, type CardStatementCells } from './card-rows';
import { STATEMENT_PARSERS } from './parsers';
import type { StatementParse } from './types';

const read = (pages: string[][]): StatementParse =>
	FICTIONAL_CARD.parse({ format: 'pdf_text', pages: pages.map((p) => p.join('\n')) });
const withRows = (rows: string[], over: Partial<typeof FICTIONAL_CARD_SPEC> = {}) =>
	read(fictionalCardPages({ ...over, rows }));
const refused = (p: StatementParse) => p.inconsistent === true && p.rows.length === 0;

describe('card row dates (FN-55 B3, AC 23)', () => {
	it('takes the latest real year not after the statement date, within 400 days', () => {
		expect(cardRowDate(28, 12, '2026-01-05')).toBe('2025-12-28');
		expect(cardRowDate(2, 1, '2026-01-05')).toBe('2026-01-02');
		expect(cardRowDate(5, 1, '2026-01-05')).toBe('2026-01-05');
		expect(cardRowDate(31, 10, '2026-10-31')).toBe('2026-10-31');
		// 29 February: no qualifying year within 400 days.
		expect(cardRowDate(29, 2, '2026-03-01')).toBeNull();
		expect(cardRowDate(29, 2, '2028-03-01')).toBe('2028-02-29');
		expect(cardRowDate(31, 4, '2026-10-01')).toBeNull();
		expect(cardRowDate(1, 13, '2026-10-01')).toBeNull();
		expect(cardRowDate(1, 1, 'not-a-date')).toBeNull();
	});
});

describe('the fictional card statement (AC 19)', () => {
	it('reads every row, its figures in the wallet convention, and passes every self-check', () => {
		const p = read(fictionalCardPages());
		expect(p.inconsistent).toBeUndefined();
		expect(p.openingBalanceMinor).toBe(-200000000);
		expect(p.closingBalanceMinor).toBe(-132500050);
		expect(p.rows.every((r) => r.ok)).toBe(true);
		expect(
			p.rows.map((r) =>
				r.ok
					? [r.value.date, r.value.type, r.value.amountMinor, r.value.title, r.value.notes]
					: null
			)
		).toEqual([
			['2026-09-27', 'expense', 80000050, 'TOKO BUKU CONTOH', ''],
			['2026-09-30', 'income', 200000000, 'PEMBAYARAN TERIMA KASIH', ''],
			['2026-10-05', 'expense', 20500000, 'LANGGANAN FIKTIF ONLINE', 'USD 12,50'],
			['2026-10-10', 'expense', 24500000, 'CICILAN TOKO ELEKTRONIK FIKTIF', 'CICILAN 3/12'],
			['2026-10-25', 'expense', 7500000, 'BIAYA TAHUNAN', '']
		]);
		expect(p.card).toEqual({
			statementDate: '2026-10-25',
			dueDate: '2026-11-12',
			periodFrom: '2026-09-26',
			periodTo: '2026-10-25',
			firstPostingDate: '2026-09-28',
			previousBalanceMinor: -200000000,
			newBalanceMinor: -132500050,
			minimumPaymentMinor: 10000000,
			limitMinor: 1500000000,
			cardLast4: '0001',
			totals: {
				payments: 200000000,
				credits: 0,
				purchases: 125000050,
				fees: 7500000,
				interest: 0
			},
			classes: ['purchase', 'payment', 'purchase', 'installment', 'fee']
		});
	});

	it('a credit (CR) new balance is positive; the minimum cannot exceed what is owed', () => {
		const p = withRows(['30/09 01/10 PEMBAYARAN TERIMA KASIH 2.100.000,00 CR'], {
			payments: '2.100.000,00',
			purchases: '0,00',
			fees: '0,00',
			next: '100.000,00 CR',
			minimum: null
		});
		expect(p.closingBalanceMinor).toBe(10000000);
		expect(p.card?.newBalanceMinor).toBe(10000000);
		expect(
			refused(
				withRows(['30/09 01/10 PEMBAYARAN TERIMA KASIH 2.100.000,00 CR'], {
					payments: '2.100.000,00',
					purchases: '0,00',
					fees: '0,00',
					next: '100.000,00 CR',
					minimum: '1,00'
				})
			)
		).toBe(true);
	});
});

describe('fail closed (B4, AC 20)', () => {
	it('a new balance one sen wrong refuses the whole file', () => {
		expect(refused(read(fictionalCardPages({ next: '1.325.000,51' })))).toBe(true);
	});
	it('a payments total that does not equal its rows refuses it', () => {
		expect(refused(read(fictionalCardPages({ payments: '1.999.999,99' })))).toBe(true);
	});
	it('a purchases total that does not equal its rows refuses it', () => {
		expect(refused(read(fictionalCardPages({ purchases: '1.250.000,00' })))).toBe(true);
	});
	it('any unreadable row refuses it (never a warning)', () => {
		const rows = [...FICTIONAL_CARD_SPEC.rows];
		rows[0] = '27/09 28/09 TOKO BUKU CONTOH 800.000,5';
		expect(refused(withRows(rows))).toBe(true);
		rows[0] = '27/AB 28/09 TOKO BUKU CONTOH 800.000,50';
		expect(refused(withRows(rows))).toBe(true);
	});
	it('a missing previous or new balance, statement date or a due date out of range refuses it', () => {
		const pages = fictionalCardPages();
		expect(
			refused(read([pages[0]!.filter((l) => !l.startsWith('TAGIHAN SEBELUMNYA')), pages[1]!]))
		).toBe(true);
		expect(refused(read(fictionalCardPages({ dueDate: '24/10/2026' })))).toBe(true);
		expect(refused(read(fictionalCardPages({ dueDate: '25/12/2026' })))).toBe(true);
		expect(refused(read(fictionalCardPages({ dueDate: '31/11/2026' })))).toBe(true);
		expect(refused(read(fictionalCardPages({ statementDate: '25/13/2026' })))).toBe(true);
		// Absent optional figures are absent, never filled in.
		const bare = read(fictionalCardPages({ dueDate: null, minimum: null, limit: null }));
		expect(bare.card?.dueDate).toBeNull();
		expect(bare.card?.minimumPaymentMinor).toBeNull();
		expect(bare.card?.limitMinor).toBeNull();
	});
	it('rows past the row cap are refused, never truncated (AC 33)', () => {
		const cells: CardStatementCells = {
			statementDate: '2026-10-25',
			previousBalance: '0,00',
			newBalance: '0,00',
			cardNumbers: [],
			totals: {},
			rows: Array.from({ length: CSV_MAX_ROWS + 1 }, () => ({
				transactionDate: { day: 1, month: 10 },
				description: 'X',
				amount: '1,00',
				direction: 'debit' as const,
				amountCells: 1
			})),
			structureBroken: false,
			grammar: 'id',
			phrases: { fee: [], interest: [], tax: [], installment: [], payment: [] }
		};
		expect(refused(buildCardStatement(cells))).toBe(true);
	});
});

describe('untrusted text (B5, AC 21, 22)', () => {
	const rows = () => [...FICTIONAL_CARD_SPEC.rows];
	it('an amount forged inside a description (two amount-shaped cells) refuses the file', () => {
		const r = rows();
		r[0] = '27/09 28/09 TOKO 9.999.999,00 BUKU 800.000,50';
		expect(refused(withRows(r))).toBe(true);
	});
	it.each([
		'TAGIHAN BARU 1.325.000,50',
		'TOTAL PEMBAYARAN 2.000.000,00',
		'TANGGAL TAGIHAN 25/10/2026',
		'RINCIAN TRANSAKSI',
		'Syarat dan ketentuan berlaku'
	])('a forged "%s" line inside the table refuses the file', (line) => {
		const r = rows();
		r.splice(1, 0, line);
		expect(refused(withRows(r))).toBe(true);
	});
	it('a repeated statement-date line, another statement date on page 2, or a table line outside a table refuses it', () => {
		const pages = fictionalCardPages();
		expect(refused(read([[...pages[0]!.slice(0, 3), ...pages[0]!.slice(2)], pages[1]!]))).toBe(
			true
		);
		const other = pages[1]!.map((l) =>
			l.startsWith('TANGGAL TAGIHAN') ? 'TANGGAL TAGIHAN 26/10/2026' : l
		);
		expect(refused(read([pages[0]!, other]))).toBe(true);
		expect(refused(read([pages[0]!, [...pages[1]!, '01/10 01/10 TOKO 1.000,00']]))).toBe(true);
	});
	it('a description mimicking an amount, a direction word or a date changes none of them', () => {
		const r = rows();
		r[0] = '27/09 28/09 PEMBAYARAN CR DB 05/10 TOKO 800.000,50';
		const p = withRows(r);
		expect(p.inconsistent).toBeUndefined();
		const row = p.rows[0]!;
		expect(row.ok && [row.value.date, row.value.type, row.value.amountMinor]).toEqual([
			'2026-09-27',
			'expense',
			80000050
		]);
		// A debit that starts with the payment phrase stays a purchase.
		expect(p.card?.classes[0]).toBe('purchase');
	});
	it('a posting date before its transaction date refuses the file (AC 23)', () => {
		const r = rows();
		r[0] = '27/09 26/09 TOKO BUKU CONTOH 800.000,50';
		expect(refused(withRows(r))).toBe(true);
	});
	it('a 29/02 row on a 2026 statement is unreadable: refused', () => {
		const r = rows();
		r[0] = '29/02 01/03 TOKO BUKU CONTOH 800.000,50';
		expect(refused(withRows(r))).toBe(true);
	});
	it('more than one printed card is refused as not supported yet (AC 29)', () => {
		const pages = fictionalCardPages();
		const second = pages[1]!.map((l) =>
			l.startsWith('NOMOR KARTU') ? 'NOMOR KARTU 4111 11** **** 0002' : l
		);
		const p = read([pages[0]!, second]);
		expect(refused(p)).toBe(true);
		expect(p.unsupported).toBe('multiple_cards');
	});
});

describe('money vectors in the fixture grammar (AC 24)', () => {
	const one = (amount: string) =>
		buildCardStatement({
			statementDate: '2026-10-25',
			previousBalance: '0,00',
			newBalance: amount.endsWith('CR') ? amount : amount,
			cardNumbers: [],
			totals: {},
			rows: [
				{
					transactionDate: { day: 1, month: 10 },
					description: 'X',
					amount: amount.replace(/ CR$/, ''),
					direction: amount.endsWith('CR') ? 'credit' : 'debit',
					amountCells: 1
				}
			],
			structureBroken: false,
			grammar: 'id',
			phrases: { fee: [], interest: [], tax: [], installment: [], payment: [] }
		});
	it('reads the fixed two-decimal grammar exactly', () => {
		expect(one('1.250.000,50').rows[0]).toMatchObject({
			ok: true,
			value: { amountMinor: 125000050 }
		});
		expect(one('Rp 28.000,00').rows[0]).toMatchObject({
			ok: true,
			value: { amountMinor: 2800000 }
		});
		expect(one('50.000,00 CR').closingBalanceMinor).toBe(5000000);
		expect(refused(one('0,00'))).toBe(true);
		expect(refused(one('1.250'))).toBe(true);
		expect(refused(one('1250000,00'))).toBe(true);
		expect(refused(one('99.999.999.999.999,99'))).toBe(true);
	});
	it('classifies only by fixed phrases at the start of the description', () => {
		const phrases = {
			fee: ['BIAYA '],
			interest: ['BUNGA '],
			tax: ['PPN '],
			installment: ['CICILAN '],
			payment: ['PEMBAYARAN ']
		};
		expect(classifyCardRow('BIAYA KETERLAMBATAN', 'debit', phrases)).toBe('fee');
		expect(classifyCardRow('TOKO BIAYA MURAH', 'debit', phrases)).toBe('purchase');
		expect(classifyCardRow('BUNGA PEMBELANJAAN', 'debit', phrases)).toBe('interest');
		expect(classifyCardRow('PPN BIAYA', 'debit', phrases)).toBe('tax');
		expect(classifyCardRow('PEMBAYARAN VIA BANK', 'credit', phrases)).toBe('payment');
		expect(classifyCardRow('REFUND TOKO', 'credit', phrases)).toBe('credit');
		expect(classifyCardRow('BIAYA TAHUNAN', 'credit', phrases)).toBe('credit');
	});
});

describe('registration (AC 34)', () => {
	it('the fictional issuer is never a production parser, and no card parser ships before a real sample', () => {
		expect(STATEMENT_PARSERS.some((p) => p.id === FICTIONAL_CARD.id)).toBe(false);
		expect(STATEMENT_PARSERS.filter((p) => p.kind === 'card')).toEqual([]);
		for (const file of readdirSync('src/lib/shared/statements'))
			if (file.endsWith('.ts') && !file.endsWith('.test.ts'))
				expect(readFileSync(`src/lib/shared/statements/${file}`, 'utf8')).not.toContain(
					'fictional-card'
				);
	});
	it('no float parsing in the card reader (grep gate)', () => {
		for (const file of ['card-rows.ts', 'card-dates.ts'])
			expect(readFileSync(`src/lib/shared/statements/${file}`, 'utf8')).not.toMatch(
				/parseFloat|Number\.parseFloat|toFixed/
			);
	});
});

describe('red team L1: rows outside the printed period', () => {
	const rows = () => [...FICTIONAL_CARD_SPEC.rows];
	it('a row whose posting date the period does not hold is refused, never stored a year early', () => {
		const r = rows();
		r[0] = '30/10 30/10 TOKO BUKU CONTOH 800.000,50';
		expect(refused(withRows(r))).toBe(true);
		r[0] = '20/09 25/09 TOKO BUKU CONTOH 800.000,50';
		expect(refused(withRows(r))).toBe(true);
	});
	it('without a posting date the only date must lie in the period; with no printed period 60 days before the statement date', () => {
		const p = read(
			fictionalCardPages({
				rows: ['30/10 30/10 X 1,00'],
				period: null,
				payments: null,
				purchases: null,
				fees: null,
				interest: null,
				previous: '0,00',
				next: '1,00',
				minimum: null
			})
		);
		// No printed period: bounded from 60 days before the statement date (L1-R), so 2025-10-30 is refused.
		expect(refused(p)).toBe(true);
		// A purchase dated in the previous cycle but posted in this one stays readable.
		const ok = rows();
		ok[0] = '24/09 27/09 TOKO BUKU CONTOH 800.000,50';
		expect(withRows(ok).inconsistent).toBeUndefined();
	});
});

describe('red team L1-R: a shifted transaction-date column', () => {
	const rows = () => [...FICTIONAL_CARD_SPEC.rows];
	it.each(['30/10 01/10', '01/11 01/10'])('"%s" is refused, never stored a year early', (dates) => {
		const r = rows();
		r[0] = `${dates} TOKO BUKU CONTOH 800.000,50`;
		expect(refused(withRows(r))).toBe(true);
	});
	it('a purchase up to 60 days before the period posted inside it imports (20/09 posted 27/09)', () => {
		const r = rows();
		r[0] = '20/09 27/09 TOKO BUKU CONTOH 800.000,50';
		const p = withRows(r);
		expect(p.inconsistent).toBeUndefined();
		expect(p.rows[0]).toMatchObject({ ok: true, value: { date: '2026-09-20' } });
		r[0] = '27/07 27/09 TOKO BUKU CONTOH 800.000,50';
		expect(refused(withRows(r))).toBe(true);
	});
	it('a statement without a printed period is bounded from its statement date', () => {
		const base = {
			period: null,
			payments: null,
			purchases: null,
			fees: null,
			interest: null,
			previous: '0,00',
			minimum: null
		};
		expect(
			read(fictionalCardPages({ ...base, rows: ['01/09 02/09 X 1,00'], next: '1,00' })).inconsistent
		).toBeUndefined();
		expect(
			refused(read(fictionalCardPages({ ...base, rows: ['01/08 02/08 X 1,00'], next: '1,00' })))
		).toBe(true);
	});
});

describe('FN-55c contract: every card parse is bounded', () => {
	it('a parse result with neither a printed period nor a statement date is refused', () => {
		const pages = fictionalCardPages({ period: null }).map((p) =>
			p.filter((l) => !l.startsWith('TANGGAL TAGIHAN'))
		);
		expect(refused(read(pages))).toBe(true);
	});
});
