import { z } from 'zod';
import { CSV_FORMATS, CSV_MAX_BYTES, type CsvFormat } from '#lib/shared/csv';
import { addDays, daysBetween, isDateString } from '#lib/shared/dates';
import { cleanText, maskAccountNumbers } from '#lib/shared/text';
import { MAX_FILTER_DAYS } from '../transactions/aggregate';
import {
	FILE_EMPTY,
	FILE_NOT_TEXT,
	FILE_REQUIRED,
	FILE_TOO_LARGE,
	FORMAT_INVALID
} from './messages';
import { ID_MAX_LENGTH } from '../forms';

/**
 * Largest body an upload action reads: the 5 MB file plus the multipart framing and the few short fields
 * (owner decision B). Anything larger is refused 400 before parsing (readFormBody).
 */
export const UPLOAD_BODY_MAX_BYTES = CSV_MAX_BYTES + 64 * 1024;
/** Longest file name kept on the batch row (the name only; the file itself is never stored). */
export const FILENAME_MAX_LENGTH = 100;

const uploadSchema = z.object({
	format: z.union([z.literal(''), z.enum(CSV_FORMATS)], { error: FORMAT_INVALID }),
	defaultWalletId: z.string().max(ID_MAX_LENGTH),
	skipPossibleDuplicates: z.boolean()
});

export interface UploadFields {
	/** The user's override; null: use the format detected from the header. */
	format: CsvFormat | null;
	/** Wallet for rows that name none; null when not chosen. */
	defaultWalletId: string | null;
	/** Leave out rows that look like a transaction already in the space ("Mungkin duplikat"). */
	skipPossibleDuplicates: boolean;
}

/** The upload form's short fields; an over-long or unknown value is refused, never reinterpreted. */
export function parseUploadFields(
	form: FormData
): { ok: true; value: UploadFields } | { ok: false; error: string } {
	const field = (name: string) => {
		const v = form.get(name);
		return typeof v === 'string' ? v : '';
	};
	const parsed = uploadSchema.safeParse({
		format: field('format'),
		defaultWalletId: field('defaultWalletId'),
		skipPossibleDuplicates: field('skipPossibleDuplicates') === 'on'
	});
	if (!parsed.success) return { ok: false, error: FORMAT_INVALID };
	const { format, defaultWalletId, skipPossibleDuplicates } = parsed.data;
	return {
		ok: true,
		value: {
			format: format === '' ? null : format,
			defaultWalletId: defaultWalletId === '' ? null : defaultWalletId,
			skipPossibleDuplicates
		}
	};
}

/**
 * The uploaded file as text, read in memory only (never stored or logged): at most CSV_MAX_BYTES, strict UTF-8
 * (a file in another encoding is refused with a clear message, not read as mojibake).
 */
export async function readUploadedCsv(
	form: FormData
): Promise<{ ok: true; text: string; filename: string } | { ok: false; error: string }> {
	const file = form.get('file');
	if (!(file instanceof File) || file.size === 0) {
		return { ok: false, error: file instanceof File ? FILE_EMPTY : FILE_REQUIRED };
	}
	if (file.size > CSV_MAX_BYTES) return { ok: false, error: FILE_TOO_LARGE };
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
	} catch {
		return { ok: false, error: FILE_NOT_TEXT };
	}
	return {
		ok: true,
		text,
		filename: maskAccountNumbers(cleanText(file.name, FILENAME_MAX_LENGTH))
	};
}

const exportSchema = z.object({
	from: z.string().refine(isDateString),
	to: z.string().refine(isDateString)
});

/**
 * The export's `from`/`to` (WIB dates, both required, `from` ≤ `to`). A range longer than MAX_FILTER_DAYS is cut
 * to that many days from `from` (`truncated`), so one export never scans more than a year (owner decision B).
 */
export function parseExportRange(
	params: URLSearchParams
): { ok: true; from: string; to: string; truncated: boolean } | { ok: false } {
	const parsed = exportSchema.safeParse({
		from: (params.get('from') ?? '').slice(0, 16),
		to: (params.get('to') ?? '').slice(0, 16)
	});
	if (!parsed.success) return { ok: false };
	const { from, to } = parsed.data;
	const span = daysBetween(from, to);
	if (span < 0) return { ok: false };
	if (span >= MAX_FILTER_DAYS) {
		return { ok: true, from, to: addDays(from, MAX_FILTER_DAYS - 1), truncated: true };
	}
	return { ok: true, from, to, truncated: false };
}
