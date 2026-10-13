import { fail, type RequestEvent } from '@sveltejs/kit';
import { isAiGatewayConfigured } from '#lib/server/ai-keys/anthropic';
import { resolveAnthropicKey } from '#lib/server/ai-keys/lookup';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import { getEnv } from '#lib/server/env';
import { readFormBody } from '#lib/server/forms';
import { IMPORT_BUSY, IMPORT_FAILED, IMPORT_GONE } from '#lib/server/imports/messages';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { suggestTabMapping } from '#lib/server/spreadsheet/ai-mapping';
import {
	importSheet,
	previewSheet,
	suggestionInput,
	withSuggestion,
	type SheetLayout,
	type SheetRefusal
} from '#lib/server/spreadsheet/import';
import {
	SHEET_AI_NO_KEY,
	SHEET_AI_NOT_CONFIGURED,
	SHEET_AI_RATE_LIMITED,
	SHEET_AI_TAB_INVALID,
	SHEET_AI_UNUSABLE,
	SHEET_BUSY,
	SHEET_CORRUPT,
	SHEET_ENCRYPTED,
	SHEET_FIELDS_INVALID,
	SHEET_LEGACY,
	SHEET_MACRO,
	SHEET_NO_SHEETS,
	SHEET_NOT_TRANSACTIONS,
	SHEET_NOT_XLSX,
	SHEET_NOTHING_MAPPED,
	SHEET_RATE_LIMITED,
	SHEET_TOO_COMPLEX,
	SHEET_TOO_LARGE,
	SHEET_TOO_MANY_COLUMNS,
	SHEET_UNSAFE
} from '#lib/server/spreadsheet/messages';
import {
	parseSheetFields,
	readUploadedSheet,
	reserveSheetRead,
	SHEET_AI_PER_WINDOW,
	SHEET_BODY_IDLE_MS,
	SHEET_BODY_MAX_BYTES,
	SHEET_BODY_TIMEOUT_MS
} from '#lib/server/spreadsheet/validation';
import { STATEMENT_UPLOADS_PER_WINDOW } from '#lib/server/statements/validation';
import { overTransactionCreateLimit } from '#lib/server/transactions/create-limit';
import { TRANSACTION_LIMIT, TRANSACTION_RATE_LIMITED } from '#lib/server/transactions/messages';
import { errorLabel } from '#lib/server/util';
import { WALLET_NOT_FOUND } from '#lib/server/wallets/messages';

/**
 * The spreadsheet section's actions on /impor (FN-17): `?/previewSheet` ("Baca berkas" and "Pakai pemetaan
 * ini"), `?/suggestMapping` ("Sarankan pemetaan dengan AI") and `?/importSheet`. Each one takes a place in this
 * isolate's spreadsheet reader and counts against the user's upload budget before the body is read, reads the
 * file in memory only, and answers tagged `section: 'spreadsheet'` so only that section shows it. Plain form
 * posts: the whole path works without JavaScript.
 */

const SECTION = 'spreadsheet' as const;
/** Seconds a client is told to wait when the spreadsheet reader is busy. */
const RETRY_AFTER_S = 30;

const REFUSALS: Readonly<Record<SheetRefusal, string>> = {
	not_xlsx: SHEET_NOT_XLSX,
	legacy_xls: SHEET_LEGACY,
	encrypted: SHEET_ENCRYPTED,
	macro: SHEET_MACRO,
	too_large: SHEET_TOO_LARGE,
	unsafe_xml: SHEET_UNSAFE,
	corrupt: SHEET_CORRUPT,
	too_many_columns: SHEET_TOO_MANY_COLUMNS,
	too_complex: SHEET_TOO_COMPLEX,
	no_sheets: SHEET_NO_SHEETS,
	not_transactions: SHEET_NOT_TRANSACTIONS,
	fields_invalid: SHEET_FIELDS_INVALID,
	nothing_mapped: SHEET_NOTHING_MAPPED
};

const refused = (status: number, error: string) =>
	fail(status, { section: SECTION, sheetError: error });

/**
 * 503 with Retry-After, the body never read: this isolate's reader is full or the user has a read in flight.
 * `work` gets the slot's `release` (safe to call twice; the lane releases it again on exit): the AI suggestion
 * lets go before its provider call, which can last 30 s and needs none of the reader's memory (FN-17 L4). The
 * slot stays held while the body uploads on purpose: the buffered bytes are what the lane bounds.
 */
async function inSheetLane<T>(event: RequestEvent, work: (release: () => void) => Promise<T>) {
	const { userId } = await currentSpaceScope(event.locals);
	const release = reserveSheetRead(userId);
	if (!release) {
		event.setHeaders({ 'retry-after': String(RETRY_AFTER_S) });
		return refused(503, SHEET_BUSY);
	}
	try {
		return await work(release);
	} finally {
		release();
	}
}

/** The upload: counted per user before the body is read, read within its cap and timeouts, in memory only. */
async function sheetUpload(event: RequestEvent, opts: { requireWallet: boolean }) {
	const scope = await currentSpaceScope(event.locals);
	if (
		await overUserAttemptLimit(
			event.locals.db,
			scope.userId,
			Date.now(),
			'spreadsheet-upload',
			STATEMENT_UPLOADS_PER_WINDOW
		)
	)
		return { ok: false as const, failure: refused(429, SHEET_RATE_LIMITED) };
	const form = await readFormBody(
		event.request,
		SHEET_BODY_MAX_BYTES,
		SHEET_BODY_TIMEOUT_MS,
		SHEET_BODY_IDLE_MS
	);
	const file = await readUploadedSheet(form);
	if (!file.ok) return { ok: false as const, failure: refused(400, file.error) };
	const fields = parseSheetFields(form, opts);
	if (!fields.ok) return { ok: false as const, failure: refused(400, fields.error) };
	return { ok: true as const, scope, fields: fields.value, file };
}

/** D1 work; a failure is logged as a fixed line plus `errorLabel` (never cells) and answered 503, content-free. */
async function guarded<T>(what: string, work: () => Promise<T>) {
	try {
		return { ok: true as const, value: await work() };
	} catch (e) {
		console.error(`impor spreadsheet: ${what} failed`, errorLabel(e));
		return { ok: false as const, failure: refused(503, IMPORT_FAILED) };
	}
}

/** Whether the AI button can work for this user: the gateway configured and their own key opening. */
async function aiState(event: RequestEvent, userId: string, layout: SheetLayout) {
	const env = getEnv();
	const configured = isAiGatewayConfigured(env);
	// The key is opened only to learn whether it opens; it never leaves the server.
	const hasKey =
		configured && layout.unmapped.length > 0
			? (await resolveAnthropicKey(event.locals.db, userId, env)) !== null
			: false;
	return { configured, hasKey };
}

/** `?/previewSheet`: the file's layout (and, with a posted mapping, the review). Writes nothing. */
export const previewSheetAction = (event: RequestEvent) =>
	inSheetLane(event, async () => {
		const read = await sheetUpload(event, { requireWallet: false });
		if (!read.ok) return read.failure;
		const { scope, fields, file } = read;
		const run = await guarded('preview', () =>
			previewSheet(event.locals.db, scope.spaceId, { bytes: file.bytes, mapping: fields.mapping })
		);
		if (!run.ok) return run.failure;
		const result = run.value;
		if (!result.ok) return refused(400, REFUSALS[result.error]);
		return {
			section: SECTION,
			sheet: {
				step: result.review ? ('reviewed' as const) : ('read' as const),
				filename: file.filename,
				walletId: fields.walletId,
				skipPossibleDuplicates: fields.skipPossibleDuplicates,
				layout: result.layout,
				review: result.review,
				ai: await aiState(event, scope.userId, result.layout),
				aiError: null as string | null,
				aiTab: null as number | null
			}
		};
	});

/**
 * The upload read and the tab's analysis for `?/suggestMapping`. Returns only the small parsed result (layout,
 * header, samples): the file's bytes die with this function's scope, before the provider call (FN-17 L4).
 */
async function prepareSuggestion(event: RequestEvent) {
	const read = await sheetUpload(event, { requireWallet: false });
	if (!read.ok) return { ok: false as const, failure: read.failure };
	const { scope, fields, file } = read;
	const tab = fields.aiTab;
	if (tab === null) return { ok: false as const, failure: refused(400, SHEET_AI_TAB_INVALID) };
	const input = await suggestionInput(file.bytes, tab, fields.mapping);
	if (!input.ok) return { ok: false as const, failure: refused(400, REFUSALS[input.error]) };
	if (!input.layout.unmapped.includes(tab))
		return { ok: false as const, failure: refused(400, SHEET_AI_TAB_INVALID) };
	return {
		ok: true as const,
		scope,
		tab,
		input,
		filename: file.filename,
		walletId: fields.walletId,
		skipPossibleDuplicates: fields.skipPossibleDuplicates
	};
}

/**
 * `?/suggestMapping`: one tab's header and at most 5 sample rows sent with the user's own key; a usable answer
 * only pre-fills that tab's picker (no review until "Pakai pemetaan ini"). Any AI problem keeps the layout and
 * the manual picker, with the reason.
 */
export const suggestMappingAction = (event: RequestEvent) =>
	inSheetLane(event, async (release) => {
		const prepared = await prepareSuggestion(event);
		if (!prepared.ok) return prepared.failure;
		// The workbook is parsed and its bytes are out of scope (prepareSuggestion returned); what is left is the key
		// lookup and the provider call. Give the reader's slot to the next user now (FN-17 L4). The AI budget below
		// still bounds repeated presses.
		release();
		const { scope, tab, input, filename, walletId, skipPossibleDuplicates } = prepared;
		const answer = (
			layout: SheetLayout,
			aiError: string | null,
			ai = { configured: true, hasKey: true }
		) => ({
			section: SECTION,
			sheet: {
				step: 'read' as const,
				filename,
				walletId,
				skipPossibleDuplicates,
				layout,
				review: null,
				ai,
				aiError,
				aiTab: tab
			}
		});
		const env = getEnv();
		if (!isAiGatewayConfigured(env))
			return answer(input.layout, SHEET_AI_NOT_CONFIGURED, { configured: false, hasKey: false });
		const apiKey = await resolveAnthropicKey(event.locals.db, scope.userId, env);
		if (!apiKey) return answer(input.layout, SHEET_AI_NO_KEY, { configured: true, hasKey: false });
		// Each press spends the user's own money: its own small budget (owner decision 5).
		if (
			await overUserAttemptLimit(
				event.locals.db,
				scope.userId,
				Date.now(),
				'spreadsheet-ai',
				SHEET_AI_PER_WINDOW
			)
		)
			return answer(input.layout, SHEET_AI_RATE_LIMITED);
		const outcome = await suggestTabMapping(
			env,
			apiKey,
			{ tabName: input.tabName, header: input.header, samples: input.samples },
			input.columns
		);
		if (outcome.kind !== 'ok') return answer(input.layout, SHEET_AI_UNUSABLE);
		const headerRow = input.rowNumbers[outcome.suggestion.headerRow];
		if (headerRow === undefined) return answer(input.layout, SHEET_AI_UNUSABLE);
		return answer(
			withSuggestion(input.analysis, input.layout, tab, { ...outcome.suggestion, headerRow }),
			null
		);
	});

/** `?/importSheet`: the file re-read with the confirmed mapping and imported into the chosen wallet. */
export const importSheetAction = (event: RequestEvent) =>
	inSheetLane(event, async () => {
		const read = await sheetUpload(event, { requireWallet: true });
		if (!read.ok) return read.failure;
		const { scope, fields, file } = read;
		if (!fields.mapping || !fields.walletId) return refused(400, SHEET_NOTHING_MAPPED);
		// One creating action per import, however many rows it holds (create-limit.ts), as CSV and statements.
		if (await overTransactionCreateLimit(event.locals.db, scope.userId, Date.now()))
			return refused(429, TRANSACTION_RATE_LIMITED);
		const { mapping, walletId } = fields;
		const run = await guarded('import', () =>
			importSheet(
				event.locals.db,
				scope,
				{
					bytes: file.bytes,
					filename: file.filename || null,
					mapping,
					walletId,
					skipPossibleDuplicates: fields.skipPossibleDuplicates
				},
				Date.now()
			)
		);
		if (!run.ok) return run.failure;
		const result = run.value;
		if (!result.ok) {
			switch (result.error) {
				case 'wallet_not_found':
					return refused(404, WALLET_NOT_FOUND);
				case 'gone':
					return refused(409, IMPORT_GONE);
				case 'busy':
					return refused(409, IMPORT_BUSY);
				case 'limit':
					return refused(409, TRANSACTION_LIMIT);
				default:
					return refused(400, REFUSALS[result.error]);
			}
		}
		return {
			section: SECTION,
			sheet: {
				step: 'imported' as const,
				filename: file.filename,
				counts: result.counts,
				skips: result.skips,
				batchId: result.batchId
			}
		};
	});
