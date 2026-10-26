import { and, eq, sql } from 'drizzle-orm';
import {
	INBOUND_TRUST_LABELS,
	type InboundParser,
	type InboundTrust
} from '#lib/shared/inbound/address';
import { maskAccountNumbers } from '#lib/shared/text';
import { NOTE_MAX_LENGTH } from '#lib/shared/transactions';
import type { Db } from '../db';
import { drafts, gmailMail, inboundMail } from '../db/schema';
import { draftsUnderCap } from '../drafts/repo';
import { resolveMerchants } from '../merchants/resolve';
import { isLiveMember } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { newId, sha256Hex } from '../util';
import { upsertMail, type MailRecord, type Recipient } from './repo';

/**
 * The one insert path of an e-mail capture (FN-19 PRD § 9), shared by the inbound Worker (deterministic parsers)
 * and the jobs Worker (AI reads). A capture is always a DRAFT for review in Kotak masuk (owner decision 1:
 * nothing from mail is auto-saved), source `gmail` (owner decision 2, shown as "E-mail"), no wallet (the user
 * sets it there), never `is_demo`. FN-20: the title is the cleaned merchant name and the category the one the
 * space's rules, history or the shared dictionary name (deterministic only: no AI call without a user session);
 * none is invented for an unknown merchant. The draft, its seq bump and the ledger row are one `db.batch`.
 *
 * Idempotent: the draft is inserted only while no draft of the space (tombstones included) carries its dedupe
 * key, so a redelivered or resent mail, or one already discarded or saved, never creates a second row; the
 * draft cap (MAX_DRAFTS_PER_SPACE) and the owner's live membership are repeated in the same statement.
 */

/** Hours either side of a capture in which a live transaction with the same amount marks it `duplicate`. */
const DUPLICATE_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Hex of the first 128 bits of SHA-256(`value`). */
const hex128 = async (value: string) => (await sha256Hex(value)).slice(0, 32);

/**
 * The ledger key of a mail: its Message-ID (case-folded), or, without one, its Date, From, Subject and cleaned
 * text, so an exact replay still dedupes but two different mails sharing sender and subject never collide (red
 * team L6). Only the hash is stored.
 */
export function messageKeyOf(mail: {
	messageId: string | null;
	date: string | null;
	fromAddress: string;
	subject: string;
	text: string;
}): Promise<string> {
	const id = mail.messageId?.trim().toLowerCase();
	return hex128(
		id
			? `id:${id}`
			: `h:${JSON.stringify([mail.date ?? '', mail.fromAddress.toLowerCase(), mail.subject, mail.text])}`
	);
}

/**
 * The draft's dedupe key: by the payment's own FULL reference when it has one (the same payment mailed twice,
 * with two Message-IDs, is one capture; keyed by the parser, not the sender domain, so an auto-forward and a
 * manual forward of one payment agree), else by the mail. `referenceKey` is the unmasked reference, only hashed
 * here and never stored: a masked one (last 4 digits) would merge different payments (red team M1).
 */
export async function mailDedupeKey(input: {
	parser: InboundParser;
	referenceKey: string | null;
	amountMinor: number;
	messageKey: string;
}): Promise<string> {
	if (input.referenceKey && input.parser !== 'ai')
		return `mail:r:${await hex128(JSON.stringify([input.parser, input.referenceKey, input.amountMinor]))}`;
	return `mail:m:${input.messageKey}`;
}

export interface Capture {
	recipient: Pick<Recipient, 'spaceId' | 'userId'>;
	direction: 'expense' | 'income';
	amountMinor: number;
	merchant: string;
	occurredOn: string;
	occurredAt: number;
	reference: string | null;
	trust: InboundTrust;
	parser: InboundParser;
	dedupeKey: string;
}

/**
 * The note a capture carries: who sent it (trust), the masked reference and, when FN-20 cleaned the merchant
 * name into the title, the merchant text as the mail gave it (masked). Plain text, never HTML.
 */
function captureNote(
	c: Pick<Capture, 'trust' | 'parser' | 'reference'>,
	originalMerchant: string | null = null
): string {
	const parts = [INBOUND_TRUST_LABELS[c.trust]];
	if (c.parser === 'ai') parts.unshift('Dibaca AI');
	if (c.reference) parts.push(`Ref ${c.reference}`);
	if (originalMerchant) parts.push(maskAccountNumbers(originalMerchant));
	return parts.join(' · ').slice(0, NOTE_MAX_LENGTH);
}

/** What FN-20 made of a capture's merchant: the draft title and, when known, a category of the space. */
export interface CaptureMerchant {
	title: string;
	categoryId: string | null;
}

/**
 * The cleaned merchant name and the deterministic category (rule, history, dictionary) for a capture. Never
 * throws: a failed lookup leaves the merchant text as it came and no category, as before FN-20.
 */
export async function captureMerchant(db: Db, c: Capture): Promise<CaptureMerchant> {
	try {
		const { items } = await resolveMerchants(
			db,
			c.recipient,
			[{ rawText: c.merchant, type: c.direction }],
			{ userId: c.recipient.userId, allowAi: false }
		);
		const r = items[0];
		return { title: r?.merchant || c.merchant, categoryId: r?.categoryId ?? null };
	} catch (e) {
		console.error('inbound: merchant lookup failed', e instanceof Error ? e.message : 'unknown');
		return { title: c.merchant, categoryId: null };
	}
}

/**
 * Only a `verified` mail read by a deterministic parser goes in without the review flag; a duplicate amount
 * within 12 h is flagged `duplicate` instead (that flag also asks for a look).
 */
function flagSql(c: Capture) {
	const review = c.trust === 'verified' && c.parser !== 'ai' ? null : 'needs_review';
	return sql`case when exists (select 1 from transactions t where t.space_id = ${c.recipient.spaceId}
			and t.deleted_at is null and t.is_demo = 0 and t.currency = 'IDR' and t.type = ${c.direction}
			and t.amount_minor = ${c.amountMinor}
			and t.occurred_at between ${c.occurredAt - DUPLICATE_WINDOW_MS} and ${c.occurredAt + DUPLICATE_WINDOW_MS})
		then 'duplicate' else ${review} end`;
}

const draftExists = (c: Capture) =>
	sql`exists (select 1 from drafts d where d.space_id = ${c.recipient.spaceId} and d.source = 'gmail'
		and d.dedupe_key = ${c.dedupeKey})`;

/**
 * Where the capture's ledger row goes: a new row of the inbound Worker (`record`, everything but its status),
 * the `queued` row `mailId` the jobs Worker read with AI (its text is nulled in the same statement), or the
 * `listed` Gmail ledger row `mailId` (FN-19 Gmail: `fields` are what a payment row keeps; the draft is inserted
 * only while the Gmail connection is still connected, so a disconnect racing the read creates nothing, and
 * `draft_id` is set only when this read inserted the draft).
 */
export type CaptureLedger =
	| { kind: 'record'; record: MailRecord }
	| { kind: 'queued'; mailId: string; now: number }
	| {
			kind: 'gmail';
			mailId: string;
			connectionId: string;
			receivedAt: number;
			fields: {
				trust: 'verified' | 'unverified';
				senderDomain: string | null;
				subject: string | null;
			};
			now: number;
	  };

/**
 * The batch of one capture: seq bump, guarded draft insert, then the ledger row, whose status says what
 * happened inside the batch: `draft_created` when a draft with this key exists now (inserted here, or already
 * captured before), else `unreadable/inbox_full` (the cap refused it; the owner losing membership in the same
 * instant reads the same, a race of milliseconds).
 */
export function captureBatch(
	db: Db,
	c: Capture,
	ledger: CaptureLedger,
	merchant: CaptureMerchant = { title: c.merchant, categoryId: null }
) {
	const { spaceId, userId } = c.recipient;
	const now = ledger.kind === 'record' ? ledger.record.receivedAt : ledger.now;
	const stillConnected =
		ledger.kind === 'gmail'
			? sql`and exists (select 1 from gmail_connections g where g.id = ${ledger.connectionId}
				and g.status = 'connected')`
			: sql``;
	const row = {
		id: newId(),
		type: c.direction,
		amount: c.amountMinor,
		title: merchant.title,
		note: captureNote(c, merchant.title !== c.merchant ? c.merchant : null),
		on: c.occurredOn,
		at: c.occurredAt,
		key: c.dedupeKey
	};
	// The category only while it is still a visible category of this space of the draft's kind.
	const categorySql = sql`(select k.id from categories k where k.id = ${merchant.categoryId}
		and k.space_id = ${spaceId} and k.kind = ${row.type} and k.deleted_at is null and k.is_hidden = 0)`;
	// Columns in table order: id, space_id, type, amount_minor, currency, title, note, category_id, wallet_id,
	// occurred_on, occurred_at, source, dedupe_key, flag, is_demo, saved_transaction_id, created_at, updated_at,
	// deleted_at, seq, category_source (null: the capture's own guess, FN-48).
	const insertDraft = db
		.insert(drafts)
		.select(
			sql`select ${row.id}, ${spaceId}, ${row.type}, ${row.amount}, 'IDR', ${row.title}, ${row.note},
				${categorySql}, null, ${row.on}, ${row.at}, 'gmail', ${row.key}, ${flagSql(c)}, 0, null, ${now}, ${now},
				null, ${currentSpaceSeq(spaceId)}, null
			where ${isLiveMember(spaceId, userId)} and ${draftsUnderCap(spaceId, 1)} and not ${draftExists(c)}
				${stillConnected}`
		)
		.returning({ id: drafts.id });
	const status = sql`case when ${draftExists(c)} then 'draft_created' else 'unreadable' end`;
	const reason = sql`case when ${draftExists(c)} then null else 'inbox_full' end`;
	// The ledger's link to the draft, only when this delivery inserted it (deletion paths discard through it).
	const linkedDraft = sql`case when exists (select 1 from drafts where id = ${row.id}) then ${row.id} end`;
	if (ledger.kind === 'gmail') {
		const ledgerItem = db
			.update(gmailMail)
			.set({
				status,
				reason,
				...ledger.fields,
				parser: c.parser,
				receivedAt: ledger.receivedAt,
				draftId: linkedDraft,
				updatedAt: now
			})
			// A connection that stopped meanwhile leaves the row `listed` (read again after a reconnect).
			.where(
				and(
					eq(gmailMail.id, ledger.mailId),
					eq(gmailMail.status, 'listed'),
					sql`exists (select 1 from gmail_connections g where g.id = ${ledger.connectionId}
						and g.status = 'connected')`
				)
			)
			.returning({ id: gmailMail.id });
		return [bumpSpaceSeq(db, spaceId), insertDraft, ledgerItem] as const;
	}
	const ledgerItem =
		ledger.kind === 'record'
			? upsertMail(
					db,
					{ ...ledger.record, pendingText: null },
					{ status, reason, draftId: linkedDraft }
				)
			: db
					.update(inboundMail)
					.set({
						status,
						reason,
						parser: 'ai',
						pendingText: null,
						draftId: linkedDraft,
						updatedAt: now
					})
					.where(and(eq(inboundMail.id, ledger.mailId), eq(inboundMail.status, 'queued')))
					.returning({ id: inboundMail.id });
	return [bumpSpaceSeq(db, spaceId), insertDraft, ledgerItem] as const;
}

/** Resolves the merchant (FN-20), then runs `captureBatch`; true when this delivery inserted the draft. */
export async function captureDraft(db: Db, c: Capture, ledger: CaptureLedger): Promise<boolean> {
	const merchant = await captureMerchant(db, c);
	const [, inserted] = await db.batch(captureBatch(db, c, ledger, merchant));
	return inserted.length === 1;
}
