import type { Db } from '../db';
import { newAgentFileKey, reservePhotoKey } from '../photos/store';

/**
 * The two files of a report in the private `FILES` bucket (FN-23), with the photos' outbox discipline
 * (photos/store.ts): each key is reserved in `file_deletions` before its object is written, so a crash between
 * the put and `markReady` (which removes the reservations in the batch that stores the keys) still gets the
 * objects deleted. Keys hold ids and a fixed extension only, never request text.
 */

export const CONTENT_TYPES = {
	csv: 'text/csv; charset=utf-8',
	html: 'text/html; charset=utf-8'
} as const;

/** Content Security Policy of a served report file: nothing in it may run, load or be framed. */
export const AGENT_FILE_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";

export interface WrittenFiles {
	csvKey: string;
	htmlKey: string;
	csvBytes: number;
	htmlBytes: number;
}

export async function writeReportFiles(
	db: Db,
	bucket: R2Bucket,
	run: { id: string; spaceId: string },
	content: { csv: string; html: string },
	now: number
): Promise<WrittenFiles> {
	const csvKey = newAgentFileKey(run.spaceId, run.id, 'csv');
	const htmlKey = newAgentFileKey(run.spaceId, run.id, 'html');
	await reservePhotoKey(db, csvKey, now);
	await reservePhotoKey(db, htmlKey, now);
	const csv = new TextEncoder().encode(content.csv);
	const html = new TextEncoder().encode(content.html);
	await bucket.put(csvKey, csv, { httpMetadata: { contentType: CONTENT_TYPES.csv } });
	await bucket.put(htmlKey, html, { httpMetadata: { contentType: CONTENT_TYPES.html } });
	return { csvKey, htmlKey, csvBytes: csv.byteLength, htmlBytes: html.byteLength };
}
