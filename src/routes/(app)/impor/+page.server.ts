import { fail } from '@sveltejs/kit';
import { countCleanupCandidates } from '#lib/server/categories/cleanup';
import { overUserSlidingLimit } from '#lib/server/auth/throttle';
import { BodyBudgetExceeded, readFormBody, textField } from '#lib/server/forms';
import { getEnv } from '#lib/server/env';
import { importCsv, previewCsv, type CsvRefusal } from '#lib/server/imports/csv-import';
import {
	BATCH_ALREADY_UNDONE,
	BATCH_NOT_FOUND,
	CONTINUITY_ALREADY,
	CONTINUITY_CHANGED,
	EXPORT_RANGE_INVALID,
	FILE_EMPTY,
	FILE_TOO_MANY_COLUMNS,
	FILE_UNTERMINATED_QUOTE,
	FORMAT_MISMATCH,
	FORMAT_UNKNOWN,
	IMPORT_BUSY,
	IMPORT_FAILED,
	IMPORT_GONE,
	IMPORTS_LOAD_FAILED,
	MOVE_BATCH_UNDONE,
	MOVE_CURRENCY_MISMATCH,
	MOVE_MIXED_WALLETS,
	MOVE_NOTHING,
	MOVE_TRANSFER_LINKED,
	MOVE_SAME_WALLET,
	MOVE_SOURCE_ARCHIVED,
	OCR_INCONSISTENT,
	OCR_INSTITUTION_CONFLICT,
	OCR_INSTITUTION_MISMATCH,
	OCR_NO_ROWS,
	OCR_PICKS_INVALID,
	OCR_UNSUPPORTED,
	PDF_CORRUPT,
	PDF_NEEDS_PASSWORD,
	PDF_TOO_COMPLEX,
	PDF_WRONG_PASSWORD,
	STATEMENT_MONTRA_CSV,
	STATEMENT_INSTITUTION_CONFLICT,
	STATEMENT_INSTITUTION_MISMATCH,
	STATEMENT_NEEDS_AI,
	STATEMENT_INCONSISTENT,
	STATEMENT_NO_ROWS,
	STATEMENT_BUSY,
	STATEMENT_NOT_READABLE,
	STATEMENT_RATE_LIMITED,
	STATEMENT_SECTION_REQUIRED,
	STATEMENT_SECTION_UNKNOWN,
	STATEMENT_SECTION_UNSUPPORTED,
	STATEMENT_SPREADSHEET,
	STATEMENT_UNSUPPORTED
} from '#lib/server/imports/messages';
import {
	importBatchMoveStates,
	listImportBatches,
	moveImportBatch,
	undoImportBatch,
	type MoveResult
} from '#lib/server/imports/repo';
import {
	parseUploadFields,
	readUploadedCsv,
	UPLOAD_BODY_MAX_BYTES
} from '#lib/server/imports/validation';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { closeContinuityGap, continuityBreaks } from '#lib/server/statements/continuity';
import { countTransferMatches } from '#lib/server/transfers/match';
import { reservePdfRead, type PdfReadPlace } from '#lib/server/statements/pdf-text';
import type { StatementRefusal, StatementSectionChoice } from '#lib/server/statements/read';
import { importStatement, previewStatement } from '#lib/server/statements/statement-import';
import { importOcr, previewOcr, type OcrImportRefusal } from '#lib/server/statements/ocr-import';
import { OCR_BODY_MAX_BYTES, parseOcrFields } from '#lib/server/statements/ocr-validation';
import { SCREEN_PARSERS, type OcrRefusalCounts } from '#lib/shared/ocr/read';
import {
	parseStatementFields,
	readUploadedStatement,
	STATEMENT_BODY_IDLE_MS,
	STATEMENT_BODY_MAX_BYTES,
	STATEMENT_BODY_TIMEOUT_MS,
	STATEMENT_UPLOADS_PER_WINDOW
} from '#lib/server/statements/validation';
import type { StatementHints } from '#lib/shared/statements/detect';
import { statementCatalogue } from '#lib/shared/statements/catalogue';
import { STATEMENT_PARSERS } from '#lib/shared/statements/parsers';
import { overTransactionCreateLimit } from '#lib/server/transactions/create-limit';
import {
	ADJUSTMENT_TOO_LARGE,
	TRANSACTION_CHANGED,
	TRANSACTION_LIMIT,
	TRANSACTION_RATE_LIMITED
} from '#lib/server/transactions/messages';
import { ID_MAX_LENGTH } from '#lib/server/transactions/validation';
import { errorLabel } from '#lib/server/util';
import { importSheetAction, previewSheetAction, suggestMappingAction } from './spreadsheet.server';
import { WALLET_NOT_FOUND } from '#lib/server/wallets/messages';
import { listWallets } from '#lib/server/wallets/repo';
import { isDateString, monthOf, monthRange, wibTodayString } from '#lib/shared/dates';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

const UPDATED_AT = /^\d{1,15}$/;

/** FN-16j: each refused move as the page shows it (nothing was written). */
const MOVE_REFUSALS: Readonly<
	Record<Extract<MoveResult, { ok: false }>['reason'], { status: number; error: string }>
> = {
	missing: { status: 404, error: BATCH_NOT_FOUND },
	already: { status: 409, error: MOVE_BATCH_UNDONE },
	stale: { status: 409, error: TRANSACTION_CHANGED },
	wallet_not_found: { status: 404, error: WALLET_NOT_FOUND },
	same_wallet: { status: 400, error: MOVE_SAME_WALLET },
	currency_mismatch: { status: 400, error: MOVE_CURRENCY_MISMATCH },
	source_archived: { status: 409, error: MOVE_SOURCE_ARCHIVED },
	mixed_wallets: { status: 409, error: MOVE_MIXED_WALLETS },
	nothing_to_move: { status: 409, error: MOVE_NOTHING },
	transfer_linked: { status: 409, error: MOVE_TRANSFER_LINKED }
};
/** A gap as the page sent it: a signed integer of minor units (anything else matches no gap). */
const GAP = /^-?\d{1,16}$/;

const REFUSALS: Readonly<Record<CsvRefusal, string>> = {
	empty: FILE_EMPTY,
	unterminated_quote: FILE_UNTERMINATED_QUOTE,
	too_many_columns: FILE_TOO_MANY_COLUMNS,
	format_mismatch: FORMAT_MISMATCH,
	format_unknown: FORMAT_UNKNOWN
};

const STATEMENT_REFUSALS: Readonly<Record<StatementRefusal, string>> = {
	not_readable: STATEMENT_NOT_READABLE,
	spreadsheet_unsupported: STATEMENT_SPREADSHEET,
	encrypted: PDF_NEEDS_PASSWORD,
	wrong_password: PDF_WRONG_PASSWORD,
	corrupt: PDF_CORRUPT,
	too_complex: PDF_TOO_COMPLEX,
	needs_ai: STATEMENT_NEEDS_AI,
	montra_csv: STATEMENT_MONTRA_CSV,
	institution_unknown: STATEMENT_UNSUPPORTED,
	institution_mismatch: STATEMENT_INSTITUTION_MISMATCH,
	institution_conflict: STATEMENT_INSTITUTION_CONFLICT,
	no_rows: STATEMENT_NO_ROWS,
	inconsistent: STATEMENT_INCONSISTENT,
	reader_busy: STATEMENT_BUSY,
	section_required: STATEMENT_SECTION_REQUIRED,
	section_unknown: STATEMENT_SECTION_UNKNOWN,
	section_unsupported: STATEMENT_SECTION_UNSUPPORTED,
	empty: FILE_EMPTY,
	unterminated_quote: FILE_UNTERMINATED_QUOTE,
	too_many_columns: FILE_TOO_MANY_COLUMNS
};

/**
 * A refused statement: 400 with the message, what was recognised (counts and shapes only, never content),
 * whether it needs the AI read or a password, and a multi-account file's accounts for the picker (FN-16e).
 * Tagged `section: 'statement'` so the page shows it there.
 */
function statementFailure(
	event: RequestEvent,
	error: StatementRefusal,
	hints: StatementHints | null,
	sections: StatementSectionChoice[] = []
) {
	if (error === 'reader_busy') return statementBusy(event);
	return fail(400, {
		section: 'statement' as const,
		error: STATEMENT_REFUSALS[error],
		hints,
		needsAi: error === 'needs_ai',
		needsPassword: error === 'encrypted' || error === 'wrong_password',
		needsInstitution: error === 'institution_unknown' && STATEMENT_PARSERS.length > 0,
		...(sections.length > 0 ? { sections } : {})
	});
}

const OCR_REFUSALS: Readonly<Record<OcrImportRefusal, string>> = {
	institution_unknown: OCR_UNSUPPORTED,
	institution_mismatch: OCR_INSTITUTION_MISMATCH,
	institution_conflict: OCR_INSTITUTION_CONFLICT,
	inconsistent: OCR_INCONSISTENT,
	no_rows: OCR_NO_ROWS,
	section_required: STATEMENT_SECTION_REQUIRED,
	section_unknown: STATEMENT_SECTION_UNKNOWN,
	section_unsupported: STATEMENT_SECTION_UNSUPPORTED,
	picks_invalid: OCR_PICKS_INVALID
};

/** A refused OCR reading: 400 with the message and counts only (pages, rows, the balance gap), never row text. */
function ocrFailure(
	error: OcrImportRefusal,
	counts: OcrRefusalCounts | null,
	sections: StatementSectionChoice[] = []
) {
	return fail(400, {
		section: 'ocr' as const,
		error: OCR_REFUSALS[error],
		counts,
		needsInstitution: error === 'institution_unknown',
		...(sections.length > 0 ? { sections } : {})
	});
}

/** The export form's range: what `/impor/ekspor` sent back (a cut or refused range), else this WIB month. */
function exportRange(url: URL, today: string) {
	const from = url.searchParams.get('from') ?? '';
	const to = url.searchParams.get('to') ?? '';
	const valid = isDateString(from) && isDateString(to);
	return {
		from: valid ? from : monthRange(monthOf(today)).from,
		to: valid ? to : today,
		notice: url.searchParams.get('ekspor') === 'dipotong' ? ('cut' as const) : null,
		error: url.searchParams.get('ekspor') === 'salah' ? EXPORT_RANGE_INVALID : null
	};
}

/** What the OCR picker offers: the bank statement readers, then the screenshot families (FN-16g). */
const OCR_INSTITUTIONS = [...STATEMENT_PARSERS, ...SCREEN_PARSERS].map(({ id, label }) => ({
	id,
	label
}));

/** The statement picker's rows (FN-16i): the parsers selectable, every other FN-04 institution disabled. */
const STATEMENT_CATALOGUE = statementCatalogue(STATEMENT_PARSERS);

export const load: PageServerLoad = async ({ locals, url }) => {
	const { spaceId } = await currentSpaceScope(locals);
	const today = wibTodayString();
	const base = { today, exportRange: exportRange(url, today) };
	try {
		const [batches, wallets, cleanupCount, continuity, transferMatchCount] = await Promise.all([
			listImportBatches(locals.db, spaceId),
			listWallets(locals.db, spaceId),
			// FN-48: rows "Rapikan kategori" may still improve (the card shows only when there are any).
			countCleanupCandidates(locals.db, spaceId),
			// FN-48 Part B: statements whose Saldo Awal does not connect (the card shows only when there are any).
			continuityBreaks(locals.db, spaceId),
			// FN-48 Part C: own-transfer pairs "Cocokkan transfer" can merge (the card shows only when there are any).
			countTransferMatches(locals.db, spaceId)
		]);
		// FN-16j: the wallet each batch's rows sit in, or why the batch cannot be moved as one.
		const moveStates = await importBatchMoveStates(
			locals.db,
			spaceId,
			batches.map((b) => b.id)
		);
		return {
			...base,
			statementInstitutions: STATEMENT_PARSERS.map(({ id, label }) => ({ id, label })),
			statementCatalogue: STATEMENT_CATALOGUE,
			ocrInstitutions: OCR_INSTITUTIONS,
			batches: batches.map((b) => ({
				...b,
				fromWalletId: moveStates.get(b.id)?.fromWalletId ?? null,
				moveBlocked: moveStates.get(b.id)?.moveBlocked ?? null
			})),
			cleanupCount,
			continuity,
			transferMatchCount,
			// Imports write IDR rows only: only IDR wallets can take the rows that name no wallet.
			wallets: wallets
				.filter((w) => w.currency === 'IDR')
				.map(({ id, name, isFavourite }) => ({ id, name, isFavourite })),
			// FN-16j: where an import can move to (a live wallet of the batch's own currency; the page filters).
			moveWallets: wallets.map(({ id, name, currency }) => ({ id, name, currency })),
			loadError: null
		};
	} catch (e) {
		console.error('impor: load failed', errorLabel(e));
		return {
			...base,
			statementInstitutions: STATEMENT_PARSERS.map(({ id, label }) => ({ id, label })),
			statementCatalogue: STATEMENT_CATALOGUE,
			ocrInstitutions: OCR_INSTITUTIONS,
			batches: [],
			wallets: [],
			moveWallets: [],
			cleanupCount: 0,
			continuity: [],
			transferMatchCount: 0,
			loadError: IMPORTS_LOAD_FAILED
		};
	}
};

/** The upload, read within the upload cap (400/415 past it), the space checked, the file read in memory only. */
async function upload(event: RequestEvent) {
	const form = await readFormBody(event.request, UPLOAD_BODY_MAX_BYTES);
	const scope = await currentSpaceScope(event.locals);
	const fields = parseUploadFields(form);
	if (!fields.ok) return { ok: false as const, failure: fail(400, { error: fields.error }) };
	const file = await readUploadedCsv(form);
	if (!file.ok) return { ok: false as const, failure: fail(400, { error: file.error }) };
	return { ok: true as const, scope, fields: fields.value, file };
}

/** Seconds a client is told to wait when the statement reader is busy. */
const STATEMENT_RETRY_AFTER_S = 30;

/** 503 with Retry-After: this isolate's statement reader is full, or the user already has an upload in flight. */
function statementBusy(event: RequestEvent) {
	event.setHeaders({ 'retry-after': String(STATEMENT_RETRY_AFTER_S) });
	return fail(503, { section: 'statement' as const, error: STATEMENT_BUSY });
}

/**
 * Runs a statement action inside a place of this isolate's statement lane, taken before the body is read
 * (red team N2): when the user already holds one, 503 with Retry-After and the body is never read. The body's
 * bytes are charged to the lane as they arrive (red team L4); past its budget, 503 as well. Released on every
 * exit.
 */
async function inStatementLane<T>(event: RequestEvent, work: (place: PdfReadPlace) => Promise<T>) {
	const { userId } = await currentSpaceScope(event.locals);
	const place = reservePdfRead(userId);
	if (!place) return statementBusy(event);
	try {
		return await work(place);
	} catch (e) {
		if (e instanceof BodyBudgetExceeded) return statementBusy(event);
		throw e;
	} finally {
		place.release();
	}
}

/**
 * The statement upload (FN-16a): read within its 15 MB cap (400/415 past it, 408 when it stalls), the space
 * checked, the fields checked, the file's bytes held in memory only.
 */
async function statementUpload(event: RequestEvent, place: PdfReadPlace) {
	const scope = await currentSpaceScope(event.locals);
	const bad = (error: string, status = 400) => ({
		ok: false as const,
		failure: fail(status, { section: 'statement' as const, error })
	});
	// Counted per user before the body is even read: each upload may parse an untrusted PDF (red team M1).
	if (
		await overUserSlidingLimit(
			event.locals.db,
			scope.userId,
			Date.now(),
			'statement-upload',
			STATEMENT_UPLOADS_PER_WINDOW
		)
	)
		return bad(STATEMENT_RATE_LIMITED, 429);
	const form = await readFormBody(
		event.request,
		STATEMENT_BODY_MAX_BYTES,
		STATEMENT_BODY_TIMEOUT_MS,
		STATEMENT_BODY_IDLE_MS,
		place.charge
	);
	const fields = parseStatementFields(form);
	if (!fields.ok) return bad(fields.error);
	const file = await readUploadedStatement(form);
	if (!file.ok) return bad(file.error);
	return { ok: true as const, scope, fields: fields.value, file };
}

/**
 * Runs the import's database work; a D1 failure is logged as a fixed line plus `errorLabel` (never the error
 * message, which carries the bound rows) and answered 503 with a content-free message (red team L2).
 */
async function guardedDb<T>(what: string, work: () => Promise<T>) {
	try {
		return { ok: true as const, value: await work() };
	} catch (e) {
		console.error(`impor: ${what} failed`, errorLabel(e));
		return { ok: false as const, failure: fail(503, { error: IMPORT_FAILED }) };
	}
}

/** `?/previewStatement`: what an import of the uploaded statement would do. Writes nothing. */
async function previewStatementAction(event: RequestEvent, place: PdfReadPlace) {
	const read = await statementUpload(event, place);
	if (!read.ok) return read.failure;
	const { fields, file } = read;
	const run = await guardedDb('statement preview', () =>
		previewStatement(event.locals.db, read.scope.spaceId, {
			bytes: file.bytes,
			password: fields.password,
			institution: fields.institution,
			section: fields.section,
			defaultWalletId: fields.defaultWalletId
		})
	);
	if (!run.ok) return run.failure;
	const result = run.value;
	if (!result.ok) return statementFailure(event, result.error, result.hints, result.sections);
	return {
		section: 'statement' as const,
		done: 'statementPreviewed' as const,
		statement: result.summary,
		counts: result.counts,
		duplicates: result.duplicates
	};
}

/** `?/importStatement`: imports the uploaded statement. */
async function importStatementAction(event: RequestEvent, place: PdfReadPlace) {
	const read = await statementUpload(event, place);
	if (!read.ok) return read.failure;
	const { fields, file } = read;
	// One creating action per import, however many rows it holds (create-limit.ts), like the CSV import.
	if (await overTransactionCreateLimit(event.locals.db, read.scope.userId, Date.now()))
		return fail(429, { section: 'statement' as const, error: TRANSACTION_RATE_LIMITED });
	const run = await guardedDb('statement import', () =>
		importStatement(
			event.locals.db,
			read.scope,
			{
				bytes: file.bytes,
				password: fields.password,
				institution: fields.institution,
				section: fields.section,
				filename: file.filename || null,
				defaultWalletId: fields.defaultWalletId,
				skipPossibleDuplicates: fields.skipPossibleDuplicates,
				merchantEnv: getEnv()
			},
			Date.now()
		)
	);
	if (!run.ok) return run.failure;
	const result = run.value;
	if (!result.ok) {
		switch (result.error) {
			case 'wallet_not_found':
				return fail(404, { section: 'statement' as const, error: WALLET_NOT_FOUND });
			case 'gone':
				return fail(409, { section: 'statement' as const, error: IMPORT_GONE });
			case 'busy':
				return fail(409, { section: 'statement' as const, error: IMPORT_BUSY });
			case 'limit':
				return fail(409, { section: 'statement' as const, error: TRANSACTION_LIMIT });
			default:
				return statementFailure(event, result.error, result.hints ?? null, result.sections);
		}
	}
	return {
		section: 'statement' as const,
		done: 'statementImported' as const,
		statement: result.summary,
		counts: result.counts
	};
}

/**
 * The OCR actions' input (FN-16g): throttled in the same bucket as statement uploads before the body is read,
 * then the words (at most 512 KB, never an image) read and checked. 400/408/413/415, never 500.
 */
async function ocrUpload(event: RequestEvent) {
	const scope = await currentSpaceScope(event.locals);
	const bad = (error: string, status = 400) => ({
		ok: false as const,
		failure: fail(status, { section: 'ocr' as const, error })
	});
	if (
		await overUserSlidingLimit(
			event.locals.db,
			scope.userId,
			Date.now(),
			'statement-upload',
			STATEMENT_UPLOADS_PER_WINDOW
		)
	)
		return bad(STATEMENT_RATE_LIMITED, 429);
	const form = await readFormBody(
		event.request,
		OCR_BODY_MAX_BYTES,
		STATEMENT_BODY_TIMEOUT_MS,
		STATEMENT_BODY_IDLE_MS
	);
	const fields = parseOcrFields(form);
	if (!fields.ok) return bad(fields.error);
	return { ok: true as const, scope, fields: fields.value };
}

/** `?/previewOcr`: what importing the on-device reading would do, with its review list. Writes nothing. */
async function previewOcrAction(event: RequestEvent) {
	const read = await ocrUpload(event);
	if (!read.ok) return read.failure;
	const run = await guardedDb('ocr preview', () =>
		previewOcr(event.locals.db, read.scope.spaceId, read.fields, wibTodayString())
	);
	if (!run.ok) return run.failure;
	const result = run.value;
	if (!result.ok) return ocrFailure(result.error, result.counts, result.sections);
	return {
		section: 'ocr' as const,
		done: 'ocrPreviewed' as const,
		ocr: result.summary,
		counts: result.counts,
		duplicates: result.duplicates,
		rows: result.rows,
		totals: result.totals
	};
}

/** `?/importOcr`: imports the rows of the on-device reading the user kept. */
async function importOcrAction(event: RequestEvent) {
	const read = await ocrUpload(event);
	if (!read.ok) return read.failure;
	if (await overTransactionCreateLimit(event.locals.db, read.scope.userId, Date.now()))
		return fail(429, { section: 'ocr' as const, error: TRANSACTION_RATE_LIMITED });
	const run = await guardedDb('ocr import', () =>
		importOcr(event.locals.db, read.scope, read.fields, wibTodayString(), Date.now())
	);
	if (!run.ok) return run.failure;
	const result = run.value;
	if (!result.ok) {
		switch (result.error) {
			case 'wallet_not_found':
				return fail(404, { section: 'ocr' as const, error: WALLET_NOT_FOUND });
			case 'gone':
				return fail(409, { section: 'ocr' as const, error: IMPORT_GONE });
			case 'busy':
				return fail(409, { section: 'ocr' as const, error: IMPORT_BUSY });
			case 'limit':
				return fail(409, { section: 'ocr' as const, error: TRANSACTION_LIMIT });
			default:
				return ocrFailure(result.error, result.counts ?? null, result.sections);
		}
	}
	return {
		section: 'ocr' as const,
		done: 'ocrImported' as const,
		ocr: result.summary,
		counts: result.counts,
		batchId: result.batchId
	};
}

export const actions: Actions = {
	preview: async (event) => {
		const read = await upload(event);
		if (!read.ok) return read.failure;
		const run = await guardedDb('preview', () =>
			previewCsv(event.locals.db, read.scope.spaceId, {
				fileText: read.file.text,
				format: read.fields.format
			})
		);
		if (!run.ok) return run.failure;
		const result = run.value;
		if (!result.ok) {
			return fail(400, {
				error: REFUSALS[result.error],
				needsFormat: result.error === 'format_unknown'
			});
		}
		return {
			done: 'previewed' as const,
			format: result.format,
			counts: result.counts,
			duplicates: result.duplicates
		};
	},

	import: async (event) => {
		const read = await upload(event);
		if (!read.ok) return read.failure;
		// One creating action per import, however many rows it holds (create-limit.ts).
		const now = Date.now();
		if (await overTransactionCreateLimit(event.locals.db, read.scope.userId, now))
			return fail(429, { error: TRANSACTION_RATE_LIMITED });
		const run = await guardedDb('import', () =>
			importCsv(
				event.locals.db,
				read.scope,
				{
					fileText: read.file.text,
					filename: read.file.filename || null,
					format: read.fields.format,
					defaultWalletId: read.fields.defaultWalletId,
					skipPossibleDuplicates: read.fields.skipPossibleDuplicates,
					merchantEnv: getEnv()
				},
				now
			)
		);
		if (!run.ok) return run.failure;
		const result = run.value;
		if (!result.ok) {
			switch (result.error) {
				case 'wallet_not_found':
					return fail(404, { error: WALLET_NOT_FOUND });
				case 'gone':
					return fail(409, { error: IMPORT_GONE });
				case 'busy':
					return fail(409, { error: IMPORT_BUSY });
				case 'limit':
					return fail(409, { error: TRANSACTION_LIMIT });
				default:
					return fail(400, {
						error: REFUSALS[result.error],
						needsFormat: result.error === 'format_unknown'
					});
			}
		}
		// FN-51: the page replays the enter animation on the batch this result names (the id is already in hand).
		return { done: 'imported' as const, counts: result.counts, batchId: result.batchId };
	},

	previewStatement: (event) =>
		inStatementLane(event, (place) => previewStatementAction(event, place)),
	importStatement: (event) =>
		inStatementLane(event, (place) => importStatementAction(event, place)),
	previewSheet: previewSheetAction,
	suggestMapping: suggestMappingAction,
	importSheet: importSheetAction,
	previewOcr: previewOcrAction,
	importOcr: importOcrAction,

	undo: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const id = textField(form, 'id');
		const updatedAt = textField(form, 'updatedAt');
		// A malformed id or version matches nothing: the same answers as an unknown batch or a stale page.
		const result = await undoImportBatch(
			event.locals.db,
			scope,
			id.length > ID_MAX_LENGTH ? '' : id,
			UPDATED_AT.test(updatedAt) ? Number(updatedAt) : -1,
			Date.now()
		);
		if (result === 'missing') return fail(404, { error: BATCH_NOT_FOUND });
		if (result === 'stale') return fail(409, { error: TRANSACTION_CHANGED });
		if (result === 'already') return { done: 'already' as const, message: BATCH_ALREADY_UNDONE };
		return { done: 'undone' as const, batchId: id, transferKept: result === 'ok_transfer_kept' };
	},

	/**
	 * FN-16j "Pindahkan ke dompet lain": every live transaction of the batch (and a statement batch's continuity
	 * wallet) moves to another live wallet of the same currency, in one write. Refusals change nothing.
	 */
	move: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const id = textField(form, 'id');
		const updatedAt = textField(form, 'updatedAt');
		const walletId = textField(form, 'walletId');
		// A malformed id or version matches nothing: the same answers as an unknown batch/wallet or a stale page.
		const result = await moveImportBatch(
			event.locals.db,
			scope,
			id.length > ID_MAX_LENGTH ? '' : id,
			walletId.length > ID_MAX_LENGTH ? '' : walletId,
			UPDATED_AT.test(updatedAt) ? Number(updatedAt) : -1,
			Date.now()
		);
		if (!result.ok) {
			const refusal = MOVE_REFUSALS[result.reason];
			return fail(refusal.status, { error: refusal.error });
		}
		return {
			done: 'moved' as const,
			batchId: id,
			moved: result.moved,
			skipped: result.skipped,
			walletName: result.walletName
		};
	},

	/**
	 * FN-48 Part B "Catat penyesuaian": closes a statement's continuity gap with one balance-adjustment row. The
	 * gap is computed again on the server; the posted one only detects a page that is out of date.
	 */
	closeGap: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const now = Date.now();
		if (await overTransactionCreateLimit(event.locals.db, scope.userId, now))
			return fail(429, { error: TRANSACTION_RATE_LIMITED });
		const id = textField(form, 'id');
		const gap = textField(form, 'gap');
		const result = await closeContinuityGap(
			event.locals.db,
			scope,
			id.length > ID_MAX_LENGTH ? '' : id,
			GAP.test(gap) ? Number(gap) : Number.NaN,
			now
		);
		if (result.ok) return { done: 'gapClosed' as const };
		switch (result.reason) {
			case 'already':
				return { done: 'already' as const, message: CONTINUITY_ALREADY };
			case 'missing':
				return fail(404, { error: BATCH_NOT_FOUND });
			case 'stale':
				return fail(409, { error: CONTINUITY_CHANGED });
			case 'limit':
				return fail(409, { error: TRANSACTION_LIMIT });
			case 'too_large':
				return fail(400, { error: ADJUSTMENT_TOO_LARGE });
		}
	}
};
