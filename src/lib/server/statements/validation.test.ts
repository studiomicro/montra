import { describe, expect, it } from 'vitest';
import { parseStatementFields } from './validation';

const form = (fields: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.append(k, v);
	return f;
};

describe('parseStatementFields: the picked account of a multi-account statement (FN-16e)', () => {
	it('reads no pick as null and a position as its number', () => {
		expect(parseStatementFields(form({}))).toMatchObject({ ok: true, value: { section: null } });
		expect(parseStatementFields(form({ statementSection: '0' }))).toMatchObject({
			ok: true,
			value: { section: 0 }
		});
		expect(parseStatementFields(form({ statementSection: '19' }))).toMatchObject({
			ok: true,
			value: { section: 19 }
		});
	});

	it('refuses anything else with "choose an account from the list"', () => {
		for (const bad of ['-1', '1.5', 'x', '100', ' 1', '0x1', '1e1'])
			expect(parseStatementFields(form({ statementSection: bad })), bad).toEqual({
				ok: false,
				error: 'Pilih rekening dari daftar.'
			});
	});
});

// QA (FN-16i): the Impor picker now lists every FN-04 institution, most of them disabled with no real parser.
// A disabled row is never rendered as a choosable option and the no-JS <select> omits it, but this is the
// server-side backstop a crafted post still has to pass: only an id STATEMENT_PARSERS knows is ever accepted.
describe('parseStatementFields: an institution without a parser is refused (FN-16i disabled rows)', () => {
	it('accepts every STATEMENT_PARSERS id and empty (auto-detect)', () => {
		expect(parseStatementFields(form({ institution: '' }))).toMatchObject({
			ok: true,
			value: { institution: null }
		});
		for (const id of ['bca', 'mandiri', 'bni', 'ocbc'])
			expect(parseStatementFields(form({ institution: id })), id).toMatchObject({
				ok: true,
				value: { institution: id }
			});
	});

	it('refuses a disabled-row id the catalogue names but no parser reads (BRI, GoPay, Lainnya, …)', () => {
		for (const id of [
			'bri',
			'jago',
			'bsi',
			'cimb',
			'permata',
			'jenius',
			'seabank',
			'gopay',
			'ovo',
			'dana',
			'shopeepay',
			'other'
		])
			expect(parseStatementFields(form({ institution: id })), id).toEqual({
				ok: false,
				error: 'Pilih institusi dari daftar.'
			});
	});
});
