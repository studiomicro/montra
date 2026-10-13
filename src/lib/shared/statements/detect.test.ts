import { describe, expect, it } from 'vitest';
import { BNI_JUNE, bniPages } from '../../../../test/fixtures/statements/bni';
import { MANDIRI_SINGLE, mandiriPages } from '../../../../test/fixtures/statements/mandiri';
import { OCBC_SINGLE, ocbcPages } from '../../../../test/fixtures/statements/ocbc';
import { RK_JULY, rkPages } from '../../../../test/fixtures/statements/ocbc-rekening-koran';
import { TEMPLATE_COLUMNS } from '../csv';
import {
	decodeStatementText,
	detectInstitution,
	letterheadClaims,
	sniffStatementFile,
	statementHints
} from './detect';
import { STATEMENT_PARSERS } from './parsers';
import type { StatementDocument, StatementParser } from './types';

const bytes = (...b: number[]) => new Uint8Array(b);
const utf8 = (s: string) => new TextEncoder().encode(s);

function parser(id: string, score: number, formats: StatementParser['formats'] = ['pdf_text']) {
	return {
		id,
		label: id,
		formats,
		detect: () => score,
		parse: () => ({ rows: [], openingBalanceMinor: null, closingBalanceMinor: null })
	} satisfies StatementParser;
}

const pdfDoc: StatementDocument = { format: 'pdf_text', pages: ['Contoh fiktif satu dua'] };

describe('sniffStatementFile', () => {
	it('reads the kind from magic bytes, never the name or MIME type', () => {
		expect(sniffStatementFile(utf8('%PDF-1.7\n...'))).toBe('pdf');
		expect(sniffStatementFile(utf8('junk before header %PDF-1.4'))).toBe('pdf');
		expect(sniffStatementFile(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00))).toBe('xlsx');
		expect(sniffStatementFile(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0))).toBe(
			'xls'
		);
		expect(sniffStatementFile(utf8('tanggal,uraian\n2026-01-01,a\n'))).toBe('text');
		// A PNG with a .pdf name is not a PDF.
		expect(sniffStatementFile(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toBe(
			'unknown'
		);
	});

	it('does not see a PDF header past the first 1024 bytes', () => {
		expect(sniffStatementFile(utf8('a'.repeat(1100) + '%PDF-1.4'))).toBe('text');
	});
});

describe('decodeStatementText', () => {
	it('drops a UTF-8 BOM and reads BOM-marked UTF-16 LE and BE', () => {
		expect(decodeStatementText(bytes(0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62))).toBe('a,b');
		expect(decodeStatementText(bytes(0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00, 0x62, 0x00))).toBe('a,b');
		expect(decodeStatementText(bytes(0xfe, 0xff, 0x00, 0x61, 0x00, 0x2c, 0x00, 0x62))).toBe('a,b');
	});

	it('refuses Windows-1252 text (no silent mojibake) and binary with NUL bytes', () => {
		// "Café,Rp 1.000" in Windows-1252: é is the single byte 0xE9.
		const cp1252 = bytes(0x43, 0x61, 0x66, 0xe9, 0x2c, 0x52, 0x70, 0x20, 0x31, 0x2e, 0x30);
		expect(decodeStatementText(cp1252)).toBeNull();
		expect(decodeStatementText(bytes(0x61, 0x00, 0x62))).toBeNull();
	});
});

describe('detectInstitution', () => {
	it('ships only institutions proven by a real sample (owner decision A); others stay unknown', () => {
		expect(STATEMENT_PARSERS.map((p) => p.id)).toEqual(['bca', 'bni', 'mandiri', 'ocbc']);
		expect(detectInstitution(pdfDoc, STATEMENT_PARSERS)).toEqual({
			institution: null,
			confidence: 0
		});
	});

	it('picks the most confident parser at or above the threshold, for its own formats only', () => {
		const a = parser('a', 0.6);
		const b = parser('b', 0.9);
		const csvOnly = parser('c', 1, ['csv']);
		expect(detectInstitution(pdfDoc, [a, b, csvOnly]).institution?.id).toBe('b');
		expect(detectInstitution(pdfDoc, [parser('low', 0.49)]).institution).toBeNull();
		expect(detectInstitution(pdfDoc, [csvOnly]).institution).toBeNull();
	});

	it('answers unknown for a tie at the top — the user picks, it is never guessed', () => {
		expect(detectInstitution(pdfDoc, [parser('a', 0.8), parser('b', 0.8)]).institution).toBeNull();
	});

	it('ignores a NaN score', () => {
		expect(detectInstitution(pdfDoc, [parser('nan', Number.NaN)]).institution).toBeNull();
	});
});

describe('letterheadClaims (red team L3)', () => {
	const BNI_MARKERS = [
		'Laporan Mutasi Rekening',
		'PT Bank Negara Indonesia (Persero) Tbk.',
		'Tanggal & Waktu Rincian Transaksi Nominal (IDR) Saldo (IDR)'
	];
	const MANDIRI_MARKERS = [
		'Keterangan',
		'Remarks',
		'e-Statement',
		'PT Bank Mandiri (Persero) Tbk.'
	];
	const OCBC_MARKERS = [
		'LAPORAN MUTASI REKENING / ACCOUNT HISTORICAL TRANSACTION',
		'PT Bank OCBC NISP Tbk berizin'
	];
	const planted = (pages: string[], lines: string[]): StatementDocument => ({
		format: 'pdf_text',
		pages: [`${pages[0]}\n${lines.join('\n')}`, ...pages.slice(1)]
	});
	const ids = (doc: StatementDocument) => letterheadClaims(doc, STATEMENT_PARSERS).map((p) => p.id);

	it('lists only parsers at full letterhead confidence, for their own formats', () => {
		const claims = letterheadClaims(pdfDoc, [
			parser('a', 0.9),
			parser('b', 0.6),
			parser('c', 1),
			parser('d', 0.9, ['csv'])
		]);
		expect(claims.map((p) => p.id)).toEqual(['a', 'c']);
	});

	it('a genuine statement is claimed by its own bank only', () => {
		expect(ids({ format: 'pdf_text', pages: mandiriPages(MANDIRI_SINGLE) })).toEqual(['mandiri']);
		expect(ids({ format: 'pdf_text', pages: bniPages(BNI_JUNE) })).toEqual(['bni']);
		expect(ids({ format: 'pdf_text', pages: ocbcPages(OCBC_SINGLE) })).toEqual(['ocbc']);
	});

	it('another bank’s letterhead lines planted in remark text make two claims (and a detection tie)', () => {
		const mandiri = planted(mandiriPages(MANDIRI_SINGLE), BNI_MARKERS);
		const bni = planted(bniPages(BNI_JUNE), MANDIRI_MARKERS);
		expect(ids(mandiri)).toEqual(['bni', 'mandiri']);
		expect(ids(bni)).toEqual(['bni', 'mandiri']);
		expect(detectInstitution(mandiri, STATEMENT_PARSERS).institution).toBeNull();
	});

	it('OCBC letterhead lines planted in another bank’s remarks, and the reverse, make two claims', () => {
		const bni = planted(bniPages(BNI_JUNE), OCBC_MARKERS);
		const ocbc = planted(ocbcPages(OCBC_SINGLE), MANDIRI_MARKERS);
		expect(ids(bni)).toEqual(['bni', 'ocbc']);
		expect(ids(ocbc)).toEqual(['mandiri', 'ocbc']);
	});

	it('OCBC Rekening Koran letterhead lines planted in another bank’s remarks, and the reverse, make two claims (FN-16h)', () => {
		const rekeningKoran = [
			'00/00-1/1-0000 REKENING KORAN',
			'CABANG / BRANCH : 00002 - CABANG PALSU',
			'NOMOR REKENING /',
			'ACCOUNT NUMBER',
			'PT. Bank OCBC NISP Tbk'
		];
		expect(ids({ format: 'pdf_text', pages: rkPages(RK_JULY) })).toEqual(['ocbc']);
		expect(ids(planted(bniPages(BNI_JUNE), rekeningKoran))).toEqual(['bni', 'ocbc']);
		expect(ids(planted(rkPages(RK_JULY), MANDIRI_MARKERS))).toEqual(['mandiri', 'ocbc']);
		expect(ids(planted(rkPages(RK_JULY), BNI_MARKERS))).toEqual(['bni', 'ocbc']);
	});
});

describe('statementHints', () => {
	it('reports counts and shapes, never content', () => {
		expect(statementHints({ format: 'pdf_text', pages: ['a', 'b'] })).toEqual({
			format: 'pdf_text',
			pages: 2,
			columns: null,
			montraCsv: null
		});
		expect(statementHints({ format: 'csv', rows: [['x', 'y', 'z']] })).toEqual({
			format: 'csv',
			pages: null,
			columns: 3,
			montraCsv: null
		});
	});

	it('recognises FN-18’s own CSV shapes so they are never read as a bank statement', () => {
		expect(statementHints({ format: 'csv', rows: [[...TEMPLATE_COLUMNS]] }).montraCsv).toBe(
			'template'
		);
		const mm = ['Period', 'Accounts', 'Category', 'Note', 'Income/Expense', 'Amount'];
		expect(statementHints({ format: 'csv', rows: [mm] }).montraCsv).toBe('money_manager');
	});
});
