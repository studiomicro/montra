import { dateInPeriod, statementRow } from '#lib/shared/statements/rows';
import type {
	MappedRow,
	StatementDocument,
	StatementParse,
	StatementParser
} from '#lib/shared/statements/types';
import { parseMoneyAmount } from '#lib/shared/money-parse';
import { buildPdf, textContent } from '../../helpers/pdf';

/**
 * "Bank Contoh Fiktif": an invented institution, used only by tests to exercise the statement pipeline end to
 * end while no real sample exists (no real bank's layout is copied or guessed). It also shows the shape a real
 * parser takes: one module, `detect` from a stable letterhead phrase, `parse` through the shared `statementRow`
 * and `dateInPeriod`. Every name, account number and amount below is fictional.
 */

const LETTERHEAD = 'BANK CONTOH FIKTIF';
const CSV_HEADER = ['tanggal_fiktif', 'uraian_fiktif', 'debet_fiktif', 'kredit_fiktif'];
const PERIOD = /PERIODE (\d{2})\/(\d{2})\/(\d{4}) - (\d{2})\/(\d{2})\/(\d{4})/;
const ROW = /^(\d{2})\/(\d{2}) (.+?) ((?:\d{1,3}(?:\.\d{3})*|\d+),\d{2}) (DB|CR)$/;

const amountOf = (text: string) => parseMoneyAmount(text)?.minor ?? null;

function parsePdf(pages: readonly string[]): StatementParse {
	const lines = pages.flatMap((p) => p.split('\n')).map((l) => l.trim());
	const period = lines.map((l) => PERIOD.exec(l)).find(Boolean);
	const range = period
		? {
				from: `${period[3]}-${period[2]}-${period[1]}`,
				to: `${period[6]}-${period[5]}-${period[4]}`
			}
		: null;
	let opening: number | null = null;
	let closing: number | null = null;
	const rows: MappedRow[] = [];
	for (const line of lines) {
		if (line.startsWith('SALDO AWAL ')) opening = amountOf(line.slice(11));
		else if (line.startsWith('SALDO AKHIR ')) closing = amountOf(line.slice(12));
		else if (/^\d{2}\/\d{2} /.test(line)) {
			const m = ROW.exec(line);
			const date = m && range ? dateInPeriod(Number(m[1]), Number(m[2]), range) : null;
			rows.push(
				statementRow(rows.length, {
					date,
					direction: m ? (m[5] === 'DB' ? 'debit' : 'credit') : null,
					amount: m?.[4] ?? line.split(' ').at(-1) ?? '',
					description: m?.[3] ?? ''
				})
			);
		}
	}
	return { rows, openingBalanceMinor: opening, closingBalanceMinor: closing };
}

function parseCsvRows(table: readonly (readonly string[])[]): StatementParse {
	const rows: MappedRow[] = table.slice(1).map((r, i) => {
		const [date = '', text = '', debit = '', credit = ''] = r;
		return statementRow(i, {
			date: date.trim() || null,
			direction: debit.trim() ? 'debit' : credit.trim() ? 'credit' : null,
			amount: debit.trim() || credit.trim(),
			description: text
		});
	});
	return { rows, openingBalanceMinor: null, closingBalanceMinor: null };
}

export const FICTIONAL_BANK: StatementParser = {
	id: 'fiktif',
	label: 'Bank Contoh Fiktif',
	formats: ['pdf_text', 'csv'],
	detect(doc: StatementDocument) {
		if (doc.format === 'pdf_text') return doc.pages[0]?.includes(LETTERHEAD) ? 0.9 : 0;
		const header = (doc.rows[0] ?? []).map((c) => c.trim().toLowerCase());
		return CSV_HEADER.every((c, i) => header[i] === c) ? 0.9 : 0;
	},
	parse(doc: StatementDocument) {
		return doc.format === 'pdf_text' ? parsePdf(doc.pages) : parseCsvRows(doc.rows);
	}
};

/** The fictional statement's text lines, December 2025 into January 2026 (a year rollover). */
export const FICTIONAL_LINES = {
	head: [
		LETTERHEAD,
		'NAMA PEMILIK FIKTIF',
		'REKENING 1234567890123',
		'PERIODE 01/12/2025 - 31/01/2026',
		'SALDO AWAL 1.000.000,00'
	],
	page1: ['01/12 KOPI CONTOH 25.000,00 DB', '15/12 GAJI PT CONTOH FIKTIF 5.000.000,00 CR'],
	page2: ['31/12 LISTRIK CONTOH 200.000,00 DB', '02/01 TRANSFER KE 9876543210987 100.000,00 DB'],
	page3: ['20/01 BUNGA FIKTIF 0,00 CR', 'SALDO AKHIR 5.675.000,00']
};

/** A three-page text PDF of the fictional statement (optionally password-protected). */
export function fictionalStatementPdf(options: { password?: string; closing?: string } = {}) {
	const page3 = options.closing
		? [FICTIONAL_LINES.page3[0]!, `SALDO AKHIR ${options.closing}`]
		: FICTIONAL_LINES.page3;
	return buildPdf(
		[
			{ content: textContent([...FICTIONAL_LINES.head, ...FICTIONAL_LINES.page1]) },
			{ content: textContent(FICTIONAL_LINES.page2), flate: true },
			{ content: textContent(page3) }
		],
		{ password: options.password }
	);
}

/** The same fictional statement as a CSV export. */
export function fictionalStatementCsv(): string {
	return [
		CSV_HEADER.join(','),
		'2025-12-01,KOPI CONTOH,"25.000,00",',
		'2025-12-15,GAJI PT CONTOH FIKTIF,,"5.000.000,00"',
		'2025-12-31,LISTRIK CONTOH,"200.000,00",',
		'2026-01-02,TRANSFER KE 9876543210987,"100.000,00",'
	].join('\n');
}
