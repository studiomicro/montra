import { and, eq, sql } from 'drizzle-orm';
import { GMAIL_UNITS, type GmailMailReason } from '#lib/shared/gmail/ledger';
import { isExcludedByLabel, parseGmailMessage } from '#lib/shared/gmail/message';
import { PENDING_TEXT_MAX, SENDER_DOMAIN_MAX, SUBJECT_MAX } from '#lib/shared/inbound/address';
import { addressDomain, looksLikePayment, maskMailLines } from '#lib/shared/inbound/mail';
import { parsePaymentMail, parserFor } from '#lib/shared/inbound/parsers';
import { RetryLaterError } from '#lib/shared/jobs';
import { cleanText, maskAccountNumbers } from '#lib/shared/text';
import { isAiGatewayConfigured, type AiGatewayEnv } from '../ai-keys/anthropic';
import type { AiKeysEnv } from '../ai-keys/crypto';
import { resolveAnthropicKey } from '../ai-keys/lookup';
import { gmailMail, gmailScans } from '../db/schema';
import { readMailText } from '../inbound/ai-read';
import { INBOUND_READ_MAX_ATTEMPTS, INBOUND_RETRY_DELAY_S } from '../inbound/consume';
import {
	captureBatch,
	captureMerchant,
	mailDedupeKey,
	messageKeyOf,
	type Capture
} from '../inbound/draft';
import type { GmailClientEnv } from './config';
import { claimAiRead, claimQuota, jobConnection, liveMemberOf, pauseSpaceLost } from './repo';
import { onGoogleFailure, quotaWait, type GmailJobDeps } from './scan';
import { accessTokenFor, forgetAccessToken } from './token';

/**
 * The jobs Worker's `gmail_read` (FN-19 Gmail PRD § 7): one listed message, read and decided in this handler, the
 * shared forwarding pipeline after the fetch. Cheap checks first: the row must still be `listed` and its
 * connection `connected` (else acked without calling Google); the owner must still be a member of the row's
 * space; the quota gate; then `messages.get`. Excluded labels, a non-payment subject, a mail without an amount
 * → `not_payment` (id and date only, the AI is never called). A deterministic parser → a draft through the shared
 * `captureBatch`; else the AI read with the ROW OWNER's own key. No mail text is ever written to D1, a queue or a
 * log: it lives in this function's variables only. The ledger update and the scan counter are one `db.batch`.
 */

export type GmailReadEnv = GmailClientEnv & AiKeysEnv & AiGatewayEnv;

export interface GmailReadDeps extends GmailJobDeps {
	env: GmailReadEnv;
	/** The fetch of the AI read (tests pass a fake; nothing reaches Anthropic in tests). */
	aiFetch?: typeof fetch;
}

/** The scan counter update of the ledger write just before it in the same batch (only when that write happened). */
function countRead(deps: GmailReadDeps, scanId: string, mailId: string) {
	return deps.db
		.update(gmailScans)
		.set({
			read: sql`${gmailScans.read} + 1`,
			drafted: sql`${gmailScans.drafted} + (select count(*) from gmail_mail m
				where m.id = ${mailId} and m.draft_id is not null)`
		})
		.where(and(eq(gmailScans.id, scanId), sql`changes() = 1`));
}

export async function processGmailRead(
	deps: GmailReadDeps,
	mailId: string,
	attempts: number
): Promise<'read' | 'skipped'> {
	const { db, env } = deps;
	const [row] = await db
		.select({
			id: gmailMail.id,
			connectionId: gmailMail.connectionId,
			userId: gmailMail.userId,
			spaceId: gmailMail.spaceId,
			gmailId: gmailMail.gmailId,
			scanId: gmailMail.scanId
		})
		.from(gmailMail)
		.where(and(eq(gmailMail.id, mailId), eq(gmailMail.status, 'listed')))
		.limit(1);
	if (!row) return 'skipped';
	const conn = await jobConnection(db, row.connectionId);
	if (!conn || conn.status !== 'connected' || conn.userId !== row.userId) return 'skipped';
	const member = await db.get<{ ok: number }>(
		sql`select ${liveMemberOf(sql`${row.spaceId}`, sql`${row.userId}`)} as ok`
	);
	if (member?.ok !== 1) {
		// Nothing is written to a space the owner left: checks pause and this id (id and date only) is dropped.
		if (row.spaceId === conn.spaceId) await pauseSpaceLost(db, conn.id, deps.now());
		await db.delete(gmailMail).where(and(eq(gmailMail.id, row.id), eq(gmailMail.status, 'listed')));
		return 'skipped';
	}
	const quota = await claimQuota(db, conn.id, GMAIL_UNITS.get, deps.now());
	if (quota === 'gone') return 'skipped';
	if (quota === 'over') throw new RetryLaterError('gmail: over quota', quotaWait(deps.random()));
	let token = await accessTokenFor(deps, conn);
	if (token === null) return 'skipped';
	let fetched = await deps.google.get(token, row.gmailId);
	if (!fetched.ok && fetched.error === 'auth') {
		forgetAccessToken(deps, conn);
		token = await accessTokenFor(deps, conn);
		if (token === null) return 'skipped';
		fetched = await deps.google.get(token, row.gmailId);
	}

	const listed = and(eq(gmailMail.id, row.id), eq(gmailMail.status, 'listed'));
	/** Ends the row (and counts it on its scan) in one batch. */
	const finish = async (set: Partial<typeof gmailMail.$inferInsert>) => {
		const now = deps.now();
		const update = db
			.update(gmailMail)
			.set({ ...set, updatedAt: now })
			.where(listed);
		if (row.scanId) await db.batch([update, countRead(deps, row.scanId, row.id)]);
		else await update;
		return 'read' as const;
	};
	const unreadable = (
		reason: GmailMailReason,
		extra: Partial<typeof gmailMail.$inferInsert> = {}
	) => finish({ status: 'unreadable', reason, ...extra });

	if (!fetched.ok) {
		await onGoogleFailure(deps, conn, fetched.error, attempts);
		const reason: GmailMailReason =
			fetched.error === 'gone'
				? 'gone'
				: fetched.error === 'too_large'
					? 'too_large'
					: fetched.error === 'malformed'
						? 'malformed'
						: 'fetch_failed';
		return unreadable(reason);
	}
	const parsed = parseGmailMessage(fetched.json);
	if (parsed.kind !== 'ok' || parsed.mail.gmailId !== row.gmailId) return unreadable('malformed');
	const mail = parsed.mail;
	const receivedAt = mail.internalDate ?? deps.now();
	const notPayment = () => finish({ status: 'not_payment', receivedAt });

	if (isExcludedByLabel(mail.labelIds)) return notPayment();
	const senderDomain = addressDomain(mail.fromAddress);
	const parser = parserFor(senderDomain);
	if (!looksLikePayment({ allowlisted: parser !== null, subject: mail.subject, text: mail.text }))
		return notPayment();

	// Owner decision 2026-10-13 (red team L5): a Gmail capture is never `verified`. No header can tell mail Gmail
	// received from mail put in the mailbox by IMAP APPEND or the insert/import API, so every capture stays tagged
	// for review (and deletable), whatever its Authentication-Results say.
	const trust = 'unverified' as const;
	const fields = {
		trust,
		senderDomain: senderDomain ? senderDomain.slice(0, SENDER_DOMAIN_MAX) : null,
		subject: maskAccountNumbers(cleanText(mail.subject, SUBJECT_MAX)) || null
	} as const;
	const messageKey = await messageKeyOf(mail);
	const recipient = { spaceId: row.spaceId, userId: row.userId };
	const capture = async (c: Omit<Capture, 'recipient' | 'trust'>) => {
		const full: Capture = { ...c, recipient, trust };
		// FN-20: the same cleaned merchant name and deterministic category as a forwarded mail.
		const merchant = await captureMerchant(db, full);
		const now = deps.now();
		const items = captureBatch(
			db,
			full,
			{ kind: 'gmail', mailId: row.id, connectionId: conn.id, receivedAt, fields, now },
			merchant
		);
		if (row.scanId) await db.batch([...items, countRead(deps, row.scanId, row.id)]);
		else await db.batch(items);
		return 'read' as const;
	};

	const payment = parser ? parsePaymentMail(parser, mail.subject, mail.text) : null;
	if (parser && payment) {
		const { referenceKey, ...shown } = payment;
		return capture({
			...shown,
			parser: parser.id,
			dedupeKey: await mailDedupeKey({
				parser: parser.id,
				referenceKey,
				amountMinor: payment.amountMinor,
				messageKey
			})
		});
	}
	const kept = { ...fields, receivedAt };
	if (mail.text === '') return unreadable('unparsed', kept);
	if (!isAiGatewayConfigured(env)) return unreadable('ai_unconfigured', kept);
	const key = await resolveAnthropicKey(db, row.userId, env);
	if (!key) return unreadable('no_ai_key', kept);
	// Red team L6: any outside sender can reach this read on the owner's key, so each connection has a daily cap.
	if (!(await claimAiRead(db, conn.id, deps.now()))) return unreadable('ai_limit', kept);
	const text = maskMailLines(mail.text).slice(0, PENDING_TEXT_MAX);
	const outcome = await readMailText(env, key, text, deps.aiFetch ?? fetch);
	const aiRow = { ...kept, parser: 'ai' as const };
	switch (outcome.kind) {
		case 'ok':
			return capture({
				...outcome.reading,
				reference: null,
				parser: 'ai',
				dedupeKey: await mailDedupeKey({
					parser: 'ai',
					referenceKey: null,
					amountMinor: outcome.reading.amountMinor,
					messageKey
				})
			});
		case 'not_payment':
			return notPayment();
		case 'currency':
			return unreadable('currency', aiRow);
		case 'invalid':
			return unreadable('ai_invalid', aiRow);
		case 'not_configured':
			return unreadable('ai_unconfigured', kept);
		case 'network':
			if (attempts >= INBOUND_READ_MAX_ATTEMPTS) return unreadable('ai_failed', aiRow);
			throw new RetryLaterError('gmail read: provider unavailable', INBOUND_RETRY_DELAY_S);
		default:
			// Invalid key, quota, model unavailable: retrying will not help; the user fixes it, then "Baca ulang".
			return unreadable('ai_failed', aiRow);
	}
}
