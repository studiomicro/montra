import { describe, expect, it } from 'vitest';
import {
	csvCell,
	csvLine,
	detectCsvFormat,
	formatCsvAmount,
	headerFits,
	headerIndex,
	mapMoneyManagerRow,
	mapTemplateRow,
	parseCsv,
	parseCsvDate,
	readCsv,
	summarizeReading,
	TEMPLATE_COLUMNS
} from './csv.ts';

const TEMPLATE_HEADER = [...TEMPLATE_COLUMNS];
const MM_HEADER = [
	'Period',
	'Accounts',
	'Category',
	'Note',
	'Income/Expense',
	'Amount',
	'Currency'
];

const rows = (text: string) => {
	const r = parseCsv(text);
	if (!r.ok) throw new Error(r.error);
	return r.rows;
};

describe('parseCsv', () => {
	it('reads comma and semicolon files with the same content, the delimiter detected from the header', () => {
		const comma = 'date,type,merchant,amount\n2026-10-01,expense,Kopi,28000\n';
		const semi = 'date;type;merchant;amount\n2026-10-01;expense;Kopi;28000\n';
		expect(rows(comma)).toEqual(rows(semi));
		expect(rows(semi)).toEqual([
			['date', 'type', 'merchant', 'amount'],
			['2026-10-01', 'expense', 'Kopi', '28000']
		]);
	});

	it('keeps a quoted delimiter, an escaped quote and an embedded line break inside one field', () => {
		const text = 'a,b,c\r\n"Toko, Serba Ada","say ""hi""","line one\nline two"\r\n';
		expect(rows(text)).toEqual([
			['a', 'b', 'c'],
			['Toko, Serba Ada', 'say "hi"', 'line one\nline two']
		]);
	});

	it('keeps a semicolon file with decimal commas in quoted amounts', () => {
		expect(rows('date;amount\n2026-10-01;"28.000,00"')).toEqual([
			['date', 'amount'],
			['2026-10-01', '28.000,00']
		]);
	});

	it('drops a UTF-8 BOM, reads CR-only line ends and a last line without a break', () => {
		expect(rows('\uFEFFdate,amount\r2026-10-01,5\r2026-10-02,6')).toEqual([
			['date', 'amount'],
			['2026-10-01', '5'],
			['2026-10-02', '6']
		]);
	});

	it('literalQuotes reads a `"` as text: one record per line, cells end at the delimiter (FN-16c L1)', () => {
		expect(parseCsv('a,b\nx,"A\n"q;r",2\n', { literalQuotes: true })).toEqual({
			ok: true,
			rows: [
				['a', 'b'],
				['x', '"A'],
				['"q;r"', '2']
			],
			more: 0
		});
		expect(parseCsv('"a;b",c;d\n', { literalQuotes: true })).toMatchObject({
			rows: [['"a', 'b",c', 'd']]
		});
	});

	it('refuses an empty file, an unterminated quote and a row wider than the column cap', () => {
		expect(parseCsv('')).toEqual({ ok: false, error: 'empty' });
		expect(parseCsv('\uFEFF  \n')).toEqual({ ok: false, error: 'empty' });
		expect(parseCsv('a,b\n"open,1\n')).toEqual({ ok: false, error: 'unterminated_quote' });
		expect(parseCsv(Array.from({ length: 51 }, () => 'x').join(','))).toEqual({
			ok: false,
			error: 'too_many_columns'
		});
		expect(parseCsv('a\n' + Array.from({ length: 51 }, () => 'x').join(',') + '\n')).toEqual({
			ok: false,
			error: 'too_many_columns'
		});
	});

	it('drops blank lines: they never count toward the cap or the rest (red team L6)', () => {
		const text = 'h\n' + '\n'.repeat(10) + ' , \n1\n\n2\n,,\n3\n';
		const r = parseCsv(text, { maxRows: 2 });
		expect(r).toEqual({ ok: true, rows: [['h'], ['1'], ['2']], more: 1 });
		const blanks = parseCsv('h\n' + '\n'.repeat(6000) + 'x\n');
		expect(blanks).toEqual({ ok: true, rows: [['h'], ['x']], more: 0 });
	});

	it('keeps the header plus maxRows records and counts the rest', () => {
		const text = 'h\n' + Array.from({ length: 7 }, (_, i) => String(i)).join('\n');
		const r = parseCsv(text, { maxRows: 5 });
		expect(r.ok && r.rows.length).toBe(6);
		expect(r.ok && r.more).toBe(2);
	});
});

describe('detectCsvFormat', () => {
	it('recognises the template (full or minimum set, any case) and Money Manager', () => {
		expect(detectCsvFormat(TEMPLATE_HEADER)).toBe('template');
		expect(detectCsvFormat(['DATE', ' Type ', 'Merchant', 'amount'])).toBe('template');
		expect(detectCsvFormat(MM_HEADER)).toBe('money_manager');
		expect(detectCsvFormat(MM_HEADER.map((h) => h.toLowerCase()))).toBe('money_manager');
	});

	it('answers null for neither (the user then picks)', () => {
		expect(detectCsvFormat(['tanggal', 'jumlah'])).toBeNull();
		expect(detectCsvFormat(['date', 'type', 'amount'])).toBeNull();
		expect(detectCsvFormat([])).toBeNull();
	});

	it('headerFits tells whether a manual override fits the file', () => {
		expect(headerFits(TEMPLATE_HEADER, 'template')).toBe(true);
		expect(headerFits(TEMPLATE_HEADER, 'money_manager')).toBe(false);
	});

	it('header names are matched without prototype keys', () => {
		const index = headerIndex(['constructor', '__proto__', 'date']);
		expect(index.get('date')).toBe(2);
		expect(index.get('toString')).toBeUndefined();
	});
});

describe('parseCsvDate', () => {
	it('reads ISO and day-first dates, ignoring a time after them', () => {
		expect(parseCsvDate('2026-10-01')).toBe('2026-10-01');
		expect(parseCsvDate('01/10/2026')).toBe('2026-10-01');
		expect(parseCsvDate('1/2/2026')).toBe('2026-02-01');
		expect(parseCsvDate(' 31/12/2026 23:30:00 ')).toBe('2026-12-31');
		expect(parseCsvDate('2026-10-01 08:15')).toBe('2026-10-01');
	});

	it('refuses anything else and impossible dates', () => {
		for (const bad of ['not a date', '', '2026/10/01', '10-01-2026', '31/02/2026', '2026-13-01'])
			expect(parseCsvDate(bad)).toBeNull();
	});
});

const T = headerIndex(TEMPLATE_HEADER);
const tRow = (over: Partial<Record<(typeof TEMPLATE_COLUMNS)[number], string>>) =>
	TEMPLATE_COLUMNS.map((c) => over[c] ?? '');

describe('mapTemplateRow', () => {
	it('maps every template column', () => {
		const r = mapTemplateRow(
			tRow({
				date: '01/10/2026',
				type: 'Pemasukan',
				merchant: 'Kantor',
				amount: 'Rp 1.250.000',
				currency: 'IDR',
				category: 'Gaji',
				payment_method: 'Transfer',
				recurrence: 'bulanan',
				tag: 'kerja',
				notes: 'Oktober',
				wallet_source: 'BCA',
				reference: 'REF-1'
			}),
			T
		);
		expect(r).toEqual({
			date: '2026-10-01',
			type: 'income',
			title: 'Kantor',
			amountMinor: 125_000_000,
			currency: 'IDR',
			categoryName: 'Gaji',
			walletName: 'BCA',
			paymentMethod: 'Transfer',
			recurrence: 'bulanan',
			tag: 'kerja',
			notes: 'Oktober',
			reference: 'REF-1'
		});
	});

	it('skips transfers and unknown types', () => {
		for (const type of ['transfer', 'Transfer-Out', '', 'refund'])
			expect(mapTemplateRow(tRow({ date: '2026-10-01', type, amount: '5000' }), T)).toBe(
				'transfer'
			);
	});

	it('falls back from an empty wallet_source to payment_method', () => {
		const r = mapTemplateRow(
			tRow({ date: '2026-10-01', type: 'expense', amount: '5000', payment_method: 'GoPay' }),
			T
		);
		expect(typeof r !== 'string' && r.walletName).toBe('GoPay');
	});

	it('never guesses a missing or unreadable date or amount', () => {
		expect(mapTemplateRow(tRow({ type: 'expense', amount: '5000' }), T)).toBe('missing_date');
		expect(mapTemplateRow(tRow({ date: 'kemarin', type: 'expense', amount: '5000' }), T)).toBe(
			'unparseable_date'
		);
		expect(mapTemplateRow(tRow({ date: '2026-10-01', type: 'expense' }), T)).toBe('missing_amount');
		for (const amount of ['abc', '1.250.00', '0', 'Rp'])
			expect(mapTemplateRow(tRow({ date: '2026-10-01', type: 'expense', amount }), T)).toBe(
				'unparseable_amount'
			);
	});

	it('reads every FEATURES.md amount vector through the shared money parser', () => {
		for (const [amount, minor] of [
			['28000', 2_800_000],
			['28.000', 2_800_000],
			['Rp 28.000,00', 2_800_000],
			['28000.50', 2_800_050],
			['-28.000', 2_800_000],
			['IDR 1,250,000.00', 125_000_000]
		] as const) {
			const r = mapTemplateRow(tRow({ date: '2026-10-01', type: 'expense', amount }), T);
			expect(typeof r !== 'string' && r.amountMinor).toBe(minor);
		}
	});

	it('skips a currency other than IDR', () => {
		expect(
			mapTemplateRow(tRow({ date: '2026-10-01', type: 'expense', amount: '5', currency: 'USD' }), T)
		).toBe('unsupported_currency');
	});

	it("reads a guarded fullwidth or space-led formula back without its '", () => {
		for (const v of ['\uFF1Dx', ' =x']) {
			const r = mapTemplateRow(
				tRow({ date: '2026-10-01', type: 'expense', amount: '5000', reference: "'" + v }),
				T
			);
			expect(typeof r !== 'string' && r.reference).toBe(v);
		}
	});

	it("reads an exported formula guard back without its '", () => {
		const r = mapTemplateRow(
			tRow({ date: '2026-10-01', type: 'expense', amount: '5000', merchant: "'=SUM(A1)" }),
			T
		);
		expect(typeof r !== 'string' && r.title).toBe('=SUM(A1)');
	});
});

describe('mapMoneyManagerRow', () => {
	const M = headerIndex([...MM_HEADER, 'Description']);
	const mm = (cells: string[]) => mapMoneyManagerRow(cells, M);

	it('maps Note to the title, the part before / to the category, Income/Expense to the type', () => {
		expect(
			mm([
				'2026-10-01 12:00:00',
				'Cash',
				'Food/Groceries',
				'Pasar',
				'Exp.',
				'45000',
				'IDR',
				'sayur'
			])
		).toEqual({
			date: '2026-10-01',
			type: 'expense',
			title: 'Pasar',
			amountMinor: 4_500_000,
			currency: 'IDR',
			categoryName: 'Food',
			walletName: 'Cash',
			paymentMethod: '',
			recurrence: '',
			tag: '',
			notes: 'sayur',
			reference: ''
		});
		const income = mm(['01/10/2026', 'BCA', 'Salary', 'Gaji', 'Income', '10.000.000', '', '']);
		expect(typeof income !== 'string' && income.type).toBe('income');
	});

	it('skips transfers, non-IDR rows and rows without a date or amount', () => {
		expect(mm(['2026-10-01', 'Cash', 'x', 'y', 'Transfer-Out', '5', 'IDR'])).toBe('transfer');
		expect(mm(['2026-10-01', 'Cash', 'x', 'y', 'Expense', '5', 'USD'])).toBe(
			'unsupported_currency'
		);
		expect(mm(['', 'Cash', 'x', 'y', 'Expense', '5', 'IDR'])).toBe('missing_date');
		expect(mm(['2026-10-01', 'Cash', 'x', 'y', 'Expense', '', 'IDR'])).toBe('missing_amount');
	});
});

describe('readCsv and summarizeReading', () => {
	it('maps every non-blank record with its file position, the same on device and server', () => {
		const text =
			'date,type,merchant,amount,wallet_source\n' +
			'2026-10-01,expense,Kopi,28000,Tunai\n' +
			'\n' +
			'2026-10-01,transfer,Pindah,5000,\n' +
			'2026-10-02,expense,Roti,abc,\n' +
			'2026-10-03,income,Gaji,1000000,\n';
		const r = readCsv(text);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.reading.detected).toBe('template');
		// The blank line is not a record: positions count non-blank records only.
		expect(r.reading.rows.map((x) => x.index)).toEqual([0, 1, 2, 3]);
		expect(summarizeReading(r.reading)).toEqual({
			rows: 4,
			ready: 2,
			transfers: 1,
			invalid: 1,
			foreignCurrency: 0,
			withoutWallet: 1
		});
	});

	it('maps nothing without a format, and refuses an override that does not fit', () => {
		const r = readCsv('tanggal,jumlah\n2026-10-01,5\n');
		expect(r.ok && r.reading.detected).toBeNull();
		expect(r.ok && r.reading.rows).toEqual([]);
		expect(readCsv('tanggal,jumlah\n2026-10-01,5\n', 'template')).toEqual({
			ok: false,
			error: 'format_mismatch'
		});
	});
});

describe('formula guard round trip (cycle 3)', () => {
	it("export then import gives back =x, '=x, '-5, -5 and plain text exactly", () => {
		for (const v of ['=x', "'=x", "'-5", '-5', "''+1", "'hello", 'Kopi', '\uFF1Dx']) {
			const exported = csvLine(['2026-10-01', 'expense', v, '5000']);
			const parsed = parseCsv('date,type,merchant,amount\n' + exported);
			if (!parsed.ok) throw new Error(parsed.error);
			const r = mapTemplateRow(parsed.rows[1]!, headerIndex(parsed.rows[0]!));
			expect(typeof r !== 'string' && r.title).toBe(v);
		}
	});

	it("guards a value that already starts with ' before a formula", () => {
		expect(csvCell("'=x")).toBe("''=x");
		expect(csvCell("'hello")).toBe("'hello");
	});
});

describe('export cells', () => {
	it("neutralises every formula start (= + - @ tab CR) with a leading ' before quoting", () => {
		expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
		expect(csvCell('+1')).toBe("'+1");
		expect(csvCell('-1')).toBe("'-1");
		expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
		expect(csvCell('\tx')).toBe("'\tx");
		expect(csvCell('\rx')).toBe(`"'\rx"`);
		expect(csvCell('Kopi')).toBe('Kopi');
		expect(csvCell('Toko, Serba Ada')).toBe('"Toko, Serba Ada"');
	});

	it('also neutralises fullwidth = + - @, a leading LF, and any trigger after leading spaces (red team L4)', () => {
		for (const v of [
			'\uFF1D1+1',
			'\uFF0Bcmd',
			'\uFF0D2',
			'\uFF20SUM(A1)',
			'\n=1',
			'\nplain',
			' =1+1',
			'  @x',
			'\u3000\uFF1Dx'
		])
			expect(csvCell(v).replace(/^"/, '').startsWith("'")).toBe(true);
		expect(csvCell('Kopi =1')).toBe('Kopi =1');
		expect(csvCell(' Kopi')).toBe(' Kopi');
	});

	it('writes CRLF lines that parse back to the same cells', () => {
		const cells = ['a,b', 'say "hi"', 'x;y', 'plain'];
		const line = csvLine(cells);
		expect(line.endsWith('\r\n')).toBe(true);
		expect(rows(line)).toEqual([cells]);
	});

	it('formats amounts exactly, with sen only when present', () => {
		expect(formatCsvAmount(2_800_000, 'IDR')).toBe('28000');
		expect(formatCsvAmount(2_800_050, 'IDR')).toBe('28000.50');
		expect(formatCsvAmount(5, 'IDR')).toBe('0.05');
		expect(formatCsvAmount(10_000_000_000_000, 'IDR')).toBe('100000000000');
		expect(formatCsvAmount(1500, 'JPY')).toBe('1500');
		expect(() => formatCsvAmount(0.5, 'IDR')).toThrow(RangeError);
	});
});
