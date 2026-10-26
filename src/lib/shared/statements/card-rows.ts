import { CSV_MAX_ROWS } from '../csv.ts';
import { addDays, isDateString } from '../dates.ts';
import { MAX_AMOUNT_MINOR, parseMoneyAmount } from '../money-parse.ts';
import { cleanText } from '../text.ts';
import type { TileKey } from '../transactions.ts';
import { cardRowDate } from './card-dates.ts';
import { balanceCheck, statementRow } from './rows.ts';
import type { CardRowClass, CardStatementFigures, MappedRow, StatementParse } from './types.ts';

/**
 * Credit-card statements (FN-55b): the one place a card statement's amounts, dates and printed figures are read,
 * on top of the bank statement builders (`statementRow`, `balanceCheck`). A card parser (one per issuer, written
 * only from a real sample) finds the printed cells with its own fixed grammar and hands them here; this module
 * checks the statement against itself and refuses the whole file on any doubt (B4: fail closed, stricter than
 * a bank statement, whose unreadable rows are only warned about).
 *
 * Sign convention (B2): balances are reported in the wallet's convention — a printed balance owed P becomes −P,
 * a printed credit (CR) balance stays positive. Purchases, installments, fees, interest and tax are debit rows
 * (expense); payments and other credits are credit rows (income). So `balanceCheck` (opening + Σ signed rows =
 * closing) holds exactly when previous − payments − credits + purchases + fees + interest = new.
 *
 * Untrusted text (B5): a row's description never decides its amount, direction or date: those come only from the
 * cells the parser read from their designed columns or markers. The description decides only the category
 * (`classifyCardRow`, fixed phrases at its start). Known limit, as FN-16f/16h: a crafted remark that adds a
 * cancelling +Y/−Y pair of rows keeps every total equal and is not detected here.
 */

/** Where an issuer prints its amounts: Indonesian `1.250.000,00` or English `1,250,000.00`, always two decimals. */
type CardAmountGrammar = 'id' | 'en';

const AMOUNT: Readonly<Record<CardAmountGrammar, RegExp>> = {
	id: /^(?:Rp ?)?((?:\d{1,3}(?:\.\d{3})+|\d{1,3}),\d{2})$/,
	en: /^(?:(?:Rp|IDR) ?)?((?:\d{1,3}(?:,\d{3})+|\d{1,3})\.\d{2})$/
};
/** A printed balance: an amount, optionally followed by `CR` (a credit balance) after one space. */
const CREDIT_MARK = / ?CR$/;

/** An amount cell in the issuer's fixed grammar → its text for `parseMoneyAmount`, or null when it does not fit. */
function amountText(cell: string, grammar: CardAmountGrammar): string | null {
	const m = AMOUNT[grammar].exec(cell.trim());
	return m ? m[1]! : null;
}

/** A printed amount (a balance or total; 0 allowed) → non-negative minor units, or null when unreadable. */
function printedMinor(cell: string, grammar: CardAmountGrammar): number | null {
	const text = amountText(cell, grammar);
	if (text === null) return null;
	const parsed = parseMoneyAmount(text);
	if (!parsed || parsed.direction || parsed.minor < 0 || parsed.minor > MAX_AMOUNT_MINOR)
		return null;
	return parsed.minor;
}

/** A printed balance → the wallet's convention (owed negative, `CR` positive), or null when unreadable. */
function printedBalance(cell: string, grammar: CardAmountGrammar): number | null {
	const trimmed = cell.trim();
	const credit = CREDIT_MARK.test(trimmed);
	const minor = printedMinor(trimmed.replace(CREDIT_MARK, ''), grammar);
	if (minor === null) return null;
	return credit || minor === 0 ? minor : -minor;
}

/**
 * Fixed phrases an issuer prints at the start of a row's description, per class (upper case, as printed). Only the
 * category follows from them; a debit row matching none is a purchase, a credit row matching none another credit.
 */
export interface CardPhraseTable {
	fee: readonly string[];
	interest: readonly string[];
	tax: readonly string[];
	installment: readonly string[];
	payment: readonly string[];
}

/**
 * A row's class from its printed direction and the fixed phrase its description starts with. A phrase of the
 * other direction's classes never applies (a debit "PEMBAYARAN …" stays a purchase), so text cannot turn a debit
 * into a payment.
 */
export function classifyCardRow(
	description: string,
	direction: 'debit' | 'credit',
	phrases: CardPhraseTable
): CardRowClass {
	const text = cleanText(description, 200).toUpperCase();
	const starts = (list: readonly string[]) => list.some((p) => text.startsWith(p));
	if (direction === 'credit') return starts(phrases.payment) ? 'payment' : 'credit';
	if (starts(phrases.fee)) return 'fee';
	if (starts(phrases.interest)) return 'interest';
	if (starts(phrases.tax)) return 'tax';
	if (starts(phrases.installment)) return 'installment';
	return 'purchase';
}

/** The preset tile an imported card row is filed under (B6/AC 32); null: FN-20's resolver decides. */
export const CARD_ROW_TILES: Readonly<Record<CardRowClass, TileKey | null>> = {
	purchase: null,
	installment: null,
	fee: 'biaya-bank',
	interest: 'biaya-bank',
	tax: 'pajak',
	payment: 'transfer',
	credit: null
};

/** A day and month as printed in a date column. */
export interface DayMonth {
	day: number;
	month: number;
}

/** One transaction row as the parser found it in its designed columns. */
export interface CardRowCells {
	/** The transaction (purchase) date; null when the column could not be read. */
	transactionDate: DayMonth | null;
	/** The posting date, when the issuer prints one (validation only, never stored). */
	postingDate?: DayMonth | null;
	description: string;
	/** The amount cell exactly as printed, without its direction marker. */
	amount: string;
	/** From the printed column or the CR/DB marker only; null when unreadable. */
	direction: 'debit' | 'credit' | null;
	/** How many amount-shaped cells the row's line group held (exactly one is readable, B5). */
	amountCells: number;
	/** A foreign original amount as printed ("USD 12,50"), kept in the note only (A6). */
	foreignAmount?: string;
	/** An installment marker as printed ("Cicilan 3/12"), kept in the note only (A6). */
	installment?: string;
}

/** Everything a card parser read from one statement, before any check. */
export interface CardStatementCells {
	/** WIB date as printed in the statement header (read by the parser's own date grammar). */
	statementDate: string | null;
	/** Absent: not printed. Null: printed but unreadable (a refusal). */
	dueDate?: string | null;
	/** Absent: not printed. */
	period?: { from: string; to: string } | null;
	previousBalance: string | null;
	newBalance: string | null;
	/** Absent: not printed. */
	minimumPayment?: string | null;
	creditLimit?: string | null;
	/** Every card number the statement prints (each reduced to its last 4 digits here, nothing else kept). */
	cardNumbers: readonly string[];
	/** Printed class totals, where the issuer prints them. */
	totals: {
		payments?: string | null;
		purchases?: string | null;
		fees?: string | null;
		interest?: string | null;
	};
	rows: readonly CardRowCells[];
	/**
	 * The parser's own structure checks failed (B4.6, B4.7, B5): a header, totals or legal line inside the table, a
	 * table line outside it, a repeated section, pages with different statement dates or cards.
	 */
	structureBroken: boolean;
	grammar: CardAmountGrammar;
	phrases: CardPhraseTable;
}

/** Longest foreign-amount or installment text kept in a row's note. */
const NOTE_PART_MAX = 60;
/**
 * How far a card row's transaction date may precede the printed period's first day (a purchase dated in the
 * previous cycle posts in this one), and how far before its statement date a row of a statement that prints no
 * period may be posted (FN-55 red team L1-R).
 */
const CARD_ROW_LAG_DAYS = 60;
/** How long after its statement date a printed due date may lie (B3). */
const CARD_DUE_MAX_DAYS = 60;

const refused = (unsupported?: 'multiple_cards'): StatementParse => ({
	rows: [],
	openingBalanceMinor: null,
	closingBalanceMinor: null,
	inconsistent: true,
	...(unsupported ? { unsupported } : {})
});

/** The last 4 digits of a printed card number, or null when it holds fewer than 4 digits. */
function lastFour(printed: string): string | null {
	const digits = printed.normalize('NFKC').replace(/\D/g, '');
	return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * The card statement as rows plus its printed figures, or a refusal (`inconsistent`, nothing is imported) unless
 * every check of B4 holds: every row readable; previous − payments − credits + purchases + fees + interest = new
 * (BigInt); the balance check passes; every printed class total equals its rows; not past the row cap; the parser's
 * structure checks held. A statement printing more than one card number is refused as not supported yet.
 */
export function buildCardStatement(cells: CardStatementCells): StatementParse {
	if (cells.structureBroken) return refused();
	const statementDate = cells.statementDate;
	if (statementDate === null || !isDateString(statementDate)) return refused();
	const fours = new Set<string>();
	for (const n of cells.cardNumbers) {
		const four = lastFour(n);
		if (four === null) return refused();
		fours.add(four);
	}
	if (fours.size > 1) return refused('multiple_cards');
	const cardLast4 = fours.size === 1 ? [...fours][0]! : null;

	let dueDate: string | null = null;
	if (cells.dueDate !== undefined) {
		if (cells.dueDate === null || !isDateString(cells.dueDate)) return refused();
		if (cells.dueDate < statementDate || cells.dueDate > addDays(statementDate, CARD_DUE_MAX_DAYS))
			return refused();
		dueDate = cells.dueDate;
	}
	let periodFrom: string | null = null;
	let periodTo: string | null = null;
	if (cells.period) {
		const { from, to } = cells.period;
		if (!isDateString(from) || !isDateString(to) || from > to || to > statementDate)
			return refused();
		periodFrom = from;
		periodTo = to;
	} else if (cells.period === null) return refused();

	const g = cells.grammar;
	const previous = cells.previousBalance === null ? null : printedBalance(cells.previousBalance, g);
	const next = cells.newBalance === null ? null : printedBalance(cells.newBalance, g);
	if (previous === null || next === null) return refused();
	let minimum: number | null = null;
	if (cells.minimumPayment !== undefined) {
		minimum = cells.minimumPayment === null ? null : printedMinor(cells.minimumPayment, g);
		if (minimum === null) return refused();
		// Printed only, never computed; it can never exceed what is owed.
		if (minimum > (next < 0 ? -next : 0)) return refused();
	}
	let limit: number | null = null;
	if (cells.creditLimit !== undefined) {
		limit = cells.creditLimit === null ? null : printedMinor(cells.creditLimit, g);
		if (limit === null || limit === 0) return refused();
	}

	if (cells.rows.length > CSV_MAX_ROWS) return refused();
	const rows: MappedRow[] = [];
	const classes: CardRowClass[] = [];
	const sums = { payments: 0n, credits: 0n, purchases: 0n, fees: 0n, interest: 0n };
	let firstPostingDate: string | null = null;
	for (const [index, r] of cells.rows.entries()) {
		if (r.amountCells !== 1 || r.direction === null || r.transactionDate === null) return refused();
		const amount = amountText(r.amount, g);
		if (amount === null) return refused();
		const date = cardRowDate(r.transactionDate.day, r.transactionDate.month, statementDate);
		if (date === null) return refused();
		let posted: string | null = null;
		if (r.postingDate !== undefined) {
			posted =
				r.postingDate === null
					? null
					: cardRowDate(r.postingDate.day, r.postingDate.month, statementDate);
			if (posted === null || posted < date) return refused();
			if (firstPostingDate === null || posted < firstPostingDate) firstPostingDate = posted;
		}
		// Red team L1/L1-R: the date that put the row on this statement (its posting date, else its only date) must
		// lie in the printed period, and the transaction date no more than CARD_ROW_LAG_DAYS before the period starts,
		// so a day-month the period does not hold (in either date column) cannot land a year early. A statement that
		// prints no period is bounded the same way from CARD_ROW_LAG_DAYS before its statement date (FN-55c parsers).
		const windowFrom = periodFrom ?? addDays(statementDate, -CARD_ROW_LAG_DAYS);
		const windowTo = periodTo ?? statementDate;
		const onStatement = posted ?? date;
		if (onStatement < windowFrom || onStatement > windowTo) return refused();
		if (date < addDays(windowFrom, -CARD_ROW_LAG_DAYS)) return refused();
		const row = statementRow(index, {
			date,
			direction: r.direction,
			amount,
			description: r.description
		});
		if (!row.ok) return refused();
		const note = [r.foreignAmount, r.installment]
			.map((part) => cleanText(part ?? '', NOTE_PART_MAX))
			.filter((part) => part !== '')
			.join(' · ');
		rows.push({ ...row, value: { ...row.value, notes: note } });
		const cls = classifyCardRow(r.description, r.direction, cells.phrases);
		classes.push(cls);
		const minor = BigInt(row.value.amountMinor);
		if (cls === 'payment') sums.payments += minor;
		else if (cls === 'credit') sums.credits += minor;
		else if (cls === 'purchase' || cls === 'installment') sums.purchases += minor;
		else if (cls === 'fee' || cls === 'tax') sums.fees += minor;
		else sums.interest += minor;
	}

	// B4.4: every printed class total equals its rows.
	const printedTotals: [string | null | undefined, bigint][] = [
		[cells.totals.payments, sums.payments],
		[cells.totals.purchases, sums.purchases],
		[cells.totals.fees, sums.fees],
		[cells.totals.interest, sums.interest]
	];
	for (const [text, sum] of printedTotals) {
		if (text === undefined) continue;
		const printed = text === null ? null : printedMinor(text, g);
		if (printed === null || BigInt(printed) !== sum) return refused();
	}
	// B4.2: previous − payments − credits + purchases + fees + interest = new (owed amounts, exact).
	const owed = (balance: number) => -BigInt(balance);
	if (
		owed(previous) - sums.payments - sums.credits + sums.purchases + sums.fees + sums.interest !==
		owed(next)
	)
		return refused();
	const parse: StatementParse = {
		rows,
		openingBalanceMinor: previous,
		closingBalanceMinor: next
	};
	// B4.3: the shared balance check agrees (opening + signed rows = closing).
	if (balanceCheck(parse).status !== 'pass') return refused();
	// Sums past the safe integer range belong to no real statement: refused, never rounded.
	const max = BigInt(Number.MAX_SAFE_INTEGER);
	if (Object.values(sums).some((n) => n > max)) return refused();
	const safe = (n: bigint) => Number(n);
	const card: CardStatementFigures = {
		statementDate,
		dueDate,
		periodFrom,
		periodTo,
		firstPostingDate,
		previousBalanceMinor: previous,
		newBalanceMinor: next,
		minimumPaymentMinor: minimum,
		limitMinor: limit,
		cardLast4,
		totals: {
			payments: safe(sums.payments),
			credits: safe(sums.credits),
			purchases: safe(sums.purchases),
			fees: safe(sums.fees),
			interest: safe(sums.interest)
		},
		classes
	};
	return { ...parse, card };
}
