import { parseMoneyAmount } from './money-parse.ts';
import { isDateString } from './dates.ts';
import { currencyExponent } from './money-format.ts';
import { maskAccountNumbers } from './text.ts';

/**
 * CSV import and export (FN-18), shared by the browser (instant preview) and the app Worker (the authoritative
 * import, which re-parses the raw text from scratch). Pure: no D1, Workers or DOM dependency.
 */

/** The two fixed column shapes FN-18 reads (docs/FEATURES.md FN-18). */
export const CSV_FORMATS = ['template', 'money_manager'] as const;
export type CsvFormat = (typeof CSV_FORMATS)[number];

/** Where an import batch came from; FN-18 writes only `csv`, the rest are schema-ready for FN-16/17/19. */
export const IMPORT_SOURCES = ['csv', 'statement', 'spreadsheet', 'gmail_lookback'] as const;

/** Largest file one import request reads (owner decision B). */
export const CSV_MAX_BYTES = 5 * 1024 * 1024;
/** Most data rows one import request processes; the rest are counted as "not processed" (owner decision B). */
export const CSV_MAX_ROWS = 5000;
/** Most columns one row may have; a wider file is refused whole. */
export const CSV_MAX_COLUMNS = 50;

/** The template's column order (docs/FEATURES.md FN-18); export writes exactly these. */
export const TEMPLATE_COLUMNS = [
	'date',
	'type',
	'merchant',
	'amount',
	'currency',
	'category',
	'payment_method',
	'recurrence',
	'tag',
	'notes',
	'wallet_source',
	'reference'
] as const;
const TEMPLATE_REQUIRED = ['date', 'type', 'merchant', 'amount'];
const MONEY_MANAGER_REQUIRED = [
	'period',
	'accounts',
	'category',
	'note',
	'income/expense',
	'amount'
];

export type CsvParseError = 'empty' | 'unterminated_quote' | 'too_many_columns';

export type CsvParseResult =
	| {
			ok: true;
			/** The header row followed by at most `maxRows` non-blank records (blank lines are dropped). */
			rows: string[][];
			/** Records past `maxRows` that were counted but not kept. */
			more: number;
	  }
	| { ok: false; error: CsvParseError };

/** `;` when the header line (outside quotes) has more semicolons than commas, else `,`. */
function detectDelimiter(text: string, literalQuotes: boolean): ',' | ';' {
	let commas = 0;
	let semicolons = 0;
	let quoted = false;
	for (const ch of text) {
		if (ch === '"' && !literalQuotes) quoted = !quoted;
		else if (!quoted && (ch === '\n' || ch === '\r')) break;
		else if (!quoted && ch === ',') commas++;
		else if (!quoted && ch === ';') semicolons++;
	}
	return semicolons > commas ? ';' : ',';
}

/**
 * RFC 4180-style reader: a quoted field may hold the delimiter, a line break or an escaped `""`; CRLF, LF and CR
 * all end a record; a leading UTF-8 BOM is dropped; the delimiter (comma or semicolon) is read from the header
 * line. Blank lines are dropped. Keeps the header plus at most `maxRows` records and only counts the rest. An unterminated quote or a row
 * wider than `maxColumns` refuses the whole file (never a partial guess). `literalQuotes`: a `"` is plain text (a
 * record is one line and a cell ends at the delimiter), for a file whose quotes do not pair up.
 */
export function parseCsv(
	input: string,
	limits: { maxRows?: number; maxColumns?: number; literalQuotes?: boolean } = {}
): CsvParseResult {
	const maxRows = limits.maxRows ?? CSV_MAX_ROWS;
	const maxColumns = limits.maxColumns ?? CSV_MAX_COLUMNS;
	const literalQuotes = limits.literalQuotes ?? false;
	const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
	if (text.trim() === '') return { ok: false, error: 'empty' };
	const delimiter = detectDelimiter(text, literalQuotes);
	const rows: string[][] = [];
	let more = 0;
	let row: string[] = [];
	let field = '';
	let quoted = false;
	let i = 0;
	const endRecord = (): boolean => {
		row.push(field);
		field = '';
		if (row.length > maxColumns) return false;
		// Blank lines are not records: they never count toward the cap or "not processed" (red team L6).
		if (!isBlankRow(row)) {
			if (rows.length <= maxRows) rows.push(row);
			else more++;
		}
		row = [];
		return true;
	};
	while (i < text.length) {
		const ch = text[i] as string;
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
			} else field += ch;
			i++;
			continue;
		}
		if (ch === '"' && field === '' && !literalQuotes) quoted = true;
		else if (ch === delimiter) {
			row.push(field);
			field = '';
			if (row.length > maxColumns) return { ok: false, error: 'too_many_columns' };
		} else if (ch === '\r' || ch === '\n') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			if (!endRecord()) return { ok: false, error: 'too_many_columns' };
		} else field += ch;
		i++;
	}
	if (quoted) return { ok: false, error: 'unterminated_quote' };
	// A last record without a trailing line break.
	if (field !== '' || row.length > 0) {
		if (!endRecord()) return { ok: false, error: 'too_many_columns' };
	}
	return { ok: true, rows, more };
}

/** True for a record that holds nothing (an empty line, or only empty cells). */
export function isBlankRow(row: readonly string[]): boolean {
	return row.every((cell) => cell.trim() === '');
}

/** Header names, trimmed and lower-cased → their column index (first occurrence wins). */
export function headerIndex(headerRow: readonly string[]): Map<string, number> {
	const index = new Map<string, number>();
	headerRow.forEach((name, i) => {
		const key = name.trim().toLowerCase();
		if (key && !index.has(key)) index.set(key, i);
	});
	return index;
}

/** Which of the two fixed shapes the header names (case-insensitive), or null for neither. */
export function detectCsvFormat(headerRow: readonly string[]): CsvFormat | null {
	const index = headerIndex(headerRow);
	if (TEMPLATE_REQUIRED.every((c) => index.has(c))) return 'template';
	if (MONEY_MANAGER_REQUIRED.every((c) => index.has(c))) return 'money_manager';
	return null;
}

/** Whether the header has every column `format` needs (a manual override must still fit the file). */
export function headerFits(headerRow: readonly string[], format: CsvFormat): boolean {
	const index = headerIndex(headerRow);
	return (format === 'template' ? TEMPLATE_REQUIRED : MONEY_MANAGER_REQUIRED).every((c) =>
		index.has(c)
	);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_FIRST = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
/** An optional time after the date (`2026-10-01 14:23` or `01/10/2026 14:23:11`, as Money Manager writes). */
const TIME_SUFFIX = /\s+\d{1,2}:\d{2}(?::\d{2})?$/;

/**
 * A date cell → WIB calendar date `YYYY-MM-DD`: ISO `YYYY-MM-DD` or day-first `DD/MM/YYYY` (an optional
 * time after it is ignored). Anything else, or an impossible date, is null — never a guess.
 */
export function parseCsvDate(text: string): string | null {
	const value = text.trim().slice(0, 32).replace(TIME_SUFFIX, '');
	let date: string | null = null;
	const iso = ISO_DATE.exec(value);
	if (iso) date = value;
	const dm = DAY_FIRST.exec(value);
	if (dm)
		date = `${dm[3]}-${(dm[2] as string).padStart(2, '0')}-${(dm[1] as string).padStart(2, '0')}`;
	return date && isDateString(date) ? date : null;
}

export type SkipReason =
	| 'transfer'
	| 'missing_date'
	| 'unparseable_date'
	| 'missing_amount'
	| 'unparseable_amount'
	| 'unsupported_currency'
	/** An on-device OCR row (FN-16g) the user left out of the import, or a review row not ticked in. */
	| 'excluded';

/** One CSV record mapped to a transaction's raw fields (still untrusted text; the server validates it). */
export interface RawCsvTransaction {
	date: string;
	type: 'expense' | 'income';
	title: string;
	/** Integer IDR minor units read by the shared money parser (FN-14a), always positive. */
	amountMinor: number;
	currency: 'IDR';
	categoryName: string;
	walletName: string;
	paymentMethod: string;
	recurrence: string;
	tag: string;
	notes: string;
	reference: string;
}

/** A cell by header name ('' when the column is absent or the row is short). */
function cell(row: readonly string[], index: Map<string, number>, name: string): string {
	const at = index.get(name);
	return at === undefined ? '' : (row[at] ?? '').trim();
}

/**
 * Undoes export's formula-injection guard: exactly one leading `'` is dropped when what follows is guarded too
 * (`needsGuard`), so `=x`, `'=x`, `'-5` and `-5` all come back as they were exported.
 */
function unguard(value: string): string {
	return value.startsWith("'") && needsGuard(value.slice(1)) ? value.slice(1) : value;
}

function readType(value: string): 'expense' | 'income' | null {
	const v = value.trim().toLowerCase().replace(/\.$/, '');
	if (v === 'expense' || v === 'exp' || v === 'pengeluaran') return 'expense';
	if (v === 'income' || v === 'inc' || v === 'pemasukan') return 'income';
	return null;
}

/** The amount cell through the one shared money parser; a sign or DB/CR mark never flips the row's type. */
function readAmount(text: string): number | 'missing_amount' | 'unparseable_amount' {
	if (text === '') return 'missing_amount';
	const parsed = parseMoneyAmount(text);
	if (!parsed || parsed.minor === 0) return 'unparseable_amount';
	return Math.abs(parsed.minor);
}

function readCurrency(text: string): 'IDR' | null {
	const v = text.trim().toUpperCase();
	return v === '' || v === 'IDR' || v === 'RP' ? 'IDR' : null;
}

function common(
	dateText: string,
	type: 'expense' | 'income' | null,
	amountText: string,
	currencyText: string
):
	| { ok: true; date: string; type: 'expense' | 'income'; amountMinor: number }
	| { ok: false; reason: SkipReason } {
	if (!type) return { ok: false, reason: 'transfer' };
	if (dateText === '') return { ok: false, reason: 'missing_date' };
	const date = parseCsvDate(dateText);
	if (!date) return { ok: false, reason: 'unparseable_date' };
	const amount = readAmount(amountText);
	if (typeof amount === 'string') return { ok: false, reason: amount };
	if (!readCurrency(currencyText)) return { ok: false, reason: 'unsupported_currency' };
	return { ok: true, date, type, amountMinor: amount };
}

/**
 * A template record (`date, type, merchant, amount, currency, category, payment_method, recurrence, tag, notes,
 * wallet_source, reference`). A type other than expense/income (`transfer`, anything unknown) is skipped; an
 * empty `wallet_source` falls back to `payment_method`.
 */
export function mapTemplateRow(
	row: readonly string[],
	index: Map<string, number>
): RawCsvTransaction | SkipReason {
	const get = (name: string) => unguard(cell(row, index, name));
	const base = common(get('date'), readType(get('type')), get('amount'), get('currency'));
	if (!base.ok) return base.reason;
	const paymentMethod = get('payment_method');
	return {
		date: base.date,
		type: base.type,
		title: get('merchant'),
		amountMinor: base.amountMinor,
		currency: 'IDR',
		categoryName: get('category'),
		walletName: get('wallet_source') || paymentMethod,
		paymentMethod,
		recurrence: get('recurrence'),
		tag: get('tag'),
		notes: get('notes'),
		reference: get('reference')
	};
}

/**
 * A Money Manager record (`Period, Accounts, Category, Note, Income/Expense, Amount, Currency`, plus an optional
 * `Description`). `Food/Groceries` becomes the category `Food`; `Note` is the title; transfers are skipped; a
 * non-IDR `Currency` is skipped (owner decision D).
 */
export function mapMoneyManagerRow(
	row: readonly string[],
	index: Map<string, number>
): RawCsvTransaction | SkipReason {
	const get = (name: string) => unguard(cell(row, index, name));
	const base = common(
		get('period'),
		readType(get('income/expense')),
		get('amount'),
		get('currency')
	);
	if (!base.ok) return base.reason;
	return {
		date: base.date,
		type: base.type,
		title: get('note'),
		amountMinor: base.amountMinor,
		currency: 'IDR',
		categoryName: (get('category').split('/')[0] ?? '').trim(),
		walletName: get('accounts'),
		paymentMethod: '',
		recurrence: '',
		tag: '',
		notes: get('description'),
		reference: ''
	};
}

/** One record of a parsed file: its position (the dedupe key's row index) and what it maps to. */
/**
 * Why an on-device OCR row (FN-16g) needs the user's look before it is imported: such rows are excluded unless
 * ticked in. CSV and text-statement paths never set it.
 */
export type RowReview =
	| 'low_confidence'
	| 'no_balance_check'
	| 'direction_unknown'
	| 'year_assumed'
	| 'relative_date'
	| 'balance_mismatch'
	| 'photo_unclear'
	| 'overlap';

export type MappedRow =
	| { index: number; ok: true; value: RawCsvTransaction; review?: RowReview }
	| { index: number; ok: false; reason: SkipReason };

export interface CsvReading {
	/** The format as detected from the header (null: neither shape matched). */
	detected: CsvFormat | null;
	/** Every non-blank record (at most CSV_MAX_ROWS), mapped. Empty when no format applies. */
	rows: MappedRow[];
	/** Records past CSV_MAX_ROWS, not processed (owner decision B). */
	notProcessed: number;
}

export type ReadCsvResult =
	{ ok: true; reading: CsvReading } | { ok: false; error: CsvParseError | 'format_mismatch' };

/**
 * The whole file → mapped records, the same on device and Worker: parse, detect the format, and map every
 * non-blank record with `format` (the user's override) or the detected one. A file whose header does not fit
 * the chosen format is refused; with no format at all, `rows` is empty and the caller asks the user to pick.
 */
export function readCsv(text: string, format: CsvFormat | null = null): ReadCsvResult {
	const parsed = parseCsv(text);
	if (!parsed.ok) return parsed;
	const [header = [], ...records] = parsed.rows;
	const detected = detectCsvFormat(header);
	const chosen = format ?? detected;
	if (format && !headerFits(header, format)) return { ok: false, error: 'format_mismatch' };
	if (!chosen) return { ok: true, reading: { detected, rows: [], notProcessed: parsed.more } };
	const index = headerIndex(header);
	const mapper = chosen === 'template' ? mapTemplateRow : mapMoneyManagerRow;
	const rows: MappedRow[] = [];
	records.forEach((record, i) => {
		const mapped = mapper(record, index);
		rows.push(
			typeof mapped === 'string'
				? { index: i, ok: false, reason: mapped }
				: { index: i, ok: true, value: mapped }
		);
	});
	return { ok: true, reading: { detected, rows, notProcessed: parsed.more } };
}

/** Counts of a reading as the summary shows them. */
export interface CsvSummary {
	rows: number;
	ready: number;
	transfers: number;
	invalid: number;
	foreignCurrency: number;
	/** Ready rows naming neither a wallet nor a payment method (they need the fallback wallet). */
	withoutWallet: number;
}

export function summarizeReading(reading: CsvReading): CsvSummary {
	const s: CsvSummary = {
		rows: reading.rows.length,
		ready: 0,
		transfers: 0,
		invalid: 0,
		foreignCurrency: 0,
		withoutWallet: 0
	};
	for (const r of reading.rows) {
		if (r.ok) {
			s.ready++;
			if (!r.value.walletName) s.withoutWallet++;
		} else if (r.reason === 'transfer') s.transfers++;
		else if (r.reason === 'unsupported_currency') s.foreignCurrency++;
		else s.invalid++;
	}
	return s;
}

/**
 * A cell a spreadsheet may read as a formula (checklist › CSV export): it starts with tab, CR or LF, or with
 * `=`, `+`, `-`, `@` or their fullwidth forms (U+FF1D, U+FF0B, U+FF0D, U+FF20) after any leading whitespace
 * (red team L4).
 */
const FORMULA_START = /^(?:[\t\r\n]|\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/;

/**
 * Whether export prefixes `'`: a formula start, also behind leading `'`s, so a value that itself begins with `'`
 * before a formula (`'=x`) keeps that quote through export and re-import (`unguard` strips exactly one).
 */
function needsGuard(value: string): boolean {
	return FORMULA_START.test(value.replace(/^'+/, ''));
}

/**
 * A value made safe for any spreadsheet cell (CSV export, FN-29's Sheets rows): a formula-looking value gets a
 * leading `'`, which spreadsheets read as "text", so it is shown and never evaluated.
 */
export function guardFormula(value: string): string {
	return needsGuard(value) ? `'${value}` : value;
}

/** One cell made safe for a spreadsheet: a formula-looking value gets a leading `'`, then RFC 4180 quoting. */
export function csvCell(value: string): string {
	const guarded = guardFormula(value);
	return /[",\r\n;]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** One CSV line (CRLF-terminated, RFC 4180) of guarded cells. */
export function csvLine(cells: readonly string[]): string {
	return cells.map(csvCell).join(',') + '\r\n';
}

/**
 * An amount in minor units as an export cell: plain major units with a `.` decimal mark only when there are sen
 * (`2800000` IDR → `28000`, `2800050` → `28000.50`). Exact (string arithmetic, never a float); the shared money
 * parser reads it back to the same minor units.
 */
export function formatCsvAmount(minor: number, currency: string): string {
	if (!Number.isSafeInteger(minor)) throw new RangeError('amount must be a safe integer');
	const exp = currencyExponent(currency);
	const digits = Math.abs(minor)
		.toString()
		.padStart(exp + 1, '0');
	const whole = exp === 0 ? digits : digits.slice(0, -exp);
	const frac = exp === 0 ? '' : digits.slice(-exp);
	const sign = minor < 0 ? '-' : '';
	return /^0*$/.test(frac) ? `${sign}${whole}` : `${sign}${whole}.${frac}`;
}

/** One transaction as an export writes it (FN-18 CSV, FN-29 Sheets): every template column, names joined in. */
export interface ExportRow {
	id: string;
	type: 'expense' | 'income';
	amountMinor: number;
	currency: string;
	title: string | null;
	note: string | null;
	occurredOn: string;
	occurredAt: number;
	categoryName: string | null;
	walletName: string | null;
	paymentMethod: string | null;
	recurrence: string | null;
	tag: string | null;
	reference: string | null;
}

/**
 * One transaction's export cells in TEMPLATE_COLUMNS order, before the formula guard: account and card numbers
 * in the payment method, recurrence, tag, wallet and reference cells cut to the last 4 digits. The CSV export
 * and the Sheets rows both start here, so they can never disagree.
 */
export function exportCells(row: ExportRow): string[] {
	const masked = (value: string | null) => maskAccountNumbers(value ?? '');
	return [
		row.occurredOn,
		row.type,
		row.title ?? '',
		formatCsvAmount(row.amountMinor, row.currency),
		row.currency,
		row.categoryName ?? '',
		masked(row.paymentMethod),
		masked(row.recurrence),
		masked(row.tag),
		row.note ?? '',
		masked(row.walletName),
		masked(row.reference)
	];
}
