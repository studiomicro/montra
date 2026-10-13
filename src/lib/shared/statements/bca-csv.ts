import { isDateString } from '../dates.ts';
import { parseMoneyAmount } from '../money-parse.ts';
import { statementRow } from './rows.ts';
import type { MappedRow, StatementParse } from './types.ts';

/**
 * BCA account mutation as CSV (KlikBCA / myBCA › Mutasi Rekening › unduh CSV) — FN-16c, written from the structure
 * of a real export (no value from it is kept here). The records, as FN-18's CSV reader returns them (blank lines
 * dropped, comma or semicolon separated):
 *
 * - a header block of `<label>,=,<value>` records: `No. Rekening` (value prefixed with `'`), `Nama`, `Mata Uang`;
 * - the column row `Tanggal,Keterangan,Cabang,Jumlah,,Saldo`;
 * - one record per transaction: `'DD/MM/YYYY,<keterangan>,'<cabang>,<jumlah>,<DB|CR>,<saldo>` — a full date (WIB
 *   calendar date as printed), amounts as `1234567.89` (dot cents, no grouping; `1,234,567.89` is read as well),
 *   `DB` a debit and `CR` a credit, the running balance after the row;
 * - a footer block of `<label>,=,<amount>` records: `Saldo Awal`, `Kredit`, `Debet`, `Saldo Akhir`.
 *
 * Self-checks (as FN-16b, red team M1): the description is the only third-party text, so nothing in it may decide
 * an amount. A record is read from its right end (the bank's own last four columns), so a comma in a remark only
 * widens the description. The file is accepted only when every row is readable, every printed running balance
 * equals `Saldo Awal` + the rows so far, the last one reaches `Saldo Akhir`, and the `Kredit`/`Debet` totals equal
 * the rows' sums — all in integer minor units. A record that is neither a row nor a header/footer label, a row
 * after the footer, a repeated label or a `PEND` (pending, not yet booked) date makes the file `inconsistent`:
 * refused whole, never imported with a warning. The account number and name are never read into a row.
 */

const COLUMNS = ['tanggal', 'keterangan', 'cabang', 'jumlah', '', 'saldo'];
/** Where the column row may be: the header block is a handful of records. */
const HEADER_SCAN = 20;
/** An amount cell: plain or comma-grouped digits, always two decimals. Bounded before the regex runs. */
const AMOUNT = /^(?:\d{1,3}(?:,\d{3})+|\d{1,16})\.\d{2}$/;
const AMOUNT_MAX_LENGTH = 32;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
/** KlikBCA's date for a mutation that is still pending (not booked, no final balance). */
const PENDING = 'PEND';

type Footer = 'saldo awal' | 'kredit' | 'debet' | 'saldo akhir';
const FOOTERS: readonly Footer[] = ['saldo awal', 'kredit', 'debet', 'saldo akhir'];

/** A cell as printed: trimmed, one leading `'` (the export's "keep as text" mark) dropped. */
function cellOf(row: readonly string[], at: number): string {
	const value = (row[at] ?? '').trim();
	return value.startsWith("'") ? value.slice(1).trim() : value;
}

/** `<label>,=,<value>`: the label (lower-cased, single-spaced) and value, or null. */
function labelOf(row: readonly string[]): { label: string; value: string } | null {
	if (row.length < 3 || cellOf(row, 1) !== '=') return null;
	return { label: cellOf(row, 0).replace(/\s+/g, ' ').toLowerCase(), value: cellOf(row, 2) };
}

const isColumnRow = (row: readonly string[]) =>
	row.length === COLUMNS.length && COLUMNS.every((c, i) => cellOf(row, i).toLowerCase() === c);

const amountOf = (text: string): number | null =>
	text.length <= AMOUNT_MAX_LENGTH && AMOUNT.test(text)
		? (parseMoneyAmount(text)?.minor ?? null)
		: null;

/** The column row's index within the header block, or -1. */
function columnRowAt(rows: readonly (readonly string[])[]): number {
	const end = Math.min(rows.length, HEADER_SCAN);
	for (let i = 0; i < end; i++) if (isColumnRow(rows[i]!)) return i;
	return -1;
}

/**
 * Confidence from layout markers only: the column row, plus the `No. Rekening` and `Mata Uang` header labels
 * above it. 0 without the column row.
 */
export function detectBcaCsv(rows: readonly (readonly string[])[]): number {
	const at = columnRowAt(rows);
	if (at < 0) return 0;
	const labels = new Set(rows.slice(0, at).map((r) => labelOf(r)?.label));
	return labels.has('no. rekening') && labels.has('mata uang') ? 0.9 : 0.6;
}

/** `DD/MM/YYYY` → `YYYY-MM-DD` when it is a real date, else null. */
function dateOf(text: string): string | null {
	const m = DATE.exec(text);
	const date = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
	return date && isDateString(date) ? date : null;
}

const refused = (rows: MappedRow[]): StatementParse => ({
	rows,
	openingBalanceMinor: null,
	closingBalanceMinor: null,
	inconsistent: true
});

export function parseBcaCsv(records: readonly (readonly string[])[]): StatementParse {
	const at = columnRowAt(records);
	if (at < 0) return refused([]);
	const currencies = new Set<string>();
	let stray = false;
	for (const record of records.slice(0, at)) {
		const label = labelOf(record);
		if (!label) stray = true;
		else if (label.label === 'mata uang') currencies.add(label.value.toUpperCase());
	}

	const rows: MappedRow[] = [];
	/** Printed running balance per row index. */
	const balances: (number | null)[] = [];
	const footer = new Map<Footer, number | null>();
	for (const record of records.slice(at + 1)) {
		// A record that starts with a date is a row, whatever its remark says (`=` as the remark is not a label).
		const startsRow = DATE.test(cellOf(record, 0)) || cellOf(record, 0) === PENDING;
		const label = startsRow ? null : labelOf(record);
		if (label) {
			const kind = FOOTERS.find((f) => f === label.label);
			// An unknown or repeated label is not guessed at.
			if (!kind || footer.has(kind)) stray = true;
			else footer.set(kind, amountOf(label.value));
			continue;
		}
		// A row after the footer (or a record that is no row at all) is never read on its own.
		if (footer.size > 0) stray = true;
		const index = rows.length;
		const printedDate = cellOf(record, 0);
		if (record.length < COLUMNS.length || (!DATE.test(printedDate) && printedDate !== PENDING)) {
			stray = true;
			continue;
		}
		// The bank's own columns are the last four; anything between the date and them is the description.
		const n = record.length;
		const mark = cellOf(record, n - 2).toUpperCase();
		const amount = cellOf(record, n - 3);
		balances.push(amountOf(cellOf(record, n - 1)));
		if (printedDate === PENDING) {
			rows.push({ index, ok: false, reason: 'unparseable_date' });
			continue;
		}
		if ((mark !== 'DB' && mark !== 'CR') || amountOf(amount) === null) {
			rows.push({ index, ok: false, reason: 'unparseable_amount' });
			continue;
		}
		rows.push(
			statementRow(index, {
				date: dateOf(printedDate) ?? printedDate,
				direction: mark === 'DB' ? 'debit' : 'credit',
				amount,
				description: record
					.slice(1, n - 4)
					.join(',')
					.replace(/\s+/g, ' ')
					.trim()
			})
		);
	}

	if ([...currencies].some((c) => c !== 'IDR'))
		return {
			rows: rows.map((r) => ({ index: r.index, ok: false, reason: 'unsupported_currency' })),
			openingBalanceMinor: null,
			closingBalanceMinor: null
		};
	const opening = footer.get('saldo awal') ?? null;
	const closing = footer.get('saldo akhir') ?? null;
	const ok =
		!stray &&
		currencies.size === 1 &&
		consistent(rows, balances, opening, closing, footer.get('kredit'), footer.get('debet'));
	return { rows, openingBalanceMinor: opening, closingBalanceMinor: closing, inconsistent: !ok };
}

/** Every row readable, every running balance chains from the opening to the closing, totals match. */
function consistent(
	rows: readonly MappedRow[],
	balances: readonly (number | null)[],
	opening: number | null,
	closing: number | null,
	credit: number | null | undefined,
	debit: number | null | undefined
): boolean {
	if (opening === null || closing === null || credit == null || debit == null) return false;
	let running = opening;
	let credits = 0;
	let debits = 0;
	for (const r of rows) {
		if (!r.ok) return false;
		if (r.value.type === 'income') {
			running += r.value.amountMinor;
			credits += r.value.amountMinor;
		} else {
			running -= r.value.amountMinor;
			debits += r.value.amountMinor;
		}
		if (!Number.isSafeInteger(running) || !Number.isSafeInteger(credits + debits)) return false;
		if (balances[r.index] !== running) return false;
	}
	return running === closing && credits === credit && debits === debit;
}
