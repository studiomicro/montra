import type { StatementHints } from '#lib/shared/statements/detect';
import type { BalanceCheck } from '#lib/shared/statements/rows';
import type { MappedRow, StatementParser } from '#lib/shared/statements/types';
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
import { bytesToHex } from '../util';
import { checkStatement, statementSpan, type Continuity, type StatementSpan } from './continuity';
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
export interface StatementSummary {
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

async function prepare(
	input: StatementReadInput,
	parsers: readonly StatementParser[] | undefined
): Promise<
	| {
			ok: true;
			prepared: PreparedRows;
			summary: Omit<StatementSummary, 'continuity'>;
			span: StatementSpan | null;
	  }
	| Refused
> {
	// 128 bits of the SHA-256 of the exact bytes: the same file always gives the same keys. Hashed first: the
	// PDF reader takes the buffer over (PDF.js receives it without a copy).
	const hash = bytesToHex(await crypto.subtle.digest('SHA-256', input.bytes as BufferSource)).slice(
		0,
		32
	);
	const read = await readStatement(input, parsers);
	if (!read.ok) return read;
	const { reading } = read;
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
			keyPrefix: `statement:${hash}:`
		},
		summary: {
			format: reading.format,
			institution: reading.institution,
			manual: reading.manual,
			pages: reading.pages,
			pagesNotProcessed: reading.pagesNotProcessed,
			balance: reading.balance,
			section: reading.section,
			sections: reading.sections
		},
		span: statementSpan(reading.parse, reading.notProcessed > 0 || reading.pagesNotProcessed > 0)
	};
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
	const read = await prepare(input, parsers);
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
	| { ok: true; batchId: string | null; summary: StatementSummary; counts: CsvCounts }
	| Refused
	| { ok: false; error: ImportRowsFailure; hints?: undefined; sections?: undefined };

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
	const read = await prepare(input, parsers);
	if (!read.ok) return read;
	const result = await importRows(
		db,
		scope,
		read.prepared,
		{
			filename: input.filename,
			fallbackWallet: fallback.wallet,
			skipPossibleDuplicates: input.skipPossibleDuplicates,
			merchantEnv: input.merchantEnv,
			statement: read.span
		},
		now
	);
	if (!result.ok) return result;
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
		counts: result.counts
	};
}
