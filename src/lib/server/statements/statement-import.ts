import type { StatementHints } from '#lib/shared/statements/detect';
import type { BalanceCheck } from '#lib/shared/statements/rows';
import { CARD_ROW_TILES } from '#lib/shared/statements/card-rows';
import type {
	CardStatementFigures,
	MappedRow,
	StatementParser
} from '#lib/shared/statements/types';
import type { TileKey } from '#lib/shared/transactions';
import { cleanText, maskAccountNumbers } from '#lib/shared/text';
import { TITLE_MAX_LENGTH } from '#lib/shared/transactions';
import type { Db } from '../db';
import {
	fallbackWalletOf,
	importRows,
	previewRows,
	type CsvCounts,
	type ImportRowsFailure,
	type MerchantEnv,
	type PossibleDuplicate,
	type PreparedRows
} from '../imports/csv-import';
import type { SpaceScope } from '../spaces/access';
import { safeMinor } from '../transactions/aggregate';
import { readWalletBalance } from '../transactions/wallet-sum';
import { autoMatchTransferPairs } from '../transfers/match';
import { bytesToHex, errorLabel } from '../util';
import { getWallet, type WalletSummary } from '../wallets/repo';
import {
	cardStatementExists,
	cardStatementsFull,
	previousCardStatementDate
} from '../cards/statements';
import {
	cardStatementSpan,
	checkStatement,
	statementSpan,
	type Continuity,
	type StatementSpan
} from './continuity';
import {
	readStatement,
	type StatementSectionChoice,
	type StatementReadFormat,
	type StatementReadInput,
	type StatementRefusal
} from './read';

/**
 * Statement import (FN-16a): the uploaded bytes are read from scratch on the server (never a client row list),
 * then go through FN-18's preview and import core unchanged — same "Mungkin duplikat" query, same validator,
 * same all-or-nothing `db.batch`, same undo — with source `statement` and the dedupe key
 * `statement:<sha256 of the bytes>:<row index>`.
 */

/** What the preview and import show about the reading (counts and labels only, never row text). */
interface StatementSummary {
	format: StatementReadFormat;
	institution: { id: string; label: string };
	manual: boolean;
	pages: number | null;
	pagesNotProcessed: number;
	balance: BalanceCheck;
	/** The account read from a multi-account statement (FN-16e), and every account in the file. */
	section: StatementSectionChoice | null;
	sections: StatementSectionChoice[];
	/**
	 * FN-48 Part B: whether the statement's Saldo Awal connects with the wallet's earlier statement or balance
	 * (`none` without a wallet or a printed balance).
	 */
	continuity: Continuity;
	/** FN-55b, a card statement only: what it printed (wallet convention, owed negative) and the card's balance now. */
	card: CardSummary | null;
}

/** A card statement as the Impor preview shows it: every figure printed, or a row sum, never computed otherwise. */
interface CardSummary {
	statementDate: string;
	dueDate: string | null;
	periodFrom: string | null;
	periodTo: string | null;
	previousBalanceMinor: number;
	newBalanceMinor: number;
	minimumPaymentMinor: number | null;
	limitMinor: number | null;
	/** Row sums (positive): payments, other credits, purchases with installments, fees with tax, interest. */
	totals: { payments: number; credits: number; purchases: number; fees: number; interest: number };
	/** Fees (with tax) plus interest, summed exactly (BigInt); null when past the safe range. */
	feesAndInterestMinor: number | null;
	/** The card wallet's balance now (information beside a first statement's "no claim"); null when too large. */
	walletBalanceMinor: number | null;
}

type Refused = {
	ok: false;
	error: StatementRefusal;
	hints: StatementHints | null;
	sections?: StatementSectionChoice[];
};

/** Longest description or note kept from a statement row. */
const NOTE_MAX_LENGTH = 500;

/**
 * Statement text as stored: cleaned (invisible characters out, length bounded), account and card numbers cut to
 * the last 4 digits, and only then cut to `max` — cutting first could leave a number's leading digits, too short
 * to be masked, at the end (red team L4).
 */
const masked = (text: string, max: number) =>
	cleanText(maskAccountNumbers(cleanText(text, max * 4)), max);

/** A row's free text as stored and shown (also used by the OCR import, FN-16g). */
export function maskRow(row: MappedRow): MappedRow {
	if (!row.ok) return row;
	const v = row.value;
	return {
		...row,
		value: {
			...v,
			title: masked(v.title, TITLE_MAX_LENGTH),
			notes: masked(v.notes, NOTE_MAX_LENGTH),
			walletName: masked(v.walletName, TITLE_MAX_LENGTH)
		}
	};
}

const refused = (error: StatementRefusal): Refused => ({ ok: false, error, hints: null });

/**
 * Reads the file for `wallet` (null: none chosen). FN-55b: a `kartu_kredit` wallet reads card parsers only and any
 * other wallet bank parsers only (read.ts); a card statement is then checked against the wallet (IDR, the printed
 * card's last 4, not already imported, below the per-card cap) before any row is considered, its rows carry their
 * class tiles and the card duplicate rule, and its span is its printed period (continuity.ts `cardStatementSpan`).
 */
async function prepare(
	db: Db,
	spaceId: string,
	input: StatementReadInput,
	parsers: readonly StatementParser[] | undefined,
	wallet: WalletSummary | null
): Promise<
	| {
			ok: true;
			prepared: PreparedRows;
			summary: Omit<StatementSummary, 'continuity'>;
			span: StatementSpan | null;
			/** FN-55b: the card statement's figures to store (only with a card wallet). */
			card: CardStatementFigures | null;
	  }
	| Refused
> {
	// 128 bits of the SHA-256 of the exact bytes: the same file always gives the same keys. Hashed first: the
	// PDF reader takes the buffer over (PDF.js receives it without a copy).
	const hash = bytesToHex(await crypto.subtle.digest('SHA-256', input.bytes as BufferSource)).slice(
		0,
		32
	);
	const read = await readStatement(
		{ ...input, walletKind: wallet?.type === 'kartu_kredit' ? 'card' : 'bank' },
		parsers
	);
	if (!read.ok) return read;
	const { reading } = read;
	const card = reading.parse.card ?? null;
	let tiles: Map<number, TileKey> | undefined;
	let span = statementSpan(
		reading.parse,
		reading.notProcessed > 0 || reading.pagesNotProcessed > 0
	);
	let cardSummary: CardSummary | null = null;
	if (card && wallet) {
		if (wallet.currency !== 'IDR') return refused('card_currency');
		if (card.cardLast4 !== null && wallet.lastFour !== null && card.cardLast4 !== wallet.lastFour)
			return refused('card_mismatch');
		// The same statement again (any bytes): refused before a row is considered.
		if (await cardStatementExists(db, spaceId, wallet.id, card.statementDate))
			return refused('card_already_imported');
		if (await cardStatementsFull(db, spaceId, wallet.id)) return refused('card_limit');
		tiles = new Map();
		for (const [i, row] of reading.parse.rows.entries()) {
			const tile = CARD_ROW_TILES[card.classes[i] ?? 'purchase'];
			if (tile) tiles.set(row.index, tile);
		}
		span = cardStatementSpan(
			card,
			await previousCardStatementDate(db, spaceId, wallet.id, card.statementDate)
		);
		const balance = await readWalletBalance(db, spaceId, wallet.id);
		cardSummary = {
			statementDate: card.statementDate,
			dueDate: card.dueDate,
			periodFrom: card.periodFrom,
			periodTo: card.periodTo,
			previousBalanceMinor: card.previousBalanceMinor,
			newBalanceMinor: card.newBalanceMinor,
			minimumPaymentMinor: card.minimumPaymentMinor,
			limitMinor: card.limitMinor,
			totals: card.totals,
			feesAndInterestMinor: safeMinor(BigInt(card.totals.fees) + BigInt(card.totals.interest)),
			walletBalanceMinor: balance === null ? null : safeMinor(balance)
		};
	}
	if (!reading.parse.rows.some((r) => r.ok))
		return {
			ok: false,
			error: 'no_rows',
			hints: null,
			...(reading.sections.length > 0 ? { sections: reading.sections } : {})
		};
	return {
		ok: true,
		prepared: {
			source: 'statement',
			format: null,
			rows: reading.parse.rows.map(maskRow),
			notProcessed: reading.notProcessed,
			keyPrefix: `statement:${hash}:`,
			...(tiles ? { tiles } : {}),
			...(card && wallet ? { cardWalletId: wallet.id } : {})
		},
		summary: {
			format: reading.format,
			institution: reading.institution,
			manual: reading.manual,
			pages: reading.pages,
			pagesNotProcessed: reading.pagesNotProcessed,
			balance: reading.balance,
			section: reading.section,
			sections: reading.sections,
			card: cardSummary
		},
		span,
		card: card && wallet ? card : null
	};
}

/** The statement's wallet: a live wallet of the space, or null (none chosen, or not one of this space). */
async function walletOf(db: Db, spaceId: string, walletId: string | null | undefined) {
	return walletId ? getWallet(db, spaceId, walletId) : null;
}

/** The statement's continuity in `walletId` (FN-48 Part B); no claim without a wallet or a readable row. */
async function continuityIn(
	db: Db,
	spaceId: string,
	walletId: string | null,
	span: StatementSpan | null,
	batchId: string | null
): Promise<Continuity> {
	if (!walletId || !span) return { status: 'none' };
	return checkStatement(db, spaceId, walletId, { ...span, id: batchId });
}

export type PreviewStatementResult =
	| { ok: true; summary: StatementSummary; counts: CsvCounts; duplicates: PossibleDuplicate[] }
	| Refused;

/** "Pratinjau" of a statement: what an import would do now, with the balance check. Writes nothing. */
export async function previewStatement(
	db: Db,
	spaceId: string,
	input: StatementReadInput & { defaultWalletId?: string | null },
	parsers?: readonly StatementParser[]
): Promise<PreviewStatementResult> {
	const wallet = await walletOf(db, spaceId, input.defaultWalletId);
	const read = await prepare(db, spaceId, input, parsers, wallet);
	if (!read.ok) return read;
	const { counts, duplicates } = await previewRows(db, spaceId, read.prepared);
	const continuity = await continuityIn(
		db,
		spaceId,
		input.defaultWalletId ?? null,
		read.span,
		null
	);
	return { ok: true, summary: { ...read.summary, continuity }, counts, duplicates };
}

export interface ImportStatementInput extends StatementReadInput {
	filename: string | null;
	defaultWalletId: string | null;
	skipPossibleDuplicates: boolean;
	/** FN-20: the app's bindings for the merchant resolver's AI step (the user's own key). */
	merchantEnv?: MerchantEnv;
}

export type ImportStatementResult =
	| {
			ok: true;
			batchId: string | null;
			summary: StatementSummary;
			counts: CsvCounts;
			/** FN-48d: own-transfer pairs the auto-match pass merged right after this import committed. */
			autoMatchedCount: number;
	  }
	| Refused
	| { ok: false; error: ImportRowsFailure; hints?: undefined; sections?: undefined };

/**
 * FN-48d: the auto-match pass after a committed statement import, as its own round trips. Its failure never fails
 * the import (already committed): it is logged as a fixed line plus `errorLabel` and counts 0 — the pairs stay on
 * the review page, nothing is lost.
 */
async function autoMatchAfterImport(db: Db, scope: SpaceScope, batchId: string, now: number) {
	try {
		return (await autoMatchTransferPairs(db, scope, batchId, now)).autoMatchedCount;
	} catch (e) {
		console.error('impor: transfer auto-match failed', errorLabel(e));
		return 0;
	}
}

/**
 * Imports a statement into the space: the fallback wallet is checked first (another space's id: not found,
 * before the file is even read), then the file is read and written by FN-18's `importRows`.
 */
export async function importStatement(
	db: Db,
	scope: SpaceScope,
	input: ImportStatementInput,
	now: number,
	parsers?: readonly StatementParser[]
): Promise<ImportStatementResult> {
	const fallback = await fallbackWalletOf(db, scope.spaceId, input.defaultWalletId);
	if (!fallback.ok) return fallback;
	const wallet = await walletOf(db, scope.spaceId, fallback.wallet?.id);
	const read = await prepare(db, scope.spaceId, input, parsers, wallet);
	if (!read.ok) return read;
	const { card } = read;
	const result = await importRows(
		db,
		scope,
		read.prepared,
		{
			filename: input.filename,
			fallbackWallet: fallback.wallet,
			skipPossibleDuplicates: input.skipPossibleDuplicates,
			merchantEnv: input.merchantEnv,
			statement: read.span,
			card
		},
		now
	);
	// FN-55b: a concurrent import of the same card statement won the race (the unique index refused this one, or
	// its rows are now all "already imported"): the same answer as importing it again afterwards.
	if (card && wallet && (!result.ok || result.batchId === null)) {
		if (await cardStatementExists(db, scope.spaceId, wallet.id, card.statementDate))
			return refused('card_already_imported');
	}
	if (!result.ok) return result;
	const autoMatchedCount = result.batchId
		? await autoMatchAfterImport(db, scope, result.batchId, now)
		: 0;
	// Checked against what is stored now: the new batch itself when one was written, else as a candidate.
	const continuity = await continuityIn(
		db,
		scope.spaceId,
		fallback.wallet?.id ?? null,
		read.span,
		result.batchId
	);
	return {
		ok: true,
		batchId: result.batchId,
		summary: { ...read.summary, continuity },
		counts: result.counts,
		autoMatchedCount
	};
}
