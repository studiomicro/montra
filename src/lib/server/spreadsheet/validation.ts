import { z } from 'zod';
import {
	COLUMN_ROLES,
	TAB_KINDS,
	type SheetMapping,
	type TabMapping
} from '#lib/shared/spreadsheet/types';
import { isMonthString } from '#lib/shared/dates';
import { cleanText, maskAccountNumbers } from '#lib/shared/text';
import { FILENAME_MAX_LENGTH } from '../imports/validation';
import {
	SHEET_CSV_HERE,
	SHEET_FIELDS_INVALID,
	SHEET_FILE_EMPTY,
	SHEET_FILE_REQUIRED,
	SHEET_LEGACY,
	SHEET_MACRO,
	SHEET_TOO_LARGE,
	SHEET_WALLET_REQUIRED
} from './messages';
import { SHEET_MAX_COLUMNS, SHEET_MAX_TABS, XLSX_MAX_BYTES } from './xlsx-read';
import { ID_MAX_LENGTH } from '../forms';

/** Largest body the spreadsheet actions read: the 5 MB file plus multipart framing and the mapping fields. */
export const SHEET_BODY_MAX_BYTES = XLSX_MAX_BYTES + 128 * 1024;
/** A 5 MB upload on a slow phone link: 60 s in all, no 15 s gap without bytes (as statements). */
export const SHEET_BODY_TIMEOUT_MS = 60_000;
export const SHEET_BODY_IDLE_MS = 15_000;
/** "Sarankan pemetaan dengan AI" presses per user per throttle window (owner decision 5: 10 per 10 minutes). */
export const SHEET_AI_PER_WINDOW = 10;
/** Spreadsheet reads one isolate holds at once; one per user (as the statement lane). */
export const SHEET_READ_LANE_MAX = 3;

const lane = new Set<string>();

/**
 * A place in this isolate's spreadsheet reader, taken before the body is read: null when the user already
 * has a read in flight or the isolate is full (the route answers 503 with Retry-After). Release on every exit.
 */
export function reserveSheetRead(userId: string): (() => void) | null {
	if (lane.has(userId) || lane.size >= SHEET_READ_LANE_MAX) return null;
	lane.add(userId);
	let released = false;
	return () => {
		if (!released) lane.delete(userId);
		released = true;
	};
}

/** Extensions refused with their own message before any byte is read. */
const LEGACY = /\.(?:xls|xlsb|ods|numbers)$/i;
const MACRO = /\.(?:xlsm|xltm|xlam)$/i;
const CSV = /\.(?:csv|tsv|txt)$/i;

/** The uploaded workbook's bytes, in memory only (never stored or logged); refused past 5 MB before any read. */
export async function readUploadedSheet(
	form: FormData
): Promise<{ ok: true; bytes: Uint8Array; filename: string } | { ok: false; error: string }> {
	const file = form.get('file');
	if (!(file instanceof File) || file.size === 0)
		return { ok: false, error: file instanceof File ? SHEET_FILE_EMPTY : SHEET_FILE_REQUIRED };
	if (CSV.test(file.name)) return { ok: false, error: SHEET_CSV_HERE };
	if (MACRO.test(file.name)) return { ok: false, error: SHEET_MACRO };
	if (LEGACY.test(file.name)) return { ok: false, error: SHEET_LEGACY };
	if (file.size > XLSX_MAX_BYTES) return { ok: false, error: SHEET_TOO_LARGE };
	return {
		ok: true,
		bytes: new Uint8Array(await file.arrayBuffer()),
		filename: maskAccountNumbers(cleanText(file.name, FILENAME_MAX_LENGTH))
	};
}

export interface SheetFields {
	walletId: string | null;
	skipPossibleDuplicates: boolean;
	/** Null: no mapping was posted (read the file with the heuristic proposal). */
	mapping: SheetMapping | null;
	/** "Sarankan pemetaan dengan AI": the tab to suggest for. */
	aiTab: number | null;
}

const tabSchema = z
	.object({
		tab: z.number().int().min(0).max(999),
		use: z.boolean(),
		headerRow: z.number().int().min(0).max(1_048_576),
		columns: z.array(z.enum(COLUMN_ROLES)).max(SHEET_MAX_COLUMNS),
		kind: z.enum(TAB_KINDS),
		month: z.string().refine(isMonthString).nullable()
	})
	.strict();

const FIELD = /^tab\.(\d{1,3})\.(use|header|kind|month|col\.(\d{1,2}))$/;
const NUMBER = /^\d{1,7}$/;

/**
 * The mapping form fields (`tab.<i>.use|header|kind|month|col.<c>`), checked with zod: bounded tab and column
 * counts, enums only. Plain fields so the form works without JavaScript. Null when the form carries none.
 */
export function parseMappingFields(form: FormData): SheetMapping | null | 'invalid' {
	const tabs = new Map<number, Record<string, unknown> & { columns: unknown[] }>();
	let fields = 0;
	for (const [name, value] of form) {
		const m = FIELD.exec(name);
		if (!m) continue;
		if (typeof value !== 'string' || ++fields > SHEET_MAX_TABS * (SHEET_MAX_COLUMNS + 4))
			return 'invalid';
		const index = Number(m[1]);
		if (!tabs.has(index)) {
			if (tabs.size >= SHEET_MAX_TABS) return 'invalid';
			tabs.set(index, {
				tab: index,
				use: false,
				headerRow: 0,
				kind: 'auto',
				month: null,
				columns: []
			});
		}
		const tab = tabs.get(index)!;
		if (m[2] === 'use') tab.use = value === 'on';
		else if (m[2] === 'header') {
			if (!NUMBER.test(value)) return 'invalid';
			tab.headerRow = Number(value);
		} else if (m[2] === 'kind') tab.kind = value;
		else if (m[2] === 'month') tab.month = value === '' ? null : value;
		else {
			const col = Number(m[3]);
			if (col >= SHEET_MAX_COLUMNS) return 'invalid';
			tab.columns[col] = value;
		}
	}
	if (tabs.size === 0) return null;
	const parsed: TabMapping[] = [];
	for (const raw of [...tabs.values()].sort((a, b) => (a.tab as number) - (b.tab as number))) {
		// A gap in the column list (a missing field) reads as "Abaikan".
		raw.columns = Array.from(raw.columns, (c) => c ?? 'ignore');
		const result = tabSchema.safeParse(raw);
		if (!result.success) return 'invalid';
		parsed.push(result.data);
	}
	return { tabs: parsed, fillDown: form.get('fillDown') === 'on' };
}

const field = (form: FormData, name: string) => {
	const v = form.get(name);
	return typeof v === 'string' ? v : '';
};

/** The spreadsheet form's short fields; a malformed value is refused (400), never a 500. */
export function parseSheetFields(
	form: FormData,
	opts: { requireWallet: boolean }
): { ok: true; value: SheetFields } | { ok: false; error: string } {
	const walletId = field(form, 'walletId');
	if (walletId.length > ID_MAX_LENGTH) return { ok: false, error: SHEET_FIELDS_INVALID };
	if (opts.requireWallet && walletId === '') return { ok: false, error: SHEET_WALLET_REQUIRED };
	const mapping = parseMappingFields(form);
	if (mapping === 'invalid') return { ok: false, error: SHEET_FIELDS_INVALID };
	const ai = field(form, 'aiTab');
	if (ai !== '' && !/^\d{1,3}$/.test(ai)) return { ok: false, error: SHEET_FIELDS_INVALID };
	return {
		ok: true,
		value: {
			walletId: walletId === '' ? null : walletId,
			skipPossibleDuplicates: field(form, 'skipPossibleDuplicates') === 'on',
			// "Baca berkas" reads afresh: the posted mapping is used only with "Pakai pemetaan ini" or "Impor".
			mapping: field(form, 'step') === 'read' ? null : mapping,
			aiTab: ai === '' ? null : Number(ai)
		}
	};
}
