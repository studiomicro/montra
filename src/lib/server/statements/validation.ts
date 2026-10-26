import { z } from 'zod';
import { STATEMENT_PARSERS } from '#lib/shared/statements/parsers';
import type { StatementParser } from '#lib/shared/statements/types';
import { cleanText, maskAccountNumbers } from '#lib/shared/text';
import {
	STATEMENT_FIELDS_INVALID,
	STATEMENT_FILE_EMPTY,
	STATEMENT_FILE_REQUIRED,
	STATEMENT_SECTION_INVALID,
	STATEMENT_TOO_LARGE
} from '../imports/messages';
import { FILENAME_MAX_LENGTH } from '../imports/validation';
import { PDF_PASSWORD_MAX_LENGTH } from './pdf-text';
import { STATEMENT_MAX_BYTES } from './read';
import { ID_MAX_LENGTH } from '../forms';

/** Largest body the statement actions read: the 15 MB file plus multipart framing and the short fields. */
export const STATEMENT_BODY_MAX_BYTES = STATEMENT_MAX_BYTES + 64 * 1024;
/** A 15 MB upload on a slow phone link: the whole body may take a minute, with no 15 s gap without bytes. */
export const STATEMENT_BODY_TIMEOUT_MS = 60_000;
export const STATEMENT_BODY_IDLE_MS = 15_000;
/** Statement uploads (previews and imports together) one user may send per throttle window (10 minutes). */
export const STATEMENT_UPLOADS_PER_WINDOW = 30;

const fieldsSchema = z.object({
	institution: z.string().max(32),
	defaultWalletId: z.string().max(ID_MAX_LENGTH),
	password: z.string().max(PDF_PASSWORD_MAX_LENGTH),
	skipPossibleDuplicates: z.boolean()
});

/** An account's position in a multi-account statement (FN-16e); '' when none was picked. */
const SECTION_FIELD = /^(?:\d{1,2})?$/;

export interface StatementFields {
	/** Picked institution id; null: detect. */
	institution: string | null;
	defaultWalletId: string | null;
	/** PDF password for this request only (never stored, logged or echoed back). */
	password: string | null;
	skipPossibleDuplicates: boolean;
	/** Account picked in a multi-account statement; null: none picked. */
	section: number | null;
}

/** The statement form's short fields; an unknown institution or an over-long value is refused. */
export function parseStatementFields(
	form: FormData,
	parsers: readonly StatementParser[] = STATEMENT_PARSERS
): { ok: true; value: StatementFields } | { ok: false; error: string } {
	const field = (name: string) => {
		const v = form.get(name);
		return typeof v === 'string' ? v : '';
	};
	const parsed = fieldsSchema.safeParse({
		institution: field('institution'),
		defaultWalletId: field('defaultWalletId'),
		password: field('pdfPassword'),
		skipPossibleDuplicates: field('skipPossibleDuplicates') === 'on'
	});
	if (!parsed.success) return { ok: false, error: STATEMENT_FIELDS_INVALID };
	const section = field('statementSection');
	if (!SECTION_FIELD.test(section)) return { ok: false, error: STATEMENT_SECTION_INVALID };
	const { institution, defaultWalletId, password, skipPossibleDuplicates } = parsed.data;
	if (institution !== '' && !parsers.some((p) => p.id === institution))
		return { ok: false, error: STATEMENT_FIELDS_INVALID };
	return {
		ok: true,
		value: {
			institution: institution === '' ? null : institution,
			defaultWalletId: defaultWalletId === '' ? null : defaultWalletId,
			password: password === '' ? null : password,
			skipPossibleDuplicates,
			section: section === '' ? null : Number(section)
		}
	};
}

/** The uploaded statement's bytes, in memory only (never stored or logged), refused past 15 MB before any read. */
export async function readUploadedStatement(
	form: FormData
): Promise<{ ok: true; bytes: Uint8Array; filename: string } | { ok: false; error: string }> {
	const file = form.get('file');
	if (!(file instanceof File) || file.size === 0) {
		return {
			ok: false,
			error: file instanceof File ? STATEMENT_FILE_EMPTY : STATEMENT_FILE_REQUIRED
		};
	}
	if (file.size > STATEMENT_MAX_BYTES) return { ok: false, error: STATEMENT_TOO_LARGE };
	return {
		ok: true,
		bytes: new Uint8Array(await file.arrayBuffer()),
		filename: maskAccountNumbers(cleanText(file.name, FILENAME_MAX_LENGTH))
	};
}
