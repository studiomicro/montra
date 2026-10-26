import type { MappedRow, RowReview } from '#lib/shared/csv';
import {
	readOcrDocument,
	type OcrReading,
	type OcrRefusal,
	type OcrRefusalCounts
} from '#lib/shared/ocr/read';
import type { BalanceCheck } from '#lib/shared/statements/rows';
import type { StatementSectionChoice } from '#lib/shared/statements/sections';
import type { CategoryKind } from '#lib/shared/transactions';
import type { Db } from '../db';
import {
	fallbackWalletOf,
	importRows,
	previewRows,
	type CsvCounts,
	type ImportRowsFailure,
	type PossibleDuplicate,
	type PreparedRows
} from '../imports/csv-import';
import type { SpaceScope } from '../spaces/access';
import { sha256Hex } from '../util';
import { maskRow } from './statement-import';
import type { OcrFields } from './ocr-validation';

/**
 * On-device OCR import (FN-16g, PRD Scope 4): the device sends only the recognised words; the server reads them
 * from scratch with the same shared pipeline (src/lib/shared/ocr/read.ts), recomputes every figure and the
 * balance check, and lets the device choose only which of the rows it produced to include. The rows then go
 * through FN-18's preview and import core unchanged (same "Mungkin duplikat" query, validator, all-or-nothing
 * batch and undo) with source `statement`. Nothing of the words, the text or the image is stored or logged.
 *
 * Dedupe key: `ocr:<128-bit SHA-256 of institution | account last 4 | target wallet | date | signed amount |
 * balance-after or time>:<n>`, `n` the occurrence of the same tuple in this reading. The description is not in
 * it (it jitters between scans), so scanning the same statement again into the same wallet finds the rows
 * already imported, while another bank, account or wallet with the same date and amount does not.
 */

export type OcrImportRefusal = OcrRefusal | 'picks_invalid';

interface OcrSummary {
	kind: OcrReading['kind'];
	institution: { id: string; label: string };
	manual: boolean;
	pages: number;
	balance: BalanceCheck;
	unclearPages: number;
	notCompleted: number;
	section: StatementSectionChoice | null;
	sections: StatementSectionChoice[];
}

/** One row as the review list shows it (masked title; never the raw words). */
interface OcrPreviewRow {
	index: number;
	date: string;
	type: CategoryKind;
	title: string;
	amountMinor: number;
	review: RowReview | null;
	/** Imported unless the user changes it: a ready row not ticked out, or a review row ticked in. */
	included: boolean;
}

type Refused = {
	ok: false;
	error: OcrImportRefusal;
	counts: OcrRefusalCounts | null;
	sections?: StatementSectionChoice[];
};

interface Prepared {
	prepared: PreparedRows;
	summary: OcrSummary;
	rows: OcrPreviewRow[];
	totals: { incomeMinor: number; expenseMinor: number };
}

const included = (r: MappedRow, include: ReadonlySet<number>, exclude: ReadonlySet<number>) =>
	r.ok && !exclude.has(r.index) && (!r.review || include.has(r.index));

async function prepare(
	fields: OcrFields,
	todayWib: string
): Promise<{ ok: true; value: Prepared } | Refused> {
	const read = readOcrDocument({
		doc: fields.doc,
		institution: fields.institution,
		section: fields.section,
		todayWib
	});
	if (!read.ok)
		return {
			ok: false,
			error: read.error,
			counts: read.counts,
			...(read.sections ? { sections: read.sections } : {})
		};
	const { reading } = read;
	const count = reading.rows.length;
	if ([...fields.include, ...fields.exclude].some((i) => i >= count))
		return { ok: false, error: 'picks_invalid', counts: null };
	const include = new Set(fields.include);
	const exclude = new Set(fields.exclude);

	// Keys from what each row says plus where it goes (bank, account, wallet), so the same date and amount in
	// another bank, account or wallet is a different record; identical rows in one reading are told apart by
	// their occurrence. A re-scan of the same file into the same wallet has the same scope, hence the same keys.
	const scope = [
		reading.institution.id,
		reading.section?.accountLast4 ?? '',
		fields.defaultWalletId ?? ''
	].join('|');
	const keys = new Map<number, string>();
	const seen = new Map<string, number>();
	for (const r of reading.rows) {
		if (!r.ok) continue;
		const signed = r.value.type === 'income' ? r.value.amountMinor : -r.value.amountMinor;
		const tuple = `${scope}|${r.value.date}|${signed}|${reading.keyParts[r.index] ?? ''}`;
		const n = seen.get(tuple) ?? 0;
		seen.set(tuple, n + 1);
		keys.set(r.index, `ocr:${(await sha256Hex(tuple)).slice(0, 32)}:${n}`);
	}

	const masked = reading.rows.map(maskRow);
	const rows: OcrPreviewRow[] = [];
	const totals = { incomeMinor: 0, expenseMinor: 0 };
	for (const r of masked) {
		if (!r.ok) continue;
		const on = included(r, include, exclude);
		rows.push({
			index: r.index,
			date: r.value.date,
			type: r.value.type,
			title: r.value.title,
			amountMinor: r.value.amountMinor,
			review: r.review ?? null,
			included: on
		});
		if (on)
			totals[r.value.type === 'income' ? 'incomeMinor' : 'expenseMinor'] += r.value.amountMinor;
	}
	return {
		ok: true,
		value: {
			prepared: {
				source: 'statement',
				format: null,
				// Rows left out are skipped, never written.
				rows: masked.map((r): MappedRow =>
					r.ok && !included(r, include, exclude)
						? { index: r.index, ok: false, reason: 'excluded' }
						: r
				),
				notProcessed: reading.notProcessed,
				keyPrefix: 'ocr:',
				keys
			},
			summary: {
				kind: reading.kind,
				institution: reading.institution,
				manual: reading.manual,
				pages: reading.pages,
				balance: reading.balance,
				unclearPages: reading.unclearPages,
				notCompleted: reading.notCompleted,
				section: reading.section,
				sections: reading.sections
			},
			rows,
			totals
		}
	};
}

export type PreviewOcrResult =
	| {
			ok: true;
			summary: OcrSummary;
			counts: CsvCounts;
			duplicates: PossibleDuplicate[];
			rows: OcrPreviewRow[];
			totals: { incomeMinor: number; expenseMinor: number };
	  }
	| Refused;

/** What importing the reading would do now, with the per-row review list. Writes nothing. */
export async function previewOcr(
	db: Db,
	spaceId: string,
	fields: OcrFields,
	todayWib: string
): Promise<PreviewOcrResult> {
	const read = await prepare(fields, todayWib);
	if (!read.ok) return read;
	const { counts, duplicates } = await previewRows(db, spaceId, read.value.prepared);
	return {
		ok: true,
		summary: read.value.summary,
		counts,
		duplicates,
		rows: read.value.rows,
		totals: read.value.totals
	};
}

export type ImportOcrResult =
	| { ok: true; batchId: string | null; summary: OcrSummary; counts: CsvCounts }
	| Refused
	| { ok: false; error: ImportRowsFailure; counts?: undefined; sections?: undefined };

/** Imports the picked rows: the fallback wallet is checked before anything is read; no file name is kept. */
export async function importOcr(
	db: Db,
	scope: SpaceScope,
	fields: OcrFields,
	todayWib: string,
	now: number
): Promise<ImportOcrResult> {
	const fallback = await fallbackWalletOf(db, scope.spaceId, fields.defaultWalletId);
	if (!fallback.ok) return fallback;
	const read = await prepare(fields, todayWib);
	if (!read.ok) return read;
	const result = await importRows(
		db,
		scope,
		read.value.prepared,
		{
			filename: null,
			fallbackWallet: fallback.wallet,
			skipPossibleDuplicates: fields.skipPossibleDuplicates
		},
		now
	);
	if (!result.ok) return result;
	return { ok: true, batchId: result.batchId, summary: read.value.summary, counts: result.counts };
}
