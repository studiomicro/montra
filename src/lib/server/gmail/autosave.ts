import { and, eq, isNull, sql } from 'drizzle-orm';
import { wibDateString } from '#lib/shared/dates';
import {
	GMAIL_AUTOSAVE_MAX_MINOR,
	GMAIL_AUTOSAVE_PER_DAY,
	type GmailScanKind
} from '#lib/shared/gmail/ledger';
import type { InboundParser } from '#lib/shared/inbound/address';
import { confirmedSender, type SenderDomain } from '#lib/shared/inbound/sender-domains';
import type { Db } from '../db';
import { drafts, gmailConnections } from '../db/schema';
import { saveDrafts } from '../drafts/repo';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { bumpedUpdatedAt } from '../sync/updated-at';
import { liveMemberOf } from './repo';

/**
 * FN-19b auto-save (PRD § B): an opt-in, per connection, that writes a trustworthy Gmail capture straight to the
 * chosen wallet instead of leaving it in Kotak masuk. Every rule must hold, or the capture stays a draft exactly as
 * before:
 *  - static facts of the read: an `hourly` scan (never a look-back or "Baca ulang"), a deterministic parser (an AI
 *    reading never auto-saves: a mail can steer an LLM), a sender domain in the CONFIRMED registry (never a
 *    fixture or unknown domain; the shipped registry is empty, so this never fires in production yet), and Gmail's
 *    own authentication of that domain (red team M1: DMARC pass + aligned DKIM on the topmost mx.google.com
 *    header);
 *  - checked inside ONE guarded statement, so a setting changed while the read was queued is obeyed: auto-save on,
 *    connection `connected` and still recording into this space, its owner a live member, the wallet live and IDR;
 *    the draft pending, an IDR expense of at most GMAIL_AUTOSAVE_MAX_MINOR, not flagged `duplicate`, with a
 *    category; and fewer than GMAIL_AUTOSAVE_PER_DAY auto-saves of this connection in the WIB day (the counter is
 *    claimed in that statement, so concurrent reads never pass it).
 * The same batch sets the draft's wallet; then FN-05's one insert path (`saveDrafts`: validator, transaction cap,
 * dedupe key, captured instant, draft tombstone pointing at the transaction) writes it. If that save refuses (cap
 * reached, changed meanwhile), the wallet is taken off again and the capture stays a draft as it came. The claimed
 * counter is not refunded (the cap stays an upper bound).
 */

export interface AutoSaveInput {
	connectionId: string;
	spaceId: string;
	userId: string;
	draftId: string;
	parser: InboundParser;
	senderDomain: string | null;
	scanKind: GmailScanKind | null;
	/**
	 * Red team M1: Gmail's own topmost `Authentication-Results` passed DMARC (header.from = the sender domain) with
	 * an aligned DKIM signature (`gmailSenderAuthenticated`). Without it a forged `From` stays a draft.
	 */
	senderAuthenticated: boolean;
}

/** Why the static rules refuse (no statement runs), or null when the guarded claim may be tried. */
export function staticRefusal(
	input: Pick<AutoSaveInput, 'parser' | 'senderDomain' | 'scanKind' | 'senderAuthenticated'>,
	registry?: readonly SenderDomain[]
): 'scan' | 'ai' | 'domain' | 'auth' | null {
	if (input.scanKind !== 'hourly') return 'scan';
	if (input.parser === 'ai') return 'ai';
	if (!confirmedSender(input.senderDomain, registry)) return 'domain';
	if (input.senderAuthenticated !== true) return 'auth';
	return null;
}

/** The transaction id auto-save wrote for this capture, or null when it stays a draft. */
export async function autoSaveCapture(
	db: Db,
	input: AutoSaveInput,
	now: number,
	registry?: readonly SenderDomain[]
): Promise<string | null> {
	if (staticRefusal(input, registry) !== null) return null;
	const { connectionId, spaceId, userId, draftId } = input;
	const today = wibDateString(now);
	const walletOk = sql`exists (select 1 from wallets w where w.id = ${gmailConnections.autoSaveWalletId}
		and w.space_id = ${spaceId} and w.deleted_at is null and w.currency = 'IDR')`;
	const draftOk = sql`exists (select 1 from drafts d where d.id = ${draftId} and d.space_id = ${spaceId}
		and d.deleted_at is null and d.wallet_id is null and d.source = 'gmail' and d.type = 'expense'
		and d.currency = 'IDR' and d.amount_minor between 1 and ${GMAIL_AUTOSAVE_MAX_MINOR}
		and (d.flag is null or d.flag <> 'duplicate') and d.category_id is not null)`;
	const [, claimed, walleted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(gmailConnections)
			.set({
				autoSaveDay: today,
				autoSaves: sql`case when ${gmailConnections.autoSaveDay} = ${today}
					then ${gmailConnections.autoSaves} + 1 else 1 end`
			})
			.where(
				and(
					eq(gmailConnections.id, connectionId),
					eq(gmailConnections.userId, userId),
					eq(gmailConnections.spaceId, spaceId),
					eq(gmailConnections.status, 'connected'),
					eq(gmailConnections.autoSave, 1),
					sql`(${gmailConnections.autoSaveDay} is not ${today}
						or ${gmailConnections.autoSaves} < ${GMAIL_AUTOSAVE_PER_DAY})`,
					liveMemberOf(sql`${spaceId}`, sql`${userId}`),
					walletOk,
					draftOk
				)
			)
			.returning({ walletId: gmailConnections.autoSaveWalletId }),
		db
			.update(drafts)
			.set({
				walletId: sql`(select g.auto_save_wallet_id from gmail_connections g where g.id = ${connectionId})`,
				updatedAt: bumpedUpdatedAt(drafts.updatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(drafts.id, draftId),
					eq(drafts.spaceId, spaceId),
					isNull(drafts.deletedAt),
					isNull(drafts.walletId),
					sql`changes() = 1`
				)
			)
			.returning({ updatedAt: drafts.updatedAt, walletId: drafts.walletId })
	]);
	const set = walleted[0];
	if (claimed.length !== 1 || !set) return null;
	const saved = await saveDrafts(
		db,
		{ spaceId, userId },
		[{ id: draftId, updatedAt: set.updatedAt }],
		now
	);
	if (saved.ok && saved.saved === 1) {
		const row = await db.get<{ tx: string | null }>(
			sql`select saved_transaction_id as tx from drafts where id = ${draftId} and space_id = ${spaceId}`
		);
		if (row?.tx) return row.tx;
	}
	// Refused (transaction cap, changed meanwhile): the capture stays the draft it came as, without the wallet.
	await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.update(drafts)
			.set({
				walletId: null,
				updatedAt: bumpedUpdatedAt(drafts.updatedAt, now),
				seq: currentSpaceSeq(spaceId)
			})
			.where(
				and(
					eq(drafts.id, draftId),
					eq(drafts.spaceId, spaceId),
					isNull(drafts.deletedAt),
					eq(drafts.updatedAt, set.updatedAt)
				)
			)
	]);
	return null;
}
