import { isDateString } from '../dates.ts';
import { parseMoneyAmount } from '../money-parse.ts';
import { statementRow } from './rows.ts';
import type {
	MappedRow,
	StatementDocument,
	StatementParse,
	StatementParser,
	StatementSection
} from './types.ts';

/**
 * Bank Mandiri e-Statement (Livin' consolidated statement, monthly text PDF) — FN-16e, written from the structure
 * of a real sample (no value from it is kept here). What the text layer looks like, one extracted line per line:
 *
 * - a page header on every page: the `e-Statement` title, the labels (`Nama/Name`, `Periode/Period`, …) and then
 *   their values, among them the period `DD Mon YYYY - DD Mon YYYY`;
 * - where an account starts (the first page of its section): `Nomor Rekening/Account Number` and its value
 *   (`<digits>:`), the currency value `: IDR`, and the summary values in this order — opening balance, `+ <dana
 *   masuk>`, `- <dana keluar>`, closing balance — followed by the product heading `<product> <ISO currency>`
 *   (`Tabungan … IDR`);
 * - the table header `No`, `Date`, `Tanggal Saldo (IDR)`, `Balance (IDR)`, `Nominal (IDR)`, `Amount (IDR)`,
 *   `Keterangan`, `Remarks`, repeated on continuation pages (which carry no account block);
 * - one transaction per block: the remark lines, the amount line `[<remark tail>] <saldo><No> <+|-><nominal>` (the
 *   row number is printed right after the balance's two decimals, without a space), then `HH:MM:SS WIB`, then the
 *   date `DD Mon YYYY`, which ends the row;
 * - amounts as `1.234.567,89` (dot thousands, comma cents); the bank's footer `PT Bank Mandiri (Persero) Tbk. …`
 *   closes every page.
 *
 * "Consolidated" means one file may hold several accounts. A section opens at an account block (or product
 * heading) right before a table; a table with no account block before it continues the open section. Only
 * savings and current accounts (`Tabungan…`, `Giro…`) in IDR are importable; any other section (a deposit, a card,
 * an investment, a foreign-currency account) is listed but never read into transactions, and a summary with no
 * table is not a section at all. The /impor flow imports one section into the chosen wallet (read.ts).
 * The sample held one savings section; the multi-account shape is inferred from it and fails closed.
 *
 * Remark lines are written by third parties (sender, transfer note), so nothing in them may decide an amount (red
 * team M1, FN-16b): a remark line shaped like an amount line makes its row unreadable, and a section is only
 * imported when it checks out against itself — every row's printed running balance, the row numbers 1…n, the
 * printed opening and closing balances and the `Dana Masuk`/`Dana Keluar` totals match the rows exactly in integer
 * minor units, every row is readable and dated inside the one printed period, and every currency it prints is
 * IDR. Otherwise the section is `inconsistent` and refused as a whole, never imported with a warning.
 */

const AMOUNT = String.raw`\d{1,3}(?:\.\d{3})*,\d{2}`;
/** A row's amount line: an optional remark tail, the running balance with the row number glued on, the nominal. */
const ROW_AMOUNT = new RegExp(String.raw`^(?:(.*\S)\s+)?(${AMOUNT})(\d{1,5})\s+([+-])(${AMOUNT})$`);
const TIME = /^\d{2}:\d{2}:\d{2} WIB$/;
const DATE = /^(\d{2}) ([A-Za-z]{3}) (\d{4})$/;
const PERIOD = /^(\d{2} [A-Za-z]{3} \d{4}) - (\d{2} [A-Za-z]{3} \d{4})$/;
const ACCOUNT_LABEL = 'Nomor Rekening/Account Number';
/** The account number value: the digits, the label's colon glued before or after. */
const ACCOUNT_VALUE = /^:?\s*(\d{6,20})\s*:?$/;
const CURRENCY_VALUE = /^:\s*([A-Z]{3})$/;
/** A currency printed in a table header (`Saldo (IDR)`, `Nominal (IDR)`). */
const HEADER_CURRENCY = /\b(?:Saldo|Balance|Nominal|Amount) \(([A-Z]{3})\)$/;
const SUMMARY_PLAIN = new RegExp(String.raw`^(${AMOUNT})$`);
const SUMMARY_IN = new RegExp(String.raw`^\+ ?(${AMOUNT})$`);
const SUMMARY_OUT = new RegExp(String.raw`^- ?(${AMOUNT})$`);
/** ISO codes a Mandiri product heading may end with; anything else is not a heading. */
const HEADING =
	/^([A-Za-z][A-Za-z0-9' &.-]{1,60}?) (IDR|USD|SGD|EUR|JPY|AUD|CNY|HKD|TWD|GBP|SAR|MYR|CHF)$/;
/** Savings and current accounts: the only sections whose table is read into transactions. */
const TRANSACTION_ACCOUNT = /(?:^|\s)(?:Tabungan|Giro)/i;
/** Labels of the account block: inside a table they end it (the next account starts on the same page). */
const BLOCK_LABELS = new Set(['Nama/Name', 'Periode/Period', ACCOUNT_LABEL]);
const FOOTER = 'PT Bank Mandiri (Persero) Tbk.';
/** Most sections one file may hold; past it the file is refused (bounded work). */
export const MANDIRI_MAX_SECTIONS = 20;

const MONTHS: Readonly<Record<string, number>> = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	mei: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	agu: 8,
	agt: 8,
	sep: 9,
	oct: 10,
	okt: 10,
	nov: 11,
	dec: 12,
	des: 12
};

/** A page's text as trimmed, single-spaced, non-empty lines. */
const linesOf = (page: string) =>
	page
		.split('\n')
		.map((l) => l.replace(/\s+/g, ' ').trim())
		.filter((l) => l !== '');

const amountOf = (text: string) => parseMoneyAmount(text)?.minor ?? null;

/** `05 Aug 2026` / `05 Agu 2026` → `2026-08-05`, or null. */
function dateOf(printed: string): string | null {
	const m = DATE.exec(printed);
	const month = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
	if (!m || !month) return null;
	const date = `${m[3]}-${String(month).padStart(2, '0')}-${m[1]}`;
	return isDateString(date) ? date : null;
}

interface Summary {
	opening: number | null;
	credit: number | null;
	debit: number | null;
	closing: number | null;
}

/** What an account block printed before its table; each distinct value is kept, so a disagreement is visible. */
interface Block {
	heading: { label: string; currency: string } | null;
	accounts: Set<string>;
	currencies: Set<string>;
	summaries: Summary[];
}

const emptyBlock = (): Block => ({
	heading: null,
	accounts: new Set(),
	currencies: new Set(),
	summaries: []
});

interface RawSection {
	block: Block;
	/** Currencies of every table header the section's rows were printed under. */
	tableCurrencies: Set<string>;
	/** Each row's lines, the date line last. */
	rows: string[][];
	/** Leftover lines at a table's end looked like part of a row (a row cut off): the section is unreadable. */
	broken: boolean;
	/** An account-block label ended the table (a next account on the same page): the section must be complete. */
	endedByLabel: boolean;
}

interface Segmented {
	sections: RawSection[];
	periods: Set<string>;
	/** Rows before any section, a row amount line outside a table, or too many sections: the file is refused. */
	broken: boolean;
}

/** Splits the pages into account sections and their raw rows, collecting what each block printed. */
function segment(pages: readonly string[]): Segmented {
	const out: Segmented = { sections: [], periods: new Set(), broken: false };
	let pending = emptyBlock();
	let current: RawSection | null = null;
	for (const lines of pages.map(linesOf)) {
		let inTable = false;
		let buffer: string[] = [];
		const pageCurrencies = new Set<string>();
		const closeTable = () => {
			// Lines after the last row (the footer, notes) are dropped; an amount or time line there is a cut row.
			if (current && buffer.some((l) => ROW_AMOUNT.test(l) || TIME.test(l))) current.broken = true;
			buffer = [];
			inTable = false;
		};
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (inTable) {
				if (BLOCK_LABELS.has(line)) {
					// Remark text can equal a label (red team M1, FN-16e): a label inside a row, or one that cuts a
					// section short (checked in parsePdf), refuses the whole file instead of opening a new section.
					if (buffer.length > 0) out.broken = true;
					if (current) current.endedByLabel = true;
					closeTable();
					continue;
				}
				buffer.push(line);
				if (DATE.test(line)) {
					current?.rows.push(buffer);
					buffer = [];
				}
				continue;
			}
			// A row's amount line outside a table is a row a label cut out of its table (red team M1, FN-16e): even
			// when what is left still checks out (a cut zero-amount row), the file's structure is in doubt.
			if (ROW_AMOUNT.test(line)) out.broken = true;
			const period = PERIOD.exec(line);
			if (period) out.periods.add(`${period[1]} - ${period[2]}`);
			const account = ACCOUNT_VALUE.exec(line);
			const currency = CURRENCY_VALUE.exec(line);
			const summaryStart = SUMMARY_PLAIN.test(line) && SUMMARY_IN.test(lines[i + 1] ?? '');
			// A block that ended with its heading and no table (a card or investment summary) is not a section:
			// the next block's values start afresh instead of mixing with it.
			if ((account || currency || summaryStart) && pending.heading) pending = emptyBlock();
			if (account) pending.accounts.add(account[1]!);
			if (currency) pending.currencies.add(currency[1]!);
			const headerCurrency = HEADER_CURRENCY.exec(line);
			if (headerCurrency) pageCurrencies.add(headerCurrency[1]!);
			const heading = HEADING.exec(line);
			if (heading) pending.heading = { label: heading[1]!, currency: heading[2]! };
			if (
				SUMMARY_PLAIN.test(line) &&
				SUMMARY_IN.test(lines[i + 1] ?? '') &&
				SUMMARY_OUT.test(lines[i + 2] ?? '') &&
				SUMMARY_PLAIN.test(lines[i + 3] ?? '')
			) {
				pending.summaries.push({
					opening: amountOf(line),
					credit: amountOf(SUMMARY_IN.exec(lines[i + 1]!)![1]!),
					debit: amountOf(SUMMARY_OUT.exec(lines[i + 2]!)![1]!),
					closing: amountOf(lines[i + 3]!)
				});
				i += 3;
				continue;
			}
			if (line === 'Remarks' && lines[i - 1] === 'Keterangan') {
				const opensSection =
					pending.heading !== null || pending.accounts.size > 0 || pending.summaries.length > 0;
				if (opensSection) {
					if (out.sections.length >= MANDIRI_MAX_SECTIONS) out.broken = true;
					current = {
						block: pending,
						tableCurrencies: new Set(),
						rows: [],
						broken: false,
						endedByLabel: false
					};
					out.sections.push(current);
					pending = emptyBlock();
				} else if (!current) out.broken = true;
				for (const c of pageCurrencies) current?.tableCurrencies.add(c);
				pageCurrencies.clear();
				inTable = true;
			}
		}
		if (inTable) closeTable();
	}
	return out;
}

interface ReadRow {
	row: MappedRow;
	/** Printed row number and running balance; null when the row is unreadable. */
	no: number | null;
	balance: number | null;
}

/** One raw row → its MappedRow, row number and printed balance. */
function readRow(index: number, lines: readonly string[], period: Period | null): ReadRow {
	const reject = (reason: 'missing_amount' | 'unparseable_amount' | 'unparseable_date') => ({
		row: { index, ok: false as const, reason },
		no: null,
		balance: null
	});
	const n = lines.length;
	const amount = n >= 3 ? ROW_AMOUNT.exec(lines[n - 3]!) : null;
	if (!amount || !TIME.test(lines[n - 2]!)) return reject('missing_amount');
	const remarks = lines.slice(0, n - 3);
	// A remark imitating an amount or time line is third-party text: unreadable, never "the last one wins".
	if (remarks.some((l) => ROW_AMOUNT.test(l) || TIME.test(l))) return reject('unparseable_amount');
	const date = dateOf(lines[n - 1]!);
	if (!date || !period || date < period.from || date > period.to) return reject('unparseable_date');
	const description = [...remarks, ...(amount[1] ? [amount[1]] : [])].join(' ');
	return {
		row: statementRow(index, {
			date,
			direction: amount[4] === '-' ? 'debit' : 'credit',
			amount: amount[5]!,
			description
		}),
		no: Number(amount[3]),
		balance: amountOf(amount[2]!)
	};
}

interface Period {
	from: string;
	to: string;
}

function periodOf(printed: string | null): Period | null {
	const [from, to] = (printed ?? '').split(' - ').map(dateOf);
	return from && to && from <= to ? { from, to } : null;
}

function only<T>(set: ReadonlySet<T>): T | null {
	return set.size === 1 ? [...set][0]! : null;
}

/**
 * One raw section → its reading and whether it may be imported, plus whether it checks out against itself
 * whatever its kind; `nextIndex` keeps row indices file-unique.
 */
function readSection(
	raw: RawSection,
	period: Period | null,
	nextIndex: number
): { section: StatementSection; checksOut: boolean } {
	const { block } = raw;
	const label = block.heading?.label ?? '';
	const account = only(block.accounts);
	const summary = block.summaries.length === 1 ? block.summaries[0]! : null;
	const read = raw.rows.map((lines, i) => readRow(nextIndex + i, lines, period));
	const currencies = new Set([
		...block.currencies,
		...raw.tableCurrencies,
		...(block.heading ? [block.heading.currency] : [])
	]);
	const foreign = [...currencies].some((c) => c !== 'IDR');
	const checksOut =
		!raw.broken &&
		block.accounts.size === 1 &&
		block.currencies.size === 1 &&
		raw.tableCurrencies.size === 1 &&
		summary !== null &&
		consistent(read, summary);
	let refusal: StatementSection['refusal'] = null;
	if (foreign) refusal = 'unsupported_currency';
	else if (!TRANSACTION_ACCOUNT.test(label)) refusal = 'not_transaction_account';
	else if (!checksOut) refusal = 'inconsistent';
	const section: StatementSection = {
		label,
		accountLast4: account ? account.slice(-4) : null,
		refusal,
		parse: {
			rows: foreign
				? read.map((r) => ({ index: r.row.index, ok: false, reason: 'unsupported_currency' }))
				: read.map((r) => r.row),
			openingBalanceMinor: foreign ? null : (summary?.opening ?? null),
			closingBalanceMinor: foreign ? null : (summary?.closing ?? null),
			inconsistent: refusal !== null
		}
	};
	return { section, checksOut };
}

/** The section checks out against itself (see the module comment); any doubt is false. */
function consistent(read: readonly ReadRow[], summary: Summary): boolean {
	const { opening, credit, debit, closing } = summary;
	if (opening === null || credit === null || debit === null || closing === null) return false;
	let running = opening;
	let credits = 0;
	let debits = 0;
	for (const [i, r] of read.entries()) {
		if (!r.row.ok || r.no !== i + 1) return false;
		const amount = r.row.value.amountMinor;
		if (r.row.value.type === 'income') {
			running += amount;
			credits += amount;
		} else {
			running -= amount;
			debits += amount;
		}
		if (!Number.isSafeInteger(running) || r.balance !== running) return false;
	}
	return running === closing && credits === credit && debits === debit;
}

function parsePdf(pages: readonly string[]): StatementParse {
	const segmented = segment(pages);
	const onePeriod = only(segmented.periods);
	const period = periodOf(onePeriod);
	const sections: StatementSection[] = [];
	let nextIndex = 0;
	let structure = !segmented.broken;
	const accounts = new Set<string>();
	for (const raw of segmented.sections.slice(0, MANDIRI_MAX_SECTIONS)) {
		const { section, checksOut } = readSection(raw, period, nextIndex);
		sections.push(section);
		nextIndex += raw.rows.length;
		// A section a label ended early, or two sections of one account (one of them forged from remark text,
		// and the picker could not tell them apart): the file's structure is in doubt.
		if (raw.endedByLabel && !checksOut) structure = false;
		for (const account of raw.block.accounts) {
			if (accounts.has(account)) structure = false;
			accounts.add(account);
		}
	}
	return {
		rows: [],
		openingBalanceMinor: null,
		closingBalanceMinor: null,
		// Pages disagreeing on the period, rows outside any section, too many sections, a section cut by a label
		// or an account printed twice refuse the whole file.
		inconsistent: !structure || period === null || sections.length === 0,
		sections
	};
}

export const MANDIRI: StatementParser = {
	id: 'mandiri',
	label: 'Mandiri',
	formats: ['pdf_text'],
	detect(doc: StatementDocument) {
		if (doc.format !== 'pdf_text') return 0;
		const lines = doc.pages.flatMap(linesOf);
		const header = lines.some((l, i) => l === 'Remarks' && lines[i - 1] === 'Keterangan');
		const letterhead = lines.includes('e-Statement') && lines.some((l) => l.startsWith(FOOTER));
		return header && letterhead ? 0.9 : 0;
	},
	parse(doc: StatementDocument) {
		return doc.format === 'pdf_text'
			? parsePdf(doc.pages)
			: { rows: [], openingBalanceMinor: null, closingBalanceMinor: null, inconsistent: true };
	}
};
