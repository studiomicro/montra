import { wibDateString } from '../dates.ts';
import type { GmailScanKind } from './ledger.ts';

/**
 * FN-19b "Transaksi dari Gmail" (PRD § C): what one Gmail capture became, and the grouping of the screen (per WIB
 * day of the mail, then per scan). Pure and shared so the page and the tests use one rule.
 */

export const GMAIL_REVIEW_STATES = ['draft', 'saved', 'cancelled', 'duplicate'] as const;
export type GmailReviewState = (typeof GMAIL_REVIEW_STATES)[number];

export interface GmailReviewRow {
	/** The ledger row id (the list key). */
	id: string;
	gmailId: string;
	receivedAt: number;
	state: GmailReviewState;
	/** Null once the capture was cancelled (a tombstone keeps no content). */
	title: string | null;
	amountMinor: number | null;
	currency: string | null;
	direction: 'expense' | 'income' | null;
	senderDomain: string | null;
	/** Already masked when stored (FN-19). */
	subject: string | null;
	scan: {
		id: string;
		kind: GmailScanKind;
		days: number | null;
		createdAt: number;
		undoneAt: number | null;
		/** The scan may still be undone (not undone yet). */
		undoable: boolean;
	} | null;
}

export interface GmailReviewScanGroup {
	/** The scan id, or `none` for captures of no scan. */
	key: string;
	scan: GmailReviewRow['scan'];
	rows: GmailReviewRow[];
}

export interface GmailReviewDay {
	/** WIB date `YYYY-MM-DD` of the mails. */
	date: string;
	/** Sum of the day's `Tersimpan` expense rows listed (IDR minor units; every capture is IDR). */
	savedOutMinor: number;
	scans: GmailReviewScanGroup[];
}

/**
 * Rows (newest first, as listed) → WIB days → scans, in first-seen order. The day's total is the integer sum of the
 * listed rows that are saved expenses, so it always equals what the list shows under it.
 */
export function groupReview(rows: readonly GmailReviewRow[]): GmailReviewDay[] {
	const days: GmailReviewDay[] = [];
	for (const row of rows) {
		const date = wibDateString(row.receivedAt);
		let day = days.at(-1);
		if (!day || day.date !== date) {
			day = { date, savedOutMinor: 0, scans: [] };
			days.push(day);
		}
		const key = row.scan?.id ?? 'none';
		let group = day.scans.find((g) => g.key === key);
		if (!group) {
			group = { key, scan: row.scan, rows: [] };
			day.scans.push(group);
		}
		group.rows.push(row);
		if (row.state === 'saved' && row.direction === 'expense' && row.amountMinor !== null)
			day.savedOutMinor += row.amountMinor;
	}
	return days;
}

/**
 * The "Buka di Gmail" link of a capture, from stored ids only: the mailbox address (percent-encoded) and the
 * Gmail message id (hex, as Gmail returns it). Null when either is missing or not of that shape.
 */
export function gmailMessageUrl(address: string | null, gmailId: string): string | null {
	if (!address || !/^[0-9a-f]{1,32}$/i.test(gmailId)) return null;
	return `https://mail.google.com/mail/u/${encodeURIComponent(address)}/#all/${gmailId}`;
}
