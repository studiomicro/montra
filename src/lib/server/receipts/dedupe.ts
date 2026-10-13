import { sql, type SQL } from 'drizzle-orm';
import { bytesToHex } from '../util';

/**
 * Dedupe keys of a receipt's rows (FN-15): `receipt:<sha256 of the photo bytes>:<row index>`, the same
 * `source:<hash>:<index>` shape as FN-18 (`csv:`) and FN-16a (`statement:`). The hash is of the checked photo as
 * the server read it; the browser re-encodes once and "Baca lagi" resends the same bytes, so a re-read photo
 * always gives the same keys. Tombstones keep their key, so a deleted row is never recreated from the photo.
 */

/** `receipt:<first 128 bits of the SHA-256 of the bytes, hex>:` */
export async function receiptKeyPrefix(photoBytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', photoBytes as BufferSource);
	return `receipt:${bytesToHex(digest).slice(0, 32)}:`;
}

export async function receiptDedupeKey(photoBytes: Uint8Array, rowIndex: number): Promise<string> {
	return `${await receiptKeyPrefix(photoBytes)}${rowIndex}`;
}

/**
 * SQL: a row of this photo (live or deleted) already exists in the space. Keys are `<prefix><digits>`; ':' sorts
 * right after '9', so the range holds exactly this photo's keys (one indexed range scan on the dedupe index).
 */
export function photoAlreadySaved(spaceId: string, prefix: string): SQL {
	const upper = prefix.slice(0, -1) + ';';
	return sql`exists (select 1 from transactions t where t.space_id = ${spaceId} and t.source = 'receipt'
		and t.dedupe_key > ${prefix} and t.dedupe_key < ${upper})`;
}
